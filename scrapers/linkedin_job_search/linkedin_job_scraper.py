"""LinkedIn job scraper for the Scraping Workbench.

Uses LinkedIn's guest job-search API (no login required):
    https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search

Results are written to ./output/ (jobs.md + jobs.csv) so they appear in the
workbench viewer. Note: LinkedIn rate-limits aggressively; large crawls may
be blocked (HTTP 429) — keep --max-pages small.

Usage:  python3 scrapers/linkedin_job_search/linkedin_job_scraper.py
"""

import argparse
import csv
import os
import re
import time
import urllib.parse

import requests
from bs4 import BeautifulSoup

try:
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover - optional dependency
    sync_playwright = None

BASE_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
REQUEST_TIMEOUT = 60
SEARCH_PARAMS = {
    "keywords": "Software Developer",
    "location": "Scottsdale, Arizona, United States",
    "f_E": "1,2",          # internship + entry level
    "sortBy": "DD",        # most recent
}
REMOTE_PARAMS = {"f_WT": "2"}  # LinkedIn work-type filter: 2 = remote
RESULTS_PER_PAGE = 25     # LinkedIn guest API paging step
MAX_PAGES = 10
REQUEST_DELAY = 3.0
MAX_REQUEST_RETRIES = 4
HEADLESS = False


# --- FILTERS (same rules as the AZ scraper) ---
def is_software_engineering(title):
    title = title.lower()
    keywords = [
        "software engineer", "software developer", "software development",
        "fullstack", "full stack", "backend", "front end", "devops", "sre",
        "application developer", "platform engineer",
        "software development engineer",
    ]
    return any(k in title for k in keywords)


def infer_experience_years(text):
    if not text:
        return "unknown"
    normalized = " ".join(re.split(r"\s+", text or "")).lower()
    if re.search(r"\b0\s*[-–]\s*3\s*years?\b|\b0\s*to\s*3\s*years?\b|\bentry[- ]level\b|\bjunior\b|\bearly[- ]career\b|\bnew grad\b|\bassociate\b", normalized):
        return "0-3 years"
    if re.search(r"\b1\s*[-–]\s*3\s*years?\b|\b1\s*to\s*3\s*years?\b", normalized):
        return "1-3 years"
    if re.search(r"\b2\s*[-–]\s*3\s*years?\b|\b2\s*to\s*3\s*years?\b|\b2\s*years?\b|\b3\s*years?\b", normalized):
        return "2-3 years"
    if re.search(r"\b(?:4|5|6|7|8|9|10|12)\+\s*years?\b|\b(?:4|5|6|7|8|9|10|12)\s*years?\s*(?:of\s*experience|experience)\b", normalized):
        return "4+ years"
    return "unknown"


# --- SCRAPER ---
def extract_jobs_from_page(html):
    soup = BeautifulSoup(html, "html.parser")
    jobs = []
    for card in soup.select("li"):
        title_el = card.select_one("h3.base-search-card__title")
        link_el = card.select_one("a.base-card__full-link")
        if not title_el or not link_el:
            continue

        title = " ".join(title_el.get_text(" ", strip=True).split())
        href = link_el.get("href", "").strip()
        if not href:
            continue

        company_el = card.select_one("h4.base-search-card__subtitle")
        location_el = card.select_one("span.job-search-card__location")
        job_id = re.search(r"/jobs/view/(?:[^/?]*-)?(\d+)", href)

        jobs.append({
            "title": title,
            "company": company_el.get_text(" ", strip=True) if company_el else "",
            "location": location_el.get_text(" ", strip=True) if location_el else "",
            "posting_number": job_id.group(1) if job_id else "",
            "experience_years": infer_experience_years(title),
            "link": href,
            "raw_text": title,
        })
    return jobs


def fetch_page_with_backoff(session, params):
    for attempt in range(1, MAX_REQUEST_RETRIES + 1):
        try:
            resp = session.get(BASE_URL, params=params, timeout=REQUEST_TIMEOUT)
            if resp.status_code in {429, 500, 502, 503, 504}:
                raise requests.HTTPError(f"{resp.status_code} transient error")
            return resp
        except requests.RequestException as exc:
            if attempt == MAX_REQUEST_RETRIES:
                raise RuntimeError(f"Request failed after {MAX_REQUEST_RETRIES} attempts: {exc}") from exc
            backoff = min(30, 2 ** attempt)
            print(f"[!] Retrying in {backoff}s (attempt {attempt + 1}/{MAX_REQUEST_RETRIES})")
            time.sleep(backoff)
    raise RuntimeError("Unreachable request handler state")


def scrape_all():
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0"
    session.headers["Accept-Language"] = "en-US,en;q=0.9"

    all_jobs, seen_ids = [], set()
    for page in range(MAX_PAGES):
        params = {**SEARCH_PARAMS, "start": page * RESULTS_PER_PAGE}
        print(f"[+] Fetching page {page + 1} (start={params['start']})")
        resp = fetch_page_with_backoff(session, params)
        if resp.status_code != 200:
            print(f"[!] Page {page + 1} failed ({resp.status_code}), stopping.")
            break

        jobs = extract_jobs_from_page(resp.text)
        new_jobs = [j for j in jobs if j["posting_number"] not in seen_ids]
        for job in new_jobs:
            seen_ids.add(job["posting_number"])
        if not new_jobs:
            print("[+] No new jobs, stopping.")
            break
        all_jobs.extend(new_jobs)
        time.sleep(REQUEST_DELAY)

    print(f"[+] Total jobs scraped: {len(all_jobs)}")
    return all_jobs


def scrape_all_browser():
    """Fetch pages with a real browser (Playwright) instead of raw requests.

    Slower but far less likely to be blocked, since LinkedIn sees a genuine
    Chromium client. Uses the same guest-API endpoint and parser as HTML mode.
    """
    if sync_playwright is None:
        raise RuntimeError(
            "Playwright is not installed. Run: pip install playwright && playwright install chromium"
        )

    all_jobs, seen_ids = [], set()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        page = browser.new_page(viewport={"width": 1400, "height": 1200})
        try:
            for i in range(MAX_PAGES):
                params = {**SEARCH_PARAMS, "start": i * RESULTS_PER_PAGE}
                url = BASE_URL + "?" + urllib.parse.urlencode(params)
                print(f"[browser] Fetching page {i + 1} (start={params['start']})")
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(2000)

                jobs = extract_jobs_from_page(page.content())
                new_jobs = [j for j in jobs if j["posting_number"] not in seen_ids]
                for job in new_jobs:
                    seen_ids.add(job["posting_number"])
                if not new_jobs:
                    print("[browser] No new jobs, stopping.")
                    break
                all_jobs.extend(new_jobs)
                time.sleep(REQUEST_DELAY)
        finally:
            browser.close()

    print(f"[+] Total jobs scraped: {len(all_jobs)}")
    return all_jobs


def detail_is_remote(link):
    """Check a job's detail page (guest API) for remote work indicators.

    LinkedIn ignores f_WT=2 for anonymous requests, so the only reliable way
    to detect remote jobs as a guest is to fetch each posting and look for
    'Remote' in the text (e.g. location shows 'United States (Remote)').
    """
    m = re.search(r"/jobs/view/(?:[^/?]*-)?(\d+)", link)
    if not m:
        return False
    url = f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{m.group(1)}"
    for attempt in range(3):
        try:
            resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=REQUEST_TIMEOUT)
        except requests.RequestException:
            return False
        if resp.status_code == 200:
            break
        if resp.status_code == 429:
            wait = 10 * (attempt + 1)
            print(f"    [!] detail 429 rate-limited; waiting {wait}s")
            time.sleep(wait)
            continue
        print(f"    [!] detail request blocked/failed (HTTP {resp.status_code})")
        return False
    else:
        return False
    text = BeautifulSoup(resp.text, "html.parser").get_text(" ", strip=True).lower()
    return "remote" in text


def filter_jobs(jobs, remote_only=False):
    filtered = []
    skipped = {"senior": 0, "not-software": 0, "not-remote": 0}
    for i, job in enumerate(jobs, start=1):
        if "senior" in job["title"].lower():
            skipped["senior"] += 1
            continue
        if not is_software_engineering(job["title"]):
            skipped["not-software"] += 1
            continue
        # Remote filtering must be done per-posting; f_WT is ignored by the
        # anonymous endpoints (verified empirically).
        if remote_only:
            print(f"  [remote-check] {i}/{len(jobs)}: {job['title']}")
            if not detail_is_remote(job["link"]):
                skipped["not-remote"] += 1
                continue
            time.sleep(1.5)  # polite delay between detail requests
        filtered.append(job)
    print(f"[+] Filtered to {len(filtered)} jobs "
          f"(skipped: {skipped['senior']} senior, {skipped['not-software']} non-software, "
          f"{skipped['not-remote']} non-remote)")
    return filtered


# --- OUTPUT ---
def output_path(filename):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    return os.path.join(OUTPUT_DIR, filename)


def write_markdown(jobs, filename=None):
    filename = filename or output_path("linkedin_jobs.md")
    with open(filename, "w", encoding="utf-8") as f:
        f.write("# LinkedIn Software Engineering Jobs\n\n")
        for i, job in enumerate(jobs, start=1):
            f.write(f"## {i}. {job['title']}\n\n")
            f.write(f"- **Company:** {job['company']}\n")
            f.write(f"- **Location:** {job['location']}\n")
            f.write(f"- **Job Posting #:** {job['posting_number']}\n")
            f.write(f"- **Link:** {job['link']}\n\n")
    print(f"[+] Markdown written to {filename}")


def write_csv(jobs, filename=None):
    filename = filename or output_path("linkedin_jobs.csv")
    fieldnames = ["title", "company", "location", "posting_number", "experience_years", "link"]
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for job in jobs:
            writer.writerow({k: job.get(k, "") for k in fieldnames})
    print(f"[+] CSV written to {filename}")


def main():
    global MAX_PAGES, HEADLESS
    parser = argparse.ArgumentParser(description="LinkedIn job scraper")
    parser.add_argument("--mode", choices=["html", "browser"], default="html",
                        help="html = fast requests; browser = Playwright Chromium (harder to block)")
    parser.add_argument("--keywords", default=SEARCH_PARAMS["keywords"])
    parser.add_argument("--location", default=SEARCH_PARAMS["location"])
    parser.add_argument("--remote", action="store_true",
                        help="Search fully remote jobs (adds f_WT=2, location=United States)")
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES)
    parser.add_argument("--headless", action="store_true",
                        help="Run browser mode without a visible window (browser mode only)")
    args = parser.parse_args()

    SEARCH_PARAMS["keywords"] = args.keywords
    if args.remote:
        SEARCH_PARAMS.update(REMOTE_PARAMS)
        SEARCH_PARAMS["location"] = "United States"
    else:
        SEARCH_PARAMS["location"] = args.location
    MAX_PAGES = max(1, args.max_pages)
    HEADLESS = args.headless

    all_jobs = scrape_all() if args.mode == "html" else scrape_all_browser()
    filtered = filter_jobs(all_jobs, remote_only=args.remote)
    write_markdown(filtered)
    write_csv(filtered)


if __name__ == "__main__":
    main()

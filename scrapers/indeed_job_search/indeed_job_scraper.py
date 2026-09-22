"""Indeed job scraper for the Scraping Workbench.

Scrapes https://www.indeed.com/jobs search results. Indeed actively blocks
bots (Cloudflare); if requests return 403, run with Playwright or reduce
--max-pages / increase delays. Results are written to ./output/
(indeed_jobs.md + indeed_jobs.csv) so they appear in the workbench viewer.

Usage:  python3 scrapers/indeed_job_search/indeed_job_scraper.py
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

BASE_URL = "https://www.indeed.com/jobs"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
REQUEST_TIMEOUT = 60
SEARCH_PARAMS = {
    "q": "Software Developer",
    "l": "Scottsdale, AZ",
    "radius": "25",
    "sort": "date",
}
RESULTS_PER_PAGE = 10
MAX_PAGES = 10
REQUEST_DELAY = 5.0
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
    for card in soup.select("div.job_seen_beacon"):
        title_link = card.select_one("h2.jobTitle a")
        if not title_link:
            continue
        title = " ".join(title_link.get_text(" ", strip=True).split())
        job_key = title_link.get("data-jk", "")
        href = f"https://www.indeed.com/viewjob?jk={job_key}" if job_key else ""

        company_el = card.select_one("[data-testid='company-name']")
        location_el = card.select_one("[data-testid='text-location']")
        snippet_el = card.select_one("div.job-snippet")
        snippet = " ".join(snippet_el.get_text(" ", strip=True).split()) if snippet_el else ""

        jobs.append({
            "title": title,
            "company": company_el.get_text(" ", strip=True) if company_el else "",
            "location": location_el.get_text(" ", strip=True) if location_el else "",
            "posting_number": job_key,
            "experience_years": infer_experience_years(f"{title} {snippet}"),
            "link": href,
            "raw_text": f"{title} {snippet}",
        })
    return jobs


def fetch_page_with_backoff(session, params):
    for attempt in range(1, MAX_REQUEST_RETRIES + 1):
        try:
            resp = session.get(BASE_URL, params=params, timeout=REQUEST_TIMEOUT)
            if resp.status_code in {403, 429, 500, 502, 503, 504}:
                raise requests.HTTPError(f"{resp.status_code} transient/blocked")
            return resp
        except requests.RequestException as exc:
            if attempt == MAX_REQUEST_RETRIES:
                raise RuntimeError(f"Request failed after {MAX_REQUEST_RETRIES} attempts: {exc}") from exc
            backoff = min(60, 2 ** attempt * 3)
            print(f"[!] Retrying in {backoff}s (attempt {attempt + 1}/{MAX_REQUEST_RETRIES})")
            time.sleep(backoff)
    raise RuntimeError("Unreachable request handler state")


def scrape_all():
    session = requests.Session()
    session.headers["User-Agent"] = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
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

    Recommended for Indeed: Cloudflare blocks most plain-requests traffic
    (HTTP 403). Runs headed Chromium so the check can be solved manually if
    a challenge appears.
    """
    if sync_playwright is None:
        raise RuntimeError(
            "Playwright is not installed. Run: pip install playwright && playwright install chromium"
        )

    all_jobs, seen_ids = [], set()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        ctx = browser.new_context(
            viewport={"width": 1366, "height": 900},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            locale="en-US",
            timezone_id="America/Phoenix",
        )
        page = ctx.new_page()
        try:
            for i in range(MAX_PAGES):
                params = {**SEARCH_PARAMS, "start": i * RESULTS_PER_PAGE}
                url = BASE_URL + "?" + urllib.parse.urlencode(params)
                print(f"[browser] Fetching page {i + 1} (start={params['start']})")
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                # Headed mode: solve the Cloudflare challenge manually if shown.
                page.wait_for_timeout(8000)  # let Cloudflare/JS settle

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


def filter_jobs(jobs):
    filtered = []
    for job in jobs:
        if "senior" in job["title"].lower():
            continue
        if not is_software_engineering(job["title"]):
            continue
        filtered.append(job)
    print(f"[+] Filtered to {len(filtered)} jobs (software roles, excluding senior titles)")
    return filtered


# --- OUTPUT ---
def output_path(filename):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    return os.path.join(OUTPUT_DIR, filename)


def write_markdown(jobs, filename=None):
    filename = filename or output_path("indeed_jobs.md")
    with open(filename, "w", encoding="utf-8") as f:
        f.write("# Indeed Software Engineering Jobs\n\n")
        for i, job in enumerate(jobs, start=1):
            f.write(f"## {i}. {job['title']}\n\n")
            f.write(f"- **Company:** {job['company']}\n")
            f.write(f"- **Location:** {job['location']}\n")
            f.write(f"- **Job Posting #:** {job['posting_number']}\n")
            f.write(f"- **Link:** {job['link']}\n\n")
    print(f"[+] Markdown written to {filename}")


def write_csv(jobs, filename=None):
    filename = filename or output_path("indeed_jobs.csv")
    fieldnames = ["title", "company", "location", "posting_number", "experience_years", "link"]
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for job in jobs:
            writer.writerow({k: job.get(k, "") for k in fieldnames})
    print(f"[+] CSV written to {filename}")


def main():
    global MAX_PAGES, HEADLESS
    parser = argparse.ArgumentParser(description="Indeed job scraper")
    parser.add_argument("--mode", choices=["html", "browser"], default="html",
                        help="html = fast requests (often blocked by Cloudflare); browser = Playwright Chromium")
    parser.add_argument("--keywords", default=SEARCH_PARAMS["q"])
    parser.add_argument("--location", default=SEARCH_PARAMS["l"])
    parser.add_argument("--remote", action="store_true",
                        help="Search fully remote jobs (location=Remote)")
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES)
    parser.add_argument("--headless", action="store_true",
                        help="Run browser mode without a visible window (browser mode only)")
    args = parser.parse_args()

    SEARCH_PARAMS["q"] = args.keywords
    SEARCH_PARAMS["l"] = "Remote" if args.remote else args.location
    MAX_PAGES = max(1, args.max_pages)
    HEADLESS = args.headless

    all_jobs = scrape_all() if args.mode == "html" else scrape_all_browser()
    filtered = filter_jobs(all_jobs)
    write_markdown(filtered)
    write_csv(filtered)


if __name__ == "__main__":
    main()

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
from dataclasses import dataclass

import requests
from bs4 import BeautifulSoup

try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover - optional dependency
    sync_playwright = None
    PlaywrightTimeoutError = Exception

BASE_URL = "https://www.indeed.com/jobs"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
STATE_FILE = os.path.join(OUTPUT_DIR, ".browser-state.json")
REQUEST_TIMEOUT = 60
RESULTS_PER_PAGE = 10
REQUEST_DELAY = 5.0
MAX_REQUEST_RETRIES = 4
TRANSIENT_STATUSES = {403, 429, 500, 502, 503, 504}


@dataclass
class ScraperConfig:
    """Runtime options for a scrape run (replaces mutated module globals)."""

    keywords: str = "Software Developer"
    location: str = "Scottsdale, AZ"
    radius: str = "25"
    sort: str = "date"
    max_pages: int = 10
    headless: bool = False

    @property
    def search_params(self):
        return {
            "q": self.keywords,
            "l": self.location,
            "radius": self.radius,
            "sort": self.sort,
        }


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

        company = company_el.get_text(" ", strip=True) if company_el else ""
        jobs.append({
            "title": title,
            "company": company,
            "location": location_el.get_text(" ", strip=True) if location_el else "",
            "posting_number": job_key,
            # Fall back to title+company when data-jk is missing, otherwise all
            # keyless cards collapse into a single dedup entry.
            "dedup_key": job_key or f"{title}|{company}",
            "experience_years": infer_experience_years(f"{title} {snippet}"),
            "link": href,
        })
    return jobs


def fetch_page_with_backoff(session, params):
    """GET a search page, retrying only transient/blocked responses.

    Non-transient statuses (400, 404, ...) fail fast instead of burning
    retries. Returns the response regardless of status; callers decide
    whether the body is usable.
    """
    for attempt in range(1, MAX_REQUEST_RETRIES + 1):
        try:
            resp = session.get(BASE_URL, params=params, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as exc:
            if attempt == MAX_REQUEST_RETRIES:
                raise RuntimeError(f"Request failed after {MAX_REQUEST_RETRIES} attempts: {exc}") from exc
        else:
            if resp.status_code not in TRANSIENT_STATUSES:
                return resp
            if attempt == MAX_REQUEST_RETRIES:
                raise RuntimeError(
                    f"Blocked/transient HTTP {resp.status_code} after {MAX_REQUEST_RETRIES} attempts"
                )
        backoff = min(60, 2 ** attempt * 3)
        print(f"[!] Retrying in {backoff}s (attempt {attempt + 1}/{MAX_REQUEST_RETRIES})")
        time.sleep(backoff)
    raise RuntimeError("Unreachable request handler state")


def scrape_pages(fetch_html, config):
    """Shared pagination/dedup loop.

    fetch_html(params) returns page HTML, or None to stop pagination.
    """
    all_jobs, seen_keys = [], set()
    for page in range(config.max_pages):
        params = {**config.search_params, "start": page * RESULTS_PER_PAGE}
        print(f"[+] Fetching page {page + 1} (start={params['start']})")
        html = fetch_html(params)
        if html is None:
            print(f"[!] Page {page + 1} failed, stopping.")
            break

        jobs = extract_jobs_from_page(html)
        new_jobs = [j for j in jobs if j["dedup_key"] not in seen_keys]
        seen_keys.update(j["dedup_key"] for j in new_jobs)
        if not new_jobs:
            print("[+] No new jobs, stopping.")
            break
        all_jobs.extend(new_jobs)
        if page < config.max_pages - 1:
            time.sleep(REQUEST_DELAY)

    print(f"[+] Total jobs scraped: {len(all_jobs)}")
    return all_jobs


def scrape_all(config):
    session = requests.Session()
    session.headers["User-Agent"] = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
    session.headers["Accept-Language"] = "en-US,en;q=0.9"

    def fetch_html(params):
        resp = fetch_page_with_backoff(session, params)
        return resp.text if resp.status_code == 200 else None

    return scrape_pages(fetch_html, config)


def _wait_for_job_cards(page, headless, timeout_ms=180000):
    """Wait for Indeed to show real job cards.

    When Cloudflare shows a Turnstile challenge ("Just a moment..."), a human
    must click the checkbox. In headed mode we wait patiently (default 3 min);
    in headless mode the challenge can't be solved, so we fail fast.
    """
    budget = 30000 if headless else timeout_ms
    waited = 0
    step = 5000
    while waited < budget:
        try:
            page.wait_for_selector("div.job_seen_beacon", timeout=step)
            return True
        except PlaywrightTimeoutError:
            waited += step
        html = page.content()
        if "Just a moment" in html or "cf-chl" in html:
            if headless:
                return False
            if waited % 15000 == 0:
                print("  [challenge] Cloudflare check shown — click the "
                      "'Verify you are human' checkbox in the browser window...")
    return False


def scrape_all_browser(config):
    """Fetch pages with a real browser (Playwright) instead of raw requests.

    Recommended for Indeed: Cloudflare blocks most plain-requests traffic
    (HTTP 403). On the first headed run a human may need to click the
    Turnstile checkbox once; the resulting clearance cookie is saved to
    output/.browser-state.json and reused afterwards.
    """
    if sync_playwright is None:
        raise RuntimeError(
            "Playwright is not installed. Run: pip install playwright && playwright install chromium"
        )

    storage_state = STATE_FILE if os.path.exists(STATE_FILE) else None
    if storage_state:
        print("[browser] Reusing saved session state (Cloudflare clearance)")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=config.headless)
        ctx = browser.new_context(
            viewport={"width": 1366, "height": 900},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            locale="en-US",
            timezone_id="America/Phoenix",
            storage_state=storage_state,
        )
        page = ctx.new_page()

        def fetch_html(params):
            url = BASE_URL + "?" + urllib.parse.urlencode(params)
            print(f"[browser] URL: {url}")
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            if not _wait_for_job_cards(page, config.headless):
                print("[browser] No job cards (challenge unsolved?), stopping.")
                return None
            ctx.storage_state(path=STATE_FILE)
            return page.content()

        try:
            return scrape_pages(fetch_html, config)
        finally:
            browser.close()


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
    defaults = ScraperConfig()
    parser = argparse.ArgumentParser(description="Indeed job scraper")
    parser.add_argument("--mode", choices=["html", "browser"], default="html",
                        help="html = fast requests (often blocked by Cloudflare); browser = Playwright Chromium")
    parser.add_argument("--keywords", default=defaults.keywords)
    parser.add_argument("--location", default=defaults.location)
    parser.add_argument("--remote", action="store_true",
                        help="Search fully remote jobs (location=Remote)")
    parser.add_argument("--max-pages", type=int, default=defaults.max_pages)
    parser.add_argument("--headless", action="store_true",
                        help="Run browser mode without a visible window (browser mode only)")
    args = parser.parse_args()

    config = ScraperConfig(
        keywords=args.keywords,
        location="Remote" if args.remote else args.location,
        max_pages=max(1, args.max_pages),
        headless=args.headless,
    )

    all_jobs = scrape_all(config) if args.mode == "html" else scrape_all_browser(config)
    filtered = filter_jobs(all_jobs)
    write_markdown(filtered)
    write_csv(filtered)


if __name__ == "__main__":
    main()

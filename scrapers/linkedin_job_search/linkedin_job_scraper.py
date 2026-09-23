"""LinkedIn job scraper for the Scraping Workbench.

Uses LinkedIn's guest job-search API (no login required):
    https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search

Results are written to ./output/ (jobs.md + jobs.csv) so they appear in the
workbench viewer. Note: LinkedIn rate-limits aggressively; large crawls may
be blocked (HTTP 429) — keep --max-pages small.

By default, searches for junior/entry-level/associate roles near --location
(Scottsdale, AZ) merged with fully remote roles nationwide using three search
strategies (the guest API ignores f_WT=2, so we also inject "remote" as a
keyword and as a location value). Pass --remote to search remote jobs only.

Usage:  python3 scrapers/linkedin_job_search/linkedin_job_scraper.py
        python3 ... --remote --time-filter 30d --max-pages 5
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
LOCAL_LOCATION = "Scottsdale, Arizona, United States"
SEARCH_PARAMS = {
    "keywords": "Software Developer",
    "location": LOCAL_LOCATION,
    "f_E": "1,2,3",        # internship + entry level + associate
    "f_TPR": "r2592000",    # last 30 days (configurable via --time-filter)
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
        "fullstack", "full stack", "backend", "front end", "frontend",
        "devops", "sre", "application developer", "platform engineer",
        "software development engineer", "programmer", "web developer",
        ".net developer", "java developer", "python developer",
        "engineer i", "engineer ii", "developer i", "developer ii",
    ]
    return any(k in title for k in keywords)


def is_junior_level(title):
    t = title.lower()
    if re.search(r"\b(?:senior|sr|snr|staff|principal|lead|manager|director|architect)\b", t):
        return False
    if re.search(r"\b(?:iii|iv|v|3|4|5)\b", t):
        return False
    return True


US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC", "PR", "VI", "GU", "AS", "MP",
}


NEAR_SCOTTSDALE_PATTERNS = [
    r"\bscottsdale\b",
    r"\bphoenix\b",
    r"\btempe\b",
    r"\bmesa\b",
    r"\bchandler\b",
    r"\bgilbert\b",
    r"\bglendale\b",
    r"\bpeoria\b",
    r"\bparadise valley\b",
    r"\barizona\b",
    r",\s*az\b",
]


def is_near_scottsdale(location):
    """Check if location is Scottsdale or in the surrounding Arizona metro area."""
    if not location:
        return False
    low = location.lower()
    return any(re.search(p, low) for p in NEAR_SCOTTSDALE_PATTERNS)


def is_us_location(location):
    """Return True if the location string appears to be in the United States."""
    if not location:
        return False
    loc = location.strip()
    low = loc.lower()
    # "United States", "USA", "U.S." anywhere in the string
    if re.search(r"\b(?:united states|usa|u\.s\.a?)\b", low):
        return True
    # Bare "Remote" or "Remote, ..." or "Remote (..."
    if low == "remote" or low.startswith("remote,") or low.startswith("remote ("):
        return True
    # Check for ", ST" pattern (US state abbreviation, allowing trailing qualifiers like (Hybrid))
    match = re.search(r",\s*([A-Z]{2})(?:\s*\(.*|\s+.*|$)", loc)
    if match and match.group(1) in US_STATES:
        return True
    return False


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


def _dedup_key(job):
    # posting_number is sometimes unextractable, so link is the reliable fallback
    return job["posting_number"] or job["link"]


def scrape_all(params=None, source_tag="local"):
    search_params = params if params is not None else SEARCH_PARAMS
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0"
    session.headers["Accept-Language"] = "en-US,en;q=0.9"

    all_jobs, seen_ids = [], set()
    for page in range(MAX_PAGES):
        page_params = {**search_params, "start": page * RESULTS_PER_PAGE}
        print(f"[+] Fetching page {page + 1} (start={page_params['start']})")
        resp = fetch_page_with_backoff(session, page_params)
        if resp.status_code != 200:
            print(f"[!] Page {page + 1} failed ({resp.status_code}), stopping.")
            break

        jobs = extract_jobs_from_page(resp.text)
        for job in jobs:
            job.setdefault("_source", source_tag)
        new_jobs = [j for j in jobs if _dedup_key(j) not in seen_ids]
        for job in new_jobs:
            seen_ids.add(_dedup_key(job))
        if not new_jobs:
            print("[+] No new jobs, stopping.")
            break
        all_jobs.extend(new_jobs)
        time.sleep(REQUEST_DELAY)

    print(f"[+] Total jobs scraped: {len(all_jobs)}")
    return all_jobs


def scrape_local_and_remote():
    """Merge local + two remote search strategies, deduped.

    Uses three search strategies to work around the guest API ignoring f_WT=2:
    1. Local search (near configured location)
    2. location="Remote" search (LinkedIn treats "Remote" as a location)
    3. Keywords with "remote" injected + location="United States"
    """
    local_params = {**SEARCH_PARAMS, "location": LOCAL_LOCATION}
    remote_loc_params = {**SEARCH_PARAMS, **REMOTE_PARAMS, "location": "Remote"}
    remote_kw_params = {
        **SEARCH_PARAMS,
        **REMOTE_PARAMS,
        "keywords": SEARCH_PARAMS["keywords"] + " remote",
        "location": "United States",
    }

    print("[+] Strategy 1/3: Searching near local area...")
    local_jobs = scrape_all(local_params, source_tag="local")
    print("[+] Strategy 2/3: Searching with location='Remote'...")
    remote_loc_jobs = scrape_all(remote_loc_params, source_tag="remote")
    print("[+] Strategy 3/3: Searching with 'remote' keyword...")
    remote_kw_jobs = scrape_all(remote_kw_params, source_tag="remote")

    seen, merged = set(), []
    for job in local_jobs + remote_loc_jobs + remote_kw_jobs:
        key = _dedup_key(job)
        if key in seen:
            continue
        seen.add(key)
        merged.append(job)

    print(f"[+] Combined total (deduped): {len(merged)}")
    return merged


def scrape_remote_multi():
    """Multi-strategy remote-only search (no local jobs)."""
    remote_wt_params = {**SEARCH_PARAMS, **REMOTE_PARAMS, "location": "United States"}
    remote_loc_params = {**SEARCH_PARAMS, **REMOTE_PARAMS, "location": "Remote"}
    remote_kw_params = {
        **SEARCH_PARAMS,
        **REMOTE_PARAMS,
        "keywords": SEARCH_PARAMS["keywords"] + " remote",
        "location": "United States",
    }

    print("[+] Strategy 1/3: f_WT=2 + location='United States'...")
    jobs1 = scrape_all(remote_wt_params, source_tag="remote")
    print("[+] Strategy 2/3: location='Remote'...")
    jobs2 = scrape_all(remote_loc_params, source_tag="remote")
    print("[+] Strategy 3/3: 'remote' keyword + location='United States'...")
    jobs3 = scrape_all(remote_kw_params, source_tag="remote")

    seen, merged = set(), []
    for job in jobs1 + jobs2 + jobs3:
        key = _dedup_key(job)
        if key in seen:
            continue
        seen.add(key)
        merged.append(job)

    print(f"[+] Combined remote total (deduped): {len(merged)}")
    return merged


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
                new_jobs = [j for j in jobs if _dedup_key(j) not in seen_ids]
                for job in new_jobs:
                    seen_ids.add(_dedup_key(job))
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
    # "hybrid" postings often also mention "remote" in passing, so exclude those explicitly
    if "hybrid" in text:
        return False
    return "remote" in text


def is_remote_job(job):
    """Cheap check using the scraped location before falling back to a detail-page fetch."""
    loc = job.get("location", "").lower()
    if "remote" in loc:
        return True
    if "hybrid" in loc:
        return False
    return detail_is_remote(job["link"])


def filter_jobs(jobs, remote_only=False, require_local_or_remote=False):
    filtered = []
    skipped = {"senior": 0, "not-software": 0, "not-us": 0, "not-remote": 0, "not-local-or-remote": 0}
    local_city = LOCAL_LOCATION.split(",")[0].lower()
    for i, job in enumerate(jobs, start=1):
        if not is_junior_level(job["title"]):
            skipped["senior"] += 1
            continue
        if infer_experience_years(job["title"]) == "4+ years":
            skipped["senior"] += 1
            continue
        if not is_software_engineering(job["title"]):
            skipped["not-software"] += 1
            continue
        if not is_us_location(job.get("location", "")):
            skipped["not-us"] += 1
            continue
        # Remote filtering: trust the search-source tag for jobs from
        # remote-targeted searches; only detail-fetch for ambiguous ones.
        if remote_only:
            loc = job.get("location", "").lower()
            if job.get("_source") == "remote" or "remote" in loc:
                pass  # trusted remote from search source or location tag
            elif "hybrid" in loc:
                skipped["not-remote"] += 1
                continue
            else:
                print(f"  [remote-check] {i}/{len(jobs)}: {job['title']}")
                if not is_remote_job(job):
                    skipped["not-remote"] += 1
                    continue
                time.sleep(1.5)  # polite delay between detail requests
        elif require_local_or_remote:
            loc = job.get("location", "").lower()
            is_remote_source = job.get("_source") == "remote"
            is_remote_loc = "remote" in loc
            is_local = is_near_scottsdale(loc)
            if not is_remote_source and not is_remote_loc and not is_local:
                skipped["not-local-or-remote"] += 1
                continue
        filtered.append(job)
    print(f"[+] Filtered to {len(filtered)} jobs "
          f"(skipped: {skipped['senior']} senior/non-junior, {skipped['not-software']} non-software, "
          f"{skipped['not-us']} non-US, {skipped['not-remote']} non-remote, "
          f"{skipped['not-local-or-remote']} not local-or-remote)")
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
                        help="Search fully remote jobs only (multi-strategy: keyword + location)")
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES)
    parser.add_argument("--headless", action="store_true",
                        help="Run browser mode without a visible window (browser mode only)")
    parser.add_argument("--time-filter", default="30d",
                        choices=["1h", "24h", "7d", "30d", "none"],
                        help="How far back to search (default: 30d)")
    args = parser.parse_args()

    SEARCH_PARAMS["keywords"] = args.keywords
    MAX_PAGES = max(1, args.max_pages)
    HEADLESS = args.headless

    # Apply time filter
    time_filters = {"1h": "r3600", "24h": "r86400", "7d": "r604800", "30d": "r2592000"}
    if args.time_filter == "none":
        SEARCH_PARAMS.pop("f_TPR", None)
    else:
        SEARCH_PARAMS["f_TPR"] = time_filters.get(args.time_filter, "r2592000")

    if args.remote:
        all_jobs = scrape_remote_multi() if args.mode == "html" else scrape_all_browser()
        filtered = filter_jobs(all_jobs, remote_only=True)
    else:
        # Default: jobs near --location (Scottsdale, AZ) merged with fully remote jobs
        SEARCH_PARAMS["location"] = args.location
        all_jobs = scrape_local_and_remote() if args.mode == "html" else scrape_all_browser()
        filtered = filter_jobs(all_jobs, remote_only=False, require_local_or_remote=True)

    write_markdown(filtered)
    write_csv(filtered)


if __name__ == "__main__":
    main()

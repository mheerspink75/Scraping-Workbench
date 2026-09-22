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

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
REQUEST_TIMEOUT = 60
SEARCH_PARAMS = {
    "keywords": "Software Developer",
    "location": "Scottsdale, Arizona, United States",
    "f_E": "1,2",          # internship + entry level
    "sortBy": "DD",        # most recent
}
RESULTS_PER_PAGE = 25     # LinkedIn guest API paging step
MAX_PAGES = 10
REQUEST_DELAY = 3.0
MAX_REQUEST_RETRIES = 4


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
        job_id = re.search(r"/jobs/view/(\d+)", href)

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
    global MAX_PAGES
    parser = argparse.ArgumentParser(description="LinkedIn job scraper")
    parser.add_argument("--keywords", default=SEARCH_PARAMS["keywords"])
    parser.add_argument("--location", default=SEARCH_PARAMS["location"])
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES)
    args = parser.parse_args()

    SEARCH_PARAMS["keywords"] = args.keywords
    SEARCH_PARAMS["location"] = args.location
    MAX_PAGES = max(1, args.max_pages)

    all_jobs = scrape_all()
    filtered = filter_jobs(all_jobs)
    write_markdown(filtered)
    write_csv(filtered)


if __name__ == "__main__":
    main()

import argparse
import csv
import requests
from bs4 import BeautifulSoup
import re
import sys
import time

try:
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover - optional dependency
    sync_playwright = None

import os

BASE_URL = "https://www.azjobconnection.gov/search/jobs"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
REQUEST_TIMEOUT = 60
SEARCH_PARAMS = {
    "search_job_search[keywords_picker]": "Software Developers",
    "search_job_search[keywords]": "",
    "search_job_search[location]": "Scottdale, AZ",
    "search_job_search[radius]": "25",
    "search_job_search[job_location_state]": "Arizona",
    "search_job_search[label]": "",
    "commit": "run_search",
}
MAX_PAGES = 50
REQUEST_DELAY = 3.0
BROWSER_PAGE_DELAY = 2.5
MAX_REQUEST_RETRIES = 4

# --- FILTERS ---
def is_software_engineering(title):
    title = title.lower()
    keywords = [
        "software engineer",
        "software developer",
        "software development",
        "fullstack",
        "full stack",
        "backend",
        "front end",
        "devops",
        "sre",
        "application developer",
        "platform engineer",
        "software development engineer",
    ]
    return any(k in title for k in keywords)

def mentions_1_to_3_years(text):
    text = text.lower()
    patterns = [
        r"1\s*[-–]\s*3\s*years?",
        r"1\s*to\s*3\s*years?",
        r"\b1 year\b",
        r"\b2 years?\b",
        r"\b3 years?\b",
    ]
    return any(re.search(p, text) for p in patterns)


def experience_matches_text(text):
    text = text.lower()
    patterns = [
        r"0\s*[-–]\s*3\s*years?",
        r"0\s*to\s*3\s*years?",
        r"\b0\s*years?\b",
        r"\b1\s*year\b",
        r"\b2\s*years?\b",
        r"\b3\s*years?\b",
        r"\bentry[- ]level\b",
        r"\bjunior\b",
        r"\bearly career\b",
        r"\bnew grad\b",
        r"\bassociate\b",
    ]
    return any(re.search(p, text) for p in patterns)


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
    if re.search(r"\b(?:minimum|at least|requires?|requirement)\s*(?:of\s*)?(?:\+\s*)?(?:4|5|6|7|8|9|10|12)\s*years?\b|\b(?:4|5|6|7|8|9|10|12)\+\s*years?\b|\b(?:4|5|6|7|8|9|10|12)\s*years?\s*(?:of\s*experience|experience)\b", normalized):
        return "4+ years"

    return "unknown"


def detail_page_has_0_to_3_years(text):
    normalized = " ".join(re.split(r"\s+", text or "")).lower()

    positive_patterns = [
        r"\b0\s*[-–]\s*3\s*years?\b",
        r"\b0\s*to\s*3\s*years?\b",
        r"\b1\s*[-–]\s*3\s*years?\b",
        r"\b1\s*to\s*3\s*years?\b",
        r"\b2\s*[-–]\s*3\s*years?\b",
        r"\b2\s*to\s*3\s*years?\b",
        r"\b0\s*years?\b",
        r"\b1\s*year\b",
        r"\b2\s*years?\b",
        r"\b3\s*years?\b",
        r"\bentry[- ]level\b",
        r"\bjunior\b",
        r"\bearly[- ]career\b",
        r"\bnew grad\b",
        r"\bassociate\b",
    ]

    negative_patterns = [
        r"\b(?:minimum|at least|requires?|requirement)\s*(?:of\s*)?(?:\+\s*)?(?:4|5|6|7|8|9|10|12)\s*years?\b",
        r"\b(?:4|5|6|7|8|9|10|12)\s*[-–]\s*(?:7|8|9|10|12|15)\s*years?\b",
        r"\b(?:4|5|6|7|8|9|10|12)\+\s*years?\b",
        r"\b(?:4|5|6|7|8|9|10|12)\s*years?\s*(?:of\s*experience|experience)\b",
    ]

    if any(re.search(p, normalized) for p in positive_patterns):
        if any(re.search(p, normalized) for p in negative_patterns):
            return False
        return True

    return False

# --- SCRAPER ---
def extract_jobs_from_page(html):
    soup = BeautifulSoup(html, "html.parser")
    jobs = []
    seen = set()

    for card in soup.select("header.card__header"):
        title_link = card.select_one("h4.card__title a")
        if not title_link:
            continue

        title = " ".join(title_link.get_text(" ", strip=True).split())
        href = title_link.get("href", "").strip()
        if not href:
            continue
        if href.startswith("/"):
            href = "https://www.azjobconnection.gov" + href

        job_id = re.search(r"/jobs/(\d+)", href)
        if not job_id:
            continue
        job_id = job_id.group(1)
        if job_id in seen:
            continue
        seen.add(job_id)

        meta = card.select_one("p.card-metadata--job-employer")
        meta_text = " ".join(meta.get_text(" ", strip=True).split()) if meta else ""
        company = ""
        location = ""

        if meta_text:
            if meta_text.lower().startswith("at "):
                meta_text = meta_text[3:]
            if " in " in meta_text:
                company, location = meta_text.rsplit(" in ", 1)
            else:
                company = meta_text

        raw_text = f"{title} {meta_text}".strip()
        jobs.append({
            "title": title,
            "company": company,
            "location": location,
            "posting_number": job_id,
            "experience_years": infer_experience_years(raw_text),
            "link": href,
            "raw_text": raw_text,
        })

    return jobs

def fetch_page_with_backoff(session, url, params=None):
    for attempt in range(1, MAX_REQUEST_RETRIES + 1):
        try:
            resp = session.get(url, params=params, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 429:
                raise requests.HTTPError("429 rate limited")
            if resp.status_code in {500, 502, 503, 504}:
                raise requests.HTTPError(f"{resp.status_code} server error")
            if resp.status_code != 200:
                print(f"[!] Page request failed with status {resp.status_code} on attempt {attempt}/{MAX_REQUEST_RETRIES}")
                return resp
            return resp
        except requests.RequestException as exc:
            if attempt == MAX_REQUEST_RETRIES:
                raise RuntimeError(f"Request failed after {MAX_REQUEST_RETRIES} attempts: {exc}") from exc
            backoff = min(30, 2 ** attempt)
            print(f"[!] Rate-limited or transient error; backing off for {backoff}s before retry {attempt + 1}/{MAX_REQUEST_RETRIES}")
            time.sleep(backoff)

    raise RuntimeError("Unreachable request handler state")


def scrape_all():
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0"
    session.headers["Accept-Language"] = "en-US,en;q=0.9"

    all_jobs = []
    seen_links = set()

    for page in range(1, MAX_PAGES + 1):
        params = {**SEARCH_PARAMS, "page": page}
        print(f"[+] Fetching page {page} (polite delay: {REQUEST_DELAY}s)")
        resp = fetch_page_with_backoff(session, BASE_URL, params=params)

        if resp.status_code != 200:
            print(f"[!] Page {page} failed ({resp.status_code})")
            break

        jobs = extract_jobs_from_page(resp.text)
        if not jobs:
            print(f"[+] No jobs found on page {page}, stopping.")
            break

        new_jobs = []
        for job in jobs:
            if job["link"] not in seen_links:
                seen_links.add(job["link"])
                new_jobs.append(job)

        if not new_jobs:
            print(f"[+] Reached duplicate page content on page {page}, stopping.")
            break

        all_jobs.extend(new_jobs)
        time.sleep(REQUEST_DELAY)

    print(f"[+] Total jobs scraped: {len(all_jobs)}")
    return all_jobs

def filter_jobs(jobs):
    filtered = []
    for job in jobs:
        title = job["title"].lower()

        if "senior" in title:
            continue

        if not is_software_engineering(job["title"]):
            continue

        job["experience_years"] = infer_experience_years(job.get("raw_text", ""))

        # Some result cards do not include experience details in the summary.
        # Only reject when the page text explicitly says the job is outside the
        # 1-3 year range; otherwise keep the match so valid software roles are not lost.
        if "year" in job["raw_text"].lower() and not mentions_1_to_3_years(job["raw_text"]):
            continue

        filtered.append(job)
    print(f"[+] Filtered to {len(filtered)} jobs (software roles, excluding senior titles)")
    return filtered

def output_path(filename):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    return os.path.join(OUTPUT_DIR, filename)


def write_markdown(jobs, filename=None):
    filename = filename or output_path("az_jobs.md")
    with open(filename, "w", encoding="utf-8") as f:
        f.write("# Software Engineering Jobs\n\n")
        for i, job in enumerate(jobs, start=1):
            f.write(f"## {i}. {job['title']}\n\n")
            f.write(f"- **Company:** {job['company']}\n")
            f.write(f"- **Location:** {job['location']}\n")
            f.write(f"- **Job Posting #:** {job['posting_number']}\n")
            f.write(f"- **Link:** {job['link']}\n\n")

    print(f"[+] Markdown written to {filename}")


def write_csv(jobs, filename=None):
    filename = filename or output_path("az_jobs.csv")
    fieldnames = ["title", "company", "location", "posting_number", "experience_years", "link"]
    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for job in jobs:
            writer.writerow({
                "title": job["title"],
                "company": job["company"],
                "location": job["location"],
                "posting_number": job["posting_number"],
                "experience_years": job.get("experience_years", infer_experience_years(job.get("raw_text", ""))),
                "link": job["link"],
            })
    print(f"[+] CSV written to {filename}")


def load_csv_jobs(filename=None):
    filename = filename or output_path("az_jobs.csv")
    with open(filename, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    return rows


# OPTION C — browser automation workflow
# This path opens each job page in a real browser so Copilot or a browser-driven tool
# can inspect the page and verify experience requirements before writing the final CSV.
def filter_jobs_via_browser(input_csv=None, output_csv=None):
    input_csv = input_csv or output_path("az_jobs.csv")
    output_csv = output_csv or output_path("az_jobs_filtered_0_3_years.csv")
    if sync_playwright is None:
        raise RuntimeError(
            "Playwright is not installed. Run: pip install playwright && playwright install chromium"
        )

    rows = load_csv_jobs(input_csv)
    filtered = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        page = browser.new_page(viewport={"width": 1400, "height": 1200})

        try:
            for index, row in enumerate(rows, start=1):
                url = row.get("link", "").strip()
                if not url:
                    continue

                print(f"[browser] checking {index}/{len(rows)}: {row.get('title','')}")
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(2000)

                if index < len(rows):
                    time.sleep(BROWSER_PAGE_DELAY)

                body_text = page.locator("body").inner_text()
                if detail_page_has_0_to_3_years(body_text):
                    filtered.append(row)
                    print(f"[browser] included -> {row.get('title','')}")
                else:
                    print(f"[browser] excluded -> {row.get('title','')}")

            browser.close()
        finally:
            try:
                browser.close()
            except Exception:
                pass

    fieldnames = ["title", "company", "location", "posting_number", "experience_years", "link"]
    with open(output_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in filtered:
            row = dict(row)
            row.setdefault("experience_years", infer_experience_years(row.get("raw_text", "")))
            writer.writerow({
                "title": row.get("title", ""),
                "company": row.get("company", ""),
                "location": row.get("location", ""),
                "posting_number": row.get("posting_number", ""),
                "experience_years": row.get("experience_years", "unknown"),
                "link": row.get("link", ""),
            })

    print(f"[+] Browser-filtered CSV written to {output_csv}")
    print(f"[+] Final count: {len(filtered)} jobs")
    return filtered


def main():
    global MAX_PAGES

    parser = argparse.ArgumentParser(description="AZ job scraper")
    parser.add_argument("--mode", choices=["html", "browser"], default="html", help="Use fast HTML scraping or browser automation workflow")
    parser.add_argument("--input", default=None, help="CSV input file used by browser mode (default: output/az_jobs.csv)")
    parser.add_argument("--output", default=None, help="CSV output file for browser mode (default: output/az_jobs_filtered_0_3_years.csv)")
    parser.add_argument("--max-pages", type=int, default=MAX_PAGES, help="Maximum number of result pages to crawl in HTML mode")
    args = parser.parse_args()

    MAX_PAGES = max(1, args.max_pages)

    if args.mode == "browser":
        filter_jobs_via_browser(args.input, args.output)
        return

    all_jobs = scrape_all()
    filtered = filter_jobs(all_jobs)
    write_markdown(filtered)
    write_csv(filtered)

if __name__ == "__main__":
    main()

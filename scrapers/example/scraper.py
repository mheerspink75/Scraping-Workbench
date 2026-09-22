#!/usr/bin/env python3
"""Example scraper for the Scraping Workbench.

Every scraper lives in scrapers/<name>/ and must:
  1. Fetch its target website.
  2. Write results into ./output/ (Markdown and/or CSV) so they show up
     in the workbench viewer on the right pane.

Run directly:  python3 scrapers/example/scraper.py
Or via the workbench: ask the model in the left pane to run this scraper.
"""

import csv
import os

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")


def scrape():
    """Scrape the target site. Replace with real scraping logic."""
    rows = [
        {"title": "Widget", "url": "https://example.com/1", "price": "9.99"},
        {"title": "Gadget", "url": "https://example.com/2", "price": "19.99"},
    ]
    summary = (
        "# Example Scrape Results\n\n"
        "**Target:** https://example.com\n\n"
        "- Widget\n"
        "- Gadget\n\n"
        "[Source](https://example.com)\n"
    )
    return rows, summary


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    rows, summary = scrape()

    csv_path = os.path.join(OUTPUT_DIR, "results.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    md_path = os.path.join(OUTPUT_DIR, "results.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(summary)

    print(f"Wrote {csv_path}")
    print(f"Wrote {md_path}")


if __name__ == "__main__":
    main()

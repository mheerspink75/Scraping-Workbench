import os
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs

import app


class ResultDiscoveryTests(unittest.TestCase):
    def test_files_are_grouped_into_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "indeed_job_search" / "output"
            output.mkdir(parents=True)
            (output / "jobs.csv").write_text(
                "title,company,url\nDeveloper,Acme,https://example.com/1\n",
                encoding="utf-8",
            )
            (output / "jobs.md").write_text("# Indeed jobs\n", encoding="utf-8")
            (output / ".hidden.csv").write_text("secret\n", encoding="utf-8")

            entries = app.collect_viewable_files(str(root))
            runs = app.build_runs(entries, str(root))

            self.assertEqual(len(entries), 2)
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0]["project_name"], "Indeed Job Search")
            self.assertEqual(runs[0]["name"], "Jobs")
            self.assertEqual(runs[0]["primary_path"], "indeed_job_search/output/jobs.csv")
            self.assertEqual(set(runs[0]["available"]), {"table", "report"})
            self.assertTrue(runs[0]["files"][0]["file_uri"].startswith("file://"))

    def test_safe_path_rejects_files_outside_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "root"
            root.mkdir()
            outside = Path(directory) / "outside.txt"
            outside.write_text("no", encoding="utf-8")
            self.assertFalse(app.is_safe_path(str(root), "../outside.txt"))


class TablePayloadTests(unittest.TestCase):
    def setUp(self):
        self.text = (
            "title,company,location,link\n"
            "Engineer,Acme,Phoenix,https://example.com/1\n"
            "Analyst,Globex,Remote,https://example.com/2\n"
            "Engineer,Initech,Remote,https://example.com/3\n"
        )
        self.metadata = {
            "path": "example/output/jobs.csv",
            "revision": "abc",
        }

    def parse(self, query=""):
        return app.build_table_payload(
            self.text,
            ".csv",
            parse_qs(query, keep_blank_values=True),
            self.metadata,
        )

    def test_search_filter_sort_and_pagination(self):
        payload = self.parse(
            "q=engineer&filter_1=initech&sort=title&direction=desc&page=1&page_size=1"
        )
        self.assertEqual(payload["total_rows"], 3)
        self.assertEqual(payload["filtered_rows"], 1)
        self.assertEqual(payload["page"], 1)
        self.assertEqual(payload["page_count"], 1)
        self.assertEqual(payload["rows"], [["Engineer", "Initech", "Remote", "https://example.com/3"]])

    def test_overview_contains_quality_and_facets(self):
        payload = self.parse("page_size=2")
        self.assertEqual(payload["overview"]["row_count"], 3)
        self.assertEqual(payload["overview"]["column_count"], 4)
        self.assertEqual(payload["overview"]["complete_rows"], 3)
        location_facet = next(item for item in payload["facets"] if item["name"] == "location")
        self.assertEqual(location_facet["values"][0], {"value": "Remote", "count": 2})
        self.assertEqual(len(payload["rows"]), 2)

    def test_page_is_clamped_to_available_pages(self):
        payload = self.parse("page=99&page_size=2")
        self.assertEqual(payload["page"], 2)
        self.assertEqual(payload["page_count"], 2)
        self.assertEqual(len(payload["rows"]), 1)


if __name__ == "__main__":
    unittest.main()

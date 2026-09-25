#!/usr/bin/env python3
"""Split-screen scraping workbench.

Left pane  : opencode serve web UI, reverse-proxied on this same port with
             credentials auto-injected (no login prompt).
Right pane : run-oriented inspector for files produced by scraping.

Routing on the app port:
  /                 -> workbench UI (static/index.html)
  /css/*, /js/*     -> workbench static assets (static/)
  /?oc              -> opencode UI (SPA route "/", proxied; used by the iframe)
  /api/files        -> legacy workbench file list
  /api/runs         -> run-oriented result metadata
  /api/file?path=   -> workbench file content (table, report, or raw)
  /api/info         -> local workbench integration metadata
  everything else (/api/session, /_assets/*, SPA routes) -> proxied to opencode

Project layout:
  static/                 workbench frontend (index.html, css/, js/)
  scrapers/<name>/        one folder per scraper/website
      scraper.py          the scraper for that website
      output/             generated results (gitignored), shown in the viewer

Usage:
    python3 app.py [--port 8080] [--opencode-url http://127.0.0.1:4096]
                   [--opencode-password workbench] [--dir .]

No third-party dependencies (Python standard library only).
"""

import argparse
import base64
import csv
import datetime
import hashlib
import http.client
import io
import json
import os
import select
import urllib.parse

from collections import Counter
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

VIEWABLE_EXTENSIONS = {".md", ".markdown", ".csv", ".txt", ".json", ".tsv"}
TABULAR_EXTENSIONS = {".csv", ".tsv"}
REPORT_EXTENSIONS = {".md", ".markdown"}
FACET_HEADERS = {
    "category", "company", "experience", "experience_years", "location",
    "source", "status", "type",
}
FORMAT_PRIORITY = {"table": 0, "report": 1, "json": 2, "text": 3}
SPECIAL_WORDS = {"az": "AZ", "linkedin": "LinkedIn", "indeed": "Indeed"}

# Headers that must not be forwarded verbatim between client and upstream.
HOP_BY_HOP = {
    "connection", "keep-alive", "transfer-encoding", "te",
    "trailer", "upgrade", "proxy-authorization", "proxy-authenticate",
}

def is_safe_path(root: str, path: str) -> bool:
    """Ensure path is a file inside root (no directory traversal)."""
    full = os.path.realpath(os.path.join(root, path))
    root_real = os.path.realpath(root)
    return full.startswith(root_real + os.sep) and os.path.isfile(full)


def _iso_timestamp(timestamp: float) -> str:
    return datetime.datetime.fromtimestamp(timestamp).astimezone().isoformat(
        timespec="seconds"
    )


def _file_revision(stat_result: os.stat_result) -> str:
    value = f"{stat_result.st_size}:{stat_result.st_mtime_ns}"
    return hashlib.sha256(value.encode()).hexdigest()[:20]


def _titleize(value: str) -> str:
    words = []
    for raw_word in value.replace("_", "-").split("-"):
        if not raw_word:
            continue
        lower = raw_word.casefold()
        words.append(SPECIAL_WORDS.get(lower, raw_word.capitalize()))
    return " ".join(words) or value


def _file_format(extension: str) -> str:
    if extension in TABULAR_EXTENSIONS:
        return "table"
    if extension in REPORT_EXTENSIONS:
        return "report"
    if extension == ".json":
        return "json"
    return "text"


def collect_viewable_files(root: str):
    """Return metadata for supported, non-hidden result files below root."""
    entries = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        parts = [] if rel_dir == "." else rel_dir.split(os.sep)
        if any(part.startswith(".") for part in parts):
            dirnames[:] = []
            continue
        dirnames[:] = sorted(
            name for name in dirnames if not name.startswith(".")
        )
        for name in sorted(filenames):
            extension = os.path.splitext(name)[1].lower()
            if extension not in VIEWABLE_EXTENSIONS or name.startswith("."):
                continue
            full = os.path.join(dirpath, name)
            relative_path = os.path.relpath(full, root)
            if not is_safe_path(root, relative_path):
                continue
            try:
                stat_result = os.stat(full)
            except OSError:
                # Outputs can disappear during a refresh while a scraper rotates them.
                continue
            entries.append({
                "path": relative_path.replace(os.sep, "/"),
                "size": stat_result.st_size,
                "mtime": datetime.datetime.fromtimestamp(
                    stat_result.st_mtime
                ).strftime("%Y-%m-%d %H:%M"),
                "modified": _iso_timestamp(stat_result.st_mtime),
                "mtime_ns": stat_result.st_mtime_ns,
                "revision": _file_revision(stat_result),
                "format": _file_format(extension),
            })
    entries.sort(key=lambda entry: entry["path"])
    return entries


def _entries_revision(entries) -> str:
    digest = hashlib.sha256()
    for entry in entries:
        digest.update(
            f"{entry['path']}\0{entry['size']}\0{entry['mtime_ns']}\n".encode()
        )
    return digest.hexdigest()[:20]


def build_runs(entries, root: str):
    """Group complementary output files into human-oriented scraper runs."""
    grouped = {}
    for entry in entries:
        run_path = os.path.splitext(entry["path"])[0].replace(os.sep, "/")
        grouped.setdefault(run_path, []).append(entry)

    runs = []
    for run_path, files in grouped.items():
        files.sort(key=lambda item: (
            FORMAT_PRIORITY.get(item["format"], 99), item["path"]
        ))
        path_parts = run_path.split("/")
        project = path_parts[0] if path_parts else "Results"
        run_name = _titleize(os.path.basename(run_path))
        project_name = _titleize(project)
        latest_ns = max(item["mtime_ns"] for item in files)
        latest = max(files, key=lambda item: item["mtime_ns"])
        public_files = []
        for item in files:
            full = os.path.realpath(os.path.join(root, item["path"]))
            public_files.append({
                "path": item["path"],
                "name": os.path.basename(item["path"]),
                "size": item["size"],
                "mtime": item["mtime"],
                "modified": item["modified"],
                "revision": item["revision"],
                "format": item["format"],
                "file_uri": "file://" + urllib.parse.quote(full),
            })
        runs.append({
            "id": run_path,
            "project": project,
            "project_name": project_name,
            "name": run_name,
            "label": f"{project_name} · {run_name}",
            "path": os.path.dirname(run_path).replace(os.sep, "/") or ".",
            "modified": latest["modified"],
            "mtime_ns": latest_ns,
            "revision": hashlib.sha256(
                "|".join(
                    f"{item['path']}:{item['revision']}" for item in files
                ).encode()
            ).hexdigest()[:20],
            "primary_path": files[0]["path"],
            "available": sorted({item["format"] for item in files}),
            "files": public_files,
        })

    runs.sort(key=lambda run: (-run["mtime_ns"], run["label"].casefold()))
    return runs


def _read_stable(path: str, attempts: int = 3):
    """Read a file only when it stayed unchanged for the duration of the read."""
    for _ in range(attempts):
        before = os.stat(path)
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
        after = os.stat(path)
        if (
            before.st_size == after.st_size
            and before.st_mtime_ns == after.st_mtime_ns
        ):
            return text, after
    raise OSError("file changed repeatedly while it was being read")


def _bounded_int(value, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(parsed, maximum))


def _sort_cell(value: str):
    stripped = value.strip()
    if not stripped:
        return (1, 0, "")
    try:
        return (0, float(stripped), "")
    except ValueError:
        return (0, 0, stripped.casefold())


def build_table_payload(text: str, extension: str, params, metadata):
    """Parse, filter, sort, summarize, and paginate a CSV/TSV file."""
    dialect = "excel-tab" if extension == ".tsv" else "excel"
    parsed_rows = list(csv.reader(io.StringIO(text), dialect=dialect))
    headers = parsed_rows[0] if parsed_rows else []
    rows = [
        row for row in parsed_rows[1:]
        if any(cell.strip() for cell in row)
    ]

    def cell(row, index):
        return row[index].strip() if index < len(row) else ""

    quality = []
    for index, header in enumerate(headers):
        values = [cell(row, index) for row in rows]
        filled = sum(bool(value) for value in values)
        quality.append({
            "name": header or f"Column {index + 1}",
            "filled": filled,
            "unique": len(set(values)),
            "fill_rate": filled / len(rows) if rows else 0,
        })

    facets = []
    top_values = {}
    for index, header in enumerate(headers):
        normalized = header.strip().casefold().replace(" ", "_")
        if normalized not in FACET_HEADERS:
            continue
        counts = Counter(
            cell(row, index) for row in rows if cell(row, index)
        )
        ranked = sorted(
            counts.items(), key=lambda item: (-item[1], item[0].casefold())
        )
        values = [
            {"value": value, "count": count}
            for value, count in ranked[:20]
        ]
        facets.append({
            "index": index,
            "name": header or f"Column {index + 1}",
            "values": values,
        })
        top_values[header] = values[:6]

    query = params.get("q", [""])[0].strip().casefold()
    filters = {}
    for index, header in enumerate(headers):
        value = params.get(f"filter_{index}", [""])[0].strip()
        if value:
            filters[index] = value.casefold()

    filtered = []
    for row in rows:
        values = [cell(row, index) for index in range(len(headers))]
        if query and query not in " ".join(values).casefold():
            continue
        if any(values[index].casefold() != value for index, value in filters.items()):
            continue
        filtered.append(row)

    sort_name = params.get("sort", [""])[0]
    sort_index = headers.index(sort_name) if sort_name in headers else None
    if sort_index is not None:
        present = [row for row in filtered if cell(row, sort_index)]
        missing = [row for row in filtered if not cell(row, sort_index)]
        present.sort(
            key=lambda row: _sort_cell(cell(row, sort_index)),
            reverse=params.get("direction", ["asc"])[0] == "desc",
        )
        filtered = present + missing

    page_size = _bounded_int(
        params.get("page_size", ["100"])[0], 100, 1, 500
    )
    page_count = (
        (len(filtered) + page_size - 1) // page_size if filtered else 0
    )
    page = _bounded_int(params.get("page", ["1"])[0], 1, 1, max(1, page_count))
    start = (page - 1) * page_size
    page_rows = filtered[start:start + page_size]
    complete_rows = sum(
        all(cell(row, index) for index in range(len(headers)))
        for row in rows
    )

    payload = dict(metadata)
    payload.update({
        "type": "csv",
        "headers": headers,
        "rows": page_rows,
        "total_rows": len(rows),
        "filtered_rows": len(filtered),
        "page": page,
        "page_size": page_size,
        "page_count": page_count,
        "facets": facets,
        "overview": {
            "row_count": len(rows),
            "column_count": len(headers),
            "complete_rows": complete_rows,
            "complete_rate": complete_rows / len(rows) if rows else 0,
            "columns": quality,
            "top_values": top_values,
        },
    })
    return payload


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    root_dir = "./scrapers"
    static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
    upstream_host = "127.0.0.1"
    upstream_port = 4096
    upstream_auth = ""  # "Basic ..." header value injected into proxied requests

    def _serve_static(self, rel):
        """Serve a file from static/ (no traversal allowed)."""
        full = os.path.realpath(os.path.join(self.static_dir, rel))
        if not full.startswith(os.path.realpath(self.static_dir) + os.sep) \
                or not os.path.isfile(full):
            self._send_json({"error": "not found"}, 404)
            return
        mime = {".css": "text/css", ".js": "text/javascript",
                ".html": "text/html; charset=utf-8",
                ".svg": "image/svg+xml", ".png": "image/png"}.get(
            os.path.splitext(full)[1].lower(), "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # ---------- workbench helpers ----------

    def _send_json(self, obj, status=200, headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_not_modified(self, revision):
        self.send_response(304)
        self.send_header("ETag", f'"{revision}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _handle_files(self):
        # Keep the original list endpoint for scripts that already consume it.
        entries = collect_viewable_files(self.root_dir)
        public_entries = [
            {key: value for key, value in entry.items() if key != "mtime_ns"}
            for entry in entries
        ]
        self._send_json(public_entries)

    def _handle_runs(self, params):
        entries = collect_viewable_files(self.root_dir)
        revision = _entries_revision(entries)
        if params.get("revision", [""])[0] == revision:
            self._send_not_modified(revision)
            return
        self._send_json(
            {"runs": build_runs(entries, self.root_dir), "revision": revision},
            headers={"ETag": f'"{revision}"'},
        )

    def _handle_info(self):
        self._send_json({
            "opencode_directory": os.path.dirname(os.path.abspath(__file__)),
            "result_root": self.root_dir,
        })

    def _handle_file(self, path, params):
        if not path or not is_safe_path(self.root_dir, path):
            self._send_json({"error": "invalid path"}, 400)
            return
        full = os.path.join(self.root_dir, path)
        extension = os.path.splitext(path)[1].lower()
        try:
            text, stat_result = _read_stable(full)
        except OSError as error:
            self._send_json({"error": str(error)}, 500)
            return

        revision = _file_revision(stat_result)
        if params.get("revision", [""])[0] == revision:
            self._send_not_modified(revision)
            return
        metadata = {
            "path": path.replace(os.sep, "/"),
            "size": stat_result.st_size,
            "modified": _iso_timestamp(stat_result.st_mtime),
            "revision": revision,
            "format": _file_format(extension),
        }
        headers = {"ETag": f'"{revision}"'}

        if params.get("raw", [""])[0] in {"1", "true", "yes"}:
            self._send_json(
                {**metadata, "type": "text", "text": text}, headers=headers
            )
        elif extension in TABULAR_EXTENSIONS:
            self._send_json(
                build_table_payload(text, extension, params, metadata),
                headers=headers,
            )
        else:
            file_type = "markdown" if extension in REPORT_EXTENSIONS else "text"
            self._send_json(
                {**metadata, "type": file_type, "text": text}, headers=headers
            )

    # ---------- reverse proxy to opencode ----------

    def _proxy(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in HOP_BY_HOP and k.lower() != "host"
        }
        if self.upstream_auth:
            headers["Authorization"] = self.upstream_auth

        try:
            conn = http.client.HTTPConnection(
                self.upstream_host, self.upstream_port, timeout=None)
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
        except OSError:
            self._send_json({"error": "opencode upstream unreachable"}, 502)
            return

        self.send_response(resp.status)
        for key, value in resp.getheaders():
            if key.lower() not in HOP_BY_HOP:
                self.send_header(key, value)
        self.end_headers()

        if resp.status == 101:
            # WebSocket (or other protocol upgrade): relay raw bytes both ways.
            self._relay_upgrade(conn.sock)
            return

        # Stream the response body; connection close marks the end when no
        # Content-Length/Transfer-Encoding was forwarded.
        self.close_connection = True
        try:
            while True:
                # read1() returns as soon as ANY data is available; read(n)
                # would block waiting for the full n bytes, stalling SSE.
                chunk = resp.read1(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            conn.close()

    def _relay_upgrade(self, upstream_sock):
        client = self.connection
        try:
            client.setblocking(False)
            upstream_sock.setblocking(False)
            sockets = [client, upstream_sock]
            while True:
                readable, _, _ = select.select(sockets, [], [], 300)
                if not readable:
                    break
                for sock in readable:
                    data = sock.recv(65536)
                    if not data:
                        return
                    (upstream_sock if sock is client else client).sendall(data)
        except OSError:
            pass
        finally:
            self.close_connection = True

    # ---------- routing ----------

    def _route(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        if path == "/" and "oc" in parsed.query.split("&"):
            # The iframe loads "/?oc": "/" is a real SPA route, the marker
            # tells the proxy this request is meant for opencode.
            self._proxy()
        elif path in ("/", "/index.html"):
            self._serve_static("index.html")
        elif path == "/api/files":
            self._handle_files()
        elif path == "/api/runs":
            self._handle_runs(query)
        elif path == "/api/info":
            self._handle_info()
        elif path == "/api/file":
            self._handle_file(query.get("path", [""])[0], query)
        elif path.startswith("/css/") or path.startswith("/js/"):
            # Workbench static assets (static/css/, static/js/).
            self._serve_static(path.lstrip("/"))
        else:
            # Everything else (/api/session, /_assets/*, SPA routes, ...) -> opencode.
            self._proxy()

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _route

    def log_message(self, fmt, *args):
        pass  # quiet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--opencode-url", default="http://127.0.0.1:4096")
    parser.add_argument("--opencode-password",
                        default=os.environ.get("OPENCODE_SERVER_PASSWORD", "workbench"))
    parser.add_argument("--dir", default="./scrapers",
                        help="directory to scan for result files (default: ./scrapers)")
    args = parser.parse_args()

    upstream = urllib.parse.urlparse(args.opencode_url)
    Handler.root_dir = os.path.abspath(args.dir)
    Handler.upstream_host = upstream.hostname or "127.0.0.1"
    Handler.upstream_port = upstream.port or 4096
    Handler.upstream_auth = "Basic " + base64.b64encode(
        f"opencode:{args.opencode_password}".encode()).decode()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Workbench:  http://127.0.0.1:{args.port}  (opencode proxied at /?oc)")
    print(f"Upstream:   {args.opencode_url}")
    print(f"Watching:   {Handler.root_dir}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

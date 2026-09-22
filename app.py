#!/usr/bin/env python3
"""Split-screen scraping workbench.

Left pane  : opencode serve web UI, reverse-proxied on this same port with
             credentials auto-injected (no login prompt).
Right pane : file viewer for Markdown / CSV files produced by scraping.

Routing on the app port:
  /                 -> workbench UI (static/index.html)
  /css/*, /js/*     -> workbench static assets (static/)
  /?oc              -> opencode UI (SPA route "/", proxied; used by the iframe)
  /api/files        -> workbench file list
  /api/file?path=   -> workbench file content
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
import http.client
import io
import json
import os
import select
import urllib.parse

from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

VIEWABLE_EXTENSIONS = {".md", ".markdown", ".csv", ".txt", ".json", ".tsv"}

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
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # ---------- workbench helpers ----------

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html):
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_files(self):
        entries = []
        for dirpath, _dirnames, filenames in os.walk(self.root_dir):
            rel_dir = os.path.relpath(dirpath, self.root_dir)
            if any(part.startswith(".") for part in rel_dir.split(os.sep) if part != "."):
                continue
            for name in sorted(filenames):
                ext = os.path.splitext(name)[1].lower()
                if ext not in VIEWABLE_EXTENSIONS or name.startswith("."):
                    continue
                full = os.path.join(dirpath, name)
                st = os.stat(full)
                entries.append({
                    "path": os.path.relpath(full, self.root_dir),
                    "size": st.st_size,
                    "mtime": datetime.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                })
        entries.sort(key=lambda e: e["path"])
        self._send_json(entries)

    def _handle_file(self, path):
        if not path or not is_safe_path(self.root_dir, path):
            self._send_json({"error": "invalid path"}, 400)
            return
        full = os.path.join(self.root_dir, path)
        ext = os.path.splitext(path)[1].lower()
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError as e:
            self._send_json({"error": str(e)}, 500)
            return
        if ext in (".csv", ".tsv"):
            dialect = "excel-tab" if ext == ".tsv" else "excel"
            rows = list(csv.reader(io.StringIO(text), dialect=dialect))
            self._send_json({"type": "csv", "headers": rows[0] if rows else [],
                             "rows": rows[1:] if rows else []})
        elif ext in (".md", ".markdown"):
            self._send_json({"type": "markdown", "text": text})
        else:
            self._send_json({"type": "text", "text": text})

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
        if path == "/" and "oc" in parsed.query.split("&"):
            # The iframe loads "/?oc": "/" is a real SPA route, the marker
            # tells the proxy this request is meant for opencode.
            self._proxy()
        elif path in ("/", "/index.html"):
            self._serve_static("index.html")
        elif path == "/api/files":
            self._handle_files()
        elif path == "/api/file":
            qs = urllib.parse.parse_qs(parsed.query)
            self._handle_file(qs.get("path", [""])[0])
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

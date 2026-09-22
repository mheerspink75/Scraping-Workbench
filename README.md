# Scraping Workbench

A split-screen web scraping workbench:

- **Left pane:** the [opencode](https://opencode.ai) web UI (`opencode serve`), reverse-proxied with credentials auto-injected — no login prompt. Use it to direct the AI model to scrape web pages.
- **Right pane:** a live file viewer for the results the model produces — Markdown, CSV, TSV, JSON, and text files are rendered inline (Markdown as HTML, CSV/TSV as tables).

## Requirements

- Python 3.10+ (standard library only, no dependencies)
- `opencode` CLI v2 (on `PATH`)

## Quick start

```bash
./start_workbench.sh
```

Then open <http://127.0.0.1:8080> in your browser.

**First-time setup:** in the opencode pane (left), set the server URL to
**`http://127.0.0.1:8080`** (the proxy port, via the server/project picker in
the opencode UI). The opencode web app otherwise opens its live event stream
(`/api/event`) directly against the stored server URL, bypassing the proxy and
hitting the password prompt / connection errors. No credentials are needed
when connecting through 8080 — the proxy injects them.

The script starts two processes:

1. `opencode serve` on port **4096** (upstream, requires auth)
2. `app.py` on port **8080** (workbench UI + reverse proxy)

### Configuration (environment variables)

| Variable                  | Default     | Description                                   |
|---------------------------|-------------|-----------------------------------------------|
| `APP_PORT`                | `8080`      | Port of the workbench UI                      |
| `OPENCODE_PORT`           | `4096`      | Port of the upstream `opencode serve`         |
| `OPENCODE_SERVER_PASSWORD`| `workbench` | Password set on opencode and injected by proxy |

## How the proxy works

Requests to the app port are routed as follows:

| Path                | Handled by                                       |
|---------------------|--------------------------------------------------|
| `/`                 | Workbench split-screen UI                        |
| `/?oc`              | opencode UI (proxied; used by the iframe)        |
| `/api/files`        | File list (scans the working directory)          |
| `/api/file?path=..` | File content (path-traversal protected)          |
| everything else (`/_assets/*`, `/api/*`, SPA routes, ...) | Reverse-proxied to opencode with `Authorization: Basic opencode:<password>` injected |

The iframe loads `/?oc`: `/` is a real route in the opencode SPA router, and
the `?oc` marker tells the proxy to forward the request upstream. Loading the
SPA at any other synthetic path breaks its client-side router.

The proxy streams response bodies chunk-by-chunk as they arrive (`read1`)
so SSE/live updates (`/api/event`) flow in real time, and it relays `101`
protocol upgrades (WebSockets) in both directions. opencode's absolute asset
(`/_assets/*`) and API (`/api/*`) paths resolve through the proxy automatically.

## Running the pieces manually

```bash
export OPENCODE_SERVER_PASSWORD=workbench
opencode serve --port 4096 --hostname 127.0.0.1 &
python3 app.py --port 8080 --opencode-url http://127.0.0.1:4096 \
               --opencode-password workbench --dir .
```

## File viewer

The right pane recursively scans the working directory (skipping hidden
folders) for `.md`, `.markdown`, `.csv`, `.tsv`, `.json`, and `.txt` files.
Use **Refresh** to rescan manually, or enable **auto** to poll every 3
seconds — new scrape results appear as soon as the model writes them.

## Files

- `app.py` — workbench server (UI + file API + opencode reverse proxy)
- `start_workbench.sh` — launcher that starts both processes with cleanup on exit
- `results/` — sample scraped output (put your scrape results here)

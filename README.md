# Scraping Workbench

A split-screen web scraping workbench:

- **Left pane:** the [opencode](https://opencode.ai) web UI (`opencode serve`), reverse-proxied with credentials auto-injected — no login prompt. Use it to direct the AI model to scrape web pages.
- **Right pane:** a live file viewer for the results the model produces — Markdown, CSV, TSV, JSON, and text files are rendered inline (Markdown as HTML, CSV/TSV as tables).

## Requirements

- Python 3.10+ (the workbench itself is standard library only)
- `opencode` CLI v2 (on `PATH`)
- Scraper dependencies: `pip install -r requirements.txt playwright && playwright install chromium`
  (a `.venv` is included in `.gitignore`; run scripts with `.venv/bin/python`)

## Scrapers

| Folder | Site | Script |
|--------|------|--------|
| `scrapers/az_job_search/` | azjobconnection.gov | `az_job_scraper.py` |
| `scrapers/linkedin_job_search/` | LinkedIn (guest API) | `linkedin_job_scraper.py` |
| `scrapers/indeed_job_search/` | Indeed | `indeed_job_scraper.py` |

All job scrapers support `--mode html` (fast `requests`) or `--mode browser`
(Playwright Chromium — harder for LinkedIn/Indeed bot detection to block;
Indeed mode runs headed so you can solve any Cloudflare challenge manually).
| `scrapers/example/` | template | `scraper.py` — copy to start a new scraper |

Each runs standalone (e.g. `python3 scrapers/indeed_job_search/indeed_job_scraper.py`)
and writes `.md` + `.csv` results into its own `output/` folder, which the
viewer picks up automatically. LinkedIn/Indeed actively rate-limit and block
bots — expect occasional 429/403 responses; the scrapers back off and retry.

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
| `/`                 | Workbench split-screen UI (`static/index.html`)  |
| `/css/*`, `/js/*`   | Workbench static assets (`static/`)              |
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
               --opencode-password workbench --dir ./scrapers
```

## Project structure

```
scrapers/
├── app.py                 workbench server (UI + file API + opencode proxy)
├── start_workbench.sh     launcher
├── static/
│   ├── index.html         split-screen page
│   ├── css/style.css
│   └── js/app.js          viewer logic (file list, markdown/CSV rendering)
└── scrapers/              one folder per website/scraper
    └── example/           ← template: copy this to start a new scraper
        ├── scraper.py     the scraper (writes results into ./output/)
        └── output/        generated results, shown in the viewer (gitignored)
```

### Adding a new scraper

```bash
mkdir -p scrapers/mysite/output
cp scrapers/example/scraper.py scrapers/mysite/scraper.py
# edit scrapers/mysite/scraper.py to target your site; write .md/.csv into ./output/
```

Each `scrapers/<name>/scraper.py` must write its results into its own
`output/` directory as Markdown and/or CSV — everything under `scrapers/`
appears in the workbench viewer automatically.

## File viewer

The right pane recursively scans `scrapers/` (skipping hidden folders) for
`.md`, `.markdown`, `.csv`, `.tsv`, `.json`, and `.txt` files. Use **Refresh**
to rescan manually, or enable **auto** to poll every 3 seconds — new scrape
results appear as soon as a scraper writes them.

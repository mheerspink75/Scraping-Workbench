# Scraping Workbench

A split-screen web scraping workbench:

- **Left pane:** the [opencode](https://opencode.ai) web UI (`opencode serve`), reverse-proxied with credentials auto-injected — no login prompt. Use it to direct the AI model to scrape web pages.
- **Right pane:** a run-oriented results inspector that groups complementary output files, summarizes data quality, and provides searchable CSV/TSV tables, safe Markdown rendering, raw-file access, record details, and an OpenCode context bridge.

## Requirements

- Python 3.10+ (the workbench itself is standard library only)
- `opencode` CLI v2 (on `PATH`)
- Scraper dependencies: `pip install -r requirements.txt playwright && playwright install chromium`
  (a `.venv` is included in `.gitignore`; run scripts with `.venv/bin/python`)
- Optional Copilot Browser Interaction Stack: Node.js 20+ and Playwright Chromium
  (only the `browser-api/` service launches a browser)

## Scrapers

| Folder | Site | Script |
|--------|------|--------|
| `scrapers/az_job_search/` | azjobconnection.gov | `az_job_scraper.py` |
| `scrapers/linkedin_job_search/` | LinkedIn (guest API) | `linkedin_job_scraper.py` |
| `scrapers/indeed_job_search/` | Indeed | `indeed_job_scraper.py` |
| `scrapers/example/` | template | `scraper.py` — copy to start a new scraper |

All job scrapers support `--mode html` (fast `requests`) or `--mode browser`
(Playwright Chromium — harder for LinkedIn/Indeed bot detection to block;
Indeed mode runs headed so you can solve any Cloudflare challenge manually).

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
| `/api/files`        | Legacy flat file list                              |
| `/api/runs`         | Run-oriented output metadata and revisions         |
| `/api/file?path=..` | File content, table pagination, or raw output      |
| `/api/info`         | Local integration metadata                         |
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
│   ├── index.html         split-screen workbench and results inspector
│   ├── css/style.css      responsive, resizable inspector design
│   └── js/app.js          run navigation, summaries, tables, details, OpenCode bridge
├── browser-api/           permission-gated Playwright browser service
├── copilot-bridge/        validated, fixed-route Copilot forwarding service
├── tests/                 workbench and integration tests
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

## Results inspector

The right pane recursively scans `scrapers/` (skipping hidden folders and files)
for `.md`, `.markdown`, `.csv`, `.tsv`, `.json`, and `.txt` output. Files with
the same stem are grouped into one result set—for example, `jobs.csv` and
`jobs.md` become complementary **Results** and **Report** views.

Each result set provides:

- a run overview with row counts, completeness, distributions, and source files;
- paginated CSV/TSV results with full-text search, field filters, and sorting;
- record details in a focused side drawer;
- safely rendered Markdown plus copy/download access to unmodified raw output;
- an editable **Ask OpenCode** bridge that can attach the result file to a new
  or existing OpenCode session;
- revision-aware manual or automatic refresh that only reloads changed output.

Use the divider to resize and collapse either desktop pane. On narrow screens the
workbench switches to **OpenCode** and **Results** tabs. The theme control lets
the inspector match a light or dark OpenCode workspace.

## Optional Copilot Browser Interaction Stack

The repository also contains a separate, local browser interaction stack:

```text
Copilot
  │  POST /copilot/bridge (validated envelope)
  ▼
Copilot Bridge ── fixed 127.0.0.1:BROWSER_API_PORT ──► Browser API
                                                               │
                                                               ▼
                                                isolated Playwright context
```

The two services have deliberately separate responsibilities:

- [`browser-api/`](browser-api/) is the only component allowed to launch Chromium,
  inspect pages, or execute browser operations. It creates an isolated context per
  session, applies URL/network policy, and requires one-time permission tokens for
  mutating operations.
- [`copilot-bridge/`](copilot-bridge/) has no Playwright dependency and never
  opens a browser. It validates the Copilot envelope and payload with strict Zod
  schemas, maps only the ten approved logical endpoints, forwards selected
  headers, and relays the Browser API response.

The Bridge is stateless apart from an in-memory replay guard for permission
tokens. It never generates, approves, extends, changes, or reuses a token. Human
approval remains a separate control: approval/deny requests require an explicit
`x-browser-approval-secret` header, and the Bridge does not automatically attach
that secret for Copilot.

### Start the Browser API

Use Node.js 20+ and install Chromium once:

```bash
cd browser-api
npm install
npx playwright install chromium
npm run build

export BROWSER_API_PORT=8787
export BROWSER_API_SECRET='use-a-long-random-secret'
export BROWSER_APPROVAL_SECRET='use-a-separate-approval-secret'
npm start
```

The API binds to `127.0.0.1` by default. Keep it private; the Bridge is the
supported Copilot-facing entry point. See
[`browser-api/README.md`](browser-api/README.md) for the complete endpoint,
permission, sandbox, and deployment documentation.

### Start the Copilot Bridge

In a second terminal, use the same `BROWSER_API_SECRET` and
`BROWSER_APPROVAL_SECRET` values that were configured for the Browser API:

```bash
cd copilot-bridge
npm install
npm run build

export BROWSER_API_PORT=8787
export BRIDGE_PORT=8790
export BROWSER_API_SECRET='use-a-long-random-secret'
export BROWSER_APPROVAL_SECRET='use-a-separate-approval-secret'
export BRIDGE_API_SECRET='secret-for-copilot-to-call-the-bridge' # optional
npm start
```

The Bridge always uses `http://127.0.0.1:<BROWSER_API_PORT>` as its upstream
origin. Payloads cannot select a host, port, path, HTTP method, or redirect
target. Configure `BRIDGE_API_SECRET` when Copilot is not running on the same
trusted local account; callers then send `x-bridge-api-secret`.

### Copilot request flow

Start a session through the fixed envelope, then pass the returned UUID in
`x-browser-session` for session-scoped calls. For example, after
`browser.session.start` returns a session UUID:

```http
POST /copilot/bridge
Content-Type: application/json
x-bridge-api-secret: secret-for-copilot-to-call-the-bridge
x-browser-session: <session UUID>

{
  "endpoint": "browser.query",
  "payload": {
    "selector": "#results",
    "tabId": 1
  }
}
```

The `x-bridge-api-secret` header is required only when `BRIDGE_API_SECRET` is
configured; the session start request itself does not need a session header.

A mutating `browser.action` or `browser.eval` request needs exactly one
permission-token channel: `x-permission-token` or `payload.permissionToken`.
Every mutating workflow step needs its own token; there is no workflow-wide
bypass. Read-only actions must not carry tokens. Unknown endpoints are rejected
before any network request.

The logical endpoint allowlist and exact upstream routes are documented in
[`copilot-bridge/README.md`](copilot-bridge/README.md). The Bridge does not
import Playwright, evaluate JavaScript, mutate the DOM, navigate pages, or
create approval tokens.

### Health and verification

With both services running:

```bash
curl http://127.0.0.1:8790/copilot/bridge/health
# {"status":"ok","browserApiReachable":true}
```

Run the service checks independently:

```bash
(cd browser-api && npm run lint && npm test)
(cd copilot-bridge && npm run lint && npm test)
```

The Browser API tests include real Chromium integration coverage. In WSL, the
included `run-linux.sh` wrappers select a native Linux Node binary and avoid
Windows UNC-path issues:

```bash
(cd browser-api && ./run-linux.sh test)
(cd copilot-bridge && ./run-linux.sh test)
```

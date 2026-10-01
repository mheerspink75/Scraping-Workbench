# Scraping Workbench

A local, run-oriented workspace for collecting, organizing, and inspecting web-scraping results.

Scraping Workbench recursively discovers output under `scrapers/`, groups related files into result sets, summarizes data quality, and provides searchable tables, rendered reports, raw-file access, and record-level details through a browser interface. The repository also includes job-search scrapers and an optional, separately operated Copilot browser interaction stack.

[View the repository on GitHub](https://github.com/mheerspink75/Scraping-Workbench)

<!-- Add a workbench screenshot here after saving it under docs/images/. -->

## Why Scraping Workbench?

Scrapers commonly finish by writing raw CSV files or text reports that require separate tools to review. Scraping Workbench keeps the output workflow together: each scraper writes into its own `output/` directory, and the local inspector automatically turns supported files into searchable results and readable reports.

The workbench is standalone. It does not launch or proxy OpenCode, the Browser API, or the Copilot Bridge. Run scrapers separately, then use the inspector to review their output.

## Key Features

- Recursively discovers `.md`, `.markdown`, `.csv`, `.tsv`, `.json`, and `.txt` files under `scrapers/`
- Groups files with the same stem into complementary result views
- Summarizes row counts, completeness, distributions, and source files
- Provides paginated CSV and TSV tables with search, field filters, and sorting
- Opens individual records in a focused detail drawer
- Safely renders Markdown while preserving raw-file copy and download access
- Refreshes only output whose revision has changed
- Includes light and dark themes
- Runs as a local, read-only results server bound to `127.0.0.1`
- Includes an optional permission-gated browser automation stack

## How It Works

```text
Independent scrapers
        |
        v
Markdown, CSV, TSV, JSON, or text output
        |
        v
Scraping Workbench
        |
        v
Search, summaries, reports, and record inspection
```

A scraper writes results into `scrapers/<name>/output/`. The workbench scans that tree and exposes the files through its local interface and read-only file API.

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/mheerspink75/Scraping-Workbench.git
cd Scraping-Workbench
```

### 2. Create a virtual environment and install the base scraper dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

The workbench itself uses the Python standard library. `requirements.txt` installs the shared scraper dependencies: Requests and Beautiful Soup.

### 3. Start the inspector

```bash
./start_workbench.sh
```

Open [the local Scraping Workbench](http://127.0.0.1:8080) and press `Ctrl+C` in the terminal to stop it.

The launcher starts only the results inspector. It does not start a scraper, OpenCode, the Browser API, or the Copilot Bridge.

## Included Scrapers

| Folder | Target | Primary script | Browser implementation |
|---|---|---|---|
| `scrapers/az_job_search/` | Arizona Job Connection | `az_job_scraper.py` | Playwright Chromium |
| `scrapers/linkedin_job_search/` | LinkedIn guest job API | `linkedin_job_scraper.py` | Playwright Chromium |
| `scrapers/indeed_job_search/` | Indeed | `indeed_job_scraper.py` | nodriver with Google Chrome |
| `scrapers/example/` | Starter template | `scraper.py` | Not required |

The included job scrapers write Markdown and CSV output into their own `output/` directories. Job sites can change markup, enforce rate limits, or block automated clients, so scraper behavior may require maintenance over time.

### Browser dependencies

Playwright is optional and is used by the Arizona and LinkedIn browser workflows:

```bash
python -m pip install playwright
python -m playwright install chromium
```

Indeed browser mode uses `nodriver` with Google Chrome rather than Playwright:

```bash
python -m pip install nodriver
```

The current Indeed implementation expects Google Chrome at `/usr/bin/google-chrome-stable`.

### Run the Arizona scraper

The default workflow uses Playwright to collect Arizona Job Connection search results:

```bash
python scrapers/az_job_search/az_job_scraper.py
```

After generating `az_jobs.csv`, browser mode can inspect individual job pages and write a filtered CSV:

```bash
python scrapers/az_job_search/az_job_scraper.py --mode browser
```

### Run the LinkedIn scraper

```bash
python scrapers/linkedin_job_search/linkedin_job_scraper.py
```

Useful options include:

```bash
python scrapers/linkedin_job_search/linkedin_job_scraper.py \
  --remote \
  --time-filter 30d \
  --max-pages 5
```

Use Playwright browser mode when needed:

```bash
python scrapers/linkedin_job_search/linkedin_job_scraper.py --mode browser
```

LinkedIn rate-limits its guest endpoints aggressively. Keep crawls small and expect occasional HTTP 429 responses.

### Run the Indeed scraper

Fast HTTP mode is the default:

```bash
python scrapers/indeed_job_search/indeed_job_scraper.py
```

Use visible Chrome browser mode when Cloudflare blocks HTTP requests:

```bash
python scrapers/indeed_job_search/indeed_job_scraper.py --mode browser
```

If a human-verification challenge appears, complete it in the browser window. Headless mode cannot complete an interactive challenge.

## Results Inspector

Files with the same stem are grouped into one result set. For example, `jobs.csv` and `jobs.md` become complementary **Results** and **Report** views.

Each result set can provide:

- a run overview with row counts and completeness information;
- value distributions and source-file metadata;
- paginated CSV or TSV records;
- full-text search, per-field filtering, and sorting;
- record details in a side drawer;
- rendered Markdown reports;
- raw output for copying or downloading;
- manual or automatic revision-aware refresh.

## Configuration

The launcher and `app.py` support these environment variables:

| Variable | Default | Description |
|---|---:|---|
| `APP_PORT` | `8080` | Port used by the Workbench UI |
| `SCRAPERS_DIR` | `./scrapers` | Directory scanned for result files |

Run the server manually with equivalent command-line options:

```bash
python3 app.py --port 8080 --dir ./scrapers
```

The server binds to `127.0.0.1` and makes no outbound network requests.

## Routes

| Path | Purpose |
|---|---|
| `/` | Workbench interface from `static/index.html` |
| `/css/*` and `/js/*` | Static application assets |
| `/api/files` | Legacy flat file listing |
| `/api/runs` | Run-oriented output metadata and revisions |
| `/api/file?path=...` | File content, table pagination, or raw output |
| Any other path | Returns `404` |

## Technology Stack

### Workbench

- Python 3.10+
- Python standard-library HTTP server
- HTML, CSS, and JavaScript

### Scrapers

- Requests
- Beautiful Soup
- Playwright Chromium for the Arizona and LinkedIn browser workflows
- nodriver and Google Chrome for Indeed browser mode

### Browser API

- Node.js 20+
- TypeScript
- Express
- Playwright
- Zod
- QuickJS through `quickjs-emscripten`

### Copilot Bridge

- Node.js 20+
- TypeScript
- Express
- Zod

### Testing

- Python `unittest`
- TypeScript compilation and service-specific test runners
- Real Chromium integration coverage in the Browser API test suite

## Project Structure

```text
.
├── app.py                     Workbench server and read-only file API
├── start_workbench.sh         Inspector launcher
├── requirements.txt           Shared Python scraper dependencies
├── static/
│   ├── index.html             Results inspector interface
│   ├── css/style.css          Responsive styling and themes
│   └── js/app.js              Run navigation, tables, and record details
├── tests/
│   └── test_app.py            Workbench unit tests
├── scrapers/
│   ├── az_job_search/         Arizona Job Connection scraper
│   ├── linkedin_job_search/   LinkedIn guest API scraper
│   ├── indeed_job_search/     Indeed scraper
│   └── example/               Starter scraper template
├── browser-api/               Permission-gated Playwright browser service
└── copilot-bridge/            Validated, fixed-route forwarding service
```

## Add a New Scraper

Copy the example scraper and give it a dedicated output directory:

```bash
mkdir -p scrapers/mysite/output
cp scrapers/example/scraper.py scrapers/mysite/scraper.py
```

Update `scrapers/mysite/scraper.py` to target the desired source and write supported files into `scrapers/mysite/output/`.

A minimal layout looks like this:

```text
scrapers/mysite/
├── scraper.py
└── output/
    ├── results.csv
    └── results.md
```

Because the two output files share the `results` stem, the inspector groups them into one result set.

## Optional Copilot Browser Interaction Stack

The repository contains two separate local services for controlled browser interaction. They are independent of the results inspector and do not depend on an OpenCode URL, port, or password.

```text
Copilot
  |
  | POST /copilot/bridge
  v
Copilot Bridge
  |
  | fixed http://127.0.0.1:<BROWSER_API_PORT>
  v
Browser API
  |
  v
Isolated Playwright browser context
```

- `browser-api/` is the only component that launches Chromium, inspects pages, or performs browser operations.
- `copilot-bridge/` validates request envelopes, maps approved logical endpoints to fixed upstream routes, forwards selected headers, and relays responses.
- Mutating browser operations require one-time permission tokens.
- The Bridge does not launch a browser, evaluate JavaScript, mutate the DOM, navigate pages, or create approval tokens.

### Start the Browser API

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

The Browser API binds to `127.0.0.1:8787` by default. When `BROWSER_API_SECRET` and `BROWSER_APPROVAL_SECRET` are empty, no API secret is required and approval endpoints return `503 APPROVAL_DISABLED`.

See the [Browser API documentation](browser-api/README.md) for endpoint, permission, sandbox, and deployment details.

### Start the Copilot Bridge

In a second terminal:

```bash
cd copilot-bridge
npm install
npm run build

export BROWSER_API_PORT=8787
export BRIDGE_PORT=8790
export BROWSER_API_SECRET='use-a-long-random-secret'
export BROWSER_APPROVAL_SECRET='use-a-separate-approval-secret'
export BRIDGE_API_SECRET='secret-for-copilot-to-call-the-bridge'

npm start
```

The Bridge binds to `127.0.0.1:8790` by default and forwards only to `http://127.0.0.1:<BROWSER_API_PORT>`. Request payloads cannot select an arbitrary host, port, route, HTTP method, or redirect target.

`BRIDGE_API_SECRET` is optional and empty by default. Configure it when callers outside the same trusted local account can reach the Bridge.

See the [Copilot Bridge documentation](copilot-bridge/README.md) for the logical endpoint allowlist and route mappings.

### Request flow

Start a session through the fixed envelope, then include the returned session UUID in `x-browser-session` for session-scoped requests:

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

The `x-bridge-api-secret` header is required only when `BRIDGE_API_SECRET` is configured. A session-start request does not need a session header.

A mutating `browser.action` or `browser.eval` request must supply exactly one permission-token channel: `x-permission-token` or `payload.permissionToken`. Read-only requests must not include a permission token.

### Health check

With both services running:

```bash
curl http://127.0.0.1:8790/copilot/bridge/health
```

Expected response:

```json
{"status":"ok","browserApiReachable":true}
```

## Security Design

- The Workbench server is read-only and serves only its interface, assets, and file API.
- The Workbench and optional browser services bind to local loopback addresses by default.
- The Browser API owns browser execution and creates isolated browser contexts.
- The Copilot Bridge has no Playwright dependency and cannot launch Chromium.
- Bridge payloads cannot choose arbitrary upstream network destinations.
- Unknown logical endpoints are rejected before an upstream request.
- Mutating browser operations require individual one-time permission tokens.
- Approval and denial requests require the separate browser approval secret when approvals are enabled.

Keep the Browser API and Copilot Bridge private unless you have added appropriate host-level access controls and configured non-empty secrets.

## Testing

### Workbench

```bash
python3 -m unittest discover -s tests
```

### Browser API

```bash
cd browser-api
npm run lint
npm test
```

The Browser API also exposes separate commands:

```bash
npm run test:unit
npm run test:integration
```

### Copilot Bridge

```bash
cd copilot-bridge
npm run lint
npm test
```

The Bridge also exposes separate commands:

```bash
npm run test:unit
npm run test:integration
```

### WSL wrappers

The included wrappers select a native Linux Node binary from `PATH` or `~/.vscode-server/bin` and avoid Windows UNC-path issues:

```bash
(cd browser-api && ./run-linux.sh lint && ./run-linux.sh test)
(cd copilot-bridge && ./run-linux.sh lint && ./run-linux.sh test)
```

## Roadmap

Potential future improvements include:

- Additional scraper plugins
- Scheduled scraper runs
- Historical run comparison
- Optional persistent storage
- Export workflows
- Additional result analytics and visualizations

Roadmap items are ideas, not committed features.

## Responsible Use

Use the scrapers only where permitted. Review each website's terms, robots guidance, access controls, and applicable laws before collecting data. Keep request volume conservative, respect rate limits, and do not use this project to bypass authentication or authorization.

## License

This project is available under the [MIT License](LICENSE).

## Author

**Matt Heerspink**

[GitHub Profile](https://github.com/mheerspink75)
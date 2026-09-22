#!/usr/bin/env bash
# Run the Indeed job scraper.
# Defaults: fully remote software jobs, 3 pages, browser mode (Indeed blocks
# plain requests with Cloudflare). A real browser window opens — solve the
# Cloudflare challenge if one appears.
# For headless (may be blocked): ./run.sh --headless
# Edit flags or override via: ./run.sh --keywords "Backend Engineer"
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
PY="${ROOT}/.venv/bin/python"

# Fall back to system python if the venv doesn't exist
[ -x "$PY" ] || PY="python3"

# Browser mode is the default: Indeed blocks plain HTTP (403/Cloudflare).
exec "$PY" indeed_job_scraper.py --remote --mode browser --max-pages 3 "$@"

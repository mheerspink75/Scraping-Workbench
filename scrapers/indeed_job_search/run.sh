#!/usr/bin/env bash
# Run the Indeed job scraper.
# Defaults: fully remote software jobs, 3 pages, browser mode (Indeed blocks
# plain requests with Cloudflare). A real browser window opens — solve the
# Cloudflare challenge if one appears.
# For headless (default in this environment): ./run.sh
# For headed mode (requires X server): ./run.sh --headed
# Edit flags or override via: ./run.sh --keywords "Backend Engineer"
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
PY="${ROOT}/.venv/bin/python"

# Fall back to system python if the venv doesn't exist
[ -x "$PY" ] || PY="python3"

# Determine headless mode: default to headless, override with --headed
HEADLESS_FLAG="--headless"
REMAINING_ARGS=()
for arg in "$@"; do
    if [ "$arg" = "--headed" ]; then
        HEADLESS_FLAG=""
    else
        REMAINING_ARGS+=("$arg")
    fi
done

# Browser mode is the default: Indeed blocks plain HTTP (403/Cloudflare).
exec "$PY" indeed_job_scraper.py --remote --mode browser --max-pages 3 $HEADLESS_FLAG "${REMAINING_ARGS[@]}"

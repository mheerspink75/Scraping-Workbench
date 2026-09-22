#!/usr/bin/env bash
# Run the LinkedIn job scraper.
# Defaults: fully remote software jobs, 3 pages, fast HTML mode.
# Edit flags or override via: ./run.sh --keywords "Backend Engineer" --max-pages 5
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
PY="${ROOT}/.venv/bin/python"

# Fall back to system python if the venv doesn't exist
[ -x "$PY" ] || PY="python3"

# Default remote entry-level-friendly search; extra CLI args override/extend.
exec "$PY" linkedin_job_scraper.py --remote --max-pages 3 "$@"

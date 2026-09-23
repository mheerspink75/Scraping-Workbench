#!/usr/bin/env bash
# Run the LinkedIn job scraper.
# Defaults: junior/entry-level jobs near Scottsdale, AZ merged with fully
# remote jobs nationwide, 3 pages per search, fast HTML mode.
# Edit flags or override via: ./run.sh --keywords "Backend Engineer" --max-pages 5
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
PY="${ROOT}/.venv/bin/python"

# Fall back to system python if the venv doesn't exist
[ -x "$PY" ] || PY="python3"

# Default: Scottsdale, AZ + fully remote, merged; extra CLI args override/extend.
exec "$PY" linkedin_job_scraper.py --max-pages 3 "$@"

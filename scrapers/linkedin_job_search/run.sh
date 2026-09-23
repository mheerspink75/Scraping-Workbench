#!/usr/bin/env bash
# Run the LinkedIn job scraper.
# Defaults: junior/entry/associate-level jobs near Scottsdale, AZ merged with
# fully remote jobs nationwide (3 search strategies), last 30 days, 6 pages per
# search, fast HTML mode.
#
# Examples:
#   ./run.sh                                        # default (local + remote, 30d, 6 pages)
#   ./run.sh --remote                               # remote only
#   ./run.sh --time-filter 7d                       # last 7 days only
#   ./run.sh --keywords "Backend Engineer"          # different keywords
#   ./run.sh --max-pages 10                         # fetch even more pages
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
PY="${ROOT}/.venv/bin/python"

# Fall back to system python if the venv doesn't exist
[ -x "$PY" ] || PY="python3"

# Default: Scottsdale, AZ + fully remote (multi-strategy, 30 days window, 6 pages); extra CLI args override/extend.
exec "$PY" linkedin_job_scraper.py --max-pages 6 --time-filter 30d "$@"

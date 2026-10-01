#!/usr/bin/env bash
# Start the scraping workbench results inspector on port 8080.
# Scans ./scrapers for output files and serves the read-only web UI.
set -euo pipefail
cd "$(dirname "$0")"

APP_PORT="${APP_PORT:-8080}"
SCRAPERS_DIR="${SCRAPERS_DIR:-./scrapers}"

cleanup() {
  echo "Shutting down..."
  kill "${APP_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting workbench app on port ${APP_PORT}..."
python3 app.py --port "${APP_PORT}" --dir "${SCRAPERS_DIR}" &
APP_PID=$!

echo
echo "Open http://127.0.0.1:${APP_PORT} in your browser."
wait
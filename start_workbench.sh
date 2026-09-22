#!/usr/bin/env bash
# Start the scraping workbench:
#   - opencode serve on port 4096 (upstream, behind the proxy)
#   - viewer app on port 8080 (split-screen UI; proxies opencode at /oc
#     with credentials auto-injected, so no login prompt)
set -euo pipefail
cd "$(dirname "$0")"

OPENCODE_PORT="${OPENCODE_PORT:-4096}"
APP_PORT="${APP_PORT:-8080}"
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-workbench}"

cleanup() {
  echo "Shutting down..."
  kill "${OC_PID:-}" "${APP_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting opencode serve on port ${OPENCODE_PORT}..."
opencode serve --port "${OPENCODE_PORT}" --hostname 127.0.0.1 &
OC_PID=$!

echo "Starting workbench app on port ${APP_PORT}..."
python3 app.py \
  --port "${APP_PORT}" \
  --opencode-url "http://127.0.0.1:${OPENCODE_PORT}" \
  --opencode-password "${OPENCODE_SERVER_PASSWORD}" \
  --dir . &
APP_PID=$!

echo
echo "Open http://127.0.0.1:${APP_PORT} in your browser."
wait

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v node >/dev/null 2>&1 && node -p "process.platform === 'linux'" >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  NODE_BIN="$(find /home/mico/.vscode-server/bin -maxdepth 2 -type f -name node -perm -111 2>/dev/null | sort -V | tail -n 1 || true)"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Could not find a native Linux Node binary. Install Node.js in WSL or run this from a native Linux shell." >&2
  exit 1
fi

exec "$NODE_BIN" "$ROOT/scripts/run.cjs" "${1:-build}"

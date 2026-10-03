#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${BRIDGE_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SERVICE_NAME="overleaf-mcp-rt-bridge"

if [[ "$EUID" -ne 0 ]]; then
  exec sudo -E "$0" "$@"
fi

RUN_USER="$(stat -c '%U' "$REPO_DIR")"
if [[ "$RUN_USER" == "root" ]]; then
  echo "error: repository should be owned by the non-root service account" >&2
  exit 1
fi

cd "$REPO_DIR"
git pull --ff-only
sudo -u "$RUN_USER" -H npm install --omit=dev --no-audit --no-fund
sudo -u "$RUN_USER" -H npm run check
systemctl restart "$SERVICE_NAME.service"
systemctl status "$SERVICE_NAME.service" --no-pager

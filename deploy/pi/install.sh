#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="overleaf-mcp-rt-bridge"
RUN_USER="${BRIDGE_USER:-${SUDO_USER:-}}"
BIND_ADDRESS="${BRIDGE_BIND_ADDRESS:-127.0.0.1}"
PORT="${BRIDGE_PORT:-8787}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_ROOT="${BRIDGE_APP_ROOT:-/var/lib/overleaf-mcp-rt-bridge}"
SECRETS_DIR="$APP_ROOT/secrets"
TARGET_CREDENTIALS="$SECRETS_DIR/credentials.json"
ENV_FILE="$SECRETS_DIR/bridge.env"
UNIT_TEMPLATE="$REPO_DIR/deploy/pi/overleaf-mcp-rt-bridge.service.template"
UNIT_TARGET="/etc/systemd/system/overleaf-mcp-rt-bridge.service"

if [[ "$EUID" -ne 0 ]]; then
  exec sudo -E "$0" "$@"
fi

if [[ -z "$RUN_USER" || "$RUN_USER" == "root" ]]; then
  echo "error: set BRIDGE_USER to a non-root service account" >&2
  exit 1
fi

USER_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
if [[ -z "$USER_HOME" ]]; then
  echo "error: user $RUN_USER does not exist" >&2
  exit 1
fi

SOURCE_CREDENTIALS="$USER_HOME/.config/overleaf-mcp-rt/credentials.json"

echo "== storage preflight =="
mkdir -p "$APP_ROOT"
df -hT "$APP_ROOT"

mkdir -p "$SECRETS_DIR"
chown "$RUN_USER:$RUN_USER" "$APP_ROOT" "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

echo "== migrate Overleaf credentials =="
if [[ -L "$SOURCE_CREDENTIALS" ]]; then
  resolved="$(readlink -f "$SOURCE_CREDENTIALS")"
  if [[ "$resolved" != "$TARGET_CREDENTIALS" ]]; then
    echo "error: existing credentials symlink points to $resolved" >&2
    exit 1
  fi
elif [[ -f "$SOURCE_CREDENTIALS" ]]; then
  if [[ ! -f "$TARGET_CREDENTIALS" ]]; then
    install -o "$RUN_USER" -g "$RUN_USER" -m 600 \
      "$SOURCE_CREDENTIALS" "$TARGET_CREDENTIALS"
    cmp -s "$SOURCE_CREDENTIALS" "$TARGET_CREDENTIALS"
  fi
  rm -f "$SOURCE_CREDENTIALS"
  ln -s "$TARGET_CREDENTIALS" "$SOURCE_CREDENTIALS"
else
  if [[ ! -f "$TARGET_CREDENTIALS" ]]; then
    echo "error: no authenticated overleaf-mcp-rt credentials found" >&2
    echo "expected: $SOURCE_CREDENTIALS" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$SOURCE_CREDENTIALS")"
  chown "$RUN_USER:$RUN_USER" "$(dirname "$SOURCE_CREDENTIALS")"
  ln -s "$TARGET_CREDENTIALS" "$SOURCE_CREDENTIALS"
fi
chown "$RUN_USER:$RUN_USER" "$TARGET_CREDENTIALS"
chmod 600 "$TARGET_CREDENTIALS"

echo "== install Node dependencies =="
chown -R "$RUN_USER:$RUN_USER" "$REPO_DIR"
sudo -u "$RUN_USER" -H bash -lc \
  "cd '$REPO_DIR' && npm install --omit=dev --no-audit --no-fund"

echo "== verify authenticated upstream =="
sudo -u "$RUN_USER" -H env \
  OVERLEAF_CREDENTIALS_FILE="$TARGET_CREDENTIALS" \
  "$REPO_DIR/node_modules/.bin/overleaf-mcp-rt" diagnose

if [[ ! -f "$ENV_FILE" ]]; then
  token="$(openssl rand -hex 32)"
  cat >"$ENV_FILE" <<EOF
BRIDGE_HOST=$BIND_ADDRESS
BRIDGE_PORT=$PORT
BRIDGE_MAX_JSON_BODY=32mb
MCP_BEARER_TOKEN=$token
OVERLEAF_CREDENTIALS_FILE=$TARGET_CREDENTIALS
UPSTREAM_MCP_COMMAND=$REPO_DIR/node_modules/.bin/overleaf-mcp-rt
OVERLEAF_HISTORY_OT_WRITES=0
EOF
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
else
  echo "preserving existing $ENV_FILE"
fi

systemctl stop "$SERVICE_NAME.service" 2>/dev/null || true

if ss -ltnH | awk '{print $4}' | grep -Eq "(^|:)$PORT$"; then
  echo "error: TCP port $PORT is already in use; choose another BRIDGE_PORT" >&2
  exit 1
fi

escaped_user="$(printf '%s' "$RUN_USER" | sed 's/[&|]/\\&/g')"
escaped_root="$(printf '%s' "$APP_ROOT" | sed 's/[&|]/\\&/g')"
escaped_repo="$(printf '%s' "$REPO_DIR" | sed 's/[&|]/\\&/g')"

sed \
  -e "s|@@RUN_USER@@|$escaped_user|g" \
  -e "s|@@APP_ROOT@@|$escaped_root|g" \
  -e "s|@@REPO_DIR@@|$escaped_repo|g" \
  "$UNIT_TEMPLATE" >"$UNIT_TARGET"
chmod 644 "$UNIT_TARGET"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.service"

echo "== wait for readiness =="
ready=0
for _ in {1..20}; do
  if curl -fsS "http://$BIND_ADDRESS:$PORT/health" >/tmp/overleaf-mcp-rt-bridge-health.json 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.5
done

if [[ "$ready" -ne 1 ]]; then
  echo "error: bridge did not become healthy in time" >&2
  systemctl status "$SERVICE_NAME.service" --no-pager >&2 || true
  journalctl -u "$SERVICE_NAME.service" -n 50 --no-pager >&2 || true
  exit 1
fi

echo "== service =="
systemctl status "$SERVICE_NAME.service" --no-pager
echo
cat /tmp/overleaf-mcp-rt-bridge-health.json
rm -f /tmp/overleaf-mcp-rt-bridge-health.json
echo
echo
echo "Installed MCP endpoint:"
echo "  http://$BIND_ADDRESS:$PORT/mcp"
echo
echo "Bearer token is stored only in:"
echo "  $ENV_FILE"

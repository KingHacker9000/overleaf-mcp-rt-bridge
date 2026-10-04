#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="overleaf-mcp-oauth"
RUN_USER="${OAUTH_USER:-overleaf-oauth}"
RUN_GROUP="${OAUTH_GROUP:-$RUN_USER}"
INSTALL_DIR="${OAUTH_INSTALL_DIR:-/usr/local/lib/overleaf-mcp-oauth}"
CONFIG_DIR="${OAUTH_CONFIG_DIR:-/etc/overleaf-mcp-oauth}"
OAUTH_HOST="${OAUTH_HOST:-127.0.0.1}"
OAUTH_PORT="${OAUTH_PORT:-9456}"
OAUTH_SCOPE="${OAUTH_SCOPE:-overleaf:owner}"
OAUTH_REDIRECT_HOSTS="${OAUTH_REDIRECT_HOSTS:-chatgpt.com}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
UPSTREAM_MCP_URL="${UPSTREAM_MCP_URL:-}"
UPSTREAM_BEARER_TOKEN_FILE="${UPSTREAM_BEARER_TOKEN_FILE:-$CONFIG_DIR/upstream-token}"
OWNER_PASSWORD_HASH_FILE="${OWNER_PASSWORD_HASH_FILE:-$CONFIG_DIR/owner-password-hash}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_TEMPLATE="$REPO_DIR/deploy/oauth/overleaf-mcp-oauth.service.template"
UNIT_TARGET="/etc/systemd/system/$SERVICE_NAME.service"
ENV_FILE="$CONFIG_DIR/oauth.env"

if [[ "$EUID" -ne 0 ]]; then
  exec sudo -E "$0" "$@"
fi

if [[ -z "$PUBLIC_BASE_URL" || -z "$UPSTREAM_MCP_URL" ]]; then
  echo "error: PUBLIC_BASE_URL and UPSTREAM_MCP_URL are required" >&2
  exit 1
fi

if [[ ! -s "$UPSTREAM_BEARER_TOKEN_FILE" ]]; then
  echo "error: missing upstream bearer token file: $UPSTREAM_BEARER_TOKEN_FILE" >&2
  exit 1
fi

if [[ ! -s "$OWNER_PASSWORD_HASH_FILE" ]]; then
  echo "error: missing owner password hash file: $OWNER_PASSWORD_HASH_FILE" >&2
  exit 1
fi

if ! getent group "$RUN_GROUP" >/dev/null 2>&1; then
  groupadd --system "$RUN_GROUP"
fi

if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$RUN_GROUP" "$RUN_USER"
fi

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
install -o root -g root -m 755 "$REPO_DIR/deploy/oauth/oauth-proxy.mjs" "$INSTALL_DIR/oauth-proxy.mjs"
chown root:"$RUN_GROUP" "$UPSTREAM_BEARER_TOKEN_FILE" "$OWNER_PASSWORD_HASH_FILE"
chmod 640 "$UPSTREAM_BEARER_TOKEN_FILE" "$OWNER_PASSWORD_HASH_FILE"

cat >"$ENV_FILE" <<EOF
OAUTH_HOST=$OAUTH_HOST
OAUTH_PORT=$OAUTH_PORT
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
MCP_RESOURCE_URL=${PUBLIC_BASE_URL%/}/mcp
UPSTREAM_MCP_URL=$UPSTREAM_MCP_URL
UPSTREAM_BEARER_TOKEN_FILE=$UPSTREAM_BEARER_TOKEN_FILE
OWNER_PASSWORD_HASH_FILE=$OWNER_PASSWORD_HASH_FILE
OAUTH_SCOPE=$OAUTH_SCOPE
OAUTH_REDIRECT_HOSTS=$OAUTH_REDIRECT_HOSTS
EOF
chown root:"$RUN_GROUP" "$ENV_FILE"
chmod 640 "$ENV_FILE"

escaped_user="$(printf '%s' "$RUN_USER" | sed 's/[&|]/\\&/g')"
escaped_group="$(printf '%s' "$RUN_GROUP" | sed 's/[&|]/\\&/g')"
escaped_install="$(printf '%s' "$INSTALL_DIR" | sed 's/[&|]/\\&/g')"
escaped_config="$(printf '%s' "$CONFIG_DIR" | sed 's/[&|]/\\&/g')"

sed \
  -e "s|@@RUN_USER@@|$escaped_user|g" \
  -e "s|@@RUN_GROUP@@|$escaped_group|g" \
  -e "s|@@INSTALL_DIR@@|$escaped_install|g" \
  -e "s|@@CONFIG_DIR@@|$escaped_config|g" \
  "$UNIT_TEMPLATE" >"$UNIT_TARGET"
chmod 644 "$UNIT_TARGET"

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.service"

ready=0
for _ in {1..20}; do
  if curl -fsS "http://$OAUTH_HOST:$OAUTH_PORT/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done

if [[ "$ready" -ne 1 ]]; then
  echo "error: OAuth proxy did not become healthy" >&2
  systemctl status "$SERVICE_NAME.service" --no-pager >&2 || true
  journalctl -u "$SERVICE_NAME.service" -n 50 --no-pager >&2 || true
  exit 1
fi

systemctl status "$SERVICE_NAME.service" --no-pager
echo
curl -fsS "http://$OAUTH_HOST:$OAUTH_PORT/health"
echo
echo
echo "OAuth proxy installed for: ${PUBLIC_BASE_URL%/}/mcp"

# overleaf-mcp-rt-bridge

An authenticated Streamable HTTP MCP bridge for
[overleaf-mcp-rt](https://github.com/DanielHou315/overleaf-mcp-rt).

It keeps Overleaf's real-time OT implementation upstream and adds the transport
needed by remote MCP clients such as ChatGPT:

- Streamable HTTP at `/mcp`
- bearer-token authentication
- persistent MCP sessions
- passthrough of upstream tool schemas and results
- read/write/destructive MCP annotations
- optional allow/deny tool policy
- a minimal health endpoint
- example systemd and Caddy deployment templates

The bridge does **not** contain an Overleaf password or session cookie. The
upstream `overleaf-mcp-rt` credentials stay on the machine running the bridge.

## Architecture

```text
ChatGPT / Codex / Claude
          |
          | HTTPS + bearer token
          v
   public reverse proxy
          |
          | private network / VPN
          v
  overleaf-mcp-rt-bridge
          |
          | stdio MCP
          v
    overleaf-mcp-rt
          |
          | HTTPS + Socket.IO / OT
          v
      overleaf.com
```

## Requirements

- Node.js 20+
- an authenticated `overleaf-mcp-rt` credentials file
- a private or otherwise protected path between the public reverse proxy and
  the bridge host, if the bridge is exposed remotely

Verify the upstream first:

```bash
npx overleaf-mcp-rt diagnose
```

## Install

Clone the repository wherever you keep service data. For an external disk, a
generic example is:

```bash
export BRIDGE_APP_ROOT=/mnt/external/overleaf-mcp-rt-bridge
mkdir -p "$BRIDGE_APP_ROOT"
git clone https://github.com/KingHacker9000/overleaf-mcp-rt-bridge.git \
  "$BRIDGE_APP_ROOT/repo"

cd "$BRIDGE_APP_ROOT/repo"
sudo -E ./deploy/pi/install.sh
```

Useful install-time variables:

```text
BRIDGE_APP_ROOT       persistent application root
BRIDGE_USER           service account; defaults to SUDO_USER
BRIDGE_BIND_ADDRESS   private address to listen on
BRIDGE_PORT           bridge port; default 8787
```

The installer migrates the existing `overleaf-mcp-rt` credentials into the
application root, generates a random MCP bearer token, installs dependencies,
validates the upstream session, and installs a systemd unit rendered from the
generic template.

## Configuration

Example environment:

```bash
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8787
MCP_BEARER_TOKEN=replace-with-a-long-random-token
OVERLEAF_CREDENTIALS_FILE=/var/lib/overleaf-mcp-rt-bridge/secrets/credentials.json
UPSTREAM_MCP_COMMAND=/var/lib/overleaf-mcp-rt-bridge/repo/node_modules/.bin/overleaf-mcp-rt
```

Do not commit real bearer tokens or Overleaf credentials.

## Endpoints

Private bridge examples:

```text
http://127.0.0.1:8787/mcp
http://127.0.0.1:8787/health
```

For remote use, expose `/mcp` through HTTPS and keep the bridge port off the
public Internet.

## Caddy

A generic reverse-proxy example is included at
`deploy/caddy/Caddyfile.example`.

Replace the example hostname and private upstream address for your environment,
then validate and reload Caddy normally.

## Authentication

Every private bridge `/mcp` request requires:

```text
Authorization: Bearer <token>
```

The `/health` endpoint is intentionally unauthenticated and reports only basic
bridge/upstream readiness.

The Overleaf session cookie is never returned by the bridge.

### ChatGPT OAuth facade

For ChatGPT custom apps, keep the private bearer-authenticated bridge unchanged
and place the optional OAuth facade from `deploy/oauth/` at the public HTTPS
edge. It implements OAuth authorization-code + PKCE S256, protected-resource
metadata, authorization-server metadata, dynamic client registration, and
translation of OAuth access tokens to the private bridge bearer.

The public resource remains:

```text
https://mcp.example.com/mcp
```

OAuth endpoints are:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/oauth/register
/oauth/authorize
/oauth/token
```

The OAuth facade intentionally keeps registered clients, authorization codes,
and access tokens in memory. Restarting it requires reconnecting/re-authorizing
the client. The upstream MCP bearer and owner password hash stay in root-owned
files and are never returned to the client.

A matching Caddy example is included at
`deploy/caddy/Caddyfile.oauth.example`.

## Tool policy

By default the bridge exposes all tools reported by `overleaf-mcp-rt`.

To restrict the surface:

```text
BRIDGE_ALLOWED_TOOLS=overleaf_list_projects,overleaf_get_project_tree,overleaf_read_doc,overleaf_edit_doc,overleaf_compile,overleaf_read_compile_log
```

or:

```text
BRIDGE_DENIED_TOOLS=overleaf_delete_entity
```

## Safety behavior

The bridge does not automatically retry failed tool calls. A write can succeed
upstream even when its response is interrupted, so automatic retries could
duplicate a mutation.

For ordinary editing, prefer `overleaf_edit_doc` exact-string edits over
whole-document replacement.

## Operations

```bash
systemctl status overleaf-mcp-rt-bridge --no-pager
journalctl -u overleaf-mcp-rt-bridge -n 100 --no-pager
```

## Development

```bash
npm install
npm run check
MCP_BEARER_TOKEN=dev-token npm start
```

## Upstream compatibility

The repository currently pins `overleaf-mcp-rt` 2.2.0 and
`@modelcontextprotocol/sdk` 1.29.0.

## License

AGPL-3.0-or-later.

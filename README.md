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

The OAuth facade persists dynamically registered clients, access tokens, and
refresh tokens in a service-owned state file. Short-lived authorization requests
and authorization codes remain memory-only. Static public OAuth clients can be
declared in a root-owned JSON file, which is useful for clients that ask for a
pre-issued Client ID instead of using dynamic client registration.

Default persistent paths:

```text
/etc/overleaf-mcp-oauth/static-clients.json
/var/lib/overleaf-mcp-oauth/state.json
```

Static client file format:

```json
{
  "example-public-client": {
    "redirectUris": [
      "https://client.example.com/oauth/callback"
    ]
  }
}
```

The facade supports authorization-code + PKCE S256 and refresh-token grants.
The upstream MCP bearer and owner password hash stay in root-owned files and
are never returned to clients.

A matching Caddy example is included at
`deploy/caddy/Caddyfile.oauth.example`.

## Two Overleaf accounts (one overleaf.com server)

The upstream `overleaf-mcp-rt` 2.2.0 already supports **named credentials
profiles**. Both profiles can point to `https://www.overleaf.com` while
using completely separate session cookies. You do not need a second running
bridge or a second ChatGPT connector.

Log in to the second account **using the same credentials file that your
bridge reads**. On the Pi, the installer normally symlinks this from
`~/.config/overleaf-mcp-rt/credentials.json` to its protected secrets dir:

```bash
export OVERLEAF_CREDENTIALS_FILE="$(readlink -f ~/.config/overleaf-mcp-rt/credentials.json)"
./node_modules/.bin/overleaf-mcp-rt login --url https://www.overleaf.com --name brother
./node_modules/.bin/overleaf-mcp-rt hosts
./node_modules/.bin/overleaf-mcp-rt diagnose --host brother
./node_modules/.bin/overleaf-mcp-rt ls --host brother
```

Run this from the bridge repository as its service user. Browser login can
be used when there is a browser available; on a headless Pi choose the
cookie-paste login mode and have the second account owner supply their own
session cookie **only in the local trusted terminal**. Never put cookies in
issues, logs, chat, or a shared Git repository. Adding a profile preserves the
first profile, which remains the default. The upstream credentials file is
re-read on each call, so a restart is normally not required.

### Explicit account routing

`BRIDGE_HOST_SELECTION=auto` (default) makes the bridge require the `host`
argument for **every account-specific tool** as soon as two or more credential
profiles exist. `overleaf_list_hosts` remains callable without `host`.

For instance, `overleaf_list_projects({ "host": "brother" })` lists only
projects visible to the brother profile, and
`overleaf_edit_doc({ "host": "overleaf.com", ... })` edits through the
original profile. Account names refer to **login profiles**, not distinct
hostname URLs. Missing or unknown profiles cause an error before forwarding
the operation to Overleaf. The bridge updates tool schemas to mark `host`
as required whenever the policy is active. The policy reads the credentials
file on every tool call, so it also protects previously initialized clients.

Optional `BRIDGE_HOST_SELECTION` modes:

- `auto`: require an explicit profile for 2+ accounts (recommended).
- `always`: require one even for a single account.
- `off`: disable the extra guard; normal upstream default account rules apply.

To set a nondefault mode, edit the existing `secrets/bridge.env` and
restart `overleaf-mcp-rt-bridge.service`. For the default `auto` mode,
no changes to the deployed environment are needed.

**Security boundary:** This solves cookie collisions and accidental
cross-account edits, **not** access isolation between ChatGPT users. The
current OAuth facade issues owner-level tokens that can reach *all* named
profiles. Anyone authorized to use the same ChatGPT connector may select
either profile. If the two people need separate project permissions or
private credentials, use separate OAuth identities and independently routed
upstreams; that is not provided by this change. Sharing a ChatGPT login is
not a substitute for separate ChatGPT accounts.

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

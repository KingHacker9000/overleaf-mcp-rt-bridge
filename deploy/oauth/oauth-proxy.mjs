#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function trimSlash(value) {
  return value.replace(/\/+$/, '');
}

const host = process.env.OAUTH_HOST || '127.0.0.1';
const port = Number(process.env.OAUTH_PORT || '9456');
const issuer = trimSlash(required('PUBLIC_BASE_URL'));
const resource = process.env.MCP_RESOURCE_URL || `${issuer}/mcp`;
const upstreamUrl = required('UPSTREAM_MCP_URL');
const upstreamTokenFile = required('UPSTREAM_BEARER_TOKEN_FILE');
const passwordHashFile = required('OWNER_PASSWORD_HASH_FILE');
const scope = process.env.OAUTH_SCOPE || 'overleaf:owner';
const accessTokenTtlSec = Number(process.env.ACCESS_TOKEN_TTL_SEC || '3600');
const codeTtlSec = Number(process.env.AUTH_CODE_TTL_SEC || '300');
const requestTtlSec = Number(process.env.AUTH_REQUEST_TTL_SEC || '300');
const refreshTokenTtlSec = Number(process.env.REFRESH_TOKEN_TTL_SEC || '2592000');
const stateFile = process.env.OAUTH_STATE_FILE || '/var/lib/overleaf-mcp-oauth/state.json';
const staticClientsFile = process.env.OAUTH_STATIC_CLIENTS_FILE || '';
const allowedRedirectHosts = new Set(
  (process.env.OAUTH_REDIRECT_HOSTS || 'chatgpt.com')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const upstreamBearer = fs.readFileSync(upstreamTokenFile, 'utf8').trim();
const ownerPasswordHash = fs.readFileSync(passwordHashFile, 'utf8').trim().toLowerCase();

if (!/^[a-f0-9]{64}$/.test(ownerPasswordHash)) {
  throw new Error('OWNER_PASSWORD_HASH_FILE must contain a SHA-256 hex digest');
}

const clients = new Map();
const authRequests = new Map();
const authCodes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();

function now() {
  return Date.now();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function loadMap(target, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      target.set(key, entry);
    }
  }
}

function persistState() {
  const dir = stateFile.slice(0, Math.max(0, stateFile.lastIndexOf('/'))) || '.';
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempFile = `${stateFile}.tmp-${process.pid}`;
  const payload = JSON.stringify(
    {
      version: 1,
      clients: Object.fromEntries(clients),
      accessTokens: Object.fromEntries(accessTokens),
      refreshTokens: Object.fromEntries(refreshTokens),
    },
    null,
    2,
  );
  fs.writeFileSync(tempFile, payload + '\n', { mode: 0o600 });
  fs.renameSync(tempFile, stateFile);
}

function loadPersistentState() {
  if (!fs.existsSync(stateFile)) return;
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (parsed.version !== 1) throw new Error('unsupported OAuth state version');
  loadMap(clients, parsed.clients);
  loadMap(accessTokens, parsed.accessTokens);
  loadMap(refreshTokens, parsed.refreshTokens);
}

function loadStaticClients() {
  if (!staticClientsFile) return;
  if (!fs.existsSync(staticClientsFile)) {
    throw new Error(`static clients file not found: ${staticClientsFile}`);
  }
  const parsed = JSON.parse(fs.readFileSync(staticClientsFile, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('static clients file must contain a JSON object');
  }
  for (const [clientId, entry] of Object.entries(parsed)) {
    const redirectUris = entry?.redirectUris;
    if (
      !clientId ||
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every((value) => {
        try {
          return new URL(value).protocol === 'https:';
        } catch {
          return false;
        }
      })
    ) {
      throw new Error(`invalid static OAuth client: ${clientId}`);
    }
    clients.set(clientId, {
      redirectUris: [...new Set(redirectUris)],
      createdAt: Number(entry.createdAt || now()),
      static: true,
    });
  }
}

function json(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function html(res, status, body) {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
  });
  res.end(payload);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseJson(req) {
  const body = await readBody(req);
  return JSON.parse(body.toString('utf8') || '{}');
}

async function parseForm(req) {
  const body = await readBody(req);
  return new URLSearchParams(body.toString('utf8'));
}

function cleanup() {
  const cutoff = now();
  let persistentChanged = false;
  for (const [key, value] of authRequests) {
    if (value.expiresAt <= cutoff) authRequests.delete(key);
  }
  for (const [key, value] of authCodes) {
    if (value.expiresAt <= cutoff) authCodes.delete(key);
  }
  for (const [key, value] of accessTokens) {
    if (value.expiresAt <= cutoff) {
      accessTokens.delete(key);
      persistentChanged = true;
    }
  }
  for (const [key, value] of refreshTokens) {
    if (value.expiresAt <= cutoff) {
      refreshTokens.delete(key);
      persistentChanged = true;
    }
  }
  if (persistentChanged) persistState();
}
setInterval(cleanup, 60_000).unref();

function redirectAllowed(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase();
  for (const allowed of allowedRedirectHosts) {
    if (hostname === allowed || hostname.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

function bearerChallenge(error = 'invalid_token', description = 'Authentication required') {
  return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource", error="${error}", error_description="${description}"`;
}

function renderLogin(requestId, error = '') {
  const message = error
    ? `<p style="color:#b42318">${escapeHtml(error)}</p>`
    : '<p>Authorize this connector to access your Overleaf MCP tools.</p>';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Overleaf MCP</title>
</head>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:10vh auto;padding:24px">
  <h1>Overleaf MCP</h1>
  ${message}
  <form method="post" action="${escapeHtml(issuer)}/oauth/authorize">
    <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
    <label for="password">Owner password</label><br>
    <input id="password" name="password" type="password" autocomplete="current-password" required
      style="width:100%;box-sizing:border-box;padding:10px;margin:8px 0 16px">
    <button type="submit" style="padding:10px 16px">Authorize</button>
  </form>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

loadPersistentState();
loadStaticClients();
persistState();

function validateAuthorize(url) {
  const responseType = url.searchParams.get('response_type');
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state') || '';
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');
  const requestedScope = url.searchParams.get('scope') || scope;
  const requestedResource = url.searchParams.get('resource') || resource;

  if (responseType !== 'code') throw new Error('unsupported response_type');
  const client = clients.get(clientId);
  if (!client) throw new Error('unknown client_id');
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) throw new Error('redirect_uri mismatch');
  if (!codeChallenge || codeChallengeMethod !== 'S256') throw new Error('PKCE S256 is required');
  if (!requestedScope.split(/\s+/).includes(scope)) throw new Error('required scope was not requested');
  if (requestedResource !== resource) throw new Error('resource mismatch');

  return {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    requestedScope,
    requestedResource,
  };
}

function authorizeRedirect(data, code) {
  const target = new URL(data.redirectUri);
  target.searchParams.set('code', code);
  if (data.state) target.searchParams.set('state', data.state);
  return target.toString();
}

function validateAccessToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = accessTokens.get(match[1]);
  if (!token || token.expiresAt <= now()) return null;
  if (token.resource !== resource || !token.scope.split(/\s+/).includes(scope)) return null;
  return token;
}

async function proxyMcp(req, res) {
  const token = validateAccessToken(req);
  if (!token) {
    res.setHeader('www-authenticate', bearerChallenge());
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  const headers = {
    authorization: `Bearer ${upstreamBearer}`,
  };
  for (const name of [
    'accept',
    'content-type',
    'mcp-session-id',
    'mcp-protocol-version',
    'last-event-id',
    'user-agent',
  ]) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }

  const controller = new AbortController();
  const abortUpstream = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const abortOnEarlyResponseClose = () => {
    if (!res.writableFinished) abortUpstream();
  };

  req.once('aborted', abortUpstream);
  res.once('close', abortOnEarlyResponseClose);

  try {
    let body;
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
      body = await readBody(req, 40 * 1024 * 1024);
    }

    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    });

    const blockedHeaders = new Set([
      'connection',
      'content-length',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
    ]);
    for (const [name, value] of upstream.headers) {
      if (!blockedHeaders.has(name.toLowerCase())) res.setHeader(name, value);
    }
    res.statusCode = upstream.status;

    if (!upstream.body) {
      res.end();
      return;
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    const expectedDisconnect =
      controller.signal.aborted &&
      (error?.name === 'AbortError' ||
        error?.code === 'ABORT_ERR' ||
        req.aborted ||
        res.destroyed);

    if (expectedDisconnect) {
      console.log('[oauth-proxy] MCP client disconnected; upstream stream cancelled');
      return;
    }
    throw error;
  } finally {
    req.off('aborted', abortUpstream);
    res.off('close', abortOnEarlyResponseClose);
  }
}

async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', issuer);

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { status: 'ok', oauth: 'ready' });
      return;
    }

    if (
      req.method === 'GET' &&
      (url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp')
    ) {
      json(res, 200, {
        resource,
        authorization_servers: [issuer],
        scopes_supported: [scope],
        bearer_methods_supported: ['header'],
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: [scope],
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/oauth/register') {
      const input = await parseJson(req);
      if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
        json(res, 400, { error: 'invalid_redirect_uri' });
        return;
      }
      if (!input.redirect_uris.every(redirectAllowed)) {
        json(res, 400, { error: 'invalid_redirect_uri' });
        return;
      }
      if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') {
        json(res, 400, { error: 'invalid_client_metadata' });
        return;
      }

      const clientId = `overleaf_${randomToken(18)}`;
      clients.set(clientId, {
        redirectUris: [...new Set(input.redirect_uris)],
        createdAt: now(),
        static: false,
      });
      persistState();
      console.log(
        '[oauth-proxy] registered client redirect_uris=' +
          clients.get(clientId).redirectUris.join(','),
      );
      json(res, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(now() / 1000),
        redirect_uris: clients.get(clientId).redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      const data = validateAuthorize(url);
      console.log(
        '[oauth-proxy] authorization request redirect_uri=' +
          data.redirectUri +
          '; resource=' +
          data.requestedResource,
      );
      const requestId = randomToken(24);
      authRequests.set(requestId, {
        ...data,
        expiresAt: now() + requestTtlSec * 1000,
      });
      html(res, 200, renderLogin(requestId));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/oauth/authorize') {
      const form = await parseForm(req);
      const requestId = form.get('request_id') || '';
      const request = authRequests.get(requestId);
      if (!request || request.expiresAt <= now()) {
        html(res, 400, '<h1>Authorization request expired</h1>');
        return;
      }

      const passwordHash = crypto
        .createHash('sha256')
        .update(form.get('password') || '')
        .digest('hex');

      if (!safeEqualHex(passwordHash, ownerPasswordHash)) {
        html(res, 401, renderLogin(requestId, 'Incorrect password.'));
        return;
      }

      authRequests.delete(requestId);
      const code = randomToken(32);
      authCodes.set(code, {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scope: request.requestedScope,
        resource: request.requestedResource,
        expiresAt: now() + codeTtlSec * 1000,
      });

      const location = authorizeRedirect(request, code);
      console.log(
        '[oauth-proxy] authorization approved; redirect_uri=' +
          request.redirectUri,
      );
      res.writeHead(302, {
        location,
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const form = await parseForm(req);
      const grantType = form.get('grant_type');
      const clientId = form.get('client_id') || '';

      if (grantType === 'authorization_code') {
        const codeValue = form.get('code') || '';
        const redirectUri = form.get('redirect_uri') || '';
        const verifier = form.get('code_verifier') || '';
        const requestedResource = form.get('resource') || '';
        const code = authCodes.get(codeValue);

        if (!code || code.expiresAt <= now()) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        if (
          code.clientId !== clientId ||
          code.redirectUri !== redirectUri ||
          (requestedResource && code.resource !== requestedResource) ||
          sha256Base64Url(verifier) !== code.codeChallenge
        ) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }

        console.log(
          '[oauth-proxy] token exchange accepted; resource_parameter=' +
            (requestedResource ? 'present' : 'omitted'),
        );
        authCodes.delete(codeValue);

        const accessToken = randomToken(32);
        const refreshToken = randomToken(48);
        const refreshExpiresAt = now() + refreshTokenTtlSec * 1000;

        accessTokens.set(accessToken, {
          clientId,
          scope: code.scope,
          resource: code.resource,
          expiresAt: now() + accessTokenTtlSec * 1000,
        });
        refreshTokens.set(refreshToken, {
          clientId,
          scope: code.scope,
          resource: code.resource,
          expiresAt: refreshExpiresAt,
        });
        persistState();

        json(res, 200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: accessTokenTtlSec,
          scope: code.scope,
        });
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshValue = form.get('refresh_token') || '';
        const requestedResource = form.get('resource') || '';
        const requestedScope = form.get('scope') || '';
        const current = refreshTokens.get(refreshValue);

        if (!current || current.expiresAt <= now()) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }
        if (
          (clientId && current.clientId !== clientId) ||
          (requestedResource && current.resource !== requestedResource) ||
          (requestedScope && requestedScope !== current.scope)
        ) {
          json(res, 400, { error: 'invalid_grant' });
          return;
        }

        refreshTokens.delete(refreshValue);
        const accessToken = randomToken(32);
        const refreshToken = randomToken(48);
        accessTokens.set(accessToken, {
          clientId: current.clientId,
          scope: current.scope,
          resource: current.resource,
          expiresAt: now() + accessTokenTtlSec * 1000,
        });
        refreshTokens.set(refreshToken, {
          clientId: current.clientId,
          scope: current.scope,
          resource: current.resource,
          expiresAt: now() + refreshTokenTtlSec * 1000,
        });
        persistState();

        console.log('[oauth-proxy] refresh token exchange accepted');
        json(res, 200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: accessTokenTtlSec,
          scope: current.scope,
        });
        return;
      }

      json(res, 400, { error: 'unsupported_grant_type' });
      return;
    }

    if (url.pathname === '/mcp') {
      await proxyMcp(req, res);
      return;
    }

    json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('[oauth-proxy]', error);
    if (!res.headersSent) {
      json(res, 400, { error: 'invalid_request', error_description: error.message });
    } else {
      res.destroy(error);
    }
  }
}

const server = http.createServer(handler);
server.listen(port, host, () => {
  console.log(`[oauth-proxy] listening on http://${host}:${port}; resource=${resource}`);
});

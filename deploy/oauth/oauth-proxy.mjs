#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';

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
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
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
  for (const [key, value] of authRequests) {
    if (value.expiresAt <= cutoff) authRequests.delete(key);
  }
  for (const [key, value] of authCodes) {
    if (value.expiresAt <= cutoff) authCodes.delete(key);
  }
  for (const [key, value] of accessTokens) {
    if (value.expiresAt <= cutoff) accessTokens.delete(key);
  }
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
    : '<p>Authorize ChatGPT to access your Overleaf MCP tools.</p>';
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
  <form method="post" action="/oauth/authorize">
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

function validateAuthorize(url) {
  const responseType = url.searchParams.get('response_type');
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state') || '';
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');
  const requestedScope = url.searchParams.get('scope') || '';
  const requestedResource = url.searchParams.get('resource') || '';

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
  target.searchParams.set('iss', issuer);
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
  req.on('aborted', () => controller.abort());

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

  Readable.fromWeb(upstream.body).pipe(res);
}

async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', issuer);

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { status: 'ok', oauth: 'ready' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
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
        grant_types_supported: ['authorization_code'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: [scope],
        authorization_response_iss_parameter_supported: true,
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
      });
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

      res.writeHead(302, {
        location: authorizeRedirect(request, code),
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const form = await parseForm(req);
      const grantType = form.get('grant_type');
      const codeValue = form.get('code') || '';
      const clientId = form.get('client_id') || '';
      const redirectUri = form.get('redirect_uri') || '';
      const verifier = form.get('code_verifier') || '';
      const requestedResource = form.get('resource') || '';
      const code = authCodes.get(codeValue);

      if (grantType !== 'authorization_code') {
        json(res, 400, { error: 'unsupported_grant_type' });
        return;
      }
      if (!code || code.expiresAt <= now()) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      if (
        code.clientId !== clientId ||
        code.redirectUri !== redirectUri ||
        code.resource !== requestedResource ||
        sha256Base64Url(verifier) !== code.codeChallenge
      ) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }

      authCodes.delete(codeValue);
      const accessToken = randomToken(32);
      accessTokens.set(accessToken, {
        clientId,
        scope: code.scope,
        resource: code.resource,
        expiresAt: now() + accessTokenTtlSec * 1000,
      });

      json(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: accessTokenTtlSec,
        scope: code.scope,
      });
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

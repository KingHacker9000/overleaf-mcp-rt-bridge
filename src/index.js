import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { bearerAuthorized } from './auth.js';
import { loadConfig } from './config.js';
import { createProxyServer } from './proxy-server.js';
import { UpstreamOverleaf } from './upstream.js';

const config = loadConfig();
const upstream = new UpstreamOverleaf(config);
const app = express();
const sessions = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: config.maxJsonBody }));

function jsonRpcError(res, status, message) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

function requireBearer(req, res, next) {
  if (!bearerAuthorized(req.headers.authorization, config.bearerToken)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="overleaf-mcp"');
    jsonRpcError(res, 401, 'Unauthorized');
    return;
  }
  next();
}

function looksLikeInitialize(body) {
  if (Array.isArray(body)) {
    return body.some((message) => message?.method === 'initialize');
  }
  return body?.method === 'initialize';
}

async function newSession() {
  const server = createProxyServer(upstream, config);
  let registeredId = null;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      registeredId = sessionId;
      sessions.set(sessionId, { server, transport });
    },
  });

  transport.onclose = () => {
    if (registeredId) sessions.delete(registeredId);
  };

  await server.connect(transport);
  return { server, transport };
}

function getSession(req) {
  const raw = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(raw) ? raw[0] : raw;
  if (!sessionId) return null;
  return sessions.get(sessionId) ?? null;
}

app.get('/health', async (_req, res) => {
  const status = upstream.status();
  res.json({
    status: 'ok',
    upstream: status.connected ? 'connected' : 'not-yet-connected',
    upstreamToolCount: status.toolCount,
  });
});

app.post('/mcp', requireBearer, async (req, res, next) => {
  try {
    const existing = getSession(req);
    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    const presentedSessionId = req.headers['mcp-session-id'];
    if (presentedSessionId) {
      jsonRpcError(res, 404, 'Unknown or expired MCP session');
      return;
    }

    if (!looksLikeInitialize(req.body)) {
      jsonRpcError(res, 400, 'MCP session has not been initialized');
      return;
    }

    const created = await newSession();
    await created.transport.handleRequest(req, res, req.body);
  } catch (error) {
    next(error);
  }
});

for (const method of ['get', 'delete']) {
  app[method]('/mcp', requireBearer, async (req, res, next) => {
    try {
      const existing = getSession(req);
      if (!existing) {
        jsonRpcError(res, 404, 'Unknown or missing MCP session');
        return;
      }
      await existing.transport.handleRequest(req, res);
    } catch (error) {
      next(error);
    }
  });
}

app.use((error, _req, res, _next) => {
  console.error('[bridge] request failed:', error);
  if (!res.headersSent) {
    jsonRpcError(res, 500, 'Internal MCP bridge error');
  }
});

await upstream.connect();

const httpServer = app.listen(config.port, config.host, () => {
  const status = upstream.status();
  console.log(
    '[bridge] listening on http://' +
      config.host +
      ':' +
      config.port +
      '/mcp; upstream tools=' +
      status.toolCount,
  );
});

async function shutdown(signal) {
  console.log('[bridge] ' + signal + ' received; shutting down');
  httpServer.close();

  const closing = [];
  for (const session of sessions.values()) {
    closing.push(session.transport.close().catch(() => undefined));
  }
  sessions.clear();
  await Promise.allSettled(closing);
  await upstream.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('BRIDGE_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function csvSet(raw) {
  if (!raw || !raw.trim()) return new Set();
  return new Set(raw.split(',').map((value) => value.trim()).filter(Boolean));
}

export function loadConfig(env = process.env) {
  const bearerToken = env.MCP_BEARER_TOKEN?.trim();
  if (!bearerToken) {
    throw new Error('MCP_BEARER_TOKEN is required');
  }

  const hostSelection = env.BRIDGE_HOST_SELECTION?.trim() || 'auto';
  if (!['auto', 'always', 'off'].includes(hostSelection)) {
    throw new Error('BRIDGE_HOST_SELECTION must be auto, always, or off');
  }

  return {
    hostSelection,
    host: env.BRIDGE_HOST?.trim() || '127.0.0.1',
    port: parsePort(env.BRIDGE_PORT || '8787'),
    bearerToken,
    maxJsonBody: env.BRIDGE_MAX_JSON_BODY?.trim() || '32mb',
    credentialsFile:
      env.OVERLEAF_CREDENTIALS_FILE?.trim() ||
      join(homedir(), '.config', 'overleaf-mcp-rt', 'credentials.json'),
    upstreamCommand:
      env.UPSTREAM_MCP_COMMAND?.trim() ||
      resolve(process.cwd(), 'node_modules', '.bin', 'overleaf-mcp-rt'),
    allowedTools: csvSet(env.BRIDGE_ALLOWED_TOOLS),
    deniedTools: csvSet(env.BRIDGE_DENIED_TOOLS),
    historyOtWrites: env.OVERLEAF_HISTORY_OT_WRITES === '1',
  };
}

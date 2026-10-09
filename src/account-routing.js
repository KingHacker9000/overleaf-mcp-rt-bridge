import { readFileSync } from 'node:fs';

// overleaf-mcp-rt treats named hosts as credential profiles. Two profiles may
// point at the same overleaf.com URL while holding different session cookies.
export function readAccountNames(credentialsFile) {
  const data = JSON.parse(readFileSync(credentialsFile, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid Overleaf credentials file');
  }

  const hosts = data.hosts && typeof data.hosts === 'object' && !Array.isArray(data.hosts)
    ? data.hosts
    : {};
  const names = Object.keys(hosts);
  // Match the upstream v1 -> v2 compatibility handling. A legacy top-level
  // host is included only if no named host already points to the same URL.
  if (data.url && !Object.values(hosts).some((host) => host?.url === data.url)) {
    const name = new URL(data.url).hostname.replace(/^www\./, '');
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) throw new Error('No Overleaf credential profiles configured');
  return names;
}

export function accountRoutingPolicy(config) {
  if (config.hostSelection === 'off') return { required: false, names: [] };
  const names = readAccountNames(config.credentialsFile);
  return {
    required: config.hostSelection === 'always' || names.length > 1,
    names,
  };
}

function hasHostArgument(tool) {
  return tool?.name !== 'overleaf_list_hosts' &&
    Object.hasOwn(tool?.inputSchema?.properties ?? {}, 'host');
}

// The server must validate this too, not just rely on the tools/list schema:
// clients can cache schemas, and callers can send hand-crafted MCP requests.
export function hostSelectionError(tool, args, policy) {
  if (!policy.required || !hasHostArgument(tool)) return null;
  const host = args?.host;
  if (typeof host !== 'string' || !host.trim()) {
    return `Overleaf account selection required: set the 'host' argument to one of: ${policy.names.join(', ')}. Use overleaf_list_hosts to inspect accounts.`;
  }
  if (!policy.names.includes(host)) {
    return `Unknown Overleaf account '${host}'. Available host profiles: ${policy.names.join(', ')}.`;
  }
  return null;
}

export function withHostSelectionSchema(tool, policy) {
  if (!policy.required || !hasHostArgument(tool)) return tool;
  const inputSchema = tool.inputSchema;
  return {
    ...tool,
    description: `${tool.description ?? ''} IMPORTANT: Explicit 'host' selection is required because multiple Overleaf account profiles are configured. Available profile names: ${policy.names.join(', ')}.`,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...inputSchema.properties,
        host: {
          ...inputSchema.properties.host,
          description: `Required Overleaf account profile: ${policy.names.join(', ')}. This selects an account, not necessarily a distinct website.`,
        },
      },
      required: [...new Set([...(inputSchema.required ?? []), 'host'])],
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createProxyServer } from '../src/proxy-server.js';

const original = {
  default: 'overleaf.com',
  hosts: {
    'overleaf.com': {
      url: 'https://www.overleaf.com',
      session_cookie: 'my-private-cookie',
    },
  },
};
const multiple = {
  ...original,
  hosts: {
    ...original.hosts,
    brother: {
      url: 'https://www.overleaf.com',
      session_cookie: 'brother-private-cookie',
    },
  },
};

const projectsTool = {
  name: 'overleaf_list_projects',
  description: 'List projects',
  inputSchema: {
    type: 'object',
    properties: { host: { type: 'string', description: 'Optional host' } },
    required: [],
  },
};
const hostsTool = {
  name: 'overleaf_list_hosts',
  description: 'List accounts',
  inputSchema: { type: 'object', properties: {} },
};

test('MCP advertises and enforces explicit account selection after second login', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'overleaf-proxy-'));
  const credentialsFile = join(dir, 'credentials.json');
  writeFileSync(credentialsFile, JSON.stringify(original));

  const calls = [];
  const upstream = {
    listTools: async () => [projectsTool, hostsTool],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: 'success' }] };
    },
  };
  const server = createProxyServer(upstream, {
    credentialsFile,
    hostSelection: 'auto',
    allowedTools: new Set(),
    deniedTools: new Set(),
  });
  const client = new Client(
    { name: 'routing-integration-test', version: '1.0.0' },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const firstTools = await client.listTools();
    const originalProjects = firstTools.tools.find((tool) => tool.name === 'overleaf_list_projects');
    assert.equal(originalProjects.inputSchema.required?.includes('host') ?? false, false);

    const before = await client.callTool({ name: 'overleaf_list_projects', arguments: {} });
    assert.equal(before.isError, undefined);
    assert.equal(calls.length, 1);

    // Login writes credentials while the bridge and client MCP sessions stay alive.
    writeFileSync(credentialsFile, JSON.stringify(multiple));

    const afterTools = await client.listTools();
    const projects = afterTools.tools.find((tool) => tool.name === 'overleaf_list_projects');
    const hosts = afterTools.tools.find((tool) => tool.name === 'overleaf_list_hosts');
    assert.ok(projects.inputSchema.required.includes('host'));
    assert.equal(hosts.inputSchema.required?.includes('host') ?? false, false);
    assert.doesNotMatch(JSON.stringify(afterTools), /private-cookie/);

    const missing = await client.callTool({ name: 'overleaf_list_projects', arguments: {} });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /selection required/);
    assert.equal(calls.length, 1);

    const wrong = await client.callTool({ name: 'overleaf_list_projects', arguments: { host: 'typo' } });
    assert.equal(wrong.isError, true);
    assert.equal(calls.length, 1);

    const sibling = await client.callTool({ name: 'overleaf_list_projects', arguments: { host: 'brother' } });
    assert.equal(sibling.isError, undefined);
    assert.deepEqual(calls.at(-1), { name: 'overleaf_list_projects', args: { host: 'brother' } });

    const listHosts = await client.callTool({ name: 'overleaf_list_hosts', arguments: {} });
    assert.equal(listHosts.isError, undefined);
    assert.deepEqual(calls.at(-1), { name: 'overleaf_list_hosts', args: {} });
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

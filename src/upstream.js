import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class UpstreamOverleaf {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.transport = null;
    this.tools = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = this.#connectFresh();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async #connectFresh() {
    const childEnv = {
      ...process.env,
      OVERLEAF_CREDENTIALS_FILE: this.config.credentialsFile,
      OVERLEAF_HISTORY_OT_WRITES: this.config.historyOtWrites ? '1' : '0',
    };

    const transport = new StdioClientTransport({
      command: this.config.upstreamCommand,
      args: [],
      env: childEnv,
    });

    const client = new Client(
      { name: 'overleaf-mcp-rt-bridge', version: '0.1.0' },
      { capabilities: {} },
    );

    transport.onclose = () => {
      if (this.transport === transport) {
        this.client = null;
        this.transport = null;
        this.tools = null;
      }
    };

    await client.connect(transport);
    const listed = await client.listTools();

    this.transport = transport;
    this.client = client;
    this.tools = listed.tools ?? [];
    return client;
  }

  async listTools() {
    await this.connect();
    return this.tools ?? [];
  }

  async callTool(name, args) {
    const client = await this.connect();
    try {
      return await client.callTool({
        name,
        arguments: args ?? {},
      });
    } catch (error) {
      // Do not auto-retry writes. A disconnected response can occur after the
      // upstream already applied an edit, so retrying could duplicate it.
      this.client = null;
      this.transport = null;
      this.tools = null;
      throw error;
    }
  }

  status() {
    return {
      connected: Boolean(this.client),
      toolCount: this.tools?.length ?? 0,
    };
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.tools = null;
    if (client) await client.close().catch(() => undefined);
  }
}

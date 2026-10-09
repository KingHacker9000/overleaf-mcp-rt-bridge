import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { annotateTool, toolAllowed } from './tools.js';
import {
  accountRoutingPolicy,
  hostSelectionError,
  withHostSelectionSchema,
} from './account-routing.js';

const INSTRUCTIONS = [
  'This server edits the user\'s live Overleaf projects through overleaf-mcp-rt.',
  'Prefer overleaf_edit_doc exact-string edits over whole-document replacement.',
  'Read the relevant document before changing existing content.',
  'Compile after meaningful LaTeX changes and inspect the compile log if compilation fails.',
  'Never delete files or folders unless the user explicitly asked for deletion.',
  'When multiple Overleaf account profiles are configured, always supply the explicit host profile on every account-specific tool call. Never infer the intended account from the project name.',
].join(' ');

export function createProxyServer(upstream, config) {
  const server = new Server(
    { name: 'overleaf-mcp-rt-bridge', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await upstream.listTools();
    const routing = accountRoutingPolicy(config);
    return {
      tools: tools
        .filter((tool) =>
          toolAllowed(tool.name, config.allowedTools, config.deniedTools),
        )
        .map((tool) => annotateTool(withHostSelectionSchema(tool, routing))),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!toolAllowed(name, config.allowedTools, config.deniedTools)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Tool is disabled by bridge policy: ' + name,
          },
        ],
      };
    }

    // Validate at invocation time too: an MCP client may have cached the
    // schema from before a second account was configured.
    const tool = (await upstream.listTools()).find((entry) => entry.name === name);
    const routeError = hostSelectionError(
      tool,
      request.params.arguments,
      accountRoutingPolicy(config),
    );
    if (routeError) {
      return {
        isError: true,
        content: [{ type: 'text', text: routeError }],
      };
    }

    return upstream.callTool(name, request.params.arguments ?? {});
  });

  return server;
}

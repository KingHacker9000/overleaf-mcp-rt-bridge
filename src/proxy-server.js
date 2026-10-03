import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { annotateTool, toolAllowed } from './tools.js';

const INSTRUCTIONS = [
  'This server edits the user\'s live Overleaf projects through overleaf-mcp-rt.',
  'Prefer overleaf_edit_doc exact-string edits over whole-document replacement.',
  'Read the relevant document before changing existing content.',
  'Compile after meaningful LaTeX changes and inspect the compile log if compilation fails.',
  'Never delete files or folders unless the user explicitly asked for deletion.',
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
    return {
      tools: tools
        .filter((tool) =>
          toolAllowed(tool.name, config.allowedTools, config.deniedTools),
        )
        .map(annotateTool),
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

    return upstream.callTool(name, request.params.arguments ?? {});
  });

  return server;
}

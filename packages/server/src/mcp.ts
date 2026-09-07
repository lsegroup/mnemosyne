import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDef } from './tools.js';

/** Build an MCP server exposing the given tools. Transport-agnostic. */
export function createMcpServer(tools: ToolDef[]): McpServer {
  const server = new McpServer({
    name: 'mnemosyne',
    version: '0.1.0',
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.shape },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args ?? {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: `${tool.name} failed: ${(err as Error).message}` }],
          };
        }
      },
    );
  }

  return server;
}

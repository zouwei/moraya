/**
 * Internal Tools - built-in tools that are always available, independent of MCP servers.
 * These tools allow the AI to perform actions on Moraya itself (e.g., configuring MCP servers).
 */

import type { ToolDefinition, ToolCallRequest } from './types';
import { mcpStore, connectServer, type MCPServerConfig } from '$lib/services/mcp';

/** Built-in tool definitions — always injected into the LLM tool list. */
export const INTERNAL_TOOLS: ToolDefinition[] = [
  {
    name: 'add_mcp_server',
    description:
      'Add and connect a new MCP server to Moraya. Use this when the user asks to install, add, or configure an MCP server. ' +
      'Supports stdio transport (command + args, most common) and HTTP/SSE transport (url). ' +
      'After adding, the server is automatically connected and its tools become available.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Server display name, e.g. "PostgreSQL", "Filesystem", "Notion"',
        },
        transport_type: {
          type: 'string',
          enum: ['stdio', 'http', 'sse'],
          description: 'Transport type. Most MCP servers use "stdio".',
        },
        command: {
          type: 'string',
          description: 'For stdio: executable command, e.g. "npx" or "uvx"',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For stdio: command arguments array, e.g. ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@localhost/db"]',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'For stdio: optional environment variables, e.g. {"DATABASE_URL": "..."}',
        },
        url: {
          type: 'string',
          description: 'For http/sse: server endpoint URL, e.g. "http://localhost:3000/mcp"',
        },
      },
      required: ['name', 'transport_type'],
    },
  },
];

/** Check if a tool name belongs to an internal tool. */
export function isInternalTool(name: string): boolean {
  return INTERNAL_TOOLS.some(t => t.name === name);
}

/** Execute an internal tool and return the result. */
export async function executeInternalTool(
  tc: ToolCallRequest,
): Promise<{ content: string; isError: boolean }> {
  switch (tc.name) {
    case 'add_mcp_server':
      return handleAddMcpServer(tc.arguments);
    default:
      return { content: `Unknown internal tool: ${tc.name}`, isError: true };
  }
}

async function handleAddMcpServer(
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const name = args.name as string;
  const transportType = args.transport_type as string;

  if (!name) {
    return { content: 'Error: "name" is required', isError: true };
  }

  let transport: MCPServerConfig['transport'];

  if (transportType === 'stdio') {
    const command = args.command as string;
    if (!command) {
      return { content: 'Error: "command" is required for stdio transport', isError: true };
    }
    transport = {
      type: 'stdio',
      command,
      args: (args.args as string[]) || [],
      env: (args.env as Record<string, string>) || undefined,
    };
  } else if (transportType === 'http' || transportType === 'sse') {
    const url = args.url as string;
    if (!url) {
      return { content: `Error: "url" is required for ${transportType} transport`, isError: true };
    }
    transport = { type: transportType, url };
  } else {
    return { content: `Error: unsupported transport_type "${transportType}"`, isError: true };
  }

  const config: MCPServerConfig = {
    id: `mcp-${Date.now()}`,
    name,
    transport,
    enabled: true,
  };

  mcpStore.addServer(config);

  try {
    await connectServer(config);
    const state = mcpStore.getState();
    const toolCount = state.tools.filter(t => t.serverId === config.id).length;
    return {
      content: `MCP Server "${name}" added and connected successfully. Discovered ${toolCount} tool(s).`,
      isError: false,
    };
  } catch (e: any) {
    return {
      content: `MCP Server "${name}" added but connection failed: ${e.message}. You can try connecting manually in Settings → MCP.`,
      isError: false,
    };
  }
}

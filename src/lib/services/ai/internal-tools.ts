/**
 * Internal Tools - built-in tools that are always available, independent of MCP servers.
 * These tools allow the AI to perform actions on Moraya itself (e.g., configuring MCP servers).
 */

import type { ToolDefinition, ToolCallRequest } from './types';
import { mcpStore, connectServer, type MCPServerConfig } from '$lib/services/mcp';
import {
  createService,
  saveService,
  removeService,
  listServices,
} from '$lib/services/mcp/container-manager';
import { containerStore } from '$lib/services/mcp/container-store';
import { editorStore } from '$lib/stores/editor-store';
import { invoke } from '@tauri-apps/api/core';

/** Extract a human-readable message from unknown caught values (Error objects, strings, etc.). */
function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

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
  {
    name: 'create_mcp_service',
    description:
      'Create and start a new dynamic MCP service on-the-fly. Use this when you need to call an HTTP API ' +
      'or perform a task that no existing MCP tool covers. You provide tool definitions (JSON Schema) ' +
      'and handler code (Node.js JavaScript using built-in fetch). The service runs as a local MCP ' +
      'server and its tools become immediately available for use.\n\n' +
      'Handler code requirements:\n' +
      '- Export an object with async functions matching tool names: module.exports = { tool_name: async (args) => result }\n' +
      '- Use built-in fetch() for HTTP API calls (Node.js 18+)\n' +
      '- Access environment variables (API keys) via process.env.KEY_NAME\n' +
      '- Return a string or object (objects are JSON-stringified automatically)\n' +
      '- Throw errors to report failures to the caller',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Service name (alphanumeric + hyphens, e.g. "weather-api", "github-issues")',
        },
        description: {
          type: 'string',
          description: 'Brief description of what this service does',
        },
        tools: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool name (snake_case)' },
              description: { type: 'string', description: 'What this tool does' },
              inputSchema: {
                type: 'object',
                description: 'JSON Schema for tool input parameters',
              },
            },
            required: ['name', 'description', 'inputSchema'],
          },
          description: 'Array of tool definitions with JSON Schema input specs',
        },
        handlersCode: {
          type: 'string',
          description:
            'Node.js JavaScript code exporting handler functions. ' +
            'Example: module.exports = { get_weather: async ({ city }) => { ' +
            "const r = await fetch('https://api.example.com/weather?city=' + city); " +
            'return await r.json(); } }',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional environment variables (e.g. API keys) to pass to the service process',
        },
      },
      required: ['name', 'description', 'tools', 'handlersCode'],
    },
  },
  {
    name: 'save_mcp_service',
    description:
      'Save a temporary AI-created MCP service so it persists across sessions. ' +
      'Use this when the user wants to keep a dynamically created service for future use.',
    input_schema: {
      type: 'object',
      properties: {
        serviceId: {
          type: 'string',
          description: 'The service ID returned by create_mcp_service',
        },
      },
      required: ['serviceId'],
    },
  },
  {
    name: 'list_dynamic_services',
    description: 'List all AI-created dynamic MCP services (both temporary and saved)',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'remove_dynamic_service',
    description: 'Stop and remove an AI-created dynamic MCP service',
    input_schema: {
      type: 'object',
      properties: {
        serviceId: {
          type: 'string',
          description: 'The service ID to remove',
        },
      },
      required: ['serviceId'],
    },
  },
  {
    name: 'update_editor_content',
    description:
      'Write Markdown content directly into the Moraya editor. Use this tool (instead of write_file) ' +
      'when you need to fill or replace the current document with generated content. ' +
      'If the editor has an open file, it writes to that file and refreshes the editor. ' +
      'If the editor has a new unsaved document, it fills the content directly into the editor.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The full Markdown content to write into the editor',
        },
      },
      required: ['content'],
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
    case 'create_mcp_service':
      return handleCreateMcpService(tc.arguments);
    case 'save_mcp_service':
      return handleSaveMcpService(tc.arguments);
    case 'list_dynamic_services':
      return handleListDynamicServices();
    case 'remove_dynamic_service':
      return handleRemoveDynamicService(tc.arguments);
    case 'update_editor_content':
      return handleUpdateEditorContent(tc.arguments);
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
      content: `MCP Server "${name}" added but connection failed: ${errMsg(e)}. You can try connecting manually in Settings → MCP.`,
      isError: false,
    };
  }
}

// ── Dynamic Service Handlers ──

async function handleCreateMcpService(
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const state = containerStore.getState();
  if (!state.nodeAvailable) {
    return {
      content: 'Error: Node.js 18+ is required to create dynamic MCP services but was not found. Please install Node.js from https://nodejs.org/',
      isError: true,
    };
  }

  const name = args.name as string;
  const description = args.description as string;
  const tools = args.tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  const handlersCode = args.handlersCode as string;
  const env = args.env as Record<string, string> | undefined;

  if (!name || !description || !tools || !handlersCode) {
    return { content: 'Error: name, description, tools, and handlersCode are all required', isError: true };
  }

  try {
    const service = await createService({ name, description, tools, handlersCode, env });
    return {
      content: `Dynamic MCP service "${service.name}" created and running. ${service.tools.length} tool(s) available: ${service.tools.join(', ')}. Service ID: ${service.id}`,
      isError: false,
    };
  } catch (e: any) {
    return { content: `Failed to create dynamic service: ${errMsg(e)}`, isError: true };
  }
}

async function handleSaveMcpService(
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const serviceId = args.serviceId as string;
  if (!serviceId) {
    return { content: 'Error: serviceId is required', isError: true };
  }

  try {
    await saveService(serviceId);
    const state = containerStore.getState();
    const svc = state.services.find((s) => s.id === serviceId);
    return {
      content: `Service "${svc?.name || serviceId}" saved. It will auto-reconnect on next app launch.`,
      isError: false,
    };
  } catch (e: any) {
    return { content: `Failed to save service: ${errMsg(e)}`, isError: true };
  }
}

async function handleListDynamicServices(): Promise<{ content: string; isError: boolean }> {
  const services = listServices();
  if (services.length === 0) {
    return { content: 'No dynamic MCP services are currently active.', isError: false };
  }

  const list = services
    .map(
      (s) =>
        `- ${s.name} (ID: ${s.id}, status: ${s.status}, lifecycle: ${s.lifecycle}, tools: ${s.tools.join(', ')})`,
    )
    .join('\n');
  return { content: `Active dynamic services:\n${list}`, isError: false };
}

async function handleRemoveDynamicService(
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const serviceId = args.serviceId as string;
  if (!serviceId) {
    return { content: 'Error: serviceId is required', isError: true };
  }

  const state = containerStore.getState();
  const svc = state.services.find((s) => s.id === serviceId);
  const name = svc?.name || serviceId;

  try {
    await removeService(serviceId);
    return { content: `Service "${name}" has been stopped and removed.`, isError: false };
  } catch (e: any) {
    return { content: `Failed to remove service: ${errMsg(e)}`, isError: true };
  }
}

async function handleUpdateEditorContent(
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const markdownContent = args.content as string;
  if (!markdownContent) {
    return { content: 'Error: "content" is required', isError: true };
  }

  const state = editorStore.getState();
  const filePath = state.currentFilePath;

  // Update editor content
  editorStore.setContent(markdownContent);
  window.dispatchEvent(new CustomEvent('moraya:file-synced', { detail: { content: markdownContent } }));

  // If the file is saved (has a path), also persist to disk
  if (filePath) {
    try {
      await invoke('write_file', { path: filePath, content: markdownContent });
      editorStore.setDirty(false);
      return {
        content: `Content written to editor and saved to ${filePath.split('/').pop()} (${markdownContent.length} chars).`,
        isError: false,
      };
    } catch {
      editorStore.setDirty(true);
      return {
        content: `Content updated in editor (${markdownContent.length} chars) but failed to save to disk. The file is marked as unsaved.`,
        isError: false,
      };
    }
  }

  // New unsaved document — just fill the editor
  editorStore.setDirty(true);
  return {
    content: `Content filled into editor (${markdownContent.length} chars). The document is unsaved — user can save with Cmd+S.`,
    isError: false,
  };
}

/**
 * MCP Client - connects to MCP servers via SSE/HTTP transport
 * For stdio transport, the Rust backend acts as the bridge
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  MCPServerConfig,
  MCPTool,
  MCPResource,
  MCPToolCall,
  MCPToolResult,
  JSONRPCRequest,
  JSONRPCResponse,
} from './types';

class MCPClient {
  private serverConfig: MCPServerConfig;
  private requestId = 0;
  private eventSource: EventSource | null = null;
  private pendingRequests = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();

  constructor(config: MCPServerConfig) {
    this.serverConfig = config;
  }

  /**
   * Initialize connection to MCP server
   */
  async connect(): Promise<void> {
    const transport = this.serverConfig.transport;

    switch (transport.type) {
      case 'sse':
        await this.connectSSE(transport.url, transport.headers);
        break;
      case 'http':
        // HTTP is stateless, no persistent connection needed
        break;
      case 'stdio':
        // Delegate to Rust backend
        await invoke('mcp_connect_stdio', {
          serverId: this.serverConfig.id,
          command: transport.command,
          args: transport.args || [],
          env: transport.env || {},
        });
        break;
    }

    // Send initialize request
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
        resources: {},
      },
      clientInfo: {
        name: 'Moraya',
        version: '0.1.0',
      },
    });

    // Send initialized notification (required by MCP spec before calling tools/list)
    await this.sendNotification('initialized');
  }

  /**
   * Connect via Server-Sent Events
   */
  private connectSSE(url: string, headers?: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.eventSource = new EventSource(url);

      this.eventSource.onopen = () => resolve();

      this.eventSource.onmessage = (event) => {
        try {
          const response: JSONRPCResponse = JSON.parse(event.data);
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            if (response.error) {
              pending.reject(new Error(response.error.message));
            } else {
              pending.resolve(response.result);
            }
            this.pendingRequests.delete(response.id);
          }
        } catch {
          // Ignore malformed messages
        }
      };

      this.eventSource.onerror = () => {
        reject(new Error(`SSE connection failed to ${url}`));
      };
    });
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected)
   */
  private async sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
    const notification = {
      jsonrpc: '2.0',
      method,
      params: params || {},
    };

    const transport = this.serverConfig.transport;

    if (transport.type === 'stdio') {
      await invoke('mcp_send_notification', {
        serverId: this.serverConfig.id,
        notification: JSON.stringify(notification),
      });
    } else if (transport.type === 'http') {
      await fetch(transport.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(transport.headers || {}) },
        body: JSON.stringify(notification),
      });
    } else if (transport.type === 'sse') {
      const postUrl = transport.url.replace('/sse', '/message');
      await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(transport.headers || {}) },
        body: JSON.stringify(notification),
      });
    }
  }

  /**
   * Send a JSON-RPC request to the MCP server
   */
  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const transport = this.serverConfig.transport;

    if (transport.type === 'http') {
      const response = await fetch(transport.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(transport.headers || {}),
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`MCP HTTP error: ${response.status}`);
      }

      const result: JSONRPCResponse = await response.json();
      if (result.error) {
        throw new Error(result.error.message);
      }
      return result.result;

    } else if (transport.type === 'sse') {
      // For SSE, we send via a POST endpoint and receive via SSE
      return new Promise((resolve, reject) => {
        this.pendingRequests.set(id, { resolve, reject });
        // Send request via companion POST endpoint
        const postUrl = transport.url.replace('/sse', '/message');
        fetch(postUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(transport.headers || {}),
          },
          body: JSON.stringify(request),
        }).catch(reject);
      });

    } else if (transport.type === 'stdio') {
      // Delegate to Rust backend — returns raw JSON string, must parse
      const responseStr = await invoke<string>('mcp_send_request', {
        serverId: this.serverConfig.id,
        request: JSON.stringify(request),
      });
      if (!responseStr || !responseStr.trim()) {
        throw new Error('MCP server returned empty response');
      }
      const response: JSONRPCResponse = JSON.parse(responseStr);
      if (response.error) {
        throw new Error(response.error.message);
      }
      return response.result;
    }
  }

  /**
   * List available tools from the server
   */
  async listTools(): Promise<MCPTool[]> {
    const result = await this.sendRequest('tools/list') as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
    return (result?.tools || []).map(tool => ({
      ...tool,
      serverId: this.serverConfig.id,
    }));
  }

  /**
   * List available resources from the server
   */
  async listResources(): Promise<MCPResource[]> {
    const result = await this.sendRequest('resources/list') as { resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> };
    return (result?.resources || []).map(resource => ({
      ...resource,
      serverId: this.serverConfig.id,
    }));
  }

  /**
   * Call a tool on the MCP server
   */
  async callTool(call: MCPToolCall): Promise<MCPToolResult> {
    const result = await this.sendRequest('tools/call', {
      name: call.name,
      arguments: call.arguments,
    });
    return result as MCPToolResult;
  }

  /**
   * Read a resource from the MCP server
   */
  async readResource(uri: string): Promise<string> {
    const result = await this.sendRequest('resources/read', { uri }) as {
      contents: Array<{ text?: string; blob?: string }>;
    };
    return result?.contents?.[0]?.text || '';
  }

  /**
   * Disconnect from the MCP server
   */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    // Kill stdio process via Rust backend
    if (this.serverConfig.transport.type === 'stdio') {
      invoke('mcp_disconnect', { serverId: this.serverConfig.id }).catch(() => {});
    }
    this.pendingRequests.clear();
  }
}

export default MCPClient;

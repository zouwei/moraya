/**
 * MCP (Model Context Protocol) type definitions
 * Implements the MCP specification for tool/resource interaction
 */

export interface MCPServerConfig {
  id: string;
  name: string;
  description?: string;
  transport: MCPTransport;
  enabled: boolean;
}

export type MCPTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverId: string;
}

export interface MCPToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

// JSON-RPC message types for MCP protocol
export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// Publishing-specific types
export interface PublishTarget {
  id: string;
  name: string;
  type: 'blog' | 'cms' | 'static-site' | 'knowledge-base' | 'custom';
  mcpServerId: string;
  config: Record<string, string>;
}

export interface PublishRequest {
  title: string;
  content: string;
  format: 'markdown' | 'html';
  metadata?: Record<string, unknown>;
  targetId: string;
}

export interface PublishResult {
  success: boolean;
  url?: string;
  message?: string;
}

// Knowledge base sync types
export interface SyncConfig {
  id: string;
  name: string;
  mcpServerId: string;
  remotePath: string;
  localPath: string;
  autoSync: boolean;
  syncInterval: number; // milliseconds
  lastSyncTime?: number;
}

export interface SyncStatus {
  configId: string;
  status: 'idle' | 'syncing' | 'success' | 'error';
  lastSync: number | null;
  error?: string;
  filesChanged: number;
}

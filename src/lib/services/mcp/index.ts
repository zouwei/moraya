export { default as MCPClient } from './mcp-client';
export {
  mcpStore,
  connectServer,
  disconnectServer,
  callTool,
  publishDocument,
  syncToKnowledgeBase,
  getAllTools,
  connectAllServers,
  disconnectAllServers,
  initMCPStore,
} from './mcp-manager';
export type {
  MCPServerConfig,
  MCPTransport,
  MCPTool,
  MCPResource,
  MCPToolCall,
  MCPToolResult,
  PublishTarget,
  PublishRequest,
  PublishResult,
  SyncConfig,
  SyncStatus,
} from './types';

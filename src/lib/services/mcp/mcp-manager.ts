/**
 * MCP Manager - manages multiple MCP server connections
 * Handles publishing, syncing, and tool orchestration
 */

import { writable, get } from 'svelte/store';
import { load } from '@tauri-apps/plugin-store';
import MCPClient from './mcp-client';
import { MCP_PRESETS } from './presets';
import type {
  MCPServerConfig,
  MCPTool,
  MCPResource,
  MCPToolResult,
  PublishTarget,
  PublishRequest,
  PublishResult,
  SyncConfig,
  SyncStatus,
} from './types';

// ── MCP State Store ──

interface MCPState {
  servers: MCPServerConfig[];
  connectedServers: Set<string>;
  tools: MCPTool[];
  resources: MCPResource[];
  publishTargets: PublishTarget[];
  syncConfigs: SyncConfig[];
  syncStatuses: Map<string, SyncStatus>;
  isLoading: boolean;
  error: string | null;
}

function createMCPStore() {
  const { subscribe, set, update } = writable<MCPState>({
    servers: [],
    connectedServers: new Set(),
    tools: [],
    resources: [],
    publishTargets: [],
    syncConfigs: [],
    syncStatuses: new Map(),
    isLoading: false,
    error: null,
  });

  return {
    subscribe,
    addServer(config: MCPServerConfig) {
      update(state => ({
        ...state,
        servers: [...state.servers.filter(s => s.id !== config.id), config],
      }));
      persistMCPServers();
    },
    removeServer(id: string) {
      update(state => ({
        ...state,
        servers: state.servers.filter(s => s.id !== id),
        connectedServers: new Set([...state.connectedServers].filter(s => s !== id)),
        tools: state.tools.filter(t => t.serverId !== id),
        resources: state.resources.filter(r => r.serverId !== id),
      }));
      persistMCPServers();
    },
    setConnected(id: string, connected: boolean) {
      update(state => {
        const set = new Set(state.connectedServers);
        if (connected) set.add(id); else set.delete(id);
        return { ...state, connectedServers: set };
      });
    },
    setTools(tools: MCPTool[]) {
      update(state => ({ ...state, tools }));
    },
    setResources(resources: MCPResource[]) {
      update(state => ({ ...state, resources }));
    },
    addPublishTarget(target: PublishTarget) {
      update(state => ({
        ...state,
        publishTargets: [...state.publishTargets.filter(t => t.id !== target.id), target],
      }));
    },
    addSyncConfig(config: SyncConfig) {
      update(state => ({
        ...state,
        syncConfigs: [...state.syncConfigs.filter(c => c.id !== config.id), config],
      }));
    },
    removeSyncConfig(configId: string) {
      update(state => ({
        ...state,
        syncConfigs: state.syncConfigs.filter(c => c.id !== configId),
      }));
    },
    updateSyncStatus(status: SyncStatus) {
      update(state => {
        const statuses = new Map(state.syncStatuses);
        statuses.set(status.configId, status);
        return { ...state, syncStatuses: statuses };
      });
    },
    setError(error: string | null) {
      update(state => ({ ...state, error }));
    },
    setLoading(loading: boolean) {
      update(state => ({ ...state, isLoading: loading }));
    },
    getState() {
      return get({ subscribe });
    },
  };
}

export const mcpStore = createMCPStore();

const MCP_STORE_FILE = 'mcp-config.json';

async function persistMCPServers() {
  try {
    const state = mcpStore.getState();
    const store = await load(MCP_STORE_FILE);
    await store.set('servers', state.servers);
    await store.save();
  } catch { /* ignore */ }
}

async function persistSyncConfigs() {
  try {
    const state = mcpStore.getState();
    const store = await load(MCP_STORE_FILE);
    await store.set('syncConfigs', state.syncConfigs);
    await store.save();
  } catch { /* ignore */ }
}

/** Load persisted MCP server configs from disk. Call once at app startup. */
export async function initMCPStore() {
  try {
    const store = await load(MCP_STORE_FILE);
    const servers = await store.get<MCPServerConfig[]>('servers');
    if (servers && servers.length > 0) {
      // Migration: remove old preset duplicates (timestamp IDs like mcp-123456)
      const presetNames = new Set(MCP_PRESETS.map(p => p.name));
      const cleaned = servers.filter(s => {
        if (presetNames.has(s.name) && !s.id.startsWith('preset-')) {
          return false; // old duplicate — skip
        }
        return true;
      });
      for (const s of cleaned) {
        mcpStore.addServer(s);
      }
      if (cleaned.length < servers.length) {
        persistMCPServers();
      }
    }
    const syncConfigs = await store.get<SyncConfig[]>('syncConfigs');
    if (syncConfigs && syncConfigs.length > 0) {
      for (const sc of syncConfigs) {
        mcpStore.addSyncConfig(sc);
      }
    }
  } catch { /* first launch */ }
}

/**
 * Add a sync configuration and persist it
 */
export function addSyncConfig(config: SyncConfig) {
  mcpStore.addSyncConfig(config);
  persistSyncConfigs();
}

/**
 * Remove a sync configuration and persist
 */
export function removeSyncConfig(configId: string) {
  mcpStore.removeSyncConfig(configId);
  persistSyncConfigs();
}

// ── MCP Client Manager ──

const clients = new Map<string, MCPClient>();

/**
 * Connect to an MCP server
 */
export async function connectServer(config: MCPServerConfig): Promise<void> {
  if (clients.has(config.id)) {
    await disconnectServer(config.id);
  }

  const client = new MCPClient(config);
  try {
    mcpStore.setLoading(true);
    console.log(`[MCP] Connecting to ${config.name} (${config.transport.type})...`);
    await client.connect();
    clients.set(config.id, client);
    mcpStore.setConnected(config.id, true);
    console.log(`[MCP] Connected to ${config.name}`);

    // Discover tools and resources
    const [tools, resources] = await Promise.all([
      client.listTools().catch((e) => { console.error(`[MCP] listTools failed for ${config.name}:`, e); return []; }),
      client.listResources().catch((e) => { console.error(`[MCP] listResources failed for ${config.name}:`, e); return []; }),
    ]);

    console.log(`[MCP] ${config.name}: discovered ${tools.length} tools, ${resources.length} resources`);
    if (tools.length > 0) console.log(`[MCP] Tools:`, tools.map(t => t.name).join(', '));

    const state = mcpStore.getState();
    mcpStore.setTools([...state.tools.filter(t => t.serverId !== config.id), ...tools]);
    mcpStore.setResources([...state.resources.filter(r => r.serverId !== config.id), ...resources]);
    mcpStore.setError(null);
  } catch (error: any) {
    console.error(`[MCP] Failed to connect to ${config.name}:`, error);
    mcpStore.setError(`Failed to connect to ${config.name}: ${error?.message || error}`);
    throw error;
  } finally {
    mcpStore.setLoading(false);
  }
}

/**
 * Disconnect from an MCP server
 */
export async function disconnectServer(serverId: string): Promise<void> {
  const client = clients.get(serverId);
  if (client) {
    client.disconnect();
    clients.delete(serverId);
  }
  mcpStore.setConnected(serverId, false);
}

/**
 * Call a tool on any connected MCP server
 */
export async function callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
  const state = mcpStore.getState();
  const tool = state.tools.find(t => t.name === toolName);
  if (!tool) throw new Error(`Tool not found: ${toolName}`);

  const client = clients.get(tool.serverId);
  if (!client) throw new Error(`Server not connected: ${tool.serverId}`);

  return client.callTool({ name: toolName, arguments: args });
}

/**
 * Publish a document via MCP
 */
export async function publishDocument(request: PublishRequest): Promise<PublishResult> {
  const state = mcpStore.getState();
  const target = state.publishTargets.find(t => t.id === request.targetId);
  if (!target) throw new Error(`Publish target not found: ${request.targetId}`);

  const client = clients.get(target.mcpServerId);
  if (!client) throw new Error(`MCP server not connected: ${target.mcpServerId}`);

  try {
    const result = await client.callTool({
      name: 'publish',
      arguments: {
        title: request.title,
        content: request.content,
        format: request.format,
        metadata: request.metadata || {},
        targetConfig: target.config,
      },
    });

    const text = result.content?.[0]?.text || '';
    let parsed: { url?: string; message?: string } = {};
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }

    return {
      success: !result.isError,
      url: parsed.url,
      message: parsed.message || text,
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message,
    };
  }
}

/**
 * Sync documents to a knowledge base via MCP
 */
export async function syncToKnowledgeBase(syncConfigId: string, files: Array<{ path: string; content: string }>): Promise<void> {
  const state = mcpStore.getState();
  const config = state.syncConfigs.find(c => c.id === syncConfigId);
  if (!config) throw new Error(`Sync config not found: ${syncConfigId}`);

  const client = clients.get(config.mcpServerId);
  if (!client) throw new Error(`MCP server not connected: ${config.mcpServerId}`);

  mcpStore.updateSyncStatus({
    configId: syncConfigId,
    status: 'syncing',
    lastSync: null,
    filesChanged: files.length,
  });

  try {
    for (const file of files) {
      await client.callTool({
        name: 'sync_file',
        arguments: {
          localPath: file.path,
          remotePath: `${config.remotePath}/${file.path.split('/').pop()}`,
          content: file.content,
        },
      });
    }

    mcpStore.updateSyncStatus({
      configId: syncConfigId,
      status: 'success',
      lastSync: Date.now(),
      filesChanged: files.length,
    });
  } catch (error: any) {
    mcpStore.updateSyncStatus({
      configId: syncConfigId,
      status: 'error',
      lastSync: null,
      error: error.message,
      filesChanged: 0,
    });
    throw error;
  }
}

/**
 * Get all available tools across connected servers
 */
export function getAllTools(): MCPTool[] {
  return mcpStore.getState().tools;
}

/**
 * Discover publishing capabilities from connected MCP servers.
 * Looks for tools with names or descriptions matching publishing patterns.
 */
export function discoverPublishTargets(): PublishTarget[] {
  const state = mcpStore.getState();
  return state.tools
    .filter(t =>
      t.name.toLowerCase().includes('publish') ||
      t.description.toLowerCase().includes('publish')
    )
    .map(t => {
      const server = state.servers.find(s => s.id === t.serverId);
      return {
        id: `auto-${t.serverId}-${t.name}`,
        name: `${server?.name || t.serverId}: ${t.name}`,
        type: 'custom' as const,
        mcpServerId: t.serverId,
        config: { toolName: t.name },
      };
    });
}

/**
 * Connect all enabled servers
 */
export async function connectAllServers(): Promise<void> {
  const state = mcpStore.getState();
  const enabled = state.servers.filter(s => s.enabled);

  await Promise.allSettled(enabled.map(s => connectServer(s)));
}

/**
 * Disconnect all servers
 */
export async function disconnectAllServers(): Promise<void> {
  const serverIds = [...clients.keys()];
  await Promise.allSettled(serverIds.map(id => disconnectServer(id)));
}

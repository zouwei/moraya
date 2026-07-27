/**
 * MCP Manager - manages multiple MCP server connections
 * Handles publishing, syncing, and tool orchestration
 */

import { writable, get } from 'svelte/store';
import { load } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';
import MCPClient from './mcp-client';
import {
  secretsOf,
  hasPlaintextSecrets,
  withoutSecretValues,
  withSecretValues,
} from './mcp-secrets';
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
      void deleteServerSecrets(id);
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

// ── Secret handling ──────────────────────────────────────────────────
//
// A server's `env` (stdio) and `headers` (sse/http) carry real credentials —
// API secrets, bearer tokens. They used to be written verbatim into
// mcp-config.json, a plaintext file on disk, which the project's security rules
// forbid for any credential. They now live in the OS keychain, keyed by server
// id, exactly like AI provider keys; only the KEY NAMES stay on disk so the
// settings UI can still show which variables a server expects.

const KEYCHAIN_MCP_PREFIX = 'mcp-secrets:';

/**
 * Write a server's secret map into the OS keychain.
 *
 * Returns whether the credentials are now safely in the keychain. The caller
 * MUST NOT blank the on-disk copy unless this said true: a swallowed failure
 * plus an unconditional blanking would destroy the user's credentials in both
 * places at once, leaving a server that can never connect again.
 */
async function saveServerSecrets(server: MCPServerConfig): Promise<boolean> {
  if (!hasPlaintextSecrets(server)) return true; // nothing to protect
  try {
    await invoke('keychain_set', {
      key: `${KEYCHAIN_MCP_PREFIX}${server.id}`,
      value: JSON.stringify(secretsOf(server)),
    });
    return true;
  } catch (e) {
    // Keep the value where it already is rather than losing it. This is the
    // pre-existing on-disk state, so it leaks nothing new — but it is loud,
    // because a silent downgrade to plaintext is its own problem.
    console.warn('[MCP] keychain write failed; credentials left in the config file', e);
    return false;
  }
}

/** Read a server's secret map back from the keychain. */
async function loadServerSecrets(id: string): Promise<Record<string, string> | null> {
  try {
    const raw = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_MCP_PREFIX}${id}` });
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/** Drop a removed server's credentials from the keychain. */
async function deleteServerSecrets(id: string): Promise<void> {
  try {
    await invoke('keychain_delete', { key: `${KEYCHAIN_MCP_PREFIX}${id}` });
  } catch { /* nothing stored / keychain unavailable */ }
}

async function persistMCPServers() {
  try {
    const state = mcpStore.getState();
    // Credentials go to the keychain; the file gets the same servers with the
    // secret values blanked out (key names kept so the UI can show them).
    // Blank ONLY the ones the keychain actually accepted — see saveServerSecrets.
    const saved = await Promise.all(state.servers.map(saveServerSecrets));
    const store = await load(MCP_STORE_FILE);
    await store.set(
      'servers',
      state.servers.map((s, i) => (saved[i] ? withoutSecretValues(s) : s)),
    );
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
      // Rehydrate credentials from the keychain, and migrate any that a
      // previous version left in the plaintext file: those values are read
      // once, moved into the keychain, and blanked on disk by the persist
      // below. Without the migration an existing server would silently lose
      // its credentials on upgrade.
      let migratedSecrets = false;
      const hydrated = await Promise.all(
        cleaned.map(async (s) => {
          if (hasPlaintextSecrets(s)) {
            await saveServerSecrets(s);
            migratedSecrets = true;
            return s;
          }
          const stored = await loadServerSecrets(s.id);
          return stored ? withSecretValues(s, stored) : s;
        }),
      );
      for (const s of hydrated) {
        mcpStore.addServer(s);
      }
      if (cleaned.length < servers.length || migratedSecrets) {
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

    // Discover tools and resources — SEQUENTIALLY. The Rust bridge takes the
    // child process out of its map for the whole duration of a request
    // (one reader, one writer), so two in-flight requests for the same server
    // cannot both succeed: whichever is scheduled second fails immediately with
    // "MCP server not connected". When that loser was tools/list, the server
    // ended up marked connected with zero tools — the AI then sees no MCP tools
    // at all, which is the "installed fine, useless after restart" report.
    const tools = await client.listTools().catch((e) => {
      console.error(`[MCP] listTools failed for ${config.name}:`, e);
      return [];
    });
    const resources = await client.listResources().catch((e) => {
      console.error(`[MCP] listResources failed for ${config.name}:`, e);
      return [];
    });

    // Only now call it connected: a timed-out tools/list kills the child on the
    // Rust side, so announcing success before this point advertises a server
    // that is already dead.
    mcpStore.setConnected(config.id, true);
    console.log(`[MCP] Connected to ${config.name}`);

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
  // Search persisted targets first, then dynamically discovered MCP targets
  const target = state.publishTargets.find(t => t.id === request.targetId)
    || discoverPublishTargets().find(t => t.id === request.targetId);
  if (!target) throw new Error(`Publish target not found: ${request.targetId}`);

  const client = clients.get(target.mcpServerId);
  if (!client) throw new Error(`MCP server not connected: ${target.mcpServerId}`);

  try {
    // Use the actual tool name from config (e.g., 'publish_article'), fallback to 'publish'
    const toolName = (target.config as Record<string, unknown>)?.toolName as string || 'publish';
    const result = await client.callTool({
      name: toolName,
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
 * Connect all enabled servers. Skips servers that are already connected —
 * `initContainerManager` connects saved dynamic services itself during
 * restoration, so on app startup `connectAllServers` would otherwise race
 * with it (both call `connectServer(id)` concurrently, both see
 * `clients.has(id) === false`, and both spawn duplicate stdio processes —
 * one ends up orphaned with no reader, hanging future requests).
 */
export async function connectAllServers(): Promise<void> {
  const state = mcpStore.getState();
  const enabled = state.servers.filter(s => s.enabled && !clients.has(s.id));

  await Promise.allSettled(enabled.map(s => connectServer(s)));
}

/**
 * Disconnect all servers
 */
export async function disconnectAllServers(): Promise<void> {
  const serverIds = [...clients.keys()];
  await Promise.allSettled(serverIds.map(id => disconnectServer(id)));
}

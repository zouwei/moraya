import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { writable, get } from 'svelte/store';
import { load } from '@tauri-apps/plugin-store';
import type {
  InstalledPlugin,
  PluginStateEntry,
  PluginMarketData,
  ValidationResult,
  InstallResult,
} from './types';

// ---------------------------------------------------------------------------
// Store state
// ---------------------------------------------------------------------------

interface PluginStoreState {
  installed: InstalledPlugin[];
  market: PluginMarketData[];
  marketFetchedAt: number;
  marketFromCache: boolean;
  loading: boolean;
  marketLoading: boolean;
  installProgress: Record<string, { downloaded: number; total: number }>;
  blacklist: string[];
}

const initialState: PluginStoreState = {
  installed: [],
  market: [],
  marketFetchedAt: 0,
  marketFromCache: false,
  loading: false,
  marketLoading: false,
  installProgress: {},
  blacklist: [],
};

const { subscribe, set, update } = writable<PluginStoreState>(initialState);

// ---------------------------------------------------------------------------
// Persistence (plugin-state.json via Tauri Store)
// ---------------------------------------------------------------------------

const STORE_KEY = 'installed-plugins';

async function loadPersistedState(): Promise<PluginStateEntry[]> {
  try {
    const store = await load('plugin-state.json');
    return (await store.get<PluginStateEntry[]>(STORE_KEY)) ?? [];
  } catch {
    return [];
  }
}

async function persistState(entries: PluginStateEntry[]): Promise<void> {
  try {
    const store = await load('plugin-state.json');
    await store.set(STORE_KEY, entries);
  } catch {
    // Non-critical — state will be reloaded next launch
  }
}

function entryToPlugin(entry: PluginStateEntry, runningIds: string[]): InstalledPlugin {
  return {
    manifest: entry.manifest,
    enabled: entry.enabled,
    pluginDir: entry.pluginDir,
    installedAt: entry.installedAt,
    processState: runningIds.includes(entry.id) ? 'running' : 'stopped',
  };
}

// ---------------------------------------------------------------------------
// Initialise: load persisted entries, restart enabled plugins, fetch blacklist
// ---------------------------------------------------------------------------

let _downloadProgressUnlisten: (() => void) | null = null;

async function init(): Promise<void> {
  update(s => ({ ...s, loading: true }));

  const [entries, runningIds, blacklist] = await Promise.all([
    loadPersistedState(),
    invoke<string[]>('plugin_list_running'),
    invoke<string[]>('plugin_fetch_blacklist').catch(() => [] as string[]),
  ]);

  // Force-disable blacklisted plugins
  const cleaned = entries.map(e =>
    blacklist.includes(e.id) ? { ...e, enabled: false } : e
  );

  const plugins = cleaned.map(e => entryToPlugin(e, runningIds));
  update(s => ({ ...s, installed: plugins, blacklist, loading: false }));

  // Restart enabled plugins
  for (const entry of cleaned) {
    if (entry.enabled && !blacklist.includes(entry.id)) {
      try {
        await invoke('plugin_enable', { entry });
      } catch {
        // Non-fatal — plugin will show as 'error' state
      }
    }
  }

  // Subscribe to download progress events
  if (!_downloadProgressUnlisten) {
    _downloadProgressUnlisten = await listen<{ downloaded: number; total: number }>(
      'plugin:download_progress',
      ({ payload }) => {
        // Progress is keyed by the currently installing plugin id (tracked separately)
        update(s => {
          const currentInstalling = Object.keys(s.installProgress)[0];
          if (!currentInstalling) return s;
          return {
            ...s,
            installProgress: {
              ...s.installProgress,
              [currentInstalling]: payload,
            },
          };
        });
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Install helpers
// ---------------------------------------------------------------------------

/** Install from a local .zip file (user picks via file dialog). */
async function installFromFile(): Promise<{ ok: boolean; error?: string }> {
  const selected = await open({
    filters: [{ name: 'Plugin Package', extensions: ['zip'] }],
    multiple: false,
  });
  if (!selected) return { ok: false };

  const zipPath = selected as string;

  const result = await invoke<InstallResult>('plugin_install_local', {
    zipPath,
    expectedSha256: null,
  });

  if (result.ok && result.plugin) {
    await _addInstalledPlugin(result.plugin);
  }
  return { ok: result.ok, error: result.error ?? undefined };
}

/** Install from a download URL with SHA256 verification (marketplace one-click). */
async function installFromUrl(
  pluginId: string,
  downloadUrl: string,
  expectedSha256: string
): Promise<{ ok: boolean; error?: string }> {
  update(s => ({
    ...s,
    installProgress: { ...s.installProgress, [pluginId]: { downloaded: 0, total: 0 } },
  }));

  let result: InstallResult;
  try {
    result = await invoke<InstallResult>('plugin_install_from_url', {
      downloadUrl,
      expectedSha256,
    });
  } finally {
    update(s => {
      const progress = { ...s.installProgress };
      delete progress[pluginId];
      return { ...s, installProgress: progress };
    });
  }

  if (result.ok && result.plugin) {
    await _addInstalledPlugin(result.plugin);
  }
  return { ok: result.ok, error: result.error ?? undefined };
}

async function _addInstalledPlugin(entry: PluginStateEntry): Promise<void> {
  const runningIds = await invoke<string[]>('plugin_list_running');
  const plugin = entryToPlugin(entry, runningIds);

  update(s => {
    const existing = s.installed.filter(p => p.manifest.id !== entry.id);
    return { ...s, installed: [...existing, plugin] };
  });

  // Persist updated list
  const { installed } = get(pluginStore);
  await persistState(
    installed.map(p => ({
      id: p.manifest.id,
      enabled: p.enabled,
      pluginDir: p.pluginDir,
      installedAt: p.installedAt,
      manifest: p.manifest,
    }))
  );
}

// ---------------------------------------------------------------------------
// Enable / Disable / Uninstall
// ---------------------------------------------------------------------------

async function enablePlugin(entry: PluginStateEntry): Promise<void> {
  update(s => ({
    ...s,
    installed: s.installed.map(p =>
      p.manifest.id === entry.id ? { ...p, processState: 'starting' as const } : p
    ),
  }));

  try {
    await invoke('plugin_enable', { entry });
    update(s => ({
      ...s,
      installed: s.installed.map(p =>
        p.manifest.id === entry.id
          ? { ...p, enabled: true, processState: 'running' as const }
          : p
      ),
    }));
  } catch {
    update(s => ({
      ...s,
      installed: s.installed.map(p =>
        p.manifest.id === entry.id ? { ...p, processState: 'error' as const } : p
      ),
    }));
    return;
  }

  await _persistCurrentState();
}

async function disablePlugin(pluginId: string): Promise<void> {
  await invoke('plugin_disable', { pluginId });
  update(s => ({
    ...s,
    installed: s.installed.map(p =>
      p.manifest.id === pluginId
        ? { ...p, enabled: false, processState: 'stopped' as const }
        : p
    ),
  }));
  await _persistCurrentState();
}

async function uninstallPlugin(pluginId: string): Promise<void> {
  await invoke('plugin_uninstall', { pluginId });
  update(s => ({
    ...s,
    installed: s.installed.filter(p => p.manifest.id !== pluginId),
  }));
  await _persistCurrentState();
}

async function _persistCurrentState(): Promise<void> {
  const { installed } = get(pluginStore);
  await persistState(
    installed.map(p => ({
      id: p.manifest.id,
      enabled: p.enabled,
      pluginDir: p.pluginDir,
      installedAt: p.installedAt,
      manifest: p.manifest,
    }))
  );
}

// ---------------------------------------------------------------------------
// Market / Registry
// ---------------------------------------------------------------------------

async function fetchMarket(forceRefresh = false): Promise<void> {
  update(s => ({ ...s, marketLoading: true }));
  try {
    const result = await invoke<{
      plugins: PluginMarketData[];
      fromCache: boolean;
      fetchedAt: number;
    }>('plugin_registry_fetch', { forceRefresh });

    update(s => ({
      ...s,
      market: result.plugins,
      marketFetchedAt: result.fetchedAt,
      marketFromCache: result.fromCache,
      marketLoading: false,
    }));
  } catch {
    update(s => ({ ...s, marketLoading: false }));
  }
}

// ---------------------------------------------------------------------------
// Validate (URL import)
// ---------------------------------------------------------------------------

async function validateManifest(source: string): Promise<ValidationResult> {
  return invoke<ValidationResult>('plugin_validate_manifest', { source });
}

// ---------------------------------------------------------------------------
// JSON-RPC invocation (Plugin API)
// ---------------------------------------------------------------------------

let _rpcIdCounter = 1;

async function invokePlugin(
  pluginId: string,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const id = _rpcIdCounter++;
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
  const responseStr = await invoke<string>('plugin_invoke', { pluginId, request });
  const response = JSON.parse(responseStr);
  if (response.error) {
    throw new Error(response.error.message ?? 'Plugin API error');
  }
  return response.result;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const pluginStore = {
  subscribe,
  init,
  installFromFile,
  installFromUrl,
  enablePlugin,
  disablePlugin,
  uninstallPlugin,
  fetchMarket,
  validateManifest,
  invokePlugin,
};

/**
 * Renderer Plugin Manager
 *
 * Manages the lifecycle of built-in renderer plugins:
 *   - Persistent state (enabled/disabled) in Tauri Store (`renderer-plugins.json`)
 *   - Svelte store for reactive UI
 *   - Download + load orchestration via renderer-loader.ts
 *
 * Usage in components:
 *   import { rendererManager } from '$lib/services/plugin/renderer-manager';
 *   // Subscribe to reactive state
 *   const unsub = rendererManager.subscribe(s => { ... });
 *   // Enable a plugin (downloads + loads in background)
 *   await rendererManager.enable('wavedrom');
 */

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { load } from '@tauri-apps/plugin-store';
import { RENDERER_PLUGINS, type RendererPlugin } from './renderer-registry';
import { loadRendererPlugin, clearRendererModuleCache, type LoadStatus } from './renderer-loader';
import versions from './renderer-versions.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RendererPluginState {
  id: string;
  enabled: boolean;
  /** Current download/load status */
  status: LoadStatus;
  /** Error message (if status === 'error') */
  error?: string;
  /** Installed version (undefined = not yet downloaded) */
  installedVersion?: string;
}

interface RendererManagerState {
  plugins: RendererPluginState[];
  /** True while loading persisted state on init */
  initializing: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const STORE_FILE = 'renderer-plugins.json';
const STORE_KEY = 'renderer-plugin-states';

async function loadPersisted(): Promise<Record<string, { enabled: boolean; version?: string }>> {
  try {
    const store = await load(STORE_FILE);
    return (await store.get<Record<string, { enabled: boolean; version?: string }>>(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
}

async function savePersisted(states: RendererPluginState[]): Promise<void> {
  try {
    const store = await load(STORE_FILE);
    const record: Record<string, { enabled: boolean; version?: string }> = {};
    for (const s of states) {
      record[s.id] = { enabled: s.enabled, version: s.installedVersion };
    }
    await store.set(STORE_KEY, record);
    await store.save();
  } catch (e) {
    console.error('[renderer-manager] persist failed:', e);
  }
}

function resolvedCdnUrl(plugin: RendererPlugin): string {
  const ver = (versions as Record<string, string>)[plugin.npmPackage] ?? 'latest';
  return plugin.cdnUrl.replaceAll('{version}', ver);
}

function buildInitialState(
  persisted: Record<string, { enabled: boolean; version?: string }>
): RendererPluginState[] {
  return RENDERER_PLUGINS.map((p) => ({
    id: p.id,
    enabled: persisted[p.id]?.enabled ?? false,
    status: 'idle' as LoadStatus,
    installedVersion: persisted[p.id]?.version,
  }));
}

// ---------------------------------------------------------------------------
// Svelte store
// ---------------------------------------------------------------------------

const initialManagerState: RendererManagerState = {
  plugins: RENDERER_PLUGINS.map((p) => ({
    id: p.id,
    enabled: false,
    status: 'idle',
  })),
  initializing: true,
};

const { subscribe, update } = writable<RendererManagerState>(initialManagerState);

function patchPlugin(id: string, patch: Partial<RendererPluginState>): void {
  update((s) => ({
    ...s,
    plugins: s.plugins.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  }));
}

// ---------------------------------------------------------------------------
// Cancellation tracking
// ---------------------------------------------------------------------------

/**
 * Plugin IDs cancelled mid-download.
 * When the download completes for a cancelled plugin, we delete the file and reset.
 */
const cancelledPlugins = new Set<string>();

// ---------------------------------------------------------------------------
// Init — load persisted state and re-enable previously enabled plugins
// ---------------------------------------------------------------------------

let initialized = false;

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const persisted = await loadPersisted();
  const plugins = buildInitialState(persisted);

  update((s) => ({ ...s, plugins, initializing: false }));

  // Re-load all previously enabled plugins in the background
  for (const ps of plugins) {
    if (ps.enabled) {
      const plugin = RENDERER_PLUGINS.find((p) => p.id === ps.id);
      if (plugin) {
        _load(plugin);
      }
    }
  }
}

// Internal load helper — does not flip `enabled`
function _load(plugin: RendererPlugin): void {
  const cdnUrl = resolvedCdnUrl(plugin);
  const version = (versions as Record<string, string>)[plugin.npmPackage];
  let wasCancelled = false;

  loadRendererPlugin(plugin, cdnUrl, (status) => {
    // Check cancellation on every status callback
    if (cancelledPlugins.has(plugin.id)) {
      wasCancelled = true;
      cancelledPlugins.delete(plugin.id);

      if (status === 'ready') {
        // Download finished after cancellation — clean up the file and cache
        clearRendererModuleCache(plugin.id);
        invoke('delete_renderer_plugin', { pluginId: plugin.id }).catch(() => {});
      }

      patchPlugin(plugin.id, {
        status: 'idle',
        enabled: false,
        installedVersion: undefined,
        error: undefined,
      });
      savePersisted(get({ subscribe }).plugins);
      return;
    }

    patchPlugin(plugin.id, {
      status,
      error: undefined,
      ...(status === 'ready' ? { installedVersion: version } : {}),
    });

    if (status === 'ready' || status === 'error') {
      savePersisted(get({ subscribe }).plugins);
    }
  }).then((result) => {
    if (wasCancelled) return;
    if (result.status === 'error') {
      patchPlugin(plugin.id, { status: 'error', error: result.error });
    }
  });
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

/** Enable a renderer plugin (download if needed, then load). */
async function enable(id: string): Promise<void> {
  const plugin = RENDERER_PLUGINS.find((p) => p.id === id);
  if (!plugin) return;

  patchPlugin(id, { enabled: true });
  await savePersisted(get({ subscribe }).plugins);
  _load(plugin);
}

/** Disable a renderer plugin (clears module cache, keeps file on disk). */
async function disable(id: string): Promise<void> {
  clearRendererModuleCache(id);
  patchPlugin(id, { enabled: false, status: 'idle' });
  await savePersisted(get({ subscribe }).plugins);
}

/** Cancel an in-progress download. Resets plugin to not-downloaded state. */
async function cancel(id: string): Promise<void> {
  cancelledPlugins.add(id);
  // Reset UI immediately — background download result will be discarded on arrival
  patchPlugin(id, { status: 'idle', enabled: false, error: undefined });
  await savePersisted(get({ subscribe }).plugins);
}

/** Delete the downloaded plugin file from disk. Only call when plugin is disabled. */
async function deletePlugin(id: string): Promise<void> {
  clearRendererModuleCache(id);
  try {
    await invoke('delete_renderer_plugin', { pluginId: id });
  } catch (e) {
    console.error('[renderer-manager] delete failed:', e);
  }
  patchPlugin(id, { enabled: false, status: 'idle', installedVersion: undefined, error: undefined });
  await savePersisted(get({ subscribe }).plugins);
}

/** Force re-download and reload (Retry after error). */
async function update_plugin(id: string): Promise<void> {
  const plugin = RENDERER_PLUGINS.find((p) => p.id === id);
  if (!plugin) return;

  clearRendererModuleCache(id);
  // Delete existing file so Rust re-downloads instead of using the cached (possibly broken) file
  try {
    await invoke('delete_renderer_plugin', { pluginId: id });
  } catch {
    // ignore
  }
  patchPlugin(id, { status: 'idle', installedVersion: undefined });
  _load(plugin);
}

/** Return plugin definitions for all currently enabled + ready plugins. */
function getEnabled(): RendererPlugin[] {
  const state = get({ subscribe });
  const enabledIds = new Set(
    state.plugins.filter((p) => p.enabled && p.status === 'ready').map((p) => p.id)
  );
  return RENDERER_PLUGINS.filter((p) => enabledIds.has(p.id));
}

// ---------------------------------------------------------------------------
// Export singleton
// ---------------------------------------------------------------------------

export const rendererManager = {
  subscribe,
  init,
  enable,
  disable,
  cancel,
  delete: deletePlugin,
  update: update_plugin,
  getEnabled,
};

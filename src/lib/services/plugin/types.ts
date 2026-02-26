/**
 * Plugin system type definitions for Moraya v0.16.0
 */

/** Sandbox level declared in plugin.json */
export type PluginSandboxLevel = 'sandbox' | 'local' | 'system';

/** Platform keys used in the entry field of plugin.json */
export type PluginPlatform = 'darwin-aarch64' | 'darwin-x86_64' | 'win32' | 'linux-x86_64';

/** Known permission tokens. Any other value is rejected at install time. */
export type PluginPermission =
  | 'editor:read'
  | 'editor:write'
  | 'ai:chat'
  | 'ai:image'
  | 'ai:voice'
  | 'ai:voice:capture'
  | 'net:external';

/** The plugin.json manifest structure (validated during install) */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  apiVersion: string;
  entry: Partial<Record<PluginPlatform, string>>;
  protocol: 'jsonrpc-stdio';
  permissions: PluginPermission[];
  permissionReasons?: Partial<Record<PluginPermission, string>>;
  sandboxLevel: PluginSandboxLevel;
  homepage?: string;
  limits?: {
    'ai:chat:callsPerMinute'?: number;
    'ai:chat:tokensPerDay'?: number;
  };
}

/** State of a plugin process */
export type PluginProcessState = 'stopped' | 'starting' | 'running' | 'error';

/** An installed plugin with runtime state */
export interface InstalledPlugin {
  manifest: PluginManifest;
  /** true = user has toggled the plugin on */
  enabled: boolean;
  /** Absolute path to the plugin directory in appData/plugins/{id}/ */
  pluginDir: string;
  installedAt: number;
  /** Runtime process state (not persisted) */
  processState: PluginProcessState;
}

/** Entry in plugin-state.json (persisted to Tauri Store) */
export interface PluginStateEntry {
  id: string;
  enabled: boolean;
  pluginDir: string;
  installedAt: number;
  manifest: PluginManifest;
}

// ---------------------------------------------------------------------------
// Registry types (from moraya-plugin-registry/index.json)
// ---------------------------------------------------------------------------

/** One entry in the registry index.json */
export interface RegistryIndexEntry {
  id: string;
  repo: string;           // "owner/repo"
  category: string;
  verified: boolean;
  pinnedVersion: string;
  sha256: Partial<Record<PluginPlatform, string>>;
}

/** Full registry index */
export interface RegistryIndex {
  version: number;
  updatedAt: string;
  plugins: RegistryIndexEntry[];
}

/** Blacklisted plugin entry */
export interface BlacklistEntry {
  id: string;
  repo: string;
  reason: string;
  reportedAt: string;
  affectedVersions: string[];
}

/** Dynamic data fetched from GitHub API for a single plugin */
export interface PluginMarketData {
  id: string;
  repo: string;
  category: string;
  verified: boolean;
  pinnedVersion: string;
  sha256: Partial<Record<PluginPlatform, string>>;

  /** From GitHub /repos/{owner}/{repo} */
  name: string;
  description: string;
  stars: number;
  license: string;
  updatedAt: string;

  /** From GitHub /repos/{owner}/{repo}/releases/latest */
  downloadUrls: Partial<Record<PluginPlatform, string>>;
  changelog: string;

  /** From raw plugin.json in the repo */
  manifest: PluginManifest | null;

  /** Icon URL from registry (raw.githubusercontent.com) */
  iconUrl: string;
}

/** Cached registry data written to plugin-registry-cache.json */
export interface RegistryCache {
  fetchedAt: number;
  plugins: PluginMarketData[];
}

// ---------------------------------------------------------------------------
// Install result types (returned from Rust commands)
// ---------------------------------------------------------------------------

export interface InstallResult {
  ok: boolean;
  plugin?: PluginStateEntry;
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  manifest?: PluginManifest;
  errors: string[];
  warnings: string[];
}

export interface RegistryFetchResult {
  plugins: PluginMarketData[];
  fromCache: boolean;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Plugin API event types (Moraya → Plugin via JSON-RPC notifications)
// ---------------------------------------------------------------------------

export interface PluginSegmentEvent {
  sessionId: string;
  speakerId: string;
  profileId?: string;
  displayName: string;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
  speechFinal: boolean;
}

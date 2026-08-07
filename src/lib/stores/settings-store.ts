import { writable, get } from 'svelte/store';
import { load } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { setLocale, detectSystemLocale, type SupportedLocale, type LocaleSelection } from '$lib/i18n';
import { getThemeById } from '$lib/styles/themes';
import { type ImageHostConfig, type ImageHostTarget, DEFAULT_IMAGE_HOST_CONFIG, generateImageHostTargetId } from '$lib/services/image-hosting';
import type { ImageProviderConfig, SpeechProviderConfig } from '$lib/services/ai/types';
import type { PublishTarget } from '$lib/services/publish/types';
import type { VoiceProfile } from '$lib/services/voice/types';

const SETTINGS_STORE_FILE = 'settings.json';
const KEYCHAIN_IMAGE_PREFIX = 'image-key:';
const KEYCHAIN_SPEECH_PREFIX = 'speech-key:';
const KEYCHAIN_SPEECH_AWS_AK_PREFIX = 'speech-aws-ak:';
const KEYCHAIN_SPEECH_AWS_SK_PREFIX = 'speech-aws-sk:';

export type Theme = 'light' | 'dark' | 'system';

// v0.60.0 — Native PDF export settings.
export type ExportPaperSize = 'a4' | 'letter' | 'legal' | 'a3' | 'a5';
export type ExportOrientation = 'portrait' | 'landscape';

export interface ExportSettings {
  pageSize: ExportPaperSize;
  orientation: ExportOrientation;
  margins: { top: number; right: number; bottom: number; left: number };
  headerEnabled: boolean;
  headerTemplate: string;
  footerEnabled: boolean;
  footerTemplate: string;
  fontFamily: string;     // empty string = system default
  fontSize: number;       // pt
  enableHighlight: boolean;
  enableMermaid: boolean;
  enableMath: boolean;
  autoFallbackOnFailure: boolean;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  pageSize: 'a4',
  orientation: 'portrait',
  margins: { top: 20, right: 15, bottom: 20, left: 15 },
  headerEnabled: false,
  headerTemplate: '{title}',
  footerEnabled: true,
  footerTemplate: '{page} / {total}',
  fontFamily: '',
  fontSize: 11,
  enableHighlight: true,
  enableMermaid: true,
  enableMath: true,
  autoFallbackOnFailure: true,
};

interface Settings {
  theme: Theme;
  colorTheme: string;           // active color theme id for light mode
  darkColorTheme: string;       // color theme id for dark mode
  useSeparateDarkTheme: boolean; // use a different theme in dark mode
  fontFamily: string;
  fontSize: number;
  lineWidth: number;
  autoSave: boolean;
  /** @deprecated v1.21.0 — replaced by autoSaveMaxMinutes/autoSaveIdleMinutes; kept so older settings.json files still parse. */
  autoSaveInterval: number; // milliseconds
  // v1.21.0: dual-condition autosave — force-save a dirty doc at most this many
  // minutes after the last save, even while the user keeps typing.
  autoSaveMaxMinutes: number;
  // v1.21.0: save a dirty doc once the user has paused input for this many minutes.
  autoSaveIdleMinutes: number;
  showSidebar: boolean;
  showStatusBar: boolean;
  localeSelection: LocaleSelection;
  editorLineWidth: number;
  editorTabSize: number;
  showLineNumbers: boolean;
  imageHostConfig: ImageHostConfig;
  imageHostTargets: ImageHostTarget[];
  defaultImageHostId: string;
  imageProviderConfigs: ImageProviderConfig[];
  activeImageConfigId: string | null;
  publishTargets: PublishTarget[];
  lastUpdateCheckDate: string | null;  // "YYYY-MM-DD" format
  rememberLastFolder: boolean;
  /**
   * v0.41.6 — stale-DMG self-check (macOS only).
   * Fingerprint = sorted, comma-joined list of stale mount paths the user
   * dismissed last. If the next scan returns a SUPERSET (i.e. a new stale
   * DMG appeared), we re-prompt; if it's a subset or equal, we stay quiet.
   * `null` means the user has never dismissed the prompt.
   */
  staleDmgDismissedFingerprint: string | null;
  lastOpenedFolder: string | null;
  mcpAutoApprove: boolean;
  aiMaxTokens: number;
  aiToolResultMaxChars: number;
  aiMaxToolRounds: number;
  speechProviderConfigs: SpeechProviderConfig[];
  activeSpeechConfigId: string | null;
  voiceProfiles: VoiceProfile[];
  recordingBackupDir: string | null;   // null = disabled
  voiceSyncDir: string | null;         // null = use AppData default
  showOutline: boolean;
  outlineWidth: number;
  aiPanelWidth: number | null;   // null = use default (33% of window)
  rulesHistoryCount: number;
  // v1.21.0: local per-document version history (snapshots under {kbRoot}/.versions/)
  versionHistoryEnabled: boolean;
  versionHistoryMax: number;     // per-document snapshot retention (1-500)
  // Knowledge base embedding settings
  embeddingProvider: string | null;       // null = follow AI chat provider
  embeddingConfigId: string;             // provider config ID for keychain
  embeddingModel: string;                // embedding model name
  embeddingDimensions: number;           // 384-2560, default 1024
  embeddingBaseUrl: string;              // custom base URL
  autoIndexOnSave: boolean;              // auto-index file on save
  localEmbeddingModelId: string | null;  // Phase 4 offline model ID
  // v0.32.0: AI Review consent per-provider (P1 privacy disclaimer)
  aiReviewConsent: Record<string, boolean>;
  // v0.35.0: Global KB auto-sync toggle
  kbSyncEnabled: boolean;
  // v0.36.0: Show cloud resource insert entries in Format menu + right-click menu
  showCloudInsertEntries: boolean;
  // v0.37.0: Picora tab — default account for KB sync + cloud resource browse (separate from defaultImageHostId)
  defaultPicoraAccountId: string;
  // v0.37.0: Sidebar shortcut to Picora resource browse (default off)
  picoraSidebarPinned: boolean;
  // v0.37.0: Show debug log section in Picora tab
  picoraDebugLogging: boolean;
  // v0.37.0: Whether the user has dismissed the "new Picora tab" introduction banner
  picoraTabSeen: boolean;
  // v0.37.0: Auto-rewrite base64 images in documents to Picora CDN on upload
  picoraRewriteBase64: boolean;
  // v0.60.0: Native PDF export configuration.
  exportSettings: ExportSettings;
  // v0.41.4: AI chat input — controls whether plain Enter sends the message
  // or inserts a newline. `'modEnterSend'` keeps the original behavior
  // (Cmd/Ctrl+Enter sends, Enter = newline); `'enterSend'` matches chat-app
  // convention (Enter sends, Shift+Enter = newline).
  aiChatEnterBehavior: 'modEnterSend' | 'enterSend';
  /**
   * User-customized keyboard shortcut bindings, keyed by
   * `ShortcutEntry.id` (see `$lib/shortcuts/catalog`). Only entries with
   * `customizable: true` honor overrides at runtime; everything else is
   * bound in the native menu and ignores this map.
   *
   * Empty / missing values fall back to the catalog default for the
   * current platform.
   */
  shortcutOverrides: Record<string, string>;
  /**
   * v0.41.6 — user-added MCP tool shortcut entries. Each ref produces a
   * row in the Shortcuts panel's MCP section; the actual key binding lives
   * in `shortcutOverrides` keyed by `catalogId`. Server-toggle entries are
   * NOT stored here — they're auto-derived from the installed MCP server
   * list at render time.
   */
  mcpToolShortcuts: { catalogId: string; serverId: string; toolName: string }[];
}

/**
 * Outline panel width, kept identical to the web build
 * (moraya-web EditorOutlinePanel.svelte + the edit route's readOutlineWidth)
 * so the outline is the same size wherever a document is opened.
 *
 * 260 rather than the original 200: headings are the longest strings in the
 * panel and CJK is the dense case — at 200px, after the scroll padding, the
 * base indent and 1em per nesting level, a level-3 heading had only ~14
 * Chinese characters of room and wrapped constantly. This does not narrow the
 * prose column: `.editor-content-area`'s max-width is
 * `editorLineWidth + outlineWidth`, so the outline takes gutter, not text.
 */
export const OUTLINE_DEFAULT_WIDTH = 260;
/** The pre-widening default; only this exact stored value is migrated. */
const OUTLINE_LEGACY_DEFAULT_WIDTH = 200;

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  colorTheme: 'default-light',
  darkColorTheme: 'default-dark',
  useSeparateDarkTheme: false,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontSize: 16,
  lineWidth: 800,
  autoSave: true,
  autoSaveInterval: 30000,
  autoSaveMaxMinutes: 10,
  autoSaveIdleMinutes: 3,
  showSidebar: false,
  showStatusBar: true,
  localeSelection: 'system',
  editorLineWidth: 800,
  editorTabSize: 4,
  showLineNumbers: false,
  imageHostConfig: { ...DEFAULT_IMAGE_HOST_CONFIG },
  imageHostTargets: [],
  defaultImageHostId: '',
  imageProviderConfigs: [],
  activeImageConfigId: null,
  publishTargets: [],
  lastUpdateCheckDate: null,
  rememberLastFolder: true,
  staleDmgDismissedFingerprint: null,
  lastOpenedFolder: null,
  mcpAutoApprove: false,
  aiMaxTokens: 16384,
  aiToolResultMaxChars: 10000,
  aiMaxToolRounds: 20,
  speechProviderConfigs: [],
  activeSpeechConfigId: null,
  voiceProfiles: [],
  recordingBackupDir: null,
  voiceSyncDir: null,
  showOutline: false,
  outlineWidth: OUTLINE_DEFAULT_WIDTH,
  aiPanelWidth: null,
  rulesHistoryCount: 10,
  versionHistoryEnabled: true,
  versionHistoryMax: 50,
  embeddingProvider: null,
  embeddingConfigId: '',
  embeddingModel: '',
  embeddingDimensions: 1024,
  embeddingBaseUrl: '',
  autoIndexOnSave: false,
  localEmbeddingModelId: null,
  aiReviewConsent: {},
  kbSyncEnabled: true,
  showCloudInsertEntries: true,
  defaultPicoraAccountId: '',
  picoraSidebarPinned: false,
  picoraDebugLogging: false,
  picoraTabSeen: false,
  picoraRewriteBase64: false,
  exportSettings: { ...DEFAULT_EXPORT_SETTINGS, margins: { ...DEFAULT_EXPORT_SETTINGS.margins } },
  aiChatEnterBehavior: 'modEnterSend',
  shortcutOverrides: {},
  mcpToolShortcuts: [],
};

function resolveLocale(selection: LocaleSelection): SupportedLocale {
  return selection === 'system' ? detectSystemLocale() : selection;
}

/** Detect if the current effective appearance is dark */
function isDarkMode(theme: Theme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  // system
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Apply data-theme attribute and color theme CSS variables */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

/** Custom properties the currently applied color theme wrote onto <html>. */
let appliedThemeProps: string[] = [];

function applyColorTheme(settings: Settings) {
  const dark = isDarkMode(settings.theme);
  let themeId: string;

  if (dark && settings.useSeparateDarkTheme) {
    themeId = settings.darkColorTheme;
  } else if (dark) {
    // If not using separate dark theme, try to find a dark version of current theme
    const current = getThemeById(settings.colorTheme);
    if (current && current.type === 'dark') {
      themeId = settings.colorTheme;
    } else {
      themeId = settings.darkColorTheme;
    }
  } else {
    themeId = settings.colorTheme;
  }

  const colorTheme = getThemeById(themeId);
  const root = document.documentElement;

  if (colorTheme) {
    // Clear what the PREVIOUS theme wrote before applying this one. Themes are
    // applied as inline properties on <html>, which outrank every stylesheet,
    // so a key that one theme sets and the next omits would otherwise stay
    // stuck for the rest of the session.
    for (const prop of appliedThemeProps) {
      if (!(prop in colorTheme.colors)) root.style.removeProperty(prop);
    }
    appliedThemeProps = Object.keys(colorTheme.colors);
    for (const [prop, value] of Object.entries(colorTheme.colors)) {
      root.style.setProperty(prop, value);
    }
  }
}

/** Cross-window view settings sync */
const VIEW_SYNC_EVENT = 'view-settings-sync';
let syncGuard = false; // Prevent re-emission when receiving sync from other windows
let windowLabel: string | null = null;

function emitViewSync(partial: Record<string, unknown>) {
  if (syncGuard) return;
  if (!windowLabel) {
    try { windowLabel = getCurrentWindow().label; } catch { windowLabel = 'main'; }
  }
  emit(VIEW_SYNC_EVENT, { source: windowLabel, ...partial }).catch(() => {});
}

/** Debounced persist to avoid excessive disk writes */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(state: Settings) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      // Sanitize image provider API keys for disk storage
      const diskState = { ...state };
      if (state.imageProviderConfigs?.length > 0) {
        diskState.imageProviderConfigs = [];
        for (const c of state.imageProviderConfigs) {
          if (c.apiKey && c.apiKey !== '***') {
            try {
              await invoke('keychain_set', { key: `${KEYCHAIN_IMAGE_PREFIX}${c.id}`, value: c.apiKey });
              diskState.imageProviderConfigs.push({ ...c, apiKey: '***' });
            } catch {
              diskState.imageProviderConfigs.push({ ...c }); // fallback: keep plaintext
            }
          } else {
            diskState.imageProviderConfigs.push({ ...c });
          }
        }
      }

      // Sanitize speech provider API keys for disk storage
      if (state.speechProviderConfigs?.length > 0) {
        diskState.speechProviderConfigs = [];
        for (const c of state.speechProviderConfigs) {
          const sanitized = { ...c };
          if (c.apiKey && c.apiKey !== '***') {
            try {
              await invoke('keychain_set', { key: `${KEYCHAIN_SPEECH_PREFIX}${c.id}`, value: c.apiKey });
              sanitized.apiKey = '***';
            } catch { /* fallback: keep plaintext */ }
          }
          if (c.awsAccessKey && c.awsAccessKey !== '***') {
            try {
              await invoke('keychain_set', { key: `${KEYCHAIN_SPEECH_AWS_AK_PREFIX}${c.id}`, value: c.awsAccessKey });
              sanitized.awsAccessKey = '***';
            } catch { /* fallback */ }
          }
          if (c.awsSecretKey && c.awsSecretKey !== '***') {
            try {
              await invoke('keychain_set', { key: `${KEYCHAIN_SPEECH_AWS_SK_PREFIX}${c.id}`, value: c.awsSecretKey });
              sanitized.awsSecretKey = '***';
            } catch { /* fallback */ }
          }
          diskState.speechProviderConfigs.push(sanitized);
        }
      }

      const store = await load(SETTINGS_STORE_FILE);
      await store.set('data', diskState);
      await store.save();
    } catch { /* ignore persist errors */ }
  }, 300);
}

function createSettingsStore() {
  const { subscribe, set, update } = writable<Settings>(DEFAULT_SETTINGS);

  // Apply initial locale
  setLocale(resolveLocale(DEFAULT_SETTINGS.localeSelection));

  // Listen for system theme changes to re-apply color theme
  if (typeof window !== 'undefined') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      const state = get({ subscribe });
      if (state.theme === 'system') {
        applyColorTheme(state);
      }
    });
  }

  // Auto-save on every state change
  let initialized = false;
  subscribe(state => {
    if (initialized) schedulePersist(state);
  });

  return {
    subscribe,
    /** Mark store as initialized (call after loading persisted data) */
    _setInitialized() { initialized = true; },
    update(partial: Partial<Settings>) {
      update(state => {
        const next = { ...state, ...partial };
        // Sync view-related settings across windows
        const viewSync: Record<string, unknown> = {};
        if ('showSidebar' in partial) viewSync.showSidebar = next.showSidebar;
        if ('showOutline' in partial) viewSync.showOutline = next.showOutline;
        if (Object.keys(viewSync).length > 0) emitViewSync(viewSync);
        return next;
      });
    },
    setTheme(theme: Theme) {
      update(state => {
        const next = { ...state, theme };
        applyTheme(theme);
        applyColorTheme(next);
        return next;
      });
    },
    setColorTheme(themeId: string) {
      update(state => {
        const next = { ...state, colorTheme: themeId };
        applyColorTheme(next);
        return next;
      });
    },
    setDarkColorTheme(themeId: string) {
      update(state => {
        const next = { ...state, darkColorTheme: themeId };
        applyColorTheme(next);
        return next;
      });
    },
    setUseSeparateDarkTheme(value: boolean) {
      update(state => {
        const next = { ...state, useSeparateDarkTheme: value };
        applyColorTheme(next);
        return next;
      });
    },
    setLocaleSelection(selection: LocaleSelection) {
      const resolved = resolveLocale(selection);
      setLocale(resolved);
      update(state => ({ ...state, localeSelection: selection }));
    },
    toggleSidebar() {
      update(state => {
        const next = { ...state, showSidebar: !state.showSidebar };
        emitViewSync({ showSidebar: next.showSidebar });
        return next;
      });
    },
    getState() {
      return get({ subscribe });
    },
    getDefaultImageHostTarget(): ImageHostTarget | null {
      const state = get({ subscribe });
      return state.imageHostTargets.find(t => t.id === state.defaultImageHostId) || null;
    },
    /** v0.37.0: Default Picora account (used for KB sync and cloud resource browse). */
    getDefaultPicoraTarget(): ImageHostTarget | null {
      const state = get({ subscribe });
      const picoraTargets = state.imageHostTargets.filter(t => t.provider === 'picora');
      const byDefault = picoraTargets.find(t => t.id === state.defaultPicoraAccountId);
      if (byDefault) return byDefault;
      return picoraTargets[0] ?? null;
    },
    setDefaultPicoraAccount(id: string) {
      update(state => ({ ...state, defaultPicoraAccountId: id }));
    },
    reset() {
      set(DEFAULT_SETTINGS);
    },
  };
}

export const settingsStore = createSettingsStore();

/** Load persisted settings from disk. Call once at app startup. */
export async function initSettingsStore() {
  try {
    const store = await load(SETTINGS_STORE_FILE);
    const saved = await store.get<Partial<Settings>>('data');
    if (saved) {
      // Merge with defaults to handle new fields added in updates
      settingsStore.update(saved);

      // Migration: the outline default width was widened (200 → 260).
      // Because settings persist wholesale, an existing install carries the
      // OLD default on disk forever and would never see the new one. Anyone
      // sitting on exactly the old value never chose it — it is just what the
      // panel happened to open at — so carry them across. Any other stored
      // width is a deliberate drag and is left untouched.
      if (saved.outlineWidth === OUTLINE_LEGACY_DEFAULT_WIDTH) {
        settingsStore.update({ outlineWidth: OUTLINE_DEFAULT_WIDTH });
      }

      // Migration: single imageHostConfig → imageHostTargets array
      const current = settingsStore.getState();
      if ((!current.imageHostTargets || current.imageHostTargets.length === 0) && current.imageHostConfig) {
        const old = current.imageHostConfig;
        const hasConfig = old.apiToken || old.githubRepoUrl || old.customEndpoint;
        if (hasConfig) {
          const PROVIDER_NAMES: Record<string, string> = { smms: 'SM.MS', imgur: 'Imgur', github: 'GitHub', custom: 'Custom API' };
          const migratedTarget: ImageHostTarget = {
            id: generateImageHostTargetId(),
            name: PROVIDER_NAMES[old.provider] || old.provider,
            provider: old.provider,
            apiToken: old.apiToken,
            customEndpoint: old.customEndpoint,
            customHeaders: old.customHeaders,
            customUrlTemplate: (old as { customUrlTemplate?: string }).customUrlTemplate || '',
            autoUpload: old.autoUpload,
            githubRepoUrl: old.githubRepoUrl,
            githubBranch: old.githubBranch,
            githubDir: old.githubDir,
            githubToken: old.githubToken,
            githubCdn: old.githubCdn,
            gitlabRepoUrl: '',
            gitlabBranch: 'main',
            gitlabDir: 'images/',
            gitlabToken: '',
            gitCustomRepoUrl: '',
            gitCustomBranch: 'main',
            gitCustomDir: 'images/',
            gitCustomToken: '',
            ossAccessKey: '',
            ossSecretKey: '',
            ossBucket: '',
            ossRegion: '',
            ossEndpoint: '',
            ossCdnDomain: '',
            ossPathPrefix: '',
            picoraApiUrl: '',
            picoraApiKey: '',
            picoraImgDomain: '',
            picoraUserEmail: '',
          };
          settingsStore.update({
            imageHostTargets: [migratedTarget],
            defaultImageHostId: migratedTarget.id,
          });
        }
      }

      // v0.37.0 migration: auto-pick the sole Picora target as default Picora account
      const picoraState = settingsStore.getState();
      if (!picoraState.defaultPicoraAccountId) {
        const picoraTargets = picoraState.imageHostTargets.filter(t => t.provider === 'picora');
        if (picoraTargets.length === 1) {
          settingsStore.update({ defaultPicoraAccountId: picoraTargets[0].id });
        }
      }

      // Migration: single imageProviderConfig → imageProviderConfigs array
      const current2 = settingsStore.getState();
      if ((!current2.imageProviderConfigs || current2.imageProviderConfigs.length === 0) && (saved as any).imageProviderConfig) {
        const old = (saved as any).imageProviderConfig;
        if (old.apiKey) {
          old.id = old.id || crypto.randomUUID();
          settingsStore.update({
            imageProviderConfigs: [old],
            activeImageConfigId: old.id,
          });
        }
      }

      // Restore image provider API keys from keychain (before initialization flag)
      const finalState = settingsStore.getState();
      if (finalState.imageProviderConfigs?.length > 0) {
        const restoredImageConfigs = [];
        for (const c of finalState.imageProviderConfigs) {
          if (c.apiKey === '***') {
            try {
              const key = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_IMAGE_PREFIX}${c.id}` });
              restoredImageConfigs.push({ ...c, apiKey: key || '' });
            } catch {
              restoredImageConfigs.push({ ...c, apiKey: '' });
            }
          } else if (c.apiKey && c.apiKey !== '') {
            // Legacy plaintext key — migrate to keychain
            try {
              await invoke('keychain_set', { key: `${KEYCHAIN_IMAGE_PREFIX}${c.id}`, value: c.apiKey });
            } catch { /* ignore */ }
            restoredImageConfigs.push({ ...c });
          } else {
            restoredImageConfigs.push({ ...c });
          }
        }
        settingsStore.update({ imageProviderConfigs: restoredImageConfigs });
      }

      // Restore speech provider API keys from keychain
      const speechState = settingsStore.getState();
      if (speechState.speechProviderConfigs?.length > 0) {
        const restoredSpeechConfigs = [];
        for (const c of speechState.speechProviderConfigs) {
          const restored = { ...c };
          if (c.apiKey === '***') {
            try {
              restored.apiKey = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_SPEECH_PREFIX}${c.id}` }) ?? '';
            } catch { restored.apiKey = ''; }
          }
          if (c.awsAccessKey === '***') {
            try {
              restored.awsAccessKey = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_SPEECH_AWS_AK_PREFIX}${c.id}` }) ?? '';
            } catch { restored.awsAccessKey = ''; }
          }
          if (c.awsSecretKey === '***') {
            try {
              restored.awsSecretKey = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_SPEECH_AWS_SK_PREFIX}${c.id}` }) ?? '';
            } catch { restored.awsSecretKey = ''; }
          }
          restoredSpeechConfigs.push(restored);
        }
        settingsStore.update({ speechProviderConfigs: restoredSpeechConfigs });
      }

      const state = settingsStore.getState();
      applyTheme(state.theme);
      applyColorTheme(state);
      setLocale(resolveLocale(state.localeSelection));
      document.documentElement.style.setProperty('--font-size-base', `${state.fontSize}px`);
    }
  } catch { /* first launch — no saved data */ }
  settingsStore._setInitialized();

  // Cross-window view settings sync: listen for changes from other windows
  if (!windowLabel) {
    try { windowLabel = getCurrentWindow().label; } catch { windowLabel = 'main'; }
  }
  listen<{ source: string; showSidebar?: boolean; showOutline?: boolean }>(VIEW_SYNC_EVENT, (event) => {
    if (event.payload.source === windowLabel) return; // Ignore own events
    const partial: Partial<Settings> = {};
    if ('showSidebar' in event.payload) partial.showSidebar = event.payload.showSidebar;
    if ('showOutline' in event.payload) partial.showOutline = event.payload.showOutline;
    if (Object.keys(partial).length === 0) return;
    syncGuard = true;
    settingsStore.update(partial);
    syncGuard = false;
  }).catch(() => {});
}

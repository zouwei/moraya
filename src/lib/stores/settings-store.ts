import { writable, get } from 'svelte/store';
import { load } from '@tauri-apps/plugin-store';
import { setLocale, detectSystemLocale, type SupportedLocale, type LocaleSelection } from '$lib/i18n';
import { getThemeById } from '$lib/styles/themes';
import { type ImageHostConfig, type ImageHostTarget, DEFAULT_IMAGE_HOST_CONFIG, generateImageHostTargetId } from '$lib/services/image-hosting';
import { type ImageProviderConfig, DEFAULT_IMAGE_PROVIDER_CONFIG } from '$lib/services/ai/types';
import type { PublishTarget } from '$lib/services/publish/types';

const SETTINGS_STORE_FILE = 'settings.json';

export type Theme = 'light' | 'dark' | 'system';

interface Settings {
  theme: Theme;
  colorTheme: string;           // active color theme id for light mode
  darkColorTheme: string;       // color theme id for dark mode
  useSeparateDarkTheme: boolean; // use a different theme in dark mode
  fontFamily: string;
  fontSize: number;
  lineWidth: number;
  autoSave: boolean;
  autoSaveInterval: number; // milliseconds
  showSidebar: boolean;
  showStatusBar: boolean;
  localeSelection: LocaleSelection;
  editorLineWidth: number;
  editorTabSize: number;
  showLineNumbers: boolean;
  imageHostConfig: ImageHostConfig;
  imageHostTargets: ImageHostTarget[];
  defaultImageHostId: string;
  imageProviderConfig: ImageProviderConfig;
  publishTargets: PublishTarget[];
  lastUpdateCheckDate: string | null;  // "YYYY-MM-DD" format
}

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
  showSidebar: false,
  showStatusBar: true,
  localeSelection: 'system',
  editorLineWidth: 800,
  editorTabSize: 4,
  showLineNumbers: false,
  imageHostConfig: { ...DEFAULT_IMAGE_HOST_CONFIG },
  imageHostTargets: [],
  defaultImageHostId: '',
  imageProviderConfig: { ...DEFAULT_IMAGE_PROVIDER_CONFIG },
  publishTargets: [],
  lastUpdateCheckDate: null,
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
    for (const [prop, value] of Object.entries(colorTheme.colors)) {
      root.style.setProperty(prop, value);
    }
  }
}

/** Debounced persist to avoid excessive disk writes */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(state: Settings) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const store = await load(SETTINGS_STORE_FILE);
      await store.set('data', state);
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
      update(state => ({ ...state, showSidebar: !state.showSidebar }));
    },
    getState() {
      return get({ subscribe });
    },
    getDefaultImageHostTarget(): ImageHostTarget | null {
      const state = get({ subscribe });
      return state.imageHostTargets.find(t => t.id === state.defaultImageHostId) || null;
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
            autoUpload: old.autoUpload,
            githubRepoUrl: old.githubRepoUrl,
            githubBranch: old.githubBranch,
            githubDir: old.githubDir,
            githubToken: old.githubToken,
            githubCdn: old.githubCdn,
          };
          settingsStore.update({
            imageHostTargets: [migratedTarget],
            defaultImageHostId: migratedTarget.id,
          });
        }
      }

      const state = settingsStore.getState();
      applyTheme(state.theme);
      applyColorTheme(state);
      setLocale(resolveLocale(state.localeSelection));
      document.documentElement.style.setProperty('--font-size-base', `${state.fontSize}px`);
    }
  } catch { /* first launch — no saved data */ }
  settingsStore._setInitialized();
}

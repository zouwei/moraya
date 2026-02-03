import { writable, get } from 'svelte/store';
import { setLocale, detectSystemLocale, type SupportedLocale, type LocaleSelection } from '$lib/i18n';
import { getThemeById } from '$lib/styles/themes';
import { type ImageHostConfig, DEFAULT_IMAGE_HOST_CONFIG } from '$lib/services/image-hosting';

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

  return {
    subscribe,
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
    reset() {
      set(DEFAULT_SETTINGS);
    },
  };
}

export const settingsStore = createSettingsStore();

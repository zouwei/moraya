import { writable, get } from 'svelte/store';
import { setLocale, detectSystemLocale, type SupportedLocale, type LocaleSelection } from '$lib/i18n';

export type Theme = 'light' | 'dark' | 'system';

interface Settings {
  theme: Theme;
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
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
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
};

function resolveLocale(selection: LocaleSelection): SupportedLocale {
  return selection === 'system' ? detectSystemLocale() : selection;
}

function createSettingsStore() {
  const { subscribe, set, update } = writable<Settings>(DEFAULT_SETTINGS);

  // Apply initial locale
  setLocale(resolveLocale(DEFAULT_SETTINGS.localeSelection));

  return {
    subscribe,
    update(partial: Partial<Settings>) {
      update(state => ({ ...state, ...partial }));
    },
    setTheme(theme: Theme) {
      update(state => ({ ...state, theme }));
      applyTheme(theme);
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

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

export const settingsStore = createSettingsStore();

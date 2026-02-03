import { writable, derived } from 'svelte/store';
import type { SupportedLocale } from './types';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

const translations: Record<SupportedLocale, Record<string, unknown>> = {
  'en': en,
  'zh-CN': zhCN,
};

function resolve(obj: Record<string, unknown>, path: string): string | undefined {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

export function detectSystemLocale(): SupportedLocale {
  try {
    const lang = navigator.language || navigator.languages?.[0] || 'en';
    if (lang.startsWith('zh')) return 'zh-CN';
  } catch {
    // SSR or navigator unavailable
  }
  return 'en';
}

export const locale = writable<SupportedLocale>(detectSystemLocale());

export function setLocale(l: SupportedLocale) {
  locale.set(l);
}

/**
 * Derived store that returns a translation function.
 * Usage in Svelte template: {$t('settings.theme.label')}
 * With params: {$t('settings.version', { version: '0.1.0' })}
 */
export const t = derived(locale, ($locale) => {
  return (key: string, params?: Record<string, string>): string => {
    // Try current locale, then fallback to English, then return key
    let value = resolve(translations[$locale], key)
      ?? resolve(translations['en'], key)
      ?? key;

    if (params) {
      value = value.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? _);
    }

    return value;
  };
});

export type SupportedLocale = 'en' | 'zh-CN';
export type LocaleSelection = SupportedLocale | 'system';

export interface LocaleOption {
  code: LocaleSelection;
  label: string; // Always in that language's own script
}

export const SUPPORTED_LOCALES: LocaleOption[] = [
  { code: 'system', label: 'System' },
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
];

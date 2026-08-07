/**
 * Built-in color themes for Moraya.
 * Each theme defines CSS custom property overrides.
 */

export interface ColorTheme {
  id: string;
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
}

export const builtinThemes: ColorTheme[] = [
  // ── Light themes ──
  {
    id: 'default-light',
    name: 'Default Light',
    type: 'light',
    colors: {
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f8f9fa',
      '--bg-sidebar': '#f0f1f3',
      '--bg-titlebar': '#fafafa',
      '--bg-hover': '#e9ecef',
      '--bg-active': '#dee2e6',
      '--text-primary': '#1a1a1a',
      '--text-secondary': '#6c757d',
      '--text-muted': '#adb5bd',
      '--border-color': '#e0e0e0',
      '--border-light': '#f0f0f0',
      '--accent-color': '#4a90d9',
      '--accent-hover': '#357abd',
      '--scrollbar-thumb': '#c1c1c1',
    },
  },
  {
    id: 'github',
    name: 'Github',
    type: 'light',
    colors: {
      '--bg-primary': '#ffffff',
      '--bg-secondary': '#f6f8fa',
      '--bg-sidebar': '#f0f1f3',
      '--bg-titlebar': '#f6f8fa',
      '--bg-hover': '#eaeef2',
      '--bg-active': '#d0d7de',
      '--text-primary': '#1f2328',
      '--text-secondary': '#656d76',
      '--text-muted': '#8b949e',
      '--border-color': '#d0d7de',
      '--border-light': '#d8dee4',
      '--accent-color': '#0969da',
      '--accent-hover': '#0550ae',
      '--scrollbar-thumb': '#c1c1c1',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    type: 'light',
    colors: {
      '--bg-primary': '#fdf6e3',
      '--bg-secondary': '#eee8d5',
      '--bg-sidebar': '#eee8d5',
      '--bg-titlebar': '#fdf6e3',
      '--bg-hover': '#e8e1cc',
      '--bg-active': '#ddd6c1',
      '--text-primary': '#586e75',
      '--text-secondary': '#839496',
      '--text-muted': '#93a1a1',
      '--border-color': '#d6ccb3',
      '--border-light': '#eee8d5',
      '--accent-color': '#268bd2',
      '--accent-hover': '#1a6da0',
      '--scrollbar-thumb': '#c1b899',
    },
  },

  // ── Dark themes ──
  {
    id: 'default-dark',
    name: 'Default Dark',
    type: 'dark',
    colors: {
      '--bg-primary': '#1e1e1e',
      '--bg-secondary': '#252526',
      '--bg-sidebar': '#1c1c1e',
      '--bg-titlebar': '#2d2d2d',
      '--bg-hover': '#2a2d2e',
      '--bg-active': '#37373d',
      '--text-primary': '#d4d4d4',
      '--text-secondary': '#858585',
      '--text-muted': '#5a5a5a',
      '--border-color': '#3c3c3c',
      '--border-light': '#2d2d2d',
      '--accent-color': '#569cd6',
      '--accent-hover': '#6cb0e0',
      '--scrollbar-thumb': '#4a4a4a',
    },
  },
  {
    id: 'github-dark',
    name: 'Github Dark',
    type: 'dark',
    colors: {
      '--bg-primary': '#0d1117',
      '--bg-secondary': '#161b22',
      '--bg-sidebar': '#0d1117',
      '--bg-titlebar': '#161b22',
      '--bg-hover': '#1c2128',
      '--bg-active': '#262c36',
      '--text-primary': '#e6edf3',
      '--text-secondary': '#8b949e',
      '--text-muted': '#484f58',
      '--border-color': '#30363d',
      '--border-light': '#21262d',
      '--accent-color': '#58a6ff',
      '--accent-hover': '#79c0ff',
      '--scrollbar-thumb': '#484f58',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    type: 'dark',
    colors: {
      '--bg-primary': '#282a36',
      '--bg-secondary': '#21222c',
      '--bg-sidebar': '#21222c',
      '--bg-titlebar': '#282a36',
      '--bg-hover': '#343746',
      '--bg-active': '#44475a',
      '--text-primary': '#f8f8f2',
      '--text-secondary': '#9da0b3',
      '--text-muted': '#6272a4',
      '--border-color': '#44475a',
      '--border-light': '#343746',
      '--accent-color': '#bd93f9',
      '--accent-hover': '#caa8fc',
      '--scrollbar-thumb': '#6272a4',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    type: 'dark',
    colors: {
      '--bg-primary': '#282c34',
      '--bg-secondary': '#21252b',
      '--bg-sidebar': '#21252b',
      '--bg-titlebar': '#282c34',
      '--bg-hover': '#2c313a',
      '--bg-active': '#3a3f4b',
      '--text-primary': '#abb2bf',
      '--text-secondary': '#7f848e',
      '--text-muted': '#5c6370',
      '--border-color': '#3e4451',
      '--border-light': '#2c313a',
      '--accent-color': '#61afef',
      '--accent-hover': '#82c4f8',
      '--scrollbar-thumb': '#4b5263',
    },
  },
];

export function getThemeById(id: string): ColorTheme | undefined {
  return builtinThemes.find(t => t.id === id);
}

export function getLightThemes(): ColorTheme[] {
  return builtinThemes.filter(t => t.type === 'light');
}

export function getDarkThemes(): ColorTheme[] {
  return builtinThemes.filter(t => t.type === 'dark');
}

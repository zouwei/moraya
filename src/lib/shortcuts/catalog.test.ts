import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  canonicalizeBinding,
  eventToBinding,
  eventMatchesBinding,
  effectiveBinding,
  findBindingConflict,
  bindingToTauriAccel,
  SHORTCUT_CATALOG,
  scopeOf,
  SCOPE_ORDER,
  SCOPE_LABEL_KEYS,
  FLAVOR_ONLY_MENU_ITEMS,
  disabledMenuItemsFor,
} from './catalog';

/** Build a KeyboardEvent-shape object that the matchers can read. */
function ev(key: string, opts: {
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; code?: string;
} = {}): KeyboardEvent {
  return {
    key,
    code: opts.code ?? '',
    metaKey: !!opts.metaKey,
    ctrlKey: !!opts.ctrlKey,
    altKey: !!opts.altKey,
    shiftKey: !!opts.shiftKey,
  } as KeyboardEvent;
}

describe('canonicalizeBinding', () => {
  it('orders modifiers Cmd, Ctrl, Alt, Shift', () => {
    expect(canonicalizeBinding('Shift+Cmd+F')).toBe('Cmd+Shift+f');
    expect(canonicalizeBinding('Alt+Ctrl+T')).toBe('Ctrl+Alt+t');
  });

  it('lowercases single-char keys, preserves named keys', () => {
    expect(canonicalizeBinding('Cmd+F')).toBe('Cmd+f');
    expect(canonicalizeBinding('Cmd+Enter')).toBe('Cmd+Enter');
    expect(canonicalizeBinding('Cmd+ArrowUp')).toBe('Cmd+ArrowUp');
  });

  it('treats Meta/Command/Cmd as equivalent', () => {
    expect(canonicalizeBinding('Meta+F')).toBe(canonicalizeBinding('Cmd+F'));
    expect(canonicalizeBinding('Command+F')).toBe(canonicalizeBinding('Cmd+F'));
  });

  it('treats Option/Alt as equivalent', () => {
    expect(canonicalizeBinding('Option+F')).toBe(canonicalizeBinding('Alt+F'));
  });

  it('returns empty for empty input', () => {
    expect(canonicalizeBinding('')).toBe('');
  });
});

describe('eventToBinding', () => {
  it('returns null for pure modifier press', () => {
    expect(eventToBinding(ev('Meta', { metaKey: true }), true)).toBeNull();
    expect(eventToBinding(ev('Shift', { shiftKey: true }), true)).toBeNull();
    expect(eventToBinding(ev('Control', { ctrlKey: true }), true)).toBeNull();
  });

  it('macOS: maps metaKey to Cmd, ctrlKey to Ctrl', () => {
    expect(eventToBinding(ev('f', { metaKey: true }), true)).toBe('Cmd+f');
    expect(eventToBinding(ev('f', { ctrlKey: true }), true)).toBe('Ctrl+f');
    expect(eventToBinding(ev('f', { metaKey: true, ctrlKey: true }), true)).toBe('Cmd+Ctrl+f');
  });

  it('Win/Linux: collapses metaKey and ctrlKey into Ctrl', () => {
    expect(eventToBinding(ev('f', { ctrlKey: true }), false)).toBe('Ctrl+f');
    expect(eventToBinding(ev('f', { metaKey: true }), false)).toBe('Ctrl+f');
  });

  it('preserves named keys verbatim', () => {
    expect(eventToBinding(ev('Enter', { metaKey: true }), true)).toBe('Cmd+Enter');
    expect(eventToBinding(ev('ArrowUp', { shiftKey: true, metaKey: true }), true)).toBe('Cmd+Shift+ArrowUp');
  });

  it('uses event.code to recover Shift+/ as Shift+/', () => {
    // Shift+/ produces '?' on US keyboards but binding should read as '/'
    const out = eventToBinding(ev('?', { metaKey: true, shiftKey: true, code: 'Slash' }), true);
    expect(out).toBe('Cmd+Shift+/');
  });

  it('lowercases single-char letters', () => {
    expect(eventToBinding(ev('F', { metaKey: true }), true)).toBe('Cmd+f');
  });
});

describe('eventMatchesBinding', () => {
  it('matches via canonical form (order independent)', () => {
    expect(eventMatchesBinding(ev('f', { metaKey: true }), 'Cmd+F', true)).toBe(true);
    expect(eventMatchesBinding(ev('f', { metaKey: true, shiftKey: true }), 'Shift+Cmd+f', true)).toBe(true);
  });

  it('rejects when modifier missing', () => {
    expect(eventMatchesBinding(ev('f'), 'Cmd+F', true)).toBe(false);
  });

  it('rejects when extra modifier present', () => {
    expect(eventMatchesBinding(ev('f', { metaKey: true, altKey: true }), 'Cmd+F', true)).toBe(false);
  });

  it('rejects key mismatch', () => {
    expect(eventMatchesBinding(ev('g', { metaKey: true }), 'Cmd+F', true)).toBe(false);
  });

  it('platform-agnostic Cmd→Ctrl on win when binding uses Cmd', () => {
    expect(eventMatchesBinding(ev('f', { ctrlKey: true }), 'Ctrl+F', false)).toBe(true);
  });
});

describe('effectiveBinding', () => {
  const entry = SHORTCUT_CATALOG.find(e => e.id === 'edit.find')!;

  it('returns default when no overrides', () => {
    expect(effectiveBinding(entry, true)).toBe('Cmd+F');
    expect(effectiveBinding(entry, false)).toBe('Ctrl+F');
  });

  it('returns default when overrides exist but not for this entry', () => {
    expect(effectiveBinding(entry, true, { 'something.else': 'Cmd+J' })).toBe('Cmd+F');
  });

  it('returns override when set', () => {
    expect(effectiveBinding(entry, true, { 'edit.find': 'Cmd+Shift+F' })).toBe('Cmd+Shift+F');
  });

  it('honors override for file.new (now customizable in v0.41.5+)', () => {
    const fileNew = SHORTCUT_CATALOG.find(e => e.id === 'file.new')!;
    expect(fileNew.customizable).toBe(true);
    expect(effectiveBinding(fileNew, true, { 'file.new': 'Cmd+Shift+N' })).toBe('Cmd+Shift+N');
  });
});

describe('findBindingConflict', () => {
  it('returns null when no conflict', () => {
    expect(findBindingConflict('Cmd+Shift+J', 'edit.find', true)).toBeNull();
  });

  it('detects conflict with another customizable entry default', () => {
    // edit.replace defaults to Cmd+H — recording it for edit.find should conflict
    const conflict = findBindingConflict('Cmd+H', 'edit.find', true);
    expect(conflict?.id).toBe('edit.replace');
  });

  it('excludes the entry being edited from conflict check', () => {
    expect(findBindingConflict('Cmd+F', 'edit.find', true)).toBeNull();
  });

  it('respects overrides when computing the existing binding to compare against', () => {
    // edit.replace has been overridden to Cmd+J → recording Cmd+H for find is OK
    const overrides = { 'edit.replace': 'Cmd+J' };
    expect(findBindingConflict('Cmd+H', 'edit.find', true, overrides)).toBeNull();
    // But recording Cmd+J for find now conflicts with the overridden replace
    expect(findBindingConflict('Cmd+J', 'edit.find', true, overrides)?.id).toBe('edit.replace');
  });

  it('detects conflict with file.new now that all entries are customizable', () => {
    // Cmd+N is file.new — recording it for edit.find should now register as conflict
    expect(findBindingConflict('Cmd+N', 'edit.find', true)?.id).toBe('file.new');
  });
});

describe('bindingToTauriAccel', () => {
  it('Cmd+F → CmdOrCtrl+F', () => {
    expect(bindingToTauriAccel('Cmd+F')).toBe('CmdOrCtrl+F');
  });

  it('Ctrl+F → CmdOrCtrl+F (Cmd and Ctrl collapse)', () => {
    expect(bindingToTauriAccel('Ctrl+F')).toBe('CmdOrCtrl+F');
  });

  it('multi-modifier Cmd+Shift+F → CmdOrCtrl+Shift+F', () => {
    expect(bindingToTauriAccel('Cmd+Shift+F')).toBe('CmdOrCtrl+Shift+F');
  });

  it('preserves named keys (Enter, Tab, Escape)', () => {
    expect(bindingToTauriAccel('Cmd+Enter')).toBe('CmdOrCtrl+Enter');
    expect(bindingToTauriAccel('Cmd+Tab')).toBe('CmdOrCtrl+Tab');
  });

  it('preserves punctuation single-chars', () => {
    expect(bindingToTauriAccel('Cmd+,')).toBe('CmdOrCtrl+,');
    expect(bindingToTauriAccel('Cmd+/')).toBe('CmdOrCtrl+/');
    expect(bindingToTauriAccel('Cmd+\\')).toBe('CmdOrCtrl+\\');
  });

  it('uppercases lowercase letters', () => {
    expect(bindingToTauriAccel('Cmd+f')).toBe('CmdOrCtrl+F');
  });

  it('accepts F-keys without modifier', () => {
    expect(bindingToTauriAccel('F5')).toBe('F5');
    expect(bindingToTauriAccel('F12')).toBe('F12');
    expect(bindingToTauriAccel('Cmd+F5')).toBe('CmdOrCtrl+F5');
  });

  it('accepts ArrowKeys / Escape without modifier', () => {
    expect(bindingToTauriAccel('Escape')).toBe('Escape');
    expect(bindingToTauriAccel('ArrowUp')).toBe('ArrowUp');
  });

  it('rejects single letter without modifier', () => {
    expect(bindingToTauriAccel('F')).toBeNull();
    expect(bindingToTauriAccel('a')).toBeNull();
  });

  it('rejects empty / whitespace', () => {
    expect(bindingToTauriAccel('')).toBeNull();
    expect(bindingToTauriAccel('+')).toBeNull();
  });

  it('rejects unknown named keys', () => {
    expect(bindingToTauriAccel('Cmd+Frobnicate')).toBeNull();
  });

  it('rejects two main keys', () => {
    expect(bindingToTauriAccel('Cmd+F+G')).toBeNull();
  });

  it('treats Option as Alt', () => {
    expect(bindingToTauriAccel('Option+F')).toBe('Alt+F');
  });

  it('treats Meta and Command as Cmd', () => {
    expect(bindingToTauriAccel('Meta+F')).toBe('CmdOrCtrl+F');
    expect(bindingToTauriAccel('Command+F')).toBe('CmdOrCtrl+F');
  });
});

describe('catalog menuItemId integrity', () => {
  it('every entry except workflow.* / aiChat.* has a menuItemId', () => {
    const missing: string[] = [];
    for (const e of SHORTCUT_CATALOG) {
      const expectMenuId = !e.id.startsWith('workflow.') && !e.id.startsWith('aiChat.');
      if (expectMenuId && !e.menuItemId) missing.push(e.id);
    }
    expect(missing).toEqual([]);
  });

  it('menuItemIds are unique', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of SHORTCUT_CATALOG) {
      if (!e.menuItemId) continue;
      if (seen.has(e.menuItemId)) dupes.push(e.menuItemId);
      seen.add(e.menuItemId);
    }
    expect(dupes).toEqual([]);
  });
});

describe('getRuntimeCatalog (v0.41.6 MCP dynamic entries)', () => {
  it('returns the static catalog when no MCP state is provided', async () => {
    const { getRuntimeCatalog, SHORTCUT_CATALOG_STATIC } = await import('./catalog');
    const result = getRuntimeCatalog([], [], []);
    expect(result).toEqual(SHORTCUT_CATALOG_STATIC);
  });

  it('appends one mcp.server.<id>.toggle entry per installed server', async () => {
    const { getRuntimeCatalog } = await import('./catalog');
    const result = getRuntimeCatalog(
      [
        { id: 'mcp-1', name: 'Filesystem', enabled: true },
        { id: 'preset-git', name: 'Git', enabled: false },
      ],
      [],
      [],
    );
    const dyn = result.filter(e => e.category === 'mcp');
    expect(dyn).toHaveLength(2);
    expect(dyn[0]!.id).toBe('mcp.server.mcp-1.toggle');
    expect(dyn[0]!.dynamicKind).toBe('mcp.server');
    expect(dyn[0]!.label).toBe('Filesystem');
    expect(dyn[0]!.stale).toBe(false);
    expect(dyn[0]!.menuItemId).toBeUndefined();
    expect(dyn[1]!.id).toBe('mcp.server.preset-git.toggle');
    expect(dyn[1]!.label).toBe('Git');
  });

  it('appends one mcp.tool entry per user-added tool shortcut', async () => {
    const { getRuntimeCatalog } = await import('./catalog');
    const result = getRuntimeCatalog(
      [{ id: 'mcp-1', name: 'Filesystem', enabled: true }],
      [{ name: 'read_file', serverId: 'mcp-1' }],
      [{
        catalogId: 'mcp.tool.mcp-1.read_file.prompt',
        serverId: 'mcp-1',
        toolName: 'read_file',
      }],
    );
    const tool = result.find(e => e.id === 'mcp.tool.mcp-1.read_file.prompt');
    expect(tool).toBeTruthy();
    expect(tool!.dynamicKind).toBe('mcp.tool');
    expect(tool!.label).toBe('read_file · Filesystem');
    expect(tool!.stale).toBe(false);
    expect(tool!.serverId).toBe('mcp-1');
    expect(tool!.toolName).toBe('read_file');
  });

  it('marks tool entries stale when server is gone', async () => {
    const { getRuntimeCatalog } = await import('./catalog');
    const result = getRuntimeCatalog(
      [], // no servers
      [],
      [{
        catalogId: 'mcp.tool.mcp-1.read_file.prompt',
        serverId: 'mcp-1',
        toolName: 'read_file',
      }],
    );
    const tool = result.find(e => e.id === 'mcp.tool.mcp-1.read_file.prompt');
    expect(tool).toBeTruthy();
    expect(tool!.stale).toBe(true);
    expect(tool!.label).toBe('read_file');
  });

  it('marks tool entries stale when tool is gone from server', async () => {
    const { getRuntimeCatalog } = await import('./catalog');
    const result = getRuntimeCatalog(
      [{ id: 'mcp-1', name: 'Filesystem', enabled: true }],
      [], // server present but tool removed
      [{
        catalogId: 'mcp.tool.mcp-1.read_file.prompt',
        serverId: 'mcp-1',
        toolName: 'read_file',
      }],
    );
    const tool = result.find(e => e.id === 'mcp.tool.mcp-1.read_file.prompt');
    expect(tool!.stale).toBe(true);
  });

  it('does NOT include MCP entries in the static fallback catalog', async () => {
    const { SHORTCUT_CATALOG, SHORTCUT_CATALOG_STATIC } = await import('./catalog');
    // The deprecated alias matches the static set 1:1 — never includes dynamic mcp.*
    expect(SHORTCUT_CATALOG).toBe(SHORTCUT_CATALOG_STATIC);
    expect(SHORTCUT_CATALOG.some(e => e.category === 'mcp')).toBe(false);
  });
});

describe('findBindingConflict + runtime catalog', () => {
  it('detects conflicts when one side is a dynamic MCP entry', async () => {
    const { getRuntimeCatalog, findBindingConflict } = await import('./catalog');
    const catalog = getRuntimeCatalog(
      [{ id: 'mcp-1', name: 'Filesystem', enabled: true }],
      [],
      [],
    );
    // User wants to bind Cmd+Alt+1 to file.save — what if they already
    // bound it to the Filesystem toggle?
    const overrides = { 'mcp.server.mcp-1.toggle': 'Cmd+Alt+1' };
    const conflict = findBindingConflict('Cmd+Alt+1', 'file.save', true, overrides, catalog);
    expect(conflict?.id).toBe('mcp.server.mcp-1.toggle');
  });

  it('does NOT conflict with stale entries', async () => {
    const { getRuntimeCatalog, findBindingConflict } = await import('./catalog');
    const catalog = getRuntimeCatalog(
      [], // server gone → tool entry is stale
      [],
      [{
        catalogId: 'mcp.tool.gone.read_file.prompt',
        serverId: 'gone',
        toolName: 'read_file',
      }],
    );
    const overrides = { 'mcp.tool.gone.read_file.prompt': 'Cmd+Alt+R' };
    // Recording Cmd+Alt+R for a different entry should NOT collide with a stale binding
    const conflict = findBindingConflict('Cmd+Alt+R', 'file.save', true, overrides, catalog);
    expect(conflict).toBeNull();
  });
});

describe('document-flavor scopes (v0.46.0)', () => {
  it('treats an omitted scope as shared', () => {
    const bold = SHORTCUT_CATALOG.find((e) => e.id === 'format.bold')!;
    expect(bold.scope).toBeUndefined();
    expect(scopeOf(bold)).toBe('shared');
  });

  it('keeps every Paragraph/Format binding shared so both flavors reuse it', () => {
    const shared = SHORTCUT_CATALOG.filter(
      (e) => e.category === 'paragraph' || e.category === 'format',
    );
    expect(shared.length).toBeGreaterThan(0);
    for (const entry of shared) expect(scopeOf(entry)).toBe('shared');
  });

  it('exposes the Typst file actions that previously had no catalog row', () => {
    const ids = SHORTCUT_CATALOG.map((e) => e.id);
    expect(ids).toContain('file.newTypst');
    expect(ids).toContain('file.convertTypst');
  });

  it('scopes the Typst-only and Markdown-only file actions', () => {
    const byId = (id: string) => SHORTCUT_CATALOG.find((e) => e.id === id)!;
    expect(scopeOf(byId('file.newTypst'))).toBe('typst');
    // Converting flips the active document either way — available in both.
    expect(scopeOf(byId('file.convertTypst'))).toBe('shared');
  });

  it('has a label key for every scope, in panel order', () => {
    expect(SCOPE_ORDER).toEqual(['shared', 'markdown', 'typst']);
    for (const s of SCOPE_ORDER) expect(SCOPE_LABEL_KEYS[s]).toMatch(/^shortcuts\.scopes\./);
  });

  it('disables the other flavor’s exclusive menu items', () => {
    expect(disabledMenuItemsFor('typst')).toEqual(FLAVOR_ONLY_MENU_ITEMS.markdown);
    expect(disabledMenuItemsFor('typst')).toContain('para_task_list');
    expect(disabledMenuItemsFor('typst')).toContain('insert_cloud_video');
    // Nothing Typst-exclusive exists yet, so a markdown document greys nothing.
    expect(disabledMenuItemsFor('markdown')).toEqual([]);
  });

  it('never disables a shared menu item', () => {
    const sharedMenuIds = new Set(
      SHORTCUT_CATALOG.filter((e) => scopeOf(e) === 'shared' && e.menuItemId).map(
        (e) => e.menuItemId!,
      ),
    );
    for (const id of [...FLAVOR_ONLY_MENU_ITEMS.markdown, ...FLAVOR_ONLY_MENU_ITEMS.typst]) {
      expect(sharedMenuIds.has(id)).toBe(false);
    }
  });

  it('gates every flavor-scoped menu row unless it is explicitly always-available', () => {
    // A scoped row that maps to a native menu item must either be greyed out in
    // the other flavor, or opt out via `alwaysAvailable` — otherwise the panel
    // would advertise a restriction the menu never enforces.
    for (const entry of SHORTCUT_CATALOG) {
      const scope = scopeOf(entry);
      if (scope === 'shared' || !entry.menuItemId) continue;
      if (entry.alwaysAvailable) continue;
      expect(FLAVOR_ONLY_MENU_ITEMS[scope]).toContain(entry.menuItemId);
    }
  });

  it('keeps document-creation actions available from either flavor', () => {
    const newTypst = SHORTCUT_CATALOG.find((e) => e.id === 'file.newTypst')!;
    expect(newTypst.alwaysAvailable).toBe(true);
    // Creating a .typ file must work while a markdown document is open.
    expect(disabledMenuItemsFor('markdown')).not.toContain('file_new_typst');
    expect(disabledMenuItemsFor('typst')).not.toContain('file_new_typst');
  });
});

describe('menu gate ids exist in the native menu (cross-language guard)', () => {
  // The gate list is only effective if every id matches a real menu item in
  // src-tauri/src/menu.rs — a typo or a renamed item would silently stop
  // greying anything out, with no type error to catch it.
  const menuRs = readFileSync(
    new URL('../../../src-tauri/src/menu.rs', import.meta.url),
    'utf8',
  );

  const gated = [...FLAVOR_ONLY_MENU_ITEMS.markdown, ...FLAVOR_ONLY_MENU_ITEMS.typst];

  it('has at least one gated item', () => {
    expect(gated.length).toBeGreaterThan(0);
  });

  it.each(gated)('menu.rs declares "%s"', (id) => {
    expect(menuRs).toContain(`"${id}"`);
  });

  it('declares every catalog menuItemId in menu.rs', () => {
    for (const entry of SHORTCUT_CATALOG) {
      if (!entry.menuItemId) continue;
      expect(menuRs, `${entry.id} → ${entry.menuItemId}`).toContain(`"${entry.menuItemId}"`);
    }
  });
});

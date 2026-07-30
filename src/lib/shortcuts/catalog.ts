/**
 * Catalog of all keyboard shortcuts in the desktop app.
 *
 * All entries are user-customizable from the Shortcuts settings panel.
 * Customization works via two layers:
 *  1. Frontend JS in `+page.svelte handleKeydown` honors `shortcutOverrides`
 *     and dispatches the corresponding action when a user-bound combo fires.
 *  2. The native Tauri menu still carries the original accelerator (baked at
 *     build time from `src-tauri/src/menu.rs`); the user-recorded combo runs
 *     in parallel via the JS handler. Rebuilding the native menu to drop the
 *     original accelerator is a follow-up iteration.
 *
 * `customizable` exists as an extension point if a future entry must be
 * locked (e.g. OS-reserved combos like Cmd+Q). Today all entries are `true`.
 *
 * The display string (`mac` / `win`) uses platform conventions: `Cmd` on
 * macOS, `Ctrl` on Windows/Linux. UI components should pick the right one
 * via `isMacOS`.
 */

export type ShortcutCategory =
  | 'file'
  | 'edit'
  | 'paragraph'
  | 'format'
  | 'view'
  | 'aiChat'
  | 'workflow'
  | 'mcp';

/**
 * Which document flavor a shortcut applies to (v0.46.0).
 *
 * Moraya edits two document formats — Markdown (ProseMirror) and Typst
 * (source + compiled preview). Actions that exist in both keep ONE menu item
 * and ONE binding (`shared`); the rest are only effective in their own format
 * and are greyed out in the native menu when the other flavor is active.
 * Used by the Shortcuts settings panel to group bindings into
 * shared / Markdown-only / Typst-only sections.
 */
export type DocScope = 'shared' | 'markdown' | 'typst';

export interface ShortcutEntry {
  /** Stable id used as both the i18n key and the customization key in settings. */
  id: string;
  category: ShortcutCategory;
  /** Document flavor this binding belongs to. Omitted === 'shared'. */
  scope?: DocScope;
  /**
   * Set on flavor-scoped actions that stay invocable from EITHER flavor, so
   * they are listed under their format's section but never greyed out —
   * document-creation actions ("New Typst Document" must work while a markdown
   * file is open, otherwise a .typ file could never be created).
   */
  alwaysAvailable?: boolean;
  /** i18n key (under `shortcuts.actions.<id>`) for the human-readable label.
   *  Dynamic entries (mcp.*) leave this empty and use `label` instead. */
  labelKey: string;
  /** Default key combo on macOS — e.g. `Cmd+S`, `Cmd+Shift+I`. */
  mac: string;
  /** Default key combo on Windows / Linux — e.g. `Ctrl+S`. */
  win: string;
  /** Whether the binding can currently be customized in the panel. */
  customizable: boolean;
  /**
   * Native menu item id (from `src-tauri/src/menu.rs`) this shortcut maps to,
   * or `undefined` for frontend-only shortcuts (Quick Open, AI chat send,
   * any mcp.* dynamic entry).
   * Used by `menu-sync.ts` to push accelerator overrides to the native menu.
   */
  menuItemId?: string;

  // ── Dynamic-entry fields (v0.41.6) ───────────────────────────────
  // These only apply to entries produced by `getRuntimeCatalog()` (MCP
  // servers / tools). Static entries leave them undefined.

  /** Pre-resolved display label — overrides `labelKey` lookup when present. */
  label?: string;
  /** True if generated at runtime from MCP state (not in the static catalog). */
  dynamic?: boolean;
  /** Subtype for runtime branching in the panel + action dispatcher. */
  dynamicKind?: 'mcp.server' | 'mcp.tool';
  /** True if the referenced server / tool is no longer installed.
   *  Stale entries are rendered with a "remove" affordance instead of "edit". */
  stale?: boolean;
  /** For mcp.* entries: the MCP server id this binding references. */
  serverId?: string;
  /** For mcp.tool entries: the MCP tool name this binding references. */
  toolName?: string;
}

/**
 * User-added MCP tool shortcut reference. Lives in `settings.mcpToolShortcuts`
 * and tells `getRuntimeCatalog()` which tools to add to the dynamic catalog.
 * Bindings themselves live in `settings.shortcutOverrides` keyed by
 * `catalogId` (same key used as `ShortcutEntry.id`).
 */
export interface MCPToolShortcutRef {
  catalogId: string;
  serverId: string;
  toolName: string;
}

/** Minimal shape `getRuntimeCatalog` needs — keeps this module decoupled
 *  from the full MCP types. */
export interface MCPServerStub { id: string; name: string; enabled: boolean; }
export interface MCPToolStub { name: string; serverId: string; description?: string; }

export const SHORTCUT_CATALOG_STATIC: ShortcutEntry[] = [
  // ── File (native menu) ─────────────────────────────────────────
  { id: 'file.new',         category: 'file', labelKey: 'shortcuts.actions.file.new',         mac: 'Cmd+N',       win: 'Ctrl+N',       customizable: true, menuItemId: 'file_new'},
  { id: 'file.newWindow',   category: 'file', labelKey: 'shortcuts.actions.file.new_window',   mac: 'Cmd+Shift+N', win: 'Ctrl+Shift+N', customizable: true, menuItemId: 'file_new_window'},
  { id: 'file.open',        category: 'file', labelKey: 'shortcuts.actions.file.open',        mac: 'Cmd+O',       win: 'Ctrl+O',       customizable: true, menuItemId: 'file_open'},
  { id: 'file.save',        category: 'file', labelKey: 'shortcuts.actions.file.save',        mac: 'Cmd+S',       win: 'Ctrl+S',       customizable: true, menuItemId: 'file_save'},
  { id: 'file.saveAs',      category: 'file', labelKey: 'shortcuts.actions.file.save_as',      mac: 'Cmd+Shift+S', win: 'Ctrl+Shift+S', customizable: true, menuItemId: 'file_save_as'},
  { id: 'file.exportHtml',  category: 'file', labelKey: 'shortcuts.actions.file.export_html',  mac: 'Cmd+Shift+E', win: 'Ctrl+Shift+E', customizable: true, menuItemId: 'file_export_html'},
  // Typst document actions. `newTypst` creates a .typ document; `convertTypst`
  // flips the active document between the two flavors (hence shared).
  { id: 'file.newTypst',    category: 'file', scope: 'typst', alwaysAvailable: true, labelKey: 'shortcuts.actions.file.new_typst', mac: '', win: '', customizable: true, menuItemId: 'file_new_typst'},
  { id: 'file.convertTypst', category: 'file',                   labelKey: 'shortcuts.actions.file.convert_typst', mac: '', win: '', customizable: true, menuItemId: 'file_convert_typst'},
  // v0.41.5 (Phase B): export PDF/Image/Word — no default accelerators;
  // user can set their own via Settings → Shortcuts.
  { id: 'file.exportPdf',   category: 'file', labelKey: 'shortcuts.actions.file.export_pdf',   mac: '', win: '', customizable: true, menuItemId: 'file_export_pdf' },
  { id: 'file.exportImage', category: 'file', labelKey: 'shortcuts.actions.file.export_image', mac: '', win: '', customizable: true, menuItemId: 'file_export_image' },
  { id: 'file.exportDoc',   category: 'file', labelKey: 'shortcuts.actions.file.export_doc',   mac: '', win: '', customizable: true, menuItemId: 'file_export_doc' },

  // ── Edit (native menu + page-level) ────────────────────────────
  { id: 'edit.undo',        category: 'edit', labelKey: 'shortcuts.actions.edit.undo',        mac: 'Cmd+Z',       win: 'Ctrl+Z',       customizable: true, menuItemId: 'edit_undo'},
  { id: 'edit.redo',        category: 'edit', labelKey: 'shortcuts.actions.edit.redo',        mac: 'Cmd+Shift+Z', win: 'Ctrl+Y',       customizable: true, menuItemId: 'edit_redo'},
  { id: 'edit.find',        category: 'edit', scope: 'markdown', labelKey: 'shortcuts.actions.edit.find',        mac: 'Cmd+F',       win: 'Ctrl+F',       customizable: true, menuItemId: 'edit_find'  },
  { id: 'edit.replace',     category: 'edit', scope: 'markdown', labelKey: 'shortcuts.actions.edit.replace',     mac: 'Cmd+H',       win: 'Ctrl+H',       customizable: true, menuItemId: 'edit_replace'  },

  // ── Paragraph (native menu) ────────────────────────────────────
  { id: 'paragraph.h1',     category: 'paragraph', labelKey: 'shortcuts.actions.paragraph.h1',         mac: 'Cmd+1',       win: 'Ctrl+1',       customizable: true, menuItemId: 'para_h1'},
  { id: 'paragraph.h2',     category: 'paragraph', labelKey: 'shortcuts.actions.paragraph.h2',         mac: 'Cmd+2',       win: 'Ctrl+2',       customizable: true, menuItemId: 'para_h2'},
  { id: 'paragraph.h3',     category: 'paragraph', labelKey: 'shortcuts.actions.paragraph.h3',         mac: 'Cmd+3',       win: 'Ctrl+3',       customizable: true, menuItemId: 'para_h3'},
  { id: 'paragraph.h4',     category: 'paragraph', labelKey: 'shortcuts.actions.paragraph.h4',         mac: 'Cmd+4',       win: 'Ctrl+4',       customizable: true, menuItemId: 'para_h4'},
  { id: 'paragraph.h5',     category: 'paragraph', labelKey: 'shortcuts.actions.paragraph.h5',         mac: 'Cmd+5',       win: 'Ctrl+5',       customizable: true, menuItemId: 'para_h5'},
  { id: 'paragraph.h6',     category: 'paragraph', labelKey: 'shortcuts.actions.paragraph.h6',         mac: 'Cmd+6',       win: 'Ctrl+6',       customizable: true, menuItemId: 'para_h6'},
  { id: 'paragraph.codeBlock', category: 'paragraph', labelKey: 'shortcuts.actions.paragraph.code_block', mac: 'Cmd+Shift+K', win: 'Ctrl+Shift+K', customizable: true, menuItemId: 'para_code_block'},
  { id: 'paragraph.quote',  category: 'paragraph', labelKey: 'shortcuts.actions.paragraph.quote',      mac: 'Cmd+Shift+Q', win: 'Ctrl+Shift+Q', customizable: true, menuItemId: 'para_quote'},

  // ── Format (native menu) ───────────────────────────────────────
  { id: 'format.bold',         category: 'format', labelKey: 'shortcuts.actions.format.bold',         mac: 'Cmd+B',       win: 'Ctrl+B',       customizable: true, menuItemId: 'fmt_bold'},
  { id: 'format.italic',       category: 'format', labelKey: 'shortcuts.actions.format.italic',       mac: 'Cmd+I',       win: 'Ctrl+I',       customizable: true, menuItemId: 'fmt_italic'},
  { id: 'format.strike',       category: 'format', labelKey: 'shortcuts.actions.format.strike',       mac: 'Cmd+Shift+X', win: 'Ctrl+Shift+X', customizable: true, menuItemId: 'fmt_strikethrough'},
  { id: 'format.code',         category: 'format', labelKey: 'shortcuts.actions.format.code',         mac: 'Cmd+E',       win: 'Ctrl+E',       customizable: true, menuItemId: 'fmt_code'},
  { id: 'format.link',         category: 'format', labelKey: 'shortcuts.actions.format.link',         mac: 'Cmd+K',       win: 'Ctrl+K',       customizable: true, menuItemId: 'fmt_link'},
  { id: 'format.insertImage',  category: 'format', labelKey: 'shortcuts.actions.format.insert_image',  mac: 'Cmd+Shift+G', win: 'Ctrl+Shift+G', customizable: true, menuItemId: 'fmt_image'},

  // ── View ───────────────────────────────────────────────────────
  { id: 'view.toggleMode',     category: 'view', labelKey: 'shortcuts.actions.view.toggle_mode',     mac: 'Cmd+/',       win: 'Ctrl+/',       customizable: true, menuItemId: 'view_mode_visual'},
  { id: 'view.toggleSplit',    category: 'view', labelKey: 'shortcuts.actions.view.toggle_split',    mac: 'Cmd+Shift+/', win: 'Ctrl+Shift+/', customizable: true, menuItemId: 'view_mode_split'},
  { id: 'view.toggleSidebar',  category: 'view', labelKey: 'shortcuts.actions.view.toggle_sidebar',  mac: 'Cmd+\\',      win: 'Ctrl+\\',      customizable: true, menuItemId: 'view_sidebar'},
  { id: 'view.toggleAIPanel',  category: 'view', labelKey: 'shortcuts.actions.view.toggle_aipanel',  mac: 'Cmd+Shift+I', win: 'Ctrl+Shift+I', customizable: true, menuItemId: 'view_ai_panel'},
  { id: 'view.toggleOutline',  category: 'view', labelKey: 'shortcuts.actions.view.toggle_outline',  mac: 'Cmd+Shift+O', win: 'Ctrl+Shift+O', customizable: true, menuItemId: 'view_outline'},
  { id: 'view.openSettings',   category: 'view', labelKey: 'shortcuts.actions.view.open_settings',   mac: 'Cmd+,',       win: 'Ctrl+,',       customizable: true, menuItemId: 'preferences'},
  { id: 'view.zoomIn',         category: 'view', labelKey: 'shortcuts.actions.view.zoom_in',         mac: 'Cmd+=',       win: 'Ctrl+=',       customizable: true, menuItemId: 'view_zoom_in'},
  { id: 'view.zoomOut',        category: 'view', labelKey: 'shortcuts.actions.view.zoom_out',        mac: 'Cmd+-',       win: 'Ctrl+-',       customizable: true, menuItemId: 'view_zoom_out'},
  { id: 'view.zoomReset',      category: 'view', labelKey: 'shortcuts.actions.view.zoom_reset',      mac: 'Cmd+0',       win: 'Ctrl+0',       customizable: true, menuItemId: 'view_actual_size'},

  // ── Workflow (frontend) ────────────────────────────────────────
  { id: 'workflow.quickOpen',     category: 'workflow', labelKey: 'shortcuts.actions.workflow.quick_open',     mac: 'Cmd+P',       win: 'Ctrl+P',       customizable: true},
  { id: 'workflow.commandPalette', category: 'workflow', labelKey: 'shortcuts.actions.workflow.command_palette', mac: 'Cmd+Shift+P', win: 'Ctrl+Shift+P', customizable: true},

  // ── AI Chat ────────────────────────────────────────────────────
  // The actual binding is derived from `aiChatEnterBehavior`. Shown here
  // so the user sees the current value in the same place as other shortcuts.
  { id: 'aiChat.send',     category: 'aiChat', labelKey: 'shortcuts.actions.ai_chat.send',     mac: 'Cmd+Enter',  win: 'Ctrl+Enter',  customizable: true },
  { id: 'aiChat.newline',  category: 'aiChat', labelKey: 'shortcuts.actions.ai_chat.newline',  mac: 'Enter',      win: 'Enter',       customizable: true },
];

export const CATEGORY_LABEL_KEYS: Record<ShortcutCategory, string> = {
  file: 'shortcuts.categories.file',
  edit: 'shortcuts.categories.edit',
  paragraph: 'shortcuts.categories.paragraph',
  format: 'shortcuts.categories.format',
  view: 'shortcuts.categories.view',
  aiChat: 'shortcuts.categories.ai_chat',
  workflow: 'shortcuts.categories.workflow',
  mcp: 'shortcuts.categories.mcp',
};

/** Section headings for the three document-flavor groups in the panel. */
export const SCOPE_LABEL_KEYS: Record<DocScope, string> = {
  shared: 'shortcuts.scopes.shared',
  markdown: 'shortcuts.scopes.markdown',
  typst: 'shortcuts.scopes.typst',
};

/** Panel section order: shared bindings first, then the format-specific ones. */
export const SCOPE_ORDER: DocScope[] = ['shared', 'markdown', 'typst'];

/** Scope of an entry, treating an omitted `scope` as shared. */
export function scopeOf(entry: ShortcutEntry): DocScope {
  return entry.scope ?? 'shared';
}

/**
 * Native menu items that only work in ONE document flavor.
 *
 * A superset of the catalog's flavor-scoped rows, because some menu items have
 * no shortcut binding at all (Task List, cloud audio/video, …). Items listed
 * here are greyed out — never hidden — while the other flavor is active, so the
 * menu shape stays stable and the user can see the action exists but does not
 * apply to this format.
 */
export const FLAVOR_ONLY_MENU_ITEMS: Record<Exclude<DocScope, 'shared'>, string[]> = {
  markdown: [
    // Typst has no checkbox list primitive (the converter falls back to ☑/☐ glyphs).
    'para_task_list',
    // Typst is a print format — no audio/video embeds.
    'insert_cloud_audio',
    'insert_cloud_video',
    // Find/Replace read the ProseMirror document; not wired to the Typst source
    // pane yet. (The outline IS shared — TypstEditor renders the same
    // OutlinePanel from its own heading extraction.)
    'edit_find',
    'edit_replace',
    // SEO / publish pipelines consume markdown.
    'wf_seo',
    'wf_publish',
  ],
  typst: [],
};

/**
 * Menu item ids to disable for the given active document flavor: everything
 * that belongs exclusively to the OTHER flavor.
 */
export function disabledMenuItemsFor(flavor: 'markdown' | 'typst'): string[] {
  return flavor === 'typst' ? FLAVOR_ONLY_MENU_ITEMS.markdown : FLAVOR_ONLY_MENU_ITEMS.typst;
}

/**
 * Build the runtime shortcut catalog: static entries + dynamic MCP entries.
 *
 *   - For every installed MCP server, append a "toggle" entry so the user
 *     can bind a combo that enables / disables the server.
 *   - For every user-added MCP tool shortcut (recorded in
 *     `settings.mcpToolShortcuts`), append a "prompt" entry that fires
 *     `showAIPanel = true` + sendChatMessage with the canonical
 *     `ai.prompts.mcpToolPrompt` template (same as the native menu).
 *
 * `stale: true` is set when a user-added tool shortcut references a
 * server or tool that's no longer installed / exposed. The panel renders
 * stale entries with a "remove" affordance; the runtime dispatcher
 * no-ops them with a localized toast.
 *
 * Pure function — safe to call inside Svelte `$derived`.
 */
export function getRuntimeCatalog(
  servers: MCPServerStub[],
  tools: MCPToolStub[],
  userToolShortcuts: MCPToolShortcutRef[],
): ShortcutEntry[] {
  const dynamic: ShortcutEntry[] = [];

  for (const s of servers) {
    dynamic.push({
      id: `mcp.server.${s.id}.toggle`,
      category: 'mcp',
      labelKey: '',
      label: s.name,
      mac: '',
      win: '',
      customizable: true,
      menuItemId: undefined,
      dynamic: true,
      dynamicKind: 'mcp.server',
      stale: false,
      serverId: s.id,
    });
  }

  for (const ref of userToolShortcuts) {
    const server = servers.find(s => s.id === ref.serverId);
    const tool = tools.find(t => t.serverId === ref.serverId && t.name === ref.toolName);
    const stale = !server || !tool;
    dynamic.push({
      id: ref.catalogId,
      category: 'mcp',
      labelKey: '',
      label: stale ? ref.toolName : `${ref.toolName} · ${server.name}`,
      mac: '',
      win: '',
      customizable: true,
      menuItemId: undefined,
      dynamic: true,
      dynamicKind: 'mcp.tool',
      stale,
      serverId: ref.serverId,
      toolName: ref.toolName,
    });
  }

  return [...SHORTCUT_CATALOG_STATIC, ...dynamic];
}

/**
 * @deprecated Prefer `getRuntimeCatalog()` so MCP dynamic entries are
 * included. This export remains for the small subset of callers that
 * only need the static set (e.g. native menu sync via menu-sync.ts —
 * dynamic entries have no menuItemId, so they're never relevant there).
 */
export const SHORTCUT_CATALOG = SHORTCUT_CATALOG_STATIC;

/** Render the platform-appropriate display string for an entry (default only). */
export function displayShortcut(entry: ShortcutEntry, isMacOS: boolean): string {
  return isMacOS ? entry.mac : entry.win;
}

/** User-customized binding overrides, keyed by `ShortcutEntry.id`. */
export type ShortcutOverrides = Record<string, string>;

/**
 * Return the binding the user effectively has for an entry — override if
 * present, otherwise the platform default. Returns the same canonical text
 * format as the catalog (e.g. `Cmd+Shift+F`).
 */
export function effectiveBinding(
  entry: ShortcutEntry,
  isMacOS: boolean,
  overrides?: ShortcutOverrides,
): string {
  if (entry.customizable && overrides && overrides[entry.id]) {
    return overrides[entry.id];
  }
  return displayShortcut(entry, isMacOS);
}

/** Reduce a binding string to a comparable form: sorted modifiers + lowercased key. */
export function canonicalizeBinding(binding: string): string {
  const tokens = binding.split('+').map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) return '';
  const mods = new Set<'Cmd' | 'Ctrl' | 'Alt' | 'Shift'>();
  let main = '';
  for (const t of tokens) {
    if (t === 'Cmd' || t === 'Meta' || t === 'Command') mods.add('Cmd');
    else if (t === 'Ctrl' || t === 'Control') mods.add('Ctrl');
    else if (t === 'Alt' || t === 'Option') mods.add('Alt');
    else if (t === 'Shift') mods.add('Shift');
    else main = t.length === 1 ? t.toLowerCase() : t;
  }
  // Stable order so different orderings compare equal.
  const orderedMods = (['Cmd', 'Ctrl', 'Alt', 'Shift'] as const).filter(m => mods.has(m));
  return [...orderedMods, main].filter(Boolean).join('+');
}

/**
 * Convert a live `KeyboardEvent` into a canonical binding string. Returns
 * `null` if the event is only a modifier press (e.g. the user pressed Shift
 * with no other key — we wait for a real key).
 *
 * On macOS, `metaKey` → `Cmd`, `ctrlKey` → `Ctrl`. On Win/Linux, both
 * collapse to `Ctrl` since most users mean the same thing.
 */
export function eventToBinding(event: KeyboardEvent, isMacOS: boolean): string | null {
  const key = event.key;
  if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'OS') {
    return null;
  }

  const mods: string[] = [];
  if (isMacOS) {
    if (event.metaKey) mods.push('Cmd');
    if (event.ctrlKey) mods.push('Ctrl');
  } else {
    if (event.ctrlKey || event.metaKey) mods.push('Ctrl');
  }
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');

  // Normalize the main key. Single-char letters are lowercased so case is
  // not significant; named keys (Enter, ArrowUp, F5) keep their event.key form.
  let main = key.length === 1 ? key.toLowerCase() : key;
  // Special: when shift is held with a punctuation-shifted character (e.g.
  // Shift+/ → "?"), prefer the physical `event.code` so the binding reads as
  // the user thinks of it (e.g. "Cmd+Shift+/").
  if (event.shiftKey && key.length === 1 && /[!@#$%^&*()_+{}|:"<>?~]/.test(key)) {
    const codeMap: Record<string, string> = {
      Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'",
      BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
      Minus: '-', Equal: '=',
    };
    const physical = codeMap[event.code];
    if (physical) main = physical;
  }

  return [...mods, main].join('+');
}

/** Test if a KeyboardEvent satisfies the given binding string. */
export function eventMatchesBinding(
  event: KeyboardEvent,
  binding: string,
  isMacOS: boolean,
): boolean {
  const live = eventToBinding(event, isMacOS);
  if (!live) return false;
  return canonicalizeBinding(live) === canonicalizeBinding(binding);
}

/**
 * Convert a catalog/user binding string (e.g. `"Cmd+Shift+F"`, `"Enter"`)
 * into the Tauri accelerator format consumed by `MenuItem::set_accelerator`
 * (e.g. `"CmdOrCtrl+Shift+F"`, `"Enter"`).
 *
 * Returns `null` when the binding cannot be encoded — frontend should
 * refuse to save the recording and surface a localized error.
 *
 * Tauri/muda accepts:
 *   - Modifiers: `CmdOrCtrl`, `Cmd`, `Ctrl`, `Alt`, `Option`, `Shift`, `Super`
 *   - Named keys: `Enter`, `Tab`, `Space`, `Backspace`, `Delete`, `Escape`,
 *     `ArrowUp/Down/Left/Right`, `F1`..`F24`, `Plus`, `Minus`, `Equal`, etc.
 *   - Single chars: `A`-`Z`, `0`-`9`, and punctuation like `,` `.` `/` `\` `;` `'`
 */
export function bindingToTauriAccel(binding: string): string | null {
  if (!binding) return null;
  const tokens = binding.split('+').map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;

  const modOut: string[] = [];
  let main = '';
  let sawMod = false;
  for (const t of tokens) {
    // Normalize Cmd/Ctrl/Meta → CmdOrCtrl so the same accel works cross-platform.
    if (t === 'Cmd' || t === 'Command' || t === 'Meta' || t === 'Ctrl' || t === 'Control') {
      if (!modOut.includes('CmdOrCtrl')) modOut.push('CmdOrCtrl');
      sawMod = true;
    } else if (t === 'Alt' || t === 'Option') {
      if (!modOut.includes('Alt')) modOut.push('Alt');
      sawMod = true;
    } else if (t === 'Shift') {
      if (!modOut.includes('Shift')) modOut.push('Shift');
      sawMod = true;
    } else {
      // Main key.
      if (main) return null; // two main keys → invalid
      const mapped = mainKeyToTauri(t);
      if (mapped === null) return null;
      main = mapped;
    }
  }
  if (!main) return null;
  // Allow function keys / Escape without modifiers, but for safety require
  // a modifier for typical letter/digit/punctuation keys.
  if (!sawMod && !/^(F\d{1,2}|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(main)) {
    return null;
  }
  return [...modOut, main].join('+');
}

/** Translate a single-key token into Tauri/muda's expected form. */
function mainKeyToTauri(token: string): string | null {
  // Single character keys — uppercase letters, keep digits/punctuation as-is
  if (token.length === 1) {
    if (/[a-z]/i.test(token)) return token.toUpperCase();
    if (/[0-9]/.test(token)) return token;
    // Punctuation that muda accepts directly
    if ('-=,./;\'`\\['.includes(token) || token === ']') return token;
    return null;
  }
  // Named keys — pass through if recognized
  const named = new Set([
    'Enter', 'Tab', 'Space', 'Backspace', 'Delete', 'Escape',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'Insert',
    'CapsLock', 'NumLock', 'ScrollLock', 'PrintScreen', 'Pause',
  ]);
  if (named.has(token)) return token;
  // F1..F24
  if (/^F([1-9]|1\d|2[0-4])$/.test(token)) return token;
  return null;
}

/**
 * Find the first customizable catalog entry whose effective binding would
 * conflict with `candidate` (excluding `excludeId`). Returns null if no
 * conflict.
 *
 * Callers can pass a `catalog` (e.g. `getRuntimeCatalog(...)`) to include
 * dynamic MCP entries in the conflict check. Omitting `catalog` falls back
 * to the static set — sufficient for the legacy non-MCP code paths.
 */
export function findBindingConflict(
  candidate: string,
  excludeId: string,
  isMacOS: boolean,
  overrides?: ShortcutOverrides,
  catalog: ShortcutEntry[] = SHORTCUT_CATALOG_STATIC,
): ShortcutEntry | null {
  const canon = canonicalizeBinding(candidate);
  for (const entry of catalog) {
    if (entry.id === excludeId) continue;
    if (!entry.customizable) continue;
    if (entry.stale) continue;
    const other = effectiveBinding(entry, isMacOS, overrides);
    if (!other) continue; // dynamic entries with no default + no override
    if (canonicalizeBinding(other) === canon) return entry;
  }
  return null;
}

/**
 * Resolved AI-chat send/newline bindings derived from `aiChatEnterBehavior`.
 * Centralized so the catalog UI and the actual chat input share one source
 * of truth.
 */
export function resolveAIChatBindings(
  behavior: 'modEnterSend' | 'enterSend',
  isMacOS: boolean,
): { sendDisplay: string; newlineDisplay: string } {
  if (behavior === 'enterSend') {
    return {
      sendDisplay: 'Enter',
      newlineDisplay: 'Shift+Enter',
    };
  }
  return {
    sendDisplay: isMacOS ? 'Cmd+Enter' : 'Ctrl+Enter',
    newlineDisplay: 'Enter',
  };
}

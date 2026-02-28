/**
 * Editor setup — creates and configures a ProseMirror EditorView.
 *
 * Replaces the Milkdown builder pattern with direct ProseMirror APIs.
 * Uses schema.ts for the document schema and markdown.ts for
 * parsing/serialization.
 */

import { EditorState, Plugin, PluginKey } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history } from 'prosemirror-history';
import { baseKeymap, toggleMark, setBlockType } from 'prosemirror-commands';
import { inputRules, textblockTypeInputRule, wrappingInputRule, InputRule } from 'prosemirror-inputrules';
import { splitListItem, sinkListItem, liftListItem } from 'prosemirror-schema-list';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { columnResizing, tableEditing } from 'prosemirror-tables';
import { schema } from './schema';
import { parseMarkdown, serializeMarkdown } from './markdown';
import { createEnterHandlerPlugin } from './plugins/enter-handler';
import { createEditorPropsPlugin } from './plugins/editor-props-plugin';

// ── Tier 1: Enhancement plugins (dynamic imports, loaded in parallel) ──

interface Tier1Plugins {
  highlight?: Plugin;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  codeBlockView?: any;
  emoji?: Plugin;
  defListInputRule?: InputRule;
}

let tier1Cache: Tier1Plugins | null = null;
let tier1Loading: Promise<Tier1Plugins> | null = null;

/**
 * Preload Tier 1 enhancement plugins via dynamic import().
 * Each plugin becomes a separate Vite chunk (automatic code splitting).
 * Can be called early (e.g. in +page.svelte onMount) to warm the cache.
 */
export function preloadEnhancementPlugins(): Promise<Tier1Plugins> {
  if (tier1Cache) return Promise.resolve(tier1Cache);
  if (tier1Loading) return tier1Loading;

  tier1Loading = Promise.allSettled([
    import('./plugins/highlight'),
    import('./plugins/code-block-view'),
    import('./plugins/emoji'),
    import('./plugins/definition-list'),
  ]).then(([hl, cbv, em, dl]) => {
    const plugins: Tier1Plugins = {};
    if (hl.status === 'fulfilled') plugins.highlight = hl.value.createHighlightPlugin();
    if (cbv.status === 'fulfilled') plugins.codeBlockView = cbv.value.createCodeBlockNodeView;
    if (em.status === 'fulfilled') plugins.emoji = em.value.createEmojiPlugin();
    if (dl.status === 'fulfilled') plugins.defListInputRule = dl.value.createDefListInputRule();
    // Math is handled directly in schema.ts (KaTeX rendering in toDOM)
    // Load KaTeX CSS
    import('katex/dist/katex.min.css');
    tier1Cache = plugins;
    tier1Loading = null;
    return plugins;
  });

  return tier1Loading;
}

// ── Input Rules ─────────────────────────────────────────────────

function buildInputRules(tier1: Tier1Plugins) {
  const rules: InputRule[] = [];

  // Code block: ```language
  rules.push(textblockTypeInputRule(
    /^```(?<language>[a-zA-Z][a-zA-Z0-9_+#.\-]*)?[\s\n]$/,
    schema.nodes.code_block,
    (match) => ({ language: match.groups?.language ?? '' }),
  ));

  // Blockquote: > at start of line
  rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote));

  // Bullet list: - or * at start of line
  rules.push(wrappingInputRule(/^\s*[-*]\s$/, schema.nodes.bullet_list));

  // Ordered list: 1. at start of line
  rules.push(wrappingInputRule(
    /^\s*(\d+)\.\s$/,
    schema.nodes.ordered_list,
    (match) => ({ order: +match[1] }),
    (match, node) => node.childCount + node.attrs.order === +match[1],
  ));

  // Heading: # to ######
  for (let level = 1; level <= 6; level++) {
    const pattern = new RegExp(`^#{${level}}\\s$`);
    rules.push(textblockTypeInputRule(pattern, schema.nodes.heading, { level }));
  }

  // Horizontal rule: ---
  rules.push(new InputRule(/^---$/, (state, _match, start, end) => {
    const hr = schema.nodes.horizontal_rule.create();
    const tr = state.tr.replaceWith(start - 1, end, hr);
    return tr;
  }));

  // Math block: $$
  rules.push(new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    if (!$start.node(-1).canReplaceWith(
      $start.index(-1), $start.indexAfter(-1), schema.nodes.math_block
    )) return null;
    return state.tr.delete(start, end).setBlockType(start, start, schema.nodes.math_block);
  }));

  // Math inline: $...$
  rules.push(new InputRule(/(?:\$)([^$]+)(?:\$)$/, (state, match, start, end) => {
    const content = match[1];
    if (!content) return null;
    const node = schema.nodes.math_inline.create(null, schema.text(content));
    return state.tr.replaceWith(start, end, node);
  }));

  // Strong: **text** or __text__
  rules.push(new InputRule(
    /(?<![\\w:/])(?:\*\*|__)([^*_]+?)(?:\*\*|__)(?![\\w/])$/,
    (state, match, start, end) => {
      const tr = state.tr;
      if (match[1]) {
        const textStart = start + match[0].indexOf(match[1]);
        const textEnd = textStart + match[1].length;
        if (textEnd < end) tr.delete(textEnd, end);
        if (textStart > start) tr.delete(start, textStart);
        const markFrom = start;
        const markTo = markFrom + match[1].length;
        tr.addMark(markFrom, markTo, schema.marks.strong.create());
      }
      return tr;
    },
  ));

  // Emphasis: *text* or _text_
  rules.push(new InputRule(
    /(?<![\\w:/])(?:\*|_)([^*_]+?)(?:\*|_)(?![\\w/])$/,
    (state, match, start, end) => {
      const tr = state.tr;
      if (match[1]) {
        const textStart = start + match[0].indexOf(match[1]);
        const textEnd = textStart + match[1].length;
        if (textEnd < end) tr.delete(textEnd, end);
        if (textStart > start) tr.delete(start, textStart);
        const markFrom = start;
        const markTo = markFrom + match[1].length;
        tr.addMark(markFrom, markTo, schema.marks.em.create());
      }
      return tr;
    },
  ));

  // Inline code: `text`
  rules.push(new InputRule(
    /(?:`)([^`]+)(?:`)$/,
    (state, match, start, end) => {
      const tr = state.tr;
      if (match[1]) {
        const textStart = start + 1;
        const textEnd = end - 1;
        tr.delete(end - 1, end); // remove closing backtick
        tr.delete(start, start + 1); // remove opening backtick
        tr.addMark(start, start + match[1].length, schema.marks.code.create());
      }
      return tr;
    },
  ));

  // Strikethrough: ~~text~~
  rules.push(new InputRule(
    /~~([^~]+)~~$/,
    (state, match, start, end) => {
      const tr = state.tr;
      if (match[1]) {
        const textStart = start + 2;
        const textEnd = end - 2;
        tr.delete(end - 2, end);
        tr.delete(start, start + 2);
        tr.addMark(start, start + match[1].length, schema.marks.strike_through.create());
      }
      return tr;
    },
  ));

  // Task list: [ ] or [x] at start of list item
  rules.push(new InputRule(
    /^\[(?<checked>\s|x)\]\s$/,
    (state, match, start, end) => {
      const pos = state.doc.resolve(start);
      let depth = 0;
      let node = pos.node(depth);
      while (node && node.type.name !== 'list_item') {
        depth--;
        node = pos.node(depth);
      }
      if (!node || node.attrs.checked != null) return null;
      const checked = Boolean(match.groups?.checked === 'x');
      const finPos = pos.before(depth);
      return state.tr.deleteRange(start, end).setNodeMarkup(finPos, undefined, {
        ...node.attrs,
        checked,
      });
    },
  ));

  // Definition list input rule
  if (tier1.defListInputRule) {
    rules.push(tier1.defListInputRule);
  }

  return inputRules({ rules });
}

// ── Keymaps ─────────────────────────────────────────────────────

function buildKeymap() {
  const listItemType = schema.nodes.list_item;

  return keymap({
    // History
    'Mod-z': (state, dispatch) => {
      const { undo } = require('prosemirror-history');
      return undo(state, dispatch);
    },
    'Mod-y': (state, dispatch) => {
      const { redo } = require('prosemirror-history');
      return redo(state, dispatch);
    },
    'Mod-Shift-z': (state, dispatch) => {
      const { redo } = require('prosemirror-history');
      return redo(state, dispatch);
    },

    // Marks
    'Mod-b': toggleMark(schema.marks.strong),
    'Mod-i': toggleMark(schema.marks.em),
    'Mod-e': toggleMark(schema.marks.code),
    'Mod-Alt-x': toggleMark(schema.marks.strike_through),

    // List items
    'Enter': splitListItem(listItemType),
    'Tab': sinkListItem(listItemType),
    'Mod-]': sinkListItem(listItemType),
    'Shift-Tab': liftListItem(listItemType),
    'Mod-[': liftListItem(listItemType),

    // Headings
    'Mod-Alt-0': setBlockType(schema.nodes.paragraph),
    'Mod-Alt-1': setBlockType(schema.nodes.heading, { level: 1 }),
    'Mod-Alt-2': setBlockType(schema.nodes.heading, { level: 2 }),
    'Mod-Alt-3': setBlockType(schema.nodes.heading, { level: 3 }),
    'Mod-Alt-4': setBlockType(schema.nodes.heading, { level: 4 }),
    'Mod-Alt-5': setBlockType(schema.nodes.heading, { level: 5 }),
    'Mod-Alt-6': setBlockType(schema.nodes.heading, { level: 6 }),

    // Block types
    'Mod-Alt-c': setBlockType(schema.nodes.code_block),
    'Mod-Shift-b': (state, dispatch) => {
      const { wrapIn } = require('prosemirror-commands');
      return wrapIn(schema.nodes.blockquote)(state, dispatch);
    },

    // Hard break
    'Shift-Enter': (state, dispatch) => {
      if (dispatch) {
        dispatch(state.tr.replaceSelectionWith(schema.nodes.hardbreak.create()).scrollIntoView());
      }
      return true;
    },
  });
}

// ── Dirty Tracking Plugin ───────────────────────────────────────

/**
 * Lightweight dirty-tracking plugin: fires on every doc change with the
 * document's plain text content (doc.textContent). No markdown serialization,
 * no debounce timer — runs in O(1) after each transaction.
 */
function createDirtyTrackPlugin(onDocChanged: (textContent: string) => void): Plugin {
  return new Plugin({
    key: new PluginKey('moraya-dirty-track'),
    view: () => ({
      update: (view, prevState) => {
        if (!prevState || view.state.doc.eq(prevState.doc)) return;
        onDocChanged(view.state.doc.textContent);
      },
    }),
  });
}

/**
 * ProseMirror plugin that defers markdown serialization.
 * Used ONLY in split mode where the SourceEditor needs periodic markdown sync.
 * Debounce is set to 500ms (more relaxed than visual-only mode).
 */
function createLazyChangePlugin(onChange: (markdown: string) => void): Plugin {
  let changeTimer: ReturnType<typeof setTimeout> | null = null;

  return new Plugin({
    key: new PluginKey('moraya-lazy-change'),
    view: () => ({
      update: (view, prevState) => {
        if (!prevState || view.state.doc.eq(prevState.doc)) return;

        if (changeTimer !== null) clearTimeout(changeTimer);
        changeTimer = setTimeout(() => {
          try {
            const markdown = serializeMarkdown(view.state.doc);
            onChange(markdown);
          } catch { /* editor might be destroyed */ }
          changeTimer = null;
        }, 500);
      },
      destroy: () => {
        if (changeTimer !== null) {
          clearTimeout(changeTimer);
          changeTimer = null;
        }
      },
    }),
  });
}

// ── MorayaEditor interface ──────────────────────────────────────

export interface MorayaEditor {
  /** Direct ProseMirror EditorView access. */
  view: EditorView;
  /** Serialize current document to markdown string. */
  getMarkdown(): string;
  /** Replace document content with parsed markdown. */
  setContent(markdown: string): void;
  /** Destroy the editor and clean up. */
  destroy(): void;
}

export interface EditorOptions {
  root: HTMLElement;
  defaultValue?: string;
  /** Lightweight dirty notification with plain text content for word count. No markdown serialization. */
  onDocChanged?: (textContent: string) => void;
  /** Full markdown serialization callback. Used in split mode for SourceEditor sync. */
  onChange?: (markdown: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export async function createEditor(options: EditorOptions): Promise<MorayaEditor> {
  const { root, defaultValue = '', onDocChanged, onChange, onFocus, onBlur } = options;

  // Load Tier 1 plugins (uses cache if already preloaded)
  const tier1 = await preloadEnhancementPlugins();

  const t0 = performance.now();

  // Parse initial markdown content
  const doc = parseMarkdown(defaultValue);

  // Build plugins array
  const plugins: Plugin[] = [
    // Input rules (must come before keymaps)
    buildInputRules(tier1),

    // Keymaps
    buildKeymap(),
    keymap(baseKeymap),

    // History (undo/redo)
    history(),

    // Cursor plugins
    dropCursor(),
    gapCursor(),

    // Table plugins
    columnResizing(),
    tableEditing(),

    // Custom plugins
    createEnterHandlerPlugin(),
    createEditorPropsPlugin(),
  ];

  // Change detection
  if (onChange) {
    plugins.push(createLazyChangePlugin(onChange));
  } else if (onDocChanged) {
    plugins.push(createDirtyTrackPlugin(onDocChanged));
  }

  // Tier 1 enhancement plugins
  if (tier1.highlight) plugins.push(tier1.highlight);
  if (tier1.emoji) plugins.push(tier1.emoji);

  // Create editor state
  const state = EditorState.create({
    doc,
    schema,
    plugins,
  });

  // NodeViews
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeViews: Record<string, any> = {};
  if (tier1.codeBlockView) {
    nodeViews.code_block = tier1.codeBlockView;
  }

  // Create editor view
  const view = new EditorView(root, {
    state,
    nodeViews,
    attributes: {
      class: 'moraya-editor',
      spellcheck: 'true',
    },
  });

  console.log(`[Editor] createEditor: ${(performance.now() - t0).toFixed(1)}ms (plugins: ${plugins.length})`);

  // Handle focus/blur events
  if (onFocus || onBlur) {
    const editorDom = root.querySelector('.ProseMirror');
    if (editorDom) {
      if (onFocus) editorDom.addEventListener('focus', onFocus);
      if (onBlur) editorDom.addEventListener('blur', onBlur);
    }
  }

  // Build MorayaEditor facade
  const editor: MorayaEditor = {
    view,

    getMarkdown() {
      return serializeMarkdown(view.state.doc);
    },

    setContent(markdown: string) {
      const newDoc = parseMarkdown(markdown);
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content);
      view.dispatch(tr);
    },

    destroy() {
      view.destroy();
    },
  };

  return editor;
}

// Re-export for convenience
export { serializeMarkdown as getMarkdown } from './markdown';

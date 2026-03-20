/**
 * Editor setup — creates and configures a ProseMirror EditorView.
 *
 * Replaces the Milkdown builder pattern with direct ProseMirror APIs.
 * Uses schema.ts for the document schema and markdown.ts for
 * parsing/serialization.
 */

import { AllSelection, EditorState, Plugin, PluginKey, Selection, TextSelection, NodeSelection } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history } from 'prosemirror-history';
import { baseKeymap, toggleMark, setBlockType, joinForward } from 'prosemirror-commands';
import { inputRules, textblockTypeInputRule, wrappingInputRule, InputRule } from 'prosemirror-inputrules';
import { splitListItem, sinkListItem, liftListItem } from 'prosemirror-schema-list';
import { dropCursor } from 'prosemirror-dropcursor';
// NOTE: gapCursor plugin removed — it creates GapCursor selections between
// blocks where ProseMirror places the DOM selection at gap positions, causing
// a visible native caret that cannot be hidden by CSS alone. Markdown documents
// always have text positions (headings, paragraphs, lists) so gap cursor is unnecessary.
import { columnResizing } from 'prosemirror-tables';
import { schema } from './schema';
import { parseMarkdown, serializeMarkdown } from './markdown';
import { createEnterHandlerPlugin } from './plugins/enter-handler';
import { createEditorPropsPlugin } from './plugins/editor-props-plugin';
import { createCursorSyntaxPlugin } from './plugins/cursor-syntax';
import { createLinkTextPlugin } from './plugins/link-text-plugin';
import { createInlineCodeConvertPlugin } from './plugins/inline-code-convert';

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

// ── Image Selection Highlight ───────────────────────────────────
// When a range selection covers image nodes, add a decoration class
// so CSS can show a blue overlay (images don't get browser text-selection highlight).

function createImageSelectionPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('image-selection'),
    props: {
      decorations(state) {
        const { from, to } = state.selection;
        if (from === to) return DecorationSet.empty; // cursor, no range
        const decos: Decoration[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === 'image') {
            decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'image-in-selection' }));
          } else if (node.type.name === 'html_inline' && /^<img\s/i.test(node.attrs.value as string)) {
            decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'image-in-selection' }));
          }
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty;
      },
    },
  });
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
        // The closing backtick is the just-typed character and is NOT in the
        // document yet (ProseMirror InputRule contract). Only text up to `end`
        // exists. Use indexOf to locate the captured text within the match,
        // then delete surrounding delimiters that ARE in the document.
        const textStart = start + match[0].indexOf(match[1]);
        const textEnd = textStart + match[1].length;
        if (textEnd < end) tr.delete(textEnd, end);
        if (textStart > start) tr.delete(start, textStart);
        const markFrom = start;
        const markTo = markFrom + match[1].length;
        tr.addMark(markFrom, markTo, schema.marks.code.create());
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
        const textStart = start + match[0].indexOf(match[1]);
        const textEnd = textStart + match[1].length;
        if (textEnd < end) tr.delete(textEnd, end);
        if (textStart > start) tr.delete(start, textStart);
        const markFrom = start;
        const markTo = markFrom + match[1].length;
        tr.addMark(markFrom, markTo, schema.marks.strike_through.create());
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

  // Link: [text](url) — typed in visual mode becomes a proper link mark.
  // This prevents the serializer from escaping brackets (issue: []() → \[\]()).
  rules.push(new InputRule(
    /\[([^\]]+)\]\(([^)]+)\)$/,
    (state, match, start, end) => {
      const [, text, url] = match;
      if (!text || !url) return null;
      const linkMark = schema.marks.link.create({ href: url });
      return state.tr.replaceWith(start, end, schema.text(text, [linkMark]));
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
    'Tab': (state, dispatch) => {
      // In a list → indent list item
      if (sinkListItem(listItemType)(state)) return sinkListItem(listItemType)(state, dispatch);
      // Otherwise → insert tab (4 spaces)
      if (dispatch) dispatch(state.tr.insertText('    '));
      return true;
    },
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

    // Backspace: protect block atom nodes (math_block, etc.) from deletion.
    //
    // WebKit contenteditable bug: when the caret is at the end of a textblock
    // adjacent to a contenteditable="false" block (atom node), the browser's
    // native Backspace deletes that block instead of the previous character.
    // All ProseMirror built-in handlers return false for this position, so
    // native behavior runs unchecked. We must handle it ourselves.
    'Backspace': (state, dispatch) => {
      const sel = state.selection;

      // Case 0: Fast AllSelection / full-range deletion.
      // ProseMirror's default AllSelection delete is very slow on large docs
      // (step-by-step replacement). Replace entire content with a single empty
      // paragraph in one transaction for instant deletion.
      {
        const docSize = state.doc.content.size;
        const isAllSelected =
          sel instanceof AllSelection ||
          (docSize > 0 && sel.from <= 1 && sel.to >= docSize - 1);
        if (isAllSelected && dispatch) {
          const emptyParagraph = state.schema.nodes.paragraph.create();
          const tr = state.tr.replaceWith(0, docSize, emptyParagraph);
          tr.setSelection(TextSelection.create(tr.doc, 1));
          tr.setMeta('full-delete', true);
          dispatch(tr);
          return true;
        }
        if (isAllSelected) return true; // no dispatch but still consumed
      }

      // Case 1: NodeSelection on a block atom (via arrow keys) — move cursor
      // to nearest previous text position instead of deleting the atom.
      if (sel instanceof NodeSelection && sel.node.isBlock && sel.node.type.spec.atom) {
        const before = Selection.findFrom(state.doc.resolve(sel.from), -1, true);
        if (before && dispatch) {
          dispatch(state.tr.setSelection(before).scrollIntoView());
        }
        return true;
      }

      // Remaining cases need an empty TextSelection with a cursor
      if (!sel.empty || !(sel instanceof TextSelection)) return false;
      const $cursor = sel.$cursor;
      if (!$cursor) return false;
      const { parent, parentOffset } = $cursor;

      // Case 2: Cursor at END of a textblock, next sibling is a block atom.
      // This is the main WebKit bug fix: delete the previous character via
      // ProseMirror transaction instead of letting native Backspace run.
      if (parent.isTextblock && parentOffset === parent.content.size && parent.content.size > 0) {
        const afterPos = $cursor.after();
        if (afterPos < state.doc.content.size) {
          const nextNode = state.doc.resolve(afterPos).nodeAfter;
          if (nextNode && nextNode.isBlock && nextNode.type.spec.atom) {
            if (dispatch) {
              const before = $cursor.nodeBefore;
              if (before) {
                // Text node → delete 1 char; inline atom → delete entire node
                const delSize = before.isText ? 1 : before.nodeSize;
                dispatch(state.tr.delete(sel.from - delSize, sel.from).scrollIntoView());
              }
            }
            return true;
          }
        }
      }

      // Case 3: Cursor at START of a textblock, previous sibling is a block atom.
      // Move cursor to nearest text position before the atom instead of
      // letting selectNodeBackward select-then-delete the atom.
      if (parent.isTextblock && parentOffset === 0) {
        const beforePos = $cursor.before();
        if (beforePos > 0) {
          const prevNode = state.doc.resolve(beforePos).nodeBefore;
          if (prevNode && prevNode.isBlock && prevNode.type.spec.atom) {
            const target = Selection.findFrom(
              state.doc.resolve(beforePos - prevNode.nodeSize), -1, true
            );
            if (target && dispatch) {
              dispatch(state.tr.setSelection(target).scrollIntoView());
            }
            return true;
          }
        }
      }

      // Case 4: End of paragraph after an inline atom — join forward
      if (parent.type.name === 'paragraph' && parentOffset === parent.content.size) {
        const nodeBeforeAtom = $cursor.nodeBefore;
        if (nodeBeforeAtom && nodeBeforeAtom.isAtom) {
          const afterPos2 = $cursor.after();
          if (afterPos2 < state.doc.content.size) {
            const nextNode2 = state.doc.resolve(afterPos2).nodeAfter;
            if (nextNode2 && nextNode2.isBlock) {
              return joinForward(state, dispatch);
            }
          }
        }
      }

      // Case 5: Cursor at END of a textblock — delete previous char explicitly.
      // WKWebView's Selection.modify("move","backward","character") can fail
      // at the end of a contenteditable block, causing endOfTextblock("backward")
      // to incorrectly return true. This makes baseKeymap's joinBackward merge
      // the current paragraph with the next one instead of deleting a character.
      // Handle the deletion via ProseMirror transaction to avoid the bug.
      if (parent.isTextblock && parentOffset === parent.content.size && parentOffset > 0) {
        if (dispatch) {
          const nb = $cursor.nodeBefore;
          if (nb && nb.isText && nb.text) {
            // Handle surrogate pairs (emoji etc.)
            const code = nb.text.charCodeAt(nb.text.length - 1);
            const delLen = (code >= 0xDC00 && code <= 0xDFFF) ? 2 : 1;
            dispatch(state.tr.delete(sel.from - delLen, sel.from).scrollIntoView());
          } else if (nb) {
            dispatch(state.tr.delete(sel.from - nb.nodeSize, sel.from).scrollIntoView());
          }
        }
        return true;
      }

      return false;
    },

    // Delete: protect block atom nodes from deletion.
    // Same WebKit bug applies: native Delete at start of textblock before
    // a contenteditable="false" block can remove it.
    'Delete': (state, dispatch) => {
      const sel = state.selection;

      // NodeSelection on block atom → move to next text position
      if (sel instanceof NodeSelection && sel.node.isBlock && sel.node.type.spec.atom) {
        const after = Selection.findFrom(state.doc.resolve(sel.to), 1, true);
        if (after && dispatch) {
          dispatch(state.tr.setSelection(after).scrollIntoView());
        }
        return true;
      }

      // TextSelection at end of textblock, next sibling is block atom → consume
      if (sel.empty && sel instanceof TextSelection && sel.$cursor) {
        const $c = sel.$cursor;
        if ($c.parent.isTextblock && $c.parentOffset === $c.parent.content.size) {
          const ap = $c.after();
          if (ap < state.doc.content.size) {
            const nn = state.doc.resolve(ap).nodeAfter;
            if (nn && nn.isBlock && nn.type.spec.atom) {
              return true; // consume — don't delete the atom
            }
          }
        }
      }

      return false;
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
function createLazyChangePlugin(onChange: (markdown: string) => void, debounceMs = 500): Plugin {
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
        }, debounceMs);
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
  /** Debounce interval (ms) for the lazy-change plugin. Default 500ms. Split mode uses 150ms. */
  changeDebounceMs?: number;
  onFocus?: () => void;
  onBlur?: () => void;
}

export async function createEditor(options: EditorOptions): Promise<MorayaEditor> {
  const { root, defaultValue = '', onDocChanged, onChange, changeDebounceMs, onFocus, onBlur } = options;

  // Load Tier 1 plugins (uses cache if already preloaded)
  const tier1 = await preloadEnhancementPlugins();

  const t0 = performance.now();

  // Parse initial markdown content
  const doc = parseMarkdown(defaultValue);

  // Build plugins array
  const plugins: Plugin[] = [
    // Input rules (must come before keymaps)
    buildInputRules(tier1),

    // Custom Enter handler MUST come before keymaps so pipe-table and
    // code-fence detection run before baseKeymap's splitBlock intercepts Enter.
    createEnterHandlerPlugin(),

    // Keymaps
    buildKeymap(),
    keymap(baseKeymap),

    // History (undo/redo)
    history(),

    // Cursor plugins
    dropCursor(),

    // Table plugins
    // Keep column resizing, but skip tableEditing. Its drag-to-select cell
    // behavior hijacks native text selection inside tables, which prevents
    // users from selecting text across multiple cells in visual mode.
    columnResizing(),

    // Custom plugins
    createEditorPropsPlugin(),

    // Cursor-activated source syntax display (Typora-style)
    createCursorSyntaxPlugin(),

    // Link text decorations + auto-convert [text](url) to link mark on cursor leave
    createLinkTextPlugin(),

    // Inline code auto-convert: `text` → code mark on cursor leave
    createInlineCodeConvertPlugin(),

    // Image selection highlight (blue overlay when images are within a range selection)
    createImageSelectionPlugin(),
  ];

  // Change detection
  if (onChange) {
    plugins.push(createLazyChangePlugin(onChange, changeDebounceMs));
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

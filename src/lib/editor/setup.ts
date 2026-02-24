import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx, serializerCtx, remarkStringifyOptionsCtx } from '@milkdown/core';
// ── Tier 0: Core plugins (static imports, always available) ──
import { commonmark, codeBlockSchema } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { cursor } from '@milkdown/plugin-cursor';
import { enterHandlerPlugin } from './plugins/enter-handler';
import { $prose, $inputRule } from '@milkdown/utils';
import { AllSelection, Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { textblockTypeInputRule } from '@milkdown/prose/inputrules';

// ── Tier 1: Enhancement plugins (dynamic imports, loaded in parallel) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MilkdownPlugin = any;

interface Tier1Plugins {
  highlight?: MilkdownPlugin;
  codeBlockView?: MilkdownPlugin;
  emoji?: MilkdownPlugin;
  math?: MilkdownPlugin;
  defList?: MilkdownPlugin[];
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
    import('@milkdown/plugin-math'),
  ]).then(([hl, cbv, em, dl, ma]) => {
    const plugins: Tier1Plugins = {};
    if (hl.status === 'fulfilled') plugins.highlight = hl.value.highlightPlugin;
    if (cbv.status === 'fulfilled') plugins.codeBlockView = cbv.value.codeBlockViewPlugin;
    if (em.status === 'fulfilled') plugins.emoji = em.value.emojiPlugin;
    if (dl.status === 'fulfilled') {
      const m = dl.value;
      plugins.defList = [
        m.defListRemarkPlugin, m.defListSchema,
        m.defListTermSchema, m.defListDescriptionSchema, m.defListInputRule,
      ];
    }
    if (ma.status === 'fulfilled') {
      plugins.math = ma.value.math;
      // Load KaTeX CSS only when math plugin is available
      import('katex/dist/katex.min.css');
    }
    tier1Cache = plugins;
    tier1Loading = null;
    return plugins;
  });

  return tier1Loading;
}

/**
 * ProseMirror plugin that defers markdown serialization to the next animation frame.
 * Unlike Milkdown's built-in `markdownUpdated` listener (which serializes synchronously
 * on every ProseMirror transaction), this batches rapid changes and serializes once per frame.
 */
function createLazyChangePlugin(onChange: (markdown: string) => void) {
  return $prose((ctx) => {
    let changeTimer: ReturnType<typeof setTimeout> | null = null;

    return new Plugin({
      key: new PluginKey('moraya-lazy-change'),
      view: () => ({
        update: (view, prevState) => {
          if (!prevState || view.state.doc.eq(prevState.doc)) return;

          if (changeTimer !== null) clearTimeout(changeTimer);
          // Use setTimeout instead of rAF so user input events (Delete, typing)
          // can preempt pending serialization after heavy operations like undo.
          changeTimer = setTimeout(() => {
            try {
              const serializer = ctx.get(serializerCtx);
              const markdown = serializer(view.state.doc);
              onChange(markdown);
            } catch { /* editor might be destroyed */ }
            changeTimer = null;
          }, 100);
        },
        destroy: () => {
          if (changeTimer !== null) {
            clearTimeout(changeTimer);
            changeTimer = null;
          }
        }
      })
    });
  });
}

/**
 * WKWebView caret fix: macOS WebView does not render the native blinking caret
 * inside empty paragraphs (containing only a <br>). This plugin adds a
 * 'caret-empty-para' decoration to the empty paragraph under the cursor,
 * allowing CSS to display a fake animated caret.
 */
/**
 * Paste language normalization via transformPastedHTML:
 * When pasting from external sources (other editors, web pages), the clipboard
 * HTML often uses `<pre><code class="language-mermaid">` format. Milkdown's
 * code_block parseDOM only reads `data-language` from `<pre>`, so language
 * attributes are lost, breaking mermaid diagrams and other language-specific blocks.
 *
 * This plugin preprocesses pasted HTML to copy `class="language-xxx"` from
 * `<code>` elements into `data-language="xxx"` on their parent `<pre>` elements,
 * so Milkdown's existing parseDOM can read the language correctly.
 */
const pasteLanguageFixPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('paste-language-fix'),
    props: {
      transformPastedHTML(html) {
        // Quick check: skip processing if no language class is present
        if (!html.includes('language-')) return html;

        try {
          const template = document.createElement('template');
          template.innerHTML = html;
          const fragment = template.content;

          // Find all <pre> elements and check their child <code> for language class
          for (const pre of fragment.querySelectorAll('pre')) {
            // Skip if <pre> already has data-language
            if (pre.dataset.language) continue;

            const code = pre.querySelector('code');
            if (!code) continue;

            // Extract language from class="language-xxx" or class="lang-xxx"
            const match = code.className.match(/(?:language|lang)-(\S+)/);
            if (match) {
              pre.dataset.language = match[1];
            }
          }

          return template.innerHTML;
        } catch {
          return html; // On error, return original HTML
        }
      },
    },
  });
});

/**
 * Scroll-after-paste fix: Milkdown's clipboard plugin handles paste and
 * returns true (consuming the event), so a plugin-level handlePaste never
 * fires. Instead, use a capture-phase DOM paste listener to detect paste,
 * then scroll .editor-wrapper to the cursor after the document updates.
 */
const scrollAfterPastePlugin = $prose(() => {
  let pendingPaste = false;

  return new Plugin({
    key: new PluginKey('scroll-after-paste'),
    view(editorView) {
      function onPaste() { pendingPaste = true; }
      editorView.dom.addEventListener('paste', onPaste, true);

      return {
        update(view, prevState) {
          if (!pendingPaste || view.state.doc.eq(prevState.doc)) return;
          pendingPaste = false;
          requestAnimationFrame(() => {
            try {
              const { from } = view.state.selection;
              const coords = view.coordsAtPos(from);
              const wrapper = view.dom.closest('.editor-wrapper') as HTMLElement | null;
              if (!wrapper) return;
              const rect = wrapper.getBoundingClientRect();
              if (coords.top < rect.top || coords.bottom > rect.bottom) {
                wrapper.scrollTop += coords.top - rect.top - rect.height / 2;
              }
            } catch { /* ignore */ }
          });
        },
        destroy() {
          editorView.dom.removeEventListener('paste', onPaste, true);
        },
      };
    },
  });
});

const caretFixPlugin = $prose(() => {
  const isMac = typeof document !== 'undefined' &&
    document.body.classList.contains('platform-macos');

  return new Plugin({
    key: new PluginKey('moraya-caret-fix'),
    props: {
      decorations(state) {
        if (!isMac) return DecorationSet.empty;
        const { selection } = state;
        if (!selection.empty) return DecorationSet.empty;

        const { $from } = selection;
        const parent = $from.parent;
        if (parent.type.name === 'paragraph' && parent.content.size === 0) {
          const pos = $from.before();
          return DecorationSet.create(state.doc, [
            Decoration.node(pos, pos + parent.nodeSize, { class: 'caret-empty-para' }),
          ]);
        }
        return DecorationSet.empty;
      },
    },
  });
});

/**
 * macOS Cmd+A fix for ProseMirror:
 * When PredefinedMenuItem::select_all sends the native `selectAll:` action,
 * macOS fires a DOM `selectstart` + `selectionchange` on the contenteditable.
 * ProseMirror may not correctly translate the native DOM selection-all into
 * its own AllSelection. This plugin intercepts Cmd+A (Ctrl+A on non-Mac)
 * at the keydown level — before the native menu accelerator steals it — and
 * dispatches a proper ProseMirror AllSelection.
 */
const selectAllFixPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('select-all-fix'),
    props: {
      handleKeyDown(view, event) {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && !event.shiftKey && !event.altKey && event.key === 'a') {
          event.preventDefault();
          const tr = view.state.tr.setSelection(new AllSelection(view.state.doc));
          view.dispatch(tr);
          return true;
        }
        return false;
      },
    },
  });
});

/**
 * Prevent ProseMirror from creating a NodeSelection (blue highlight) when
 * clicking on images. Instead, place a TextSelection right after the image
 * so the cursor sits next to it without visually selecting the whole node.
 */
const imageClickPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('image-click-handler'),
    props: {
      handleClickOn(view, _pos, node, nodePos, event) {
        if (node.type.name !== 'image') return false;
        // Only intercept left-click (button 0)
        if (event.button !== 0) return false;

        const $pos = view.state.doc.resolve(nodePos + node.nodeSize);
        const sel = TextSelection.near($pos);
        view.dispatch(view.state.tr.setSelection(sel));
        return true; // Prevent default NodeSelection
      },
    },
  });
});

/**
 * Extended code block input rule: Milkdown's built-in input rule only matches
 * [a-z] for language names, so `image-prompts`, `c++`, `objective-c` etc. fail.
 * This rule handles the broader character set. Registered AFTER commonmark so
 * the original rule has priority for simple lowercase languages; this catches
 * the rest (hyphens, digits, dots, plus, hash).
 */
const codeBlockExtendedInputRule = $inputRule((ctx) => {
  return textblockTypeInputRule(
    /^```(?<language>[a-zA-Z][a-zA-Z0-9_+#.\-]*)?[\s\n]$/,
    codeBlockSchema.type(ctx),
    (match) => ({ language: match.groups?.language ?? '' }),
  );
});

export interface EditorOptions {
  root: HTMLElement;
  defaultValue?: string;
  onChange?: (markdown: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export async function createEditor(options: EditorOptions): Promise<Editor> {
  const { root, defaultValue = '', onChange, onFocus, onBlur } = options;

  // Load Tier 1 plugins (uses cache if already preloaded)
  const tier1 = await preloadEnhancementPlugins();

  const t0 = performance.now();

  let builder = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, defaultValue);
      ctx.set(editorViewOptionsCtx, {
        attributes: {
          class: 'moraya-editor',
          spellcheck: 'true',
        },
      });
      // Use `-` for bullet lists and `---` for horizontal rules (matching Typora/common conventions)
      ctx.set(remarkStringifyOptionsCtx, {
        bullet: '-',
        rule: '-',
      });
    })
    // Tier 0: Core plugins
    .use(commonmark)
    .use(codeBlockExtendedInputRule)
    .use(gfm)
    .use(history)
    .use(pasteLanguageFixPlugin)
    .use(clipboard)
    .use(cursor)
    .use(enterHandlerPlugin)
    .use(caretFixPlugin)
    .use(scrollAfterPastePlugin)
    .use(imageClickPlugin)
    .use(selectAllFixPlugin);

  // Lazy change detection: serializes once per animation frame instead of per keystroke
  if (onChange) {
    builder = builder.use(createLazyChangePlugin(onChange));
  }

  // Tier 1: Enhancement plugins (only attach successfully loaded ones)
  if (tier1.highlight) builder = builder.use(tier1.highlight);
  if (tier1.codeBlockView) builder = builder.use(tier1.codeBlockView);
  if (tier1.emoji) builder = builder.use(tier1.emoji);
  if (tier1.math) builder = builder.use(tier1.math);
  if (tier1.defList) {
    for (const p of tier1.defList) builder = builder.use(p);
  }

  const editor = await builder.create();
  console.log(`[Editor] createEditor: ${(performance.now() - t0).toFixed(1)}ms (plugins: ${Object.keys(tier1).length} tier1)`);

  // Handle focus/blur events on the editor DOM
  if (onFocus || onBlur) {
    const editorDom = root.querySelector('.ProseMirror');
    if (editorDom) {
      if (onFocus) editorDom.addEventListener('focus', onFocus);
      if (onBlur) editorDom.addEventListener('blur', onBlur);
    }
  }

  return editor;
}

export function getMarkdown(editor: Editor): string {
  return editor.action((ctx) => {
    const serializer = ctx.get(serializerCtx);
    const view = ctx.get(editorViewCtx);
    return serializer(view.state.doc);
  });
}

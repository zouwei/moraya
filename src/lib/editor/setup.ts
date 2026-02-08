import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx } from '@milkdown/core';
// ── Tier 0: Core plugins (static imports, always available) ──
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { cursor } from '@milkdown/plugin-cursor';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { enterHandlerPlugin } from './plugins/enter-handler';

// ── Tier 1: Enhancement plugins (dynamic imports, loaded in parallel) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MilkdownPlugin = any;

interface Tier1Plugins {
  highlight?: MilkdownPlugin;
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
    import('./plugins/emoji'),
    import('./plugins/definition-list'),
    import('@milkdown/plugin-math'),
  ]).then(([hl, em, dl, ma]) => {
    const plugins: Tier1Plugins = {};
    if (hl.status === 'fulfilled') plugins.highlight = hl.value.highlightPlugin;
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

      if (onChange) {
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          onChange(markdown);
        });
      }
    })
    // Tier 0: Core plugins
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(clipboard)
    .use(cursor)
    .use(listener)
    .use(enterHandlerPlugin);

  // Tier 1: Enhancement plugins (only attach successfully loaded ones)
  if (tier1.highlight) builder = builder.use(tier1.highlight);
  if (tier1.emoji) builder = builder.use(tier1.emoji);
  if (tier1.math) builder = builder.use(tier1.math);
  if (tier1.defList) {
    for (const p of tier1.defList) builder = builder.use(p);
  }

  const editor = await builder.create();

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
  // Access the editor's action to get markdown content
  return editor.action((ctx) => {
    const serializer = ctx.get('serializerCtx' as any) as unknown as (node: any) => string;
    const view = ctx.get('editorViewCtx' as any) as unknown as { state: { doc: any } };
    if (serializer && view) {
      return serializer(view.state.doc);
    }
    return '';
  });
}

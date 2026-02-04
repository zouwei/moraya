import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx, editorViewCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { math } from '@milkdown/plugin-math';
import { history } from '@milkdown/plugin-history';
import { clipboard } from '@milkdown/plugin-clipboard';
import { cursor } from '@milkdown/plugin-cursor';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { highlightPlugin } from './plugins/highlight';
import { enterHandlerPlugin } from './plugins/enter-handler';
import { emojiPlugin } from './plugins/emoji';
import {
  defListRemarkPlugin,
  defListSchema,
  defListTermSchema,
  defListDescriptionSchema,
  defListInputRule,
} from './plugins/definition-list';

import 'katex/dist/katex.min.css';

export interface EditorOptions {
  root: HTMLElement;
  defaultValue?: string;
  onChange?: (markdown: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
}

export async function createEditor(options: EditorOptions): Promise<Editor> {
  const { root, defaultValue = '', onChange, onFocus, onBlur } = options;

  const editor = await Editor.make()
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
    .use(commonmark)
    .use(gfm)
    .use(math)
    .use(history)
    .use(clipboard)
    .use(cursor)
    .use(listener)
    .use(highlightPlugin)
    .use(enterHandlerPlugin)
    .use(emojiPlugin)
    .use(defListRemarkPlugin)
    .use(defListSchema)
    .use(defListTermSchema)
    .use(defListDescriptionSchema)
    .use(defListInputRule)
    .create();

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

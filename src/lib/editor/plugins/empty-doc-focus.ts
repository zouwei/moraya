/**
 * ProseMirror plugin that handles cursor retention when the document is cleared.
 *
 * Two mechanisms:
 *
 * 1. handleKeyDown (props-level, high priority):
 *    Intercepts Delete/Backspace when AllSelection is active. Instead of letting
 *    ProseMirror walk the full document tree to handle deletion, we replace the
 *    entire content with a single empty paragraph in one transaction — this is
 *    both instant and keeps focus + cursor position.
 *
 * 2. view.update (fallback):
 *    If the document becomes empty through other means (e.g. programmatic clear,
 *    cut, etc.), refocus the editor so the cursor is visible.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection, AllSelection } from '@milkdown/prose/state';

const emptyDocFocusKey = new PluginKey('empty-doc-focus');

export const emptyDocFocusPlugin = $prose(() => {
  return new Plugin({
    key: emptyDocFocusKey,

    props: {
      handleKeyDown(view, event) {
        // Intercept Delete/Backspace when all content is selected (Cmd+A state)
        if (
          (event.key === 'Delete' || event.key === 'Backspace') &&
          view.state.selection instanceof AllSelection
        ) {
          const { schema } = view.state;
          const emptyParagraph = schema.nodes.paragraph.create();
          // Replace entire document content with a single empty paragraph
          const tr = view.state.tr.replaceWith(
            0,
            view.state.doc.content.size,
            emptyParagraph,
          );
          // Place cursor inside the empty paragraph (position 1 = inside first block)
          tr.setSelection(TextSelection.create(tr.doc, 1));
          view.dispatch(tr);
          view.focus();
          event.preventDefault();
          return true;
        }
        return false;
      },
    },

    view() {
      return {
        update(view, prevState) {
          const doc = view.state.doc;
          const prevDoc = prevState.doc;

          // Only act when content was removed
          if (doc.content.size >= prevDoc.content.size) return;

          // Check if doc is now empty: single empty text block
          const isEmpty =
            doc.childCount === 1 &&
            doc.firstChild !== null &&
            doc.firstChild.isTextblock &&
            doc.firstChild.content.size === 0;

          if (isEmpty) {
            // Always refocus — don't check hasFocus() because ProseMirror may
            // report true while the caret is not visually rendered.
            setTimeout(() => {
              if (!view.isDestroyed) {
                view.focus();
              }
            }, 0);
          }
        },
      };
    },
  });
});

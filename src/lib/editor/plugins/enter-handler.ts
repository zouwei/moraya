/**
 * Enter key handler plugin for Milkdown (style).
 *
 * - Enter: split the current block into a new paragraph (no <br/>).
 * - Shift+Enter: insert a hard break (<br/>) within the same paragraph.
 * - Space after ```: intercepted via a direct capture-phase beforeinput listener
 *   to insert space as plain text without triggering Milkdown's code block input rule.
 *
 * Uses handleKeyDown (props-level) which has higher priority than keymaps,
 * ensuring this runs before Milkdown's built-in hardbreak keymap.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import {
  splitBlock,
  chainCommands,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
} from '@milkdown/prose/commands';

const enterHandlerKey = new PluginKey('enter-handler');

/**
 * Milkdown plugin that intercepts Enter at the props level (higher priority than keymaps).
 */
export const enterHandlerPlugin = $prose(() => {
  const enterCommand = chainCommands(
    newlineInCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlock
  );

  return new Plugin({
    key: enterHandlerKey,

    // Direct DOM listener for Space interception — bypasses ProseMirror's
    // plugin prop system entirely, which is more reliable than handleDOMEvents.
    view(editorView) {
      function onBeforeInput(e: Event) {
        const ie = e as InputEvent;
        if (ie.inputType !== 'insertText' || ie.data !== ' ') return;

        const { $from } = editorView.state.selection;
        if ($from.parent.type.name !== 'paragraph') return;
        const text = $from.parent.textContent;
        if ($from.parentOffset !== text.length || !/^```[a-zA-Z]*$/.test(text)) return;

        // Stop the event completely — prevents both the browser insertion
        // and ProseMirror's input rule from seeing this space.
        ie.preventDefault();
        ie.stopImmediatePropagation();

        // Manually insert the space via ProseMirror transaction.
        const { from } = editorView.state.selection;
        editorView.dispatch(editorView.state.tr.insertText(' ', from, from));
      }

      editorView.dom.addEventListener('beforeinput', onBeforeInput, true);

      return {
        destroy() {
          editorView.dom.removeEventListener('beforeinput', onBeforeInput, true);
        },
      };
    },

    props: {
      handleKeyDown(view, event) {
        // Only handle plain Enter (no Shift, no Cmd/Ctrl)
        if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
          // Check if current line is a code fence (```language)
          const { $from } = view.state.selection;
          if ($from.parent.type.name === 'paragraph') {
            const text = $from.parent.textContent;

            // Only ```language creates a code block; bare ``` is treated as
            // normal text (prevents closing fences from pasted code blocks
            // from spawning empty code blocks).
            const match = text.match(/^```(\S+)\s*$/);
            if (match) {
              const language = match[1];
              const codeBlockType = view.state.schema.nodes.code_block;
              if (codeBlockType) {
                const pos = $from.before();
                const end = $from.after();
                const tr = view.state.tr;
                tr.replaceWith(pos, end, codeBlockType.create({ language }));
                view.dispatch(tr);
                return true;
              }
            }
          }
          return enterCommand(view.state, view.dispatch, view);
        }
        return false;
      },
    },
  });
});

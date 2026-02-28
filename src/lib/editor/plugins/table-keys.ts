/**
 * Table keyboard shortcuts plugin for Milkdown.
 *
 * - Ctrl/Cmd+Enter in table cell → add a new row below
 * - Shift+Enter in table cell → insert hard break (<br>)
 *
 * Must be registered BEFORE gfm plugin so that handleKeyDown
 * intercepts Mod+Enter before GFM's exitTable keymap.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import { commandsCtx } from '@milkdown/core';
import { addRowAfterCommand } from '@milkdown/preset-gfm';

export const tableKeysPlugin = $prose((ctx) => {
  return new Plugin({
    key: new PluginKey('table-keys'),
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'Enter') return false;

        // Check if cursor is inside a table cell
        const { $from } = view.state.selection;
        let inTable = false;
        for (let d = $from.depth; d > 0; d--) {
          const nodeName = $from.node(d).type.name;
          if (nodeName === 'table_cell' || nodeName === 'table_header') {
            inTable = true;
            break;
          }
        }
        if (!inTable) return false;

        // Ctrl/Cmd+Enter → add row below, then move cursor to first cell of new row
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          ctx.get(commandsCtx).call(addRowAfterCommand.key);

          // After command, cursor stays in original row — move it to the new row
          const { $from: $cur } = view.state.selection;
          for (let d = $cur.depth; d > 0; d--) {
            const name = $cur.node(d).type.name;
            if (name === 'table_row' || name === 'table_header_row') {
              try {
                const rowEnd = $cur.after(d);
                const $newRow = view.state.doc.resolve(rowEnd + 1);
                view.dispatch(
                  view.state.tr.setSelection(TextSelection.near($newRow)).scrollIntoView()
                );
              } catch { /* new row at table boundary */ }
              break;
            }
          }
          return true;
        }

        // Shift+Enter → insert hardbreak (<br>)
        if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          const hardbreak = view.state.schema.nodes.hardbreak;
          if (hardbreak) {
            const tr = view.state.tr.replaceSelectionWith(hardbreak.create());
            view.dispatch(tr.scrollIntoView());
          }
          return true;
        }

        return false;
      },
    },
  });
});

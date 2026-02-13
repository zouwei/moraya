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
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state';
import type { Schema, Node as PmNode } from '@milkdown/prose/model';
import {
  splitBlock,
  chainCommands,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
} from '@milkdown/prose/commands';

const enterHandlerKey = new PluginKey('enter-handler');

/**
 * Parse a pipe-delimited table header line into cell texts.
 * Returns null if the text is not a valid table header (needs >= 2 columns,
 * must start/end with |, rejects separator-only rows like | --- | --- |).
 */
function parsePipeTableHeader(text: string): string[] | null {
  if (!/^\|(.+\|)+\s*$/.test(text)) return null;

  const cells = text.split('|').slice(1, -1).map(s => s.trim());
  if (cells.length < 2) return null;

  // Reject separator-only rows (e.g. | --- | :---: | ---: |)
  if (cells.every(c => /^:?-+:?$/.test(c))) return null;

  return cells;
}

/**
 * Build a GFM table node from header text values using raw ProseMirror schema.
 * Creates: header row (pre-filled) + one empty data row.
 */
function buildTableFromHeaders(schema: Schema, headers: string[]): PmNode | null {
  const tableType = schema.nodes.table;
  const headerRowType = schema.nodes.table_header_row;
  const dataRowType = schema.nodes.table_row;
  const headerCellType = schema.nodes.table_header;
  const dataCellType = schema.nodes.table_cell;
  const paragraphType = schema.nodes.paragraph;

  if (!tableType || !headerRowType || !dataRowType ||
      !headerCellType || !dataCellType || !paragraphType) {
    return null;
  }

  const headerCells = headers.map(text => {
    const para = text
      ? paragraphType.create(null, schema.text(text))
      : paragraphType.create();
    return headerCellType.create({ alignment: 'left' }, para);
  });

  const emptyCells = headers.map(() =>
    dataCellType.createAndFill({ alignment: 'left' })!
  );

  const headerRow = headerRowType.create(null, headerCells);
  const dataRow = dataRowType.create(null, emptyCells);

  return tableType.create(null, [headerRow, dataRow]);
}

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

            // Pipe-separated table header: | col1 | col2 | ... |
            const headers = parsePipeTableHeader(text);
            if (headers) {
              // Ensure the parent context allows a table node (not inside blockquote/table cell)
              const $para = view.state.doc.resolve($from.before());
              const parentNode = $para.node($para.depth);
              const tableType = view.state.schema.nodes.table;
              if (tableType && parentNode.type.contentMatch.matchType(tableType)) {
                const tableNode = buildTableFromHeaders(view.state.schema, headers);
                if (tableNode) {
                  const pos = $from.before();
                  const end = $from.after();
                  const tr = view.state.tr;
                  tr.replaceWith(pos, end, tableNode);

                  // Place cursor in first cell of the data row
                  const inserted = tr.doc.nodeAt(pos);
                  if (inserted && inserted.childCount >= 2) {
                    const headerRowSize = inserted.child(0).nodeSize;
                    const $dataRow = tr.doc.resolve(pos + 1 + headerRowSize + 1);
                    tr.setSelection(TextSelection.near($dataRow));
                  }
                  tr.scrollIntoView();
                  view.dispatch(tr);
                  return true;
                }
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

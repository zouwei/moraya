/**
 * Enter key handler plugin for Milkdown (unified).
 *
 * Handles ALL Enter-key variants in a single plugin:
 *
 * In table cells (merged from table-keys plugin):
 * - Ctrl/Cmd+Enter → add a new row below
 * - Shift+Enter → insert hard break (<br>)
 *
 * In paragraphs:
 * - Enter: split the current block into a new paragraph (no <br/>).
 * - Enter after ```language: create code block.
 * - Enter after | col1 | col2 |: create table.
 *
 * Other:
 * - Space after ```: intercepted via a direct capture-phase beforeinput listener
 *   to insert space as plain text without triggering Milkdown's code block input rule.
 *
 * Uses handleKeyDown (props-level) which has higher priority than keymaps,
 * ensuring this runs before Milkdown's built-in hardbreak keymap.
 */

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import type { Schema, Node as PmNode } from 'prosemirror-model';
import {
  splitBlock,
  chainCommands,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
} from 'prosemirror-commands';
import { addRowAfter } from 'prosemirror-tables';

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
 * Also handles Ctrl/Cmd+Enter and Shift+Enter in table cells (merged from table-keys plugin).
 */
export function createEnterHandlerPlugin(): Plugin {
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
        if (event.key !== 'Enter') return false;

        const { $from } = view.state.selection;

        // Single depth traversal to determine context: table cell or list item
        let inTable = false;
        let inListItem = false;
        for (let d = $from.depth; d > 0; d--) {
          const nodeName = $from.node(d).type.name;
          if (nodeName === 'table_cell' || nodeName === 'table_header') {
            inTable = true;
            break;
          }
          if (nodeName === 'list_item') {
            inListItem = true;
            break;
          }
        }

        // ── Table cell: Ctrl/Cmd+Enter → add row, Shift+Enter → hard break ──
        if (inTable) {
          if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
            event.preventDefault();
            addRowAfter(view.state, view.dispatch);

            // Move cursor to the new row
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
        }

        // ── List item: let Milkdown's built-in splitListItem keymap handle it ──
        if (inListItem) return false;

        // ── Plain Enter (no modifiers) in non-table, non-list context ──
        if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
          // Check if current line is a code fence (```language)
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
}

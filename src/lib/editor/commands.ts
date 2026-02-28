/**
 * Editor commands for Moraya.
 *
 * All commands follow the ProseMirror standard signature:
 *   (state, dispatch?, view?) => boolean
 *
 * Replaces Milkdown's `callCommand(cmd.key, payload)` pattern with
 * direct function calls.
 */

import { toggleMark, setBlockType, wrapIn, lift } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';
import { undo, redo } from 'prosemirror-history';
import {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
  selectedRect,
  CellSelection,
} from 'prosemirror-tables';
import type { Command } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import { schema } from './schema';

// ── Mark toggles ────────────────────────────────────────────────

export const toggleBold: Command = toggleMark(schema.marks.strong);
export const toggleItalic: Command = toggleMark(schema.marks.em);
export const toggleStrikethrough: Command = toggleMark(schema.marks.strike_through);

/**
 * Toggle inline code mark.
 * When selection has inline code, remove it.
 * When selection has other marks, remove them first then add inline code.
 */
export const toggleCode: Command = (state, dispatch, view) => {
  const { selection } = state;
  if (selection.empty) return false;
  const { from, to } = selection;

  const codeType = schema.marks.code;
  const has = state.doc.rangeHasMark(from, to, codeType);

  if (has) {
    dispatch?.(state.tr.removeMark(from, to, codeType));
    return true;
  }

  const tr = state.tr;
  // Remove other marks first
  for (const name in schema.marks) {
    if (name !== 'code') {
      tr.removeMark(from, to, schema.marks[name]);
    }
  }
  tr.addMark(from, to, codeType.create());
  dispatch?.(tr);
  return true;
};

/**
 * Toggle link mark with optional href.
 */
export function toggleLink(attrs: { href?: string; title?: string } = {}): Command {
  return toggleMark(schema.marks.link, {
    href: attrs.href ?? '',
    title: attrs.title ?? null,
  });
}

// ── Block type commands ─────────────────────────────────────────

/**
 * Set heading level (1-6). If already at that level, convert back to paragraph.
 */
export function setHeading(level: number): Command {
  return (state, dispatch, view) => {
    const { $from } = state.selection;
    if ($from.parent.type === schema.nodes.heading && $from.parent.attrs.level === level) {
      return setBlockType(schema.nodes.paragraph)(state, dispatch, view);
    }
    return setBlockType(schema.nodes.heading, { level })(state, dispatch, view);
  };
}

export const wrapInBlockquote: Command = wrapIn(schema.nodes.blockquote);
export const wrapInBulletList: Command = wrapInList(schema.nodes.bullet_list);
export const wrapInOrderedList: Command = wrapInList(schema.nodes.ordered_list);

/**
 * Insert or convert to code block.
 */
export const insertCodeBlock: Command = setBlockType(schema.nodes.code_block);

/**
 * Insert horizontal rule at current position.
 */
export const insertHorizontalRule: Command = (state, dispatch) => {
  if (!dispatch) return true;
  const { $from } = state.selection;
  const hr = schema.nodes.horizontal_rule.create();
  const para = schema.nodes.paragraph.create();
  const tr = state.tr.replaceSelectionWith(hr);
  // Add a paragraph after the hr for cursor placement
  const pos = tr.selection.from;
  tr.insert(pos, para);
  tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Insert image node with given attributes.
 */
export function insertImage(attrs: { src: string; alt?: string; title?: string }): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const node = schema.nodes.image.create({
      src: attrs.src,
      alt: attrs.alt || '',
      title: attrs.title || '',
    });
    dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

/**
 * Insert a GFM table with given dimensions.
 */
export function insertTable(rows: number = 3, cols: number = 3): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;

    const headerCells: import('prosemirror-model').Node[] = [];
    const emptyCells = () => {
      const cells: import('prosemirror-model').Node[] = [];
      for (let j = 0; j < cols; j++) {
        cells.push(schema.nodes.table_cell.createAndFill({ alignment: 'left' })!);
      }
      return cells;
    };

    for (let j = 0; j < cols; j++) {
      headerCells.push(schema.nodes.table_header.createAndFill({ alignment: 'left' })!);
    }

    const tableRows: import('prosemirror-model').Node[] = [];
    tableRows.push(schema.nodes.table_header_row.create(null, headerCells));
    for (let i = 1; i < rows; i++) {
      tableRows.push(schema.nodes.table_row.create(null, emptyCells()));
    }

    const tableNode = schema.nodes.table.create(null, tableRows);
    const tr = state.tr.replaceSelectionWith(tableNode);

    // Place cursor in first header cell
    const insertPos = tr.selection.$from.before(tr.selection.$from.depth);
    try {
      const $pos = tr.doc.resolve(insertPos + 3); // table > header_row > header_cell > paragraph
      tr.setSelection(TextSelection.near($pos));
    } catch { /* fallback to default selection */ }

    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Insert a math block at current position.
 */
export const insertMathBlock: Command = (state, dispatch) => {
  if (!dispatch) return true;
  const node = schema.nodes.math_block.create({ value: '' });
  dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
  return true;
};

// ── Table commands ──────────────────────────────────────────────

// Re-export prosemirror-tables commands directly
export {
  addRowBefore,
  addRowAfter,
  addColumnBefore,
  addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
};

/**
 * Select a table row by index and delete it.
 */
export function deleteTableRow(rowIndex: number): Command {
  return (state, dispatch) => {
    // Use prosemirror-tables' deleteRow which works with CellSelection
    return deleteRow(state, dispatch);
  };
}

/**
 * Select a table column by index and delete it.
 */
export function deleteTableColumn(colIndex: number): Command {
  return (state, dispatch) => {
    return deleteColumn(state, dispatch);
  };
}

// ── History commands ────────────────────────────────────────────

export { undo, redo };

// ── Lift command ────────────────────────────────────────────────

export { lift };

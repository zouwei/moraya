/**
 * Inline code convert plugin — two responsibilities:
 *
 * 1. **Backtick collapse**: Auto-converts `text` patterns to code marks when
 *    the cursor leaves the backtick pair. Handles the workflow where users type
 *    two backticks first, move cursor between them, type content, then leave.
 *
 * 2. **Cursor target**: Inserts a zero-width space (U+200B) after code marks
 *    at the end of textblocks. WebKit can't position the caret after a `<code>`
 *    element when there's no subsequent text node, so this provides a DOM target
 *    for both keyboard navigation and mouse clicks.
 *
 * The U+200B is stripped during markdown serialization (see serializeMarkdown).
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import { schema } from '../schema';

const pluginKey = new PluginKey('inline-code-convert');

/** Zero-width space used as cursor anchor after trailing code marks. */
export const ZWSP = '\u200B';

/** Matches `text` (backtick-delimited) for conversion — requires non-empty content. */
const CODE_PATTERN = /`([^`]+)`/g;

interface CodeMatch {
  from: number;
  to: number;
  content: string;
}

/**
 * Find `text` patterns in the textblock containing `pos`.
 * Only scans unmarked text nodes (skips text already marked as code).
 */
function findCodePatternsInBlock(state: EditorState, pos: number): CodeMatch[] {
  const matches: CodeMatch[] = [];
  const codeType = state.schema.marks.code;

  let resolved;
  try { resolved = state.doc.resolve(pos); } catch { return matches; }
  const parent = resolved.parent;
  if (!parent.isTextblock) return matches;

  // Skip code blocks — backticks are literal there
  if (parent.type.spec.code) return matches;

  const base = resolved.start();
  let nodePos = base;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    if (child.isText && child.text && !(codeType && codeType.isInSet(child.marks))) {
      CODE_PATTERN.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CODE_PATTERN.exec(child.text)) !== null) {
        matches.push({
          from: nodePos + m.index,
          to: nodePos + m.index + m[0].length,
          content: m[1],
        });
      }
    }
    nodePos += child.nodeSize;
  }
  return matches;
}

/**
 * Check if a textblock's last content is a code mark and needs a trailing
 * cursor target (U+200B). Returns the insert position, or -1 if not needed.
 */
function needsCursorTarget(state: EditorState): number {
  const { $head } = state.selection;
  if (!$head) return -1;
  const parent = $head.parent;
  if (!parent.isTextblock || parent.type.spec.code || parent.childCount === 0) return -1;

  const lastChild = parent.lastChild;
  if (!lastChild?.isText) return -1;

  const codeType = state.schema.marks.code;

  // Already has a trailing ZWSP (no code mark on it) — no action needed
  if (!codeType.isInSet(lastChild.marks) && lastChild.text?.endsWith(ZWSP)) return -1;

  // Check if the last CODE-marked child is truly the last meaningful content.
  // Walk backwards skipping any existing ZWSP-only unmarked nodes.
  for (let i = parent.childCount - 1; i >= 0; i--) {
    const child = parent.child(i);
    if (child.isText && !codeType.isInSet(child.marks) && child.text === ZWSP) continue;
    if (child.isText && codeType.isInSet(child.marks)) {
      return $head.start() + parent.content.size; // insert at end of textblock content
    }
    break; // non-code, non-ZWSP content found — no target needed
  }
  return -1;
}

export function createInlineCodeConvertPlugin(): Plugin {
  return new Plugin({
    key: pluginKey,

    appendTransaction(transactions, oldState, newState) {
      // Skip if this plugin already produced a transaction
      if (transactions.some((tr) => tr.getMeta(pluginKey))) return null;
      if (transactions.some((tr) => tr.getMeta('full-delete'))) return null;

      const selChanged = transactions.some((tr) => tr.selectionSet);
      const docChanged = transactions.some((tr) => tr.docChanged);
      if (!selChanged && !docChanged) return null;
      if (!newState.selection.empty) return null;

      const newPos = newState.selection.from;
      const oldPos = oldState.selection.from;

      // ── 1. Backtick pair collapse ──
      const oldMatches = findCodePatternsInBlock(oldState, oldPos);
      const wasIn = oldMatches.find((m) => oldPos > m.from && oldPos < m.to);
      if (wasIn) {
        let mappedFrom = wasIn.from;
        if (docChanged) {
          for (const t of transactions) {
            mappedFrom = t.mapping.map(mappedFrom);
          }
          if (mappedFrom < 0 || mappedFrom > newState.doc.content.size) return null;
        }

        const newMatches = findCodePatternsInBlock(newState, mappedFrom);
        const isStillIn = newMatches.find((m) => newPos > m.from && newPos < m.to);
        if (!isStillIn) {
          const target = newMatches.find(
            (m) => Math.abs(m.from - mappedFrom) < 3,
          );
          if (target?.content) {
            const codeNode = newState.schema.text(target.content, [
              schema.marks.code.create(),
            ]);
            const tr = newState.tr.replaceWith(target.from, target.to, codeNode);
            tr.setMeta(pluginKey, 'collapse');
            tr.setMeta('addToHistory', false);
            return tr;
          }
        }
      }

      // ── 2. Cursor target: ensure U+200B after trailing code marks ──
      const insertPos = needsCursorTarget(newState);
      if (insertPos >= 0) {
        const tr = newState.tr.insertText(ZWSP, insertPos);
        tr.setMeta(pluginKey, 'cursor-target');
        tr.setMeta('addToHistory', false);
        return tr;
      }

      // ── 3. Stored marks at code–ZWSP boundary ──
      // With inclusive:false, marks() at the right boundary of code excludes
      // the code mark. But the user expects typing at the end of code text to
      // extend the code (they visually see the cursor inside the gray background).
      // Proactively set stored marks to include code at this position.
      // ArrowRight handler sets 'code-escape' meta to opt out.
      if (transactions.some((tr) => tr.getMeta('code-escape'))) return null;

      const { $head } = newState.selection;
      if ($head && newState.selection.empty) {
        const codeType = newState.schema.marks.code;
        const nodeBefore = $head.nodeBefore;
        const nodeAfter = $head.nodeAfter;

        if (
          nodeBefore?.marks.some((m) => m.type === codeType) &&
          nodeAfter?.isText &&
          !codeType.isInSet(nodeAfter.marks) &&
          nodeAfter.text?.startsWith(ZWSP)
        ) {
          // Already has code in stored marks — nothing to do
          const stored = newState.storedMarks;
          if (stored && stored.some((m) => m.type === codeType)) return null;

          const marks = [...$head.marks(), codeType.create()];
          const tr = newState.tr.setStoredMarks(marks);
          tr.setMeta(pluginKey, 'boundary-marks');
          tr.setMeta('addToHistory', false);
          return tr;
        }
      }

      return null;
    },
  });
}

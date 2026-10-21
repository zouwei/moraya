/**
 * Pure helper (no schema / Tauri deps, unit-tested) for restoring trailing
 * empty paragraphs that standard markdown parsing discards.
 */

/** Upper bound on restored trailing blank paragraphs (guards pathological input). */
export const TRAILING_BLANK_CAP = 50

/**
 * Number of trailing EMPTY paragraphs a markdown source represents.
 *
 * The serializer writes N trailing empty paragraphs as `N + 1` trailing
 * newlines (1 empty → "text\n\n", 3 empty → "text\n\n\n\n"), but standard
 * markdown parsing drops trailing blank lines — so pressing Enter at the end of
 * a document, saving, and reopening loses the blank lines. This inverts the
 * serializer's mapping: `N = max(0, trailingNewlines - 1)`. A lone final newline
 * (common in externally-authored files) maps to 0, so no spurious paragraph is
 * added.
 *
 * Whitespace-only lines count as blank: Shift+Enter writes a hard break as
 * "  \n", so blank lines made that way end the source with "  " lines. The
 * parser drops trailing hard breaks too, so they would otherwise vanish.
 */
export function trailingBlankParagraphCount(markdown: string): number {
  const m = /(?:\n[ \t]*)+$/.exec(markdown)
  const trailingNewlines = m ? m[0].split('\n').length - 1 : 0
  return Math.min(Math.max(0, trailingNewlines - 1), TRAILING_BLANK_CAP)
}

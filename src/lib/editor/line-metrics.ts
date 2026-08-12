/**
 * Line geometry for the source pane.
 *
 * Split-view scroll sync needs to know where a given logical markdown line
 * starts inside the source textarea. It used to compute that as
 * `lineIndex * lineHeight`, which assumes one logical line occupies exactly one
 * visual row. A soft-wrapped paragraph occupies several — and in split view the
 * pane is half a window wide, so almost every paragraph wraps. The estimate ran
 * short, so scrolling the source pane mapped to a position further down the
 * visual pane, and the gap grew with distance (issue #87).
 *
 * The source editor measures each line's real rendered height in its ghost
 * mirror; this turns those heights into start offsets.
 */

/**
 * Running start offset of each line.
 *
 * `offsets[i]` is where line `i` begins, measured from the first line's top;
 * the array is one longer than `heights` so the final entry is the total.
 */
export function cumulativeLineOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < heights.length; i++) {
    offsets[i + 1] = offsets[i]! + (heights[i] ?? 0);
  }
  return offsets;
}

/**
 * Start offset of `line`, clamped to the measured range.
 *
 * Anchors are built from the rendered visual blocks, whose estimated line spans
 * can overshoot the real line count (a block's span is inferred, not counted),
 * so out-of-range lookups are expected rather than exceptional.
 */
export function lineOffsetAt(offsets: readonly number[] | null, line: number, fallbackLineHeight: number): number {
  if (!offsets || offsets.length === 0) return line * fallbackLineHeight;
  if (line < 0) return 0;
  return offsets[Math.min(line, offsets.length - 1)] ?? 0;
}

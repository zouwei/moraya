/**
 * Column-resize geometry for the editor's two drag handles.
 *
 * Both editors render their document inside a centred box:
 *
 *     .editor-wrapper  (scroll container, symmetric padding)
 *       └ .editor-content-area  { width: 100%; margin: 0 auto; max-width: N }
 *           ├ .outline-wrapper   (fixed px width, optional)
 *           └ .editor-root       (the prose column)
 *
 * Because the box is centred, an edge only travels HALF as far as the width
 * grows — widening by 100px pushes each edge out by 50px. So a handle that is
 * supposed to stay under the cursor has to apply twice the pointer delta;
 * that is what `gain: 2` means below. A handle on a left-aligned box (the
 * Typst pane) uses the default gain of 1.
 *
 * `leading` selects which edge is being dragged. On the trailing (right, in
 * LTR) edge, moving right grows the column; on the leading edge, moving LEFT
 * grows it — the same sense as dragging a window border. `rtl` flips the
 * physical direction of both, since the leading edge is on the right there.
 */

/** Prose-column bounds — the same range the settings slider exposes. */
export const LINE_WIDTH_MIN = 600;
export const LINE_WIDTH_MAX = 1600;
/**
 * Drag snaps to 10px. The settings slider steps by 50, but a pointer drag
 * wants finer control; 10 is small enough to feel continuous and coarse
 * enough to keep the persisted value tidy.
 */
export const LINE_WIDTH_STEP = 10;

/** Outline-panel bounds. */
export const OUTLINE_MIN_WIDTH = 120;
export const OUTLINE_MAX_WIDTH = 500;

export interface ResizeOptions {
  min: number;
  max: number;
  /** Snap the result to this multiple. Default 1 (no snapping). */
  step?: number;
  /** Pointer-delta multiplier. 2 for an edge of a centred box. Default 1. */
  gain?: number;
  /** True when dragging the box's leading edge (left in LTR). */
  leading?: boolean;
  /** True in right-to-left layouts, where leading/trailing swap sides. */
  rtl?: boolean;
}

/**
 * New width for a column being resized by a pointer drag.
 *
 * `startWidth` is the width captured at pointerdown and `deltaX` is the
 * pointer's total travel since then — NOT a per-move increment. Deriving from
 * the drag's origin (rather than accumulating) keeps the column exactly under
 * the cursor even when a move event is dropped or the value hits a clamp and
 * comes back.
 */
export function resizeWidth(startWidth: number, deltaX: number, o: ResizeOptions): number {
  const gain = o.gain ?? 1;
  const step = o.step ?? 1;
  const direction = (o.leading ? -1 : 1) * (o.rtl ? -1 : 1);
  const raw = startWidth + direction * gain * deltaX;
  const snapped = Math.round(raw / step) * step;
  return Math.min(o.max, Math.max(o.min, snapped));
}

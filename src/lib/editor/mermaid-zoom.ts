/**
 * Geometry + source-sniffing helpers behind the mermaid zoom preview
 * (GitHub issue #89 — dense diagrams render too small to read inline).
 *
 * Deliberately DOM-free: the fit / zoom-at-pointer maths is the part that is
 * easy to get subtly wrong (a pivot that drifts, a fit that upscales a tiny
 * diagram into a blur), so it lives here where `pnpm test` can cover it.
 * `MermaidZoomModal.svelte` owns only the wiring — listeners, the transform
 * string, focus handling.
 */

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Pan/zoom state of the stage. `tx`/`ty` are stage-space pixels, applied
 *  BEFORE `scale` (i.e. `translate(tx,ty) scale(s)` with origin `0 0`). */
export interface ViewTransform {
  scale: number
  tx: number
  ty: number
}

/** Hard limits for the zoom controls. */
export const MIN_SCALE = 0.1
export const MAX_SCALE = 8

/**
 * Ceiling applied to the *initial* fit only. A four-node flowchart fitted to a
 * 1600px window would otherwise open at ~9x — a wall of blurry strokes. The
 * user can still push past this with the + button; it is only the entry point
 * that stays sane.
 */
export const MAX_FIT_SCALE = 4

/** Padding (px) left around the diagram when fitting it to the stage. */
export const FIT_PADDING = 40

/** Multiplier applied per click of the +/− buttons and per keyboard step. */
export const STEP_FACTOR = 1.25

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  if (!Number.isFinite(scale)) return min
  return Math.min(max, Math.max(min, scale))
}

/**
 * Natural pixel size of a mermaid-produced SVG.
 *
 * mermaid emits `viewBox="0 0 W H"` plus a `width`/`height` pair that is often
 * `100%` (or absent) and an inline `max-width` — so the viewBox is the only
 * reliable source. Attributes are the fallback for hand-written SVGs and for
 * mermaid versions that omit the viewBox on some diagram types.
 *
 * Takes raw attribute strings rather than an element so it stays testable in
 * the project's `node` test environment.
 */
export function parseSvgSize(
  viewBox: string | null | undefined,
  width?: string | null,
  height?: string | null,
): Size | null {
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2]! > 0 && parts[3]! > 0) {
      return { width: parts[2]!, height: parts[3]! }
    }
  }
  const w = parseLengthPx(width)
  const h = parseLengthPx(height)
  if (w !== null && h !== null && w > 0 && h > 0) return { width: w, height: h }
  return null
}

/** `"420"` / `"420px"` → 420. Percentages and other units → null. */
function parseLengthPx(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /^\s*(-?[\d.]+)\s*(px)?\s*$/i.exec(value)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * Scale + offset that centres `content` inside `viewport` with `padding` to
 * spare. Upscaling is allowed — that is the whole point of the feature — but
 * capped at `MAX_FIT_SCALE`.
 */
export function computeFit(
  content: Size,
  viewport: Size,
  padding = FIT_PADDING,
  maxScale = MAX_FIT_SCALE,
): ViewTransform {
  if (content.width <= 0 || content.height <= 0) return { scale: 1, tx: 0, ty: 0 }
  const availWidth = Math.max(1, viewport.width - padding * 2)
  const availHeight = Math.max(1, viewport.height - padding * 2)
  const scale = clampScale(
    Math.min(availWidth / content.width, availHeight / content.height),
    MIN_SCALE,
    maxScale,
  )
  return { scale, ...centerOffset(content, viewport, scale) }
}

/** Offsets that put a `content`-sized box scaled by `scale` in the middle of `viewport`. */
export function centerOffset(content: Size, viewport: Size, scale: number): { tx: number; ty: number } {
  return {
    tx: (viewport.width - content.width * scale) / 2,
    ty: (viewport.height - content.height * scale) / 2,
  }
}

/**
 * Change the scale while keeping the content point currently under `pivot`
 * (stage-space coordinates) pinned there — the "zoom towards the cursor"
 * behaviour. Returns the current transform unchanged when the clamped scale
 * did not actually move, so a wheel at the limit does not nudge the pan.
 */
export function zoomAtPoint(current: ViewTransform, nextScale: number, pivot: Point): ViewTransform {
  const scale = clampScale(nextScale)
  if (scale === current.scale) return current
  const ratio = scale / current.scale
  return {
    scale,
    tx: pivot.x - (pivot.x - current.tx) * ratio,
    ty: pivot.y - (pivot.y - current.ty) * ratio,
  }
}

/** One +/− button press (or `+`/`-` key): `direction` is +1 to enlarge, −1 to shrink. */
export function steppedScale(scale: number, direction: number): number {
  return clampScale(scale * STEP_FACTOR ** Math.sign(direction))
}

/**
 * Wheel event → multiplicative zoom factor.
 *
 * `deltaMode` normalisation matters here: a Windows/Linux mouse reports whole
 * lines (mode 1) where a macOS trackpad reports pixels (mode 0), and treating
 * `deltaY: 3` as three pixels would make a physical mouse wheel feel dead.
 * The per-event delta is clamped so a flung trackpad gesture cannot jump
 * several octaves in one frame.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1
  const perUnit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1
  const pixels = Math.max(-160, Math.min(160, deltaY * perUnit))
  return Math.exp(-pixels * 0.002)
}

/**
 * Leading mermaid keyword of a diagram source, used as the modal's caption.
 *
 * Skips what mermaid itself skips before the diagram declaration: a YAML
 * frontmatter block, `%%` comments and `%%{init: …}%%` directives.
 * Returns null when nothing looks like a diagram type.
 */
export function detectDiagramType(code: string): string | null {
  if (!code) return null
  const lines = code.split('\n')
  let i = 0

  // YAML frontmatter (`---` … `---`), supported by mermaid ≥10.
  if (lines[0]?.trim() === '---') {
    i = 1
    while (i < lines.length && lines[i]!.trim() !== '---') i++
    i++
  }

  for (; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line || line.startsWith('%%')) continue
    const token = /^([A-Za-z][\w-]*)/.exec(line)?.[1]
    return token ?? null
  }
  return null
}

<script lang="ts">
  /**
   * Full-window zoom preview for a rendered mermaid diagram (issue #89).
   *
   * The SVG handed in is a **clone of the node already on screen**, not a fresh
   * mermaid render: opening is instant, the modal is guaranteed to match the
   * inline preview pixel for pixel, and nothing goes through `innerHTML` /
   * `{@html}` — the element is moved into the stage as a DOM node.
   *
   * All pan/zoom maths lives in `mermaid-zoom.ts` so it can be unit-tested;
   * this component owns only the listeners, the transform string and focus.
   */
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import {
    MIN_SCALE,
    MAX_SCALE,
    clampScale,
    computeFit,
    centerOffset,
    parseSvgSize,
    steppedScale,
    wheelZoomFactor,
    zoomAtPoint,
    type Size,
    type ViewTransform,
  } from './mermaid-zoom';

  let {
    svg,
    caption = null,
    onClose,
  }: {
    /** A detached clone of the rendered diagram. This component takes ownership. */
    svg: SVGSVGElement;
    /** Diagram type shown in the header (e.g. "flowchart"). */
    caption?: string | null;
    onClose: () => void;
  } = $props();

  /** Fallback natural size when the SVG carries neither viewBox nor px dimensions. */
  const FALLBACK_SIZE: Size = { width: 800, height: 600 };

  let stageEl: HTMLDivElement | undefined = $state();
  let contentEl: HTMLDivElement | undefined = $state();

  let view = $state<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  let natural: Size = FALLBACK_SIZE;

  /** Once the user has zoomed or panned, a window resize must not yank the
   *  diagram back to the fitted position under their cursor. */
  let userAdjusted = false;

  // Pan loop state. A plain mousedown → mousemove → mouseup loop rather than
  // native drag-and-drop, matching how the editor's block drag handle works.
  let panning = $state(false); // reactive: drives the grab/grabbing cursor
  let panMoved = false;
  let panStart = { x: 0, y: 0, tx: 0, ty: 0 };

  function stageSize(): Size {
    if (!stageEl) return { width: 0, height: 0 };
    return { width: stageEl.clientWidth, height: stageEl.clientHeight };
  }

  function fitToWindow() {
    view = computeFit(natural, stageSize());
    userAdjusted = false;
  }

  function actualSize() {
    view = { scale: 1, ...centerOffset(natural, stageSize(), 1) };
    userAdjusted = true;
  }

  /** Zoom a step in/out about the stage centre (buttons + keyboard). */
  function zoomBy(direction: number) {
    const { width, height } = stageSize();
    view = zoomAtPoint(view, steppedScale(view.scale, direction), { x: width / 2, y: height / 2 });
    userAdjusted = true;
  }

  function toggleFitActual() {
    const fitted = computeFit(natural, stageSize());
    if (Math.abs(view.scale - 1) < 0.001) view = fitted;
    else actualSize();
  }

  // ── Wheel zoom ───────────────────────────────────────────────────────────
  // Registered imperatively because the handler calls preventDefault(): a
  // Svelte `onwheel` attribute may be attached passively, and a passive
  // handler's preventDefault() is ignored — the whole window would scroll
  // (or, in WKWebView, rubber-band) instead of the diagram zooming.
  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    if (!stageEl) return;
    const rect = stageEl.getBoundingClientRect();
    const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
    view = zoomAtPoint(view, clampScale(view.scale * factor), {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    userAdjusted = true;
  }

  // ── Pan ──────────────────────────────────────────────────────────────────

  function startPan(e: MouseEvent) {
    if (e.button !== 0) return;
    panning = true;
    panMoved = false;
    panStart = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    window.addEventListener('mousemove', handlePanMove);
    window.addEventListener('mouseup', endPan);
  }

  function handlePanMove(e: MouseEvent) {
    if (!panning) return;
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    if (!panMoved && Math.abs(dx) + Math.abs(dy) > 3) panMoved = true;
    view = { ...view, tx: panStart.tx + dx, ty: panStart.ty + dy };
    if (panMoved) userAdjusted = true;
  }

  function endPan() {
    panning = false;
    window.removeEventListener('mousemove', handlePanMove);
    window.removeEventListener('mouseup', endPan);
  }

  /** Click on the empty stage closes — unless it was the tail of a pan drag. */
  function handleStageClick(e: MouseEvent) {
    if (panMoved) {
      panMoved = false;
      return;
    }
    if (e.target === stageEl) onClose();
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  function handleKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case '+':
      case '=':
        e.preventDefault();
        zoomBy(1);
        break;
      case '-':
      case '_':
        e.preventDefault();
        zoomBy(-1);
        break;
      case '0':
        e.preventDefault();
        fitToWindow();
        break;
      case '1':
        e.preventDefault();
        actualSize();
        break;
    }
  }

  function handleResize() {
    if (userAdjusted) return;
    fitToWindow();
  }

  onMount(() => {
    natural =
      parseSvgSize(svg.getAttribute('viewBox'), svg.getAttribute('width'), svg.getAttribute('height')) ??
      FALLBACK_SIZE;

    // mermaid pins an inline `max-width` and frequently sets width="100%" —
    // both fight the CSS transform, so the clone is re-anchored to its own
    // natural pixel box and the stage transform does all the sizing.
    svg.removeAttribute('style');
    svg.setAttribute('width', String(natural.width));
    svg.setAttribute('height', String(natural.height));
    contentEl?.appendChild(svg);

    fitToWindow();

    stageEl?.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('keydown', handleKeydown, true);
    window.addEventListener('resize', handleResize);
  });

  onDestroy(() => {
    stageEl?.removeEventListener('wheel', handleWheel);
    window.removeEventListener('keydown', handleKeydown, true);
    window.removeEventListener('resize', handleResize);
    endPan();
  });

  const percent = $derived(Math.round(view.scale * 100));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="mermaid-zoom-overlay" role="dialog" aria-modal="true" aria-label={$t('mermaid.zoom')}>
  <header class="zoom-header">
    <span class="zoom-caption">{caption ?? $t('mermaid.diagram')}</span>
    <button class="zoom-close" type="button" title={$t('common.close')} aria-label={$t('common.close')} onclick={onClose}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  </header>

  <div
    class="zoom-stage"
    class:panning
    bind:this={stageEl}
    onmousedown={startPan}
    onclick={handleStageClick}
    ondblclick={toggleFitActual}
  >
    <div
      class="zoom-content"
      bind:this={contentEl}
      style="transform: translate({view.tx}px, {view.ty}px) scale({view.scale});"
    ></div>
  </div>

  <footer class="zoom-controls">
    <button type="button" title={$t('mermaid.zoom_out')} aria-label={$t('mermaid.zoom_out')} disabled={view.scale <= MIN_SCALE} onclick={() => zoomBy(-1)}>−</button>
    <button type="button" class="zoom-percent" title={$t('mermaid.fit')} onclick={fitToWindow}>{percent}%</button>
    <button type="button" title={$t('mermaid.zoom_in')} aria-label={$t('mermaid.zoom_in')} disabled={view.scale >= MAX_SCALE} onclick={() => zoomBy(1)}>+</button>
    <span class="zoom-sep" aria-hidden="true"></span>
    <button type="button" class="zoom-text-btn" onclick={fitToWindow}>{$t('mermaid.fit')}</button>
    <button type="button" class="zoom-text-btn" onclick={actualSize}>{$t('mermaid.actual_size')}</button>
  </footer>

  <p class="zoom-hint">{$t('mermaid.zoom_hint')}</p>
</div>

<style>
  .mermaid-zoom-overlay {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: flex;
    flex-direction: column;
    /* Fully opaque, and specifically the editor's own background: mermaid
       themes every diagram against `--bg-primary`, so a translucent scrim
       (or a dark one) would show the document through the strokes and fight
       the colours the diagram was rendered for. */
    background: var(--bg-primary);
    user-select: none;
  }

  .zoom-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border-light);
  }

  .zoom-caption {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    letter-spacing: 0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .zoom-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .zoom-close:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .zoom-stage {
    flex: 1 1 auto;
    position: relative;
    overflow: hidden;
    cursor: grab;
    min-height: 0;
  }

  .zoom-stage.panning {
    cursor: grabbing;
  }

  .zoom-content {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    /* No transition: the transform is driven by wheel/drag at pointer rate,
       and interpolating it would lag a frame behind the cursor. */
  }

  /* The SVG is appended imperatively, so scoped selectors would not reach it.
     `max-width: none` undoes mermaid's own inline cap on the source node in
     case a future version moves it into the SVG's internal <style>. */
  .zoom-content :global(svg) {
    display: block;
    max-width: none;
  }

  .zoom-controls {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.4rem;
  }

  .zoom-controls button {
    min-width: 30px;
    height: 26px;
    padding: 0 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 5px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--font-size-xs);
    line-height: 1;
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }

  .zoom-controls button:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--accent-color);
  }

  .zoom-controls button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .zoom-percent {
    min-width: 56px;
    font-variant-numeric: tabular-nums;
  }

  .zoom-text-btn {
    min-width: 0;
  }

  .zoom-sep {
    width: 1px;
    height: 16px;
    margin: 0 0.35rem;
    background: var(--border-color);
  }

  .zoom-hint {
    flex: 0 0 auto;
    margin: 0;
    padding: 0 0.5rem 0.6rem;
    text-align: center;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }
</style>

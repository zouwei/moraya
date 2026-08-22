<script lang="ts">
  /**
   * The prose column's width handle — a thin strip down the RIGHT edge of the
   * content box that widens or narrows the writing measure.
   *
   * It used to live between the outline and the text, as the outline panel's
   * own right-edge handle. That put it in the exact 22px lane the block
   * buttons (drag + insert) occupy, so every trip from the text out to a
   * button crossed the strip: the strip belongs to `.outline-wrapper`, and
   * the editor's hover tracker treats anything inside the outline as "not
   * content" and hides the buttons. Moving the width handle to the far side
   * clears that lane completely; the outline keeps its own handle on the
   * opposite (leading) edge of the same box.
   *
   * The parent must be `position: relative` — the strip spans its full height
   * so the column can be resized from anywhere down the document.
   */
  import { LINE_WIDTH_MIN, LINE_WIDTH_MAX, LINE_WIDTH_STEP, resizeWidth } from './content-width';
  import { t } from '$lib/i18n';

  let {
    width,
    onWidthChange,
  }: {
    /** Current prose-column width in px (settings.editorLineWidth). */
    width: number;
    onWidthChange?: (width: number) => void;
  } = $props();

  let dragging = $state(false);
  let hoverVisible = $state(false);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  /** Same 1s dwell the outline handle uses — the strip stays invisible until
   *  the pointer has clearly settled on it, so it never flickers into view
   *  while the cursor is just passing by on its way to the scrollbar. */
  function onHandleEnter() { hoverTimer = setTimeout(() => { hoverVisible = true; }, 1000); }
  function onHandleLeave() { clearTimeout(hoverTimer); hoverVisible = false; }

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    dragging = true;
    hoverVisible = true;
    clearTimeout(hoverTimer);
    const startX = e.clientX;
    const startW = width;
    const rtl = document.documentElement.dir === 'rtl';
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    function onPointerMove(ev: PointerEvent) {
      onWidthChange?.(
        resizeWidth(startW, ev.clientX - startX, {
          min: LINE_WIDTH_MIN,
          max: LINE_WIDTH_MAX,
          step: LINE_WIDTH_STEP,
          // The content box is centred, so its right edge only travels half
          // as far as the width grows. See content-width.ts.
          gain: 2,
          rtl,
        }),
      );
    }

    function onPointerUp() {
      dragging = false;
      hoverVisible = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="width-handle"
  class:visible={hoverVisible || dragging}
  title={$t('editor.width_handle_tooltip')}
  onpointerdown={onPointerDown}
  onpointerenter={onHandleEnter}
  onpointerleave={onHandleLeave}
></div>

<style>
  .width-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    /* Straddles the column edge: half over the last few pixels of the text
       box, half in the gutter. Wide enough to grab without a precise aim,
       narrow enough not to swallow clicks meant for the text. */
    inset-inline-end: -3px;
    width: 6px;
    cursor: col-resize;
    z-index: 2;
  }

  .width-handle.visible {
    background: var(--accent-color);
    opacity: 0.4;
  }
</style>

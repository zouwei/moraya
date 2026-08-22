<script lang="ts">
  import { t } from '$lib/i18n';
  import { OUTLINE_MIN_WIDTH, OUTLINE_MAX_WIDTH, resizeWidth } from '$lib/editor/content-width';

  export interface OutlineHeading {
    id: string;
    level: number;
    text: string;
    html?: string;
  }

  let {
    headings = [],
    activeId = null,
    width = 200,
    containerHeight = 0,
    resizeEdge = 'trailing',
    centered = false,
    trailingGutter = 0,
    onSelect,
    onWidthChange,
  }: {
    headings?: OutlineHeading[];
    activeId?: string | null;
    width?: number;
    containerHeight?: number;
    /**
     * Which edge carries the resize strip.
     *
     * 'trailing' (the default, and what the Typst pane uses) puts it between
     * the outline and the content. The markdown editors pass 'leading'
     * instead: their content column has floating block buttons in that lane,
     * and a strip there swallows the pointer on the way to them. Their prose
     * column is resized from its own far edge — see ContentWidthHandle.
     */
    resizeEdge?: 'leading' | 'trailing';
    /**
     * True when the host centres the outline + content box with auto margins.
     * A centred box's edge travels half as far as the width grows, so the
     * drag has to apply twice the pointer delta to stay under the cursor.
     */
    centered?: boolean;
    /** Reserved gutter between the outline and the content, in px. */
    trailingGutter?: number;
    onSelect?: (heading: OutlineHeading) => void;
    onWidthChange?: (width: number) => void;
  } = $props();

  let dragging = $state(false);
  let hoverVisible = $state(false);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  function onHandleEnter() { hoverTimer = setTimeout(() => { hoverVisible = true; }, 1000); }
  function onHandleLeave() { clearTimeout(hoverTimer); hoverVisible = false; }

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    dragging = true;
    const startX = e.clientX;
    const startW = width;
    const isRtl = document.documentElement.dir === 'rtl';
    // Prevent text selection in editor during drag
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    function onPointerMove(ev: PointerEvent) {
      onWidthChange?.(
        resizeWidth(startW, ev.clientX - startX, {
          min: OUTLINE_MIN_WIDTH,
          max: OUTLINE_MAX_WIDTH,
          gain: centered ? 2 : 1,
          leading: resizeEdge === 'leading',
          rtl: isRtl,
        }),
      );
    }

    function onPointerUp() {
      dragging = false;
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
<div class="outline-wrapper" class:dragging style="width: {width}px; margin-inline-end: {trailingGutter}px{containerHeight > 0 ? `; --_ch: ${containerHeight}px` : ''}">
  <nav class="outline-scroll">
    {#if headings.length === 0}
      <span class="outline-empty">{$t('outline.empty')}</span>
    {:else}
      {#each headings as h}
        <button
          class="outline-item"
          class:active={h.id === activeId}
          style="--outline-indent: {h.level - 1}em"
          onclick={() => onSelect?.(h)}
          title={h.text}
        >
          {#if h.html}
            {@html h.html}
          {:else}
            {h.text}
          {/if}
        </button>
      {/each}
    {/if}
  </nav>
  <div class="resize-handle" class:leading={resizeEdge === 'leading'} class:hover-visible={hoverVisible} onpointerdown={onPointerDown} onpointerenter={onHandleEnter} onpointerleave={onHandleLeave}></div>
</div>

<style>
  /* Outer wrapper: sticky positioning + holds resize handle */
  .outline-wrapper {
    position: sticky;
    top: 0;
    flex-shrink: 0;
    align-self: flex-start;
    height: calc(var(--_ch, 100dvh) - 4rem);
    max-height: calc(100dvh - var(--statusbar-height) - 4rem);
    user-select: none;
  }

  /* Inner scrollable area */
  .outline-scroll {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 8px;
    scrollbar-width: none;
  }

  .outline-scroll::-webkit-scrollbar {
    display: none;
  }

  .outline-empty {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  /* Heading indent is ONE CHARACTER per level (set inline as `em` on the item):
     1em is one CJK glyph at the item's own font size, so the rhythm holds exactly
     and survives a font-size change. The previous fixed 12px step was ~1.1
     characters at the current font — an accidental value. Kept in sync with the
     web build. */
  .outline-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    /* Positioning context for the active indicator (see .active::before). */
    position: relative;
    /* The indent belongs to the TEXT, and the active bar sits just left of it —
       so the bar has to move with the indent. A `border-left` cannot: borders
       are outside the padding box, so the bar would stay pinned to the item's
       far-left edge while the text moved right. Hence padding for the indent
       plus 6px (2px bar + 4px gap) reserved on every row, active or not, so
       nothing shifts when the active row changes. */
    padding-block: 2px;
    padding-inline-start: calc(var(--outline-indent, 0px) + 6px);
    padding-inline-end: 4px;
    font-size: var(--font-size-xs);
    line-height: 1.6;
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.15s;
  }

  .outline-item :global(.katex) {
    font-size: inherit;
  }

  .outline-item:hover {
    color: var(--text-primary);
  }

  /* One outline for both document flavors: identical layout and behavior, with
     only the active row's colour themable by the host. TypstEditor points these
     at --typst-accent-color so the outline matches its tab underline; markdown
     hosts set nothing and fall back to the app accent. */
  .outline-item.active {
    color: var(--outline-active-text, var(--text-primary));
  }
  .outline-item.active::before {
    content: '';
    position: absolute;
    inset-block: 0;
    /* Exactly the indent: the bar lands immediately left of the first glyph,
       inside the 6px reserved above. `inset-inline-start` flips for RTL on its
       own, so no direction-specific override is needed. */
    inset-inline-start: var(--outline-indent, 0px);
    width: 2px;
    background: var(--outline-active-accent, var(--accent-color));
  }

  /* Resize handle — full height, outside the scroll area. Sits on whichever
     edge `resizeEdge` names, using logical insets so RTL mirrors it for free
     (the leading edge is the right one there). */
  .resize-handle {
    position: absolute;
    top: 0;
    inset-inline-end: 0;
    width: 4px;
    height: 100%;
    cursor: col-resize;
    z-index: 1;
  }

  .resize-handle.leading {
    inset-inline-end: auto;
    inset-inline-start: 0;
  }

  .resize-handle.hover-visible,
  .dragging .resize-handle {
    background: var(--accent-color);
    opacity: 0.4;
  }

  .outline-wrapper.dragging {
    cursor: col-resize;
  }

  /* RTL overrides */
  :global([dir="rtl"]) .outline-scroll {
    padding-right: 0;
    padding-left: 8px;
  }

  :global([dir="rtl"]) .outline-item {
    text-align: right;
  }

</style>

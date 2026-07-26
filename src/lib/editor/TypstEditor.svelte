<script lang="ts">
  /**
   * TypstEditor — the Typst authoring surface (P1).
   *
   * Typst is a compiler, not a WYSIWYG format, so a `.typ` document is edited as
   * source on the left with a live compiled preview on the right (like Overleaf
   * / the official Typst app) — deliberately distinct from the ProseMirror
   * markdown editor. The compile loop (debounce + stale-result rejection +
   * diagnostic normalization) lives in `@moraya/core/typst` so PC / Web /
   * Mobile share it; this component supplies the desktop compiler (the native
   * on-demand `typst` CLI) and the UI. Export is driven from the File → Export
   * menu, not from this component.
   */
  import { onDestroy } from 'svelte';
  import { createPreviewCompiler, type PreviewCompiler } from '@moraya/core/typst';
  import { tokenizeTypst, typstTokenClass } from '@moraya/core/typst';
  import { zoomByWheel, anchoredScroll, isZoomGesture, fitPageBox } from '@moraya/core/typst';
  import { extractTypstOutline, type TypstHeading } from '@moraya/core/typst';
  import OutlinePanel, { type OutlineHeading } from '$lib/components/OutlinePanel.svelte';
  import { t } from '$lib/i18n';
  import type { EditorMode } from '$lib/stores/editor-store';
  import { tauriTypstCompiler, queryTypstHeadingPositions, type TypstHeadingPosition } from './typst-compiler';
  import { applyTypstAction, type TypstAction } from './typst-commands';

  let {
    content = $bindable(''),
    editorMode = 'split',
    readOnly = false,
    showOutline = false,
    outlineWidth = 200,
    onContentChange,
    onOutlineWidthChange,
  }: {
    content?: string;
    /** Mirrors the app-wide Visual/Source/Split toggle: 'visual' shows only the
     *  compiled preview (Typst's closest equivalent to WYSIWYG — read/rendered,
     *  not editable), 'source' shows only the raw .typ text, 'split' (the
     *  default for Typst tabs) shows both side by side. */
    editorMode?: EditorMode;
    readOnly?: boolean;
    /** Mirrors the app-wide View ▸ Outline toggle. */
    showOutline?: boolean;
    outlineWidth?: number;
    onContentChange?: (source: string) => void;
    onOutlineWidthChange?: (width: number) => void;
  } = $props();

  const showSource = $derived(editorMode === 'source' || editorMode === 'split');
  const showPreview = $derived(editorMode === 'visual' || editorMode === 'split');

  // Split shows two panes already; a third column would leave too little room
  // for either. Matches the markdown editors, which also drop the outline in
  // split mode. In the single-pane modes the outline attaches to whichever pane
  // is on screen — the source pane in 'source', the preview in 'visual'.
  const outlineInSource = $derived(showOutline && editorMode === 'source');
  const outlineInPreview = $derived(showOutline && editorMode === 'visual');
  const outlineOn = $derived(outlineInSource || outlineInPreview);

  let pages = $state<string[]>([]);
  let compileError = $state<string | null>(null);
  let compiling = $state(false);
  let engineDownloading = $state(false);

  // Shared compile loop from core: debounces keystrokes, ignores an unchanged
  // buffer (the editor re-emits content on tab restore), and drops results a
  // newer compile has superseded.
  const preview: PreviewCompiler = createPreviewCompiler({
    compiler: tauriTypstCompiler,
    onPages: (p) => { pages = p; },
    onError: (message) => { compileError = message; },
    onProgress: (progress) => {
      // 'preparing' means the engine is being downloaded on first use (~14 MB).
      engineDownloading = progress.phase === 'preparing';
      compiling = progress.phase === 'preparing' || progress.phase === 'compiling';
    },
  });

  // Preview sizing: publish the pane's usable height as a CSS variable so a
  // page can be capped to "fit page" in real pixels (see .typst-page svg).
  // ── Preview zoom & pan ──────────────────────────────────────────────
  // Document-viewer behaviour: ⌘/Ctrl + wheel zooms about the cursor, left-drag
  // pans. `zoom` multiplies the fit-to-pane size so pages actually grow in
  // layout — that is what gives the pane real overflow to pan through (a CSS
  // transform would scale pixels but leave the scroll extent unchanged).
  let zoom = $state(1);
  let panning = $state(false);
  let panStart = { x: 0, y: 0, left: 0, top: 0 };

  function onPreviewWheel(e: WheelEvent) {
    if (!isZoomGesture(e)) return; // plain wheel keeps scrolling
    e.preventDefault();
    const el = previewPaneEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const prev = zoom;
    const next = zoomByWheel(prev, e.deltaY);
    if (next === prev) return;
    zoom = next;
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const left = el.scrollLeft;
    const top = el.scrollTop;
    // Applied after the size vars update so the new scroll extent exists.
    requestAnimationFrame(() => {
      el.scrollLeft = anchoredScroll({ scroll: left, cursor: cursorX, oldScale: prev, newScale: next });
      el.scrollTop = anchoredScroll({ scroll: top, cursor: cursorY, oldScale: prev, newScale: next });
    });
  }

  function onPreviewPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    // The outline now lives inside the pane: clicking an entry or dragging its
    // resize handle must not also start a pan (pointer capture would swallow
    // the click).
    if ((e.target as HTMLElement | null)?.closest('.outline-wrapper')) return;
    const el = previewPaneEl;
    if (!el) return;
    panning = true;
    panStart = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  }

  function onPreviewPointerMove(e: PointerEvent) {
    if (!panning) return;
    const el = previewPaneEl;
    if (!el) return;
    el.scrollLeft = panStart.left - (e.clientX - panStart.x);
    el.scrollTop = panStart.top - (e.clientY - panStart.y);
  }

  function endPan(e: PointerEvent) {
    if (!panning) return;
    panning = false;
    previewPaneEl?.releasePointerCapture(e.pointerId);
  }

  let previewPaneEl = $state<HTMLElement | null>(null);
  let paneResizeObserver: ResizeObserver | null = null;

  /** Intrinsic size of a rendered page, read from the compiled SVG's viewBox. */
  let pageSize = $state<{ width: number; height: number } | null>(null);
  let measureRaf: number | undefined;

  // Measure the page once it is in the DOM. The native compiler returns SVG
  // markup, not dimensions, and the page's own aspect ratio is what decides the
  // fit scale — a document that sets `#set page(paper: "a5")` is not A4.
  $effect(() => {
    void pages;
    const el = previewPaneEl;
    if (measureRaf !== undefined) cancelAnimationFrame(measureRaf);
    if (!el) return;
    measureRaf = requestAnimationFrame(() => {
      measureRaf = undefined;
      const svg = el.querySelector('.typst-page svg') as SVGSVGElement | null;
      if (!svg) return;
      const box = svg.viewBox?.baseVal;
      const width = box?.width || svg.width?.baseVal?.value || 0;
      const height = box?.height || svg.height?.baseVal?.value || 0;
      if (width > 0 && height > 0) pageSize = { width, height };
    });
  });

  onDestroy(() => {
    if (measureRaf !== undefined) cancelAnimationFrame(measureRaf);
  });

  $effect(() => {
    const el = previewPaneEl;
    void zoom; // recompute the size vars when zoom changes
    void pageSize;
    // Showing/hiding or dragging the outline changes the page's usable width.
    void outlineInPreview;
    void outlineWidth;
    paneResizeObserver?.disconnect();
    paneResizeObserver = null;
    if (!el) return;
    const apply = () => {
      // clientHeight/clientWidth include padding; subtract it for the content box.
      const style = getComputedStyle(el);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      // The outline shares the pane's content box, so its width is not available
      // to the page — without this the page is fitted to the full pane and
      // overflows by exactly the outline's width.
      const outlineW = outlineInPreview ? outlineWidth : 0;
      const availW = Math.max(0, el.clientWidth - padX - outlineW);
      const availH = Math.max(0, el.clientHeight - padY);

      const size = pageSize;
      if (!size) {
        // Nothing rendered yet — leave the page at its natural size.
        el.style.removeProperty('--typst-page-w');
        el.style.removeProperty('--typst-page-h');
        return;
      }
      // Fits BOTH axes (fitting height alone let a wide page overflow sideways)
      // and returns a definite size: `max-width`/`max-height` only clamp down,
      // so a page smaller than the pane never scaled up and zoom did nothing.
      const box = fitPageBox({ width: availW, height: availH }, size, zoom);
      pageBoxPx = box;
      el.style.setProperty('--typst-page-w', `${box.width}px`);
      el.style.setProperty('--typst-page-h', `${box.height}px`);
    };
    apply();
    paneResizeObserver = new ResizeObserver(apply);
    paneResizeObserver.observe(el);
    return () => {
      paneResizeObserver?.disconnect();
      paneResizeObserver = null;
    };
  });

  // Recompile whenever the source changes — typing OR an external swap (tab
  // switch rebinds `content`).
  $effect(() => {
    preview.request(content);
  });

  // ── Syntax highlighting ─────────────────────────────────────────────
  // A textarea cannot render styled spans, so a syntax-colored <pre> sits
  // underneath and the textarea on top is made transparent (native caret and
  // selection are kept). Both layers MUST share font metrics and padding, or
  // the colored text drifts away from the glyphs being edited.
  let highlightEl = $state<HTMLElement | null>(null);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const highlighted = $derived.by(() => {
    const src = content;
    let html = '';
    let last = 0;
    for (const tok of tokenizeTypst(src)) {
      if (tok.start > last) html += escapeHtml(src.slice(last, tok.start));
      const cls = typstTokenClass(tok.type);
      const text = escapeHtml(src.slice(tok.start, tok.end));
      html += cls ? `<span class="${cls}">${text}</span>` : text;
      last = tok.end;
    }
    html += escapeHtml(src.slice(last));
    // Without a trailing newline the highlight layer ends one line short of
    // the textarea while scrolling.
    return html + '\n';
  });

  function syncScroll() {
    if (!highlightEl || !textareaEl) return;
    highlightEl.scrollTop = textareaEl.scrollTop;
    highlightEl.scrollLeft = textareaEl.scrollLeft;
    if (outlineInSource) scheduleActiveUpdate();
  }

  // ── Outline ─────────────────────────────────────────────────────────
  // Headings come from `@moraya/core/typst` (shared with web / mobile); this
  // component only maps them onto the source pane's geometry. The panel itself
  // is the same OutlinePanel the markdown editors use — it is flavor-agnostic.
  let typstHeads = $state<TypstHeading[]>([]);
  let activeHeadingId = $state<string | null>(null);
  let outlineTimer: ReturnType<typeof setTimeout> | undefined;
  let topsRaf: number | undefined;
  let activeRaf: number | undefined;
  let paneHeight = $state(0);
  let panesHeight = $state(0);
  /** Rendered page box, mirrored from the sizing effect for preview scrolling. */
  let pageBoxPx = $state<{ width: number; height: number } | null>(null);
  /** Compiler-reported heading positions — visual mode only. */
  let headingPositions = $state<TypstHeadingPosition[]>([]);
  let positionsTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pixel top of each heading within the scroll content, index-aligned. */
  let headingTops: number[] = [];
  /** Suppressed while a click-driven scroll animates, so the highlight holds. */
  let outlineClickScrolling = false;
  /** Must match `.typst-preview-pane`'s `gap` and `padding` below. */
  const PREVIEW_PAGE_GAP = 16;
  const PREVIEW_PANE_PADDING = 20;

  const outlineHeadings = $derived<OutlineHeading[]>(
    typstHeads.map((h) => ({
      id: h.id,
      level: h.level,
      // The number is part of what the page shows, so the outline shows it too.
      text: h.number ? `${h.number} ${h.text}` : h.text,
    })),
  );

  $effect(() => {
    const src = content;
    const on = outlineOn;
    clearTimeout(outlineTimer);
    if (!on) { typstHeads = []; headingTops = []; activeHeadingId = null; return; }
    // Same 300ms debounce as the markdown outline: re-parsing on every
    // keystroke is wasted work for a panel nobody reads mid-word.
    outlineTimer = setTimeout(() => {
      typstHeads = extractTypstOutline(src);
      scheduleMeasure();
    }, 300);
    return () => clearTimeout(outlineTimer);
  });

  // Visual mode: positions come from the compiler, because the rendered SVG
  // has no link back to the source. Requested only while that mode's outline is
  // actually on screen — it is a second Typst process per document change.
  $effect(() => {
    const on = outlineInPreview;
    const src = content;
    clearTimeout(positionsTimer);
    if (!on) { headingPositions = []; return; }
    positionsTimer = setTimeout(async () => {
      const found = await queryTypstHeadingPositions(src);
      // The document may have moved on while the query ran.
      if (src === content) { headingPositions = found; updateActiveHeading(); }
    }, 400);
    return () => clearTimeout(positionsTimer);
  });

  /**
   * Scroll offset of a heading inside the preview pane.
   *
   * Pages stack vertically with a fixed gap, each rendered at `pageBoxPx`; the
   * compiler reports a position in points on its page, so the y within a page
   * scales by rendered-height ÷ intrinsic-height.
   */
  function previewOffsetOf(index: number): number | null {
    const pos = headingPositions[index];
    const box = pageBoxPx;
    const size = pageSize;
    if (!pos || !box || !size || size.height <= 0) return null;
    const pageStride = box.height + PREVIEW_PAGE_GAP;
    return (
      PREVIEW_PANE_PADDING +
      (pos.page - 1) * pageStride +
      (pos.y / size.height) * box.height
    );
  }

  function scheduleMeasure() {
    if (topsRaf !== undefined) cancelAnimationFrame(topsRaf);
    topsRaf = requestAnimationFrame(() => {
      topsRaf = undefined;
      measureHeadingTops();
      updateActiveHeading();
    });
  }

  function scheduleActiveUpdate() {
    if (outlineClickScrolling) return;
    if (activeRaf !== undefined) return;
    activeRaf = requestAnimationFrame(() => {
      activeRaf = undefined;
      updateActiveHeading();
    });
  }

  /**
   * Measure where each heading sits, by ranging over the highlight layer.
   *
   * NOT `line * lineHeight`: the source pane soft-wraps, so a long paragraph
   * pushes everything below it down by an amount no line count can predict.
   * The highlight `<pre>` mirrors the textarea's metrics exactly — that is the
   * whole premise of the overlay — so a Range over it measures the real thing.
   */
  function measureHeadingTops() {
    const pre = highlightEl;
    if (!pre || typstHeads.length === 0) { headingTops = []; return; }
    try {
      const base = pre.getBoundingClientRect().top - pre.scrollTop;
      headingTops = typstHeads.map((h) => {
        const rect = rectAtOffset(pre, h.offset);
        return rect ? rect.top - base : 0;
      });
    } catch { headingTops = []; }
  }

  /** Client rect of the character at `offset` in the highlight layer's text. */
  function rectAtOffset(pre: HTMLElement, offset: number): DOMRect | null {
    const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
    let seen = 0;
    let node = walker.nextNode() as Text | null;
    while (node) {
      const len = node.data.length;
      if (seen + len > offset) {
        const range = document.createRange();
        range.setStart(node, offset - seen);
        range.setEnd(node, Math.min(offset - seen + 1, len));
        const rect = range.getBoundingClientRect();
        return rect.height > 0 ? rect : null;
      }
      seen += len;
      node = walker.nextNode() as Text | null;
    }
    return null;
  }

  function updateActiveHeading() {
    if (outlineInPreview) { updateActiveFromPreview(); return; }
    const ta = textareaEl;
    if (!ta || typstHeads.length === 0 || headingTops.length === 0) {
      activeHeadingId = null;
      return;
    }
    const cursor = ta.scrollTop + 40;
    let lastId: string | null = null;
    for (let i = 0; i < typstHeads.length; i++) {
      if (headingTops[i] <= cursor) lastId = typstHeads[i].id;
      else break;
    }
    // At the very bottom the final heading can be on screen yet still below the
    // threshold, with no scroll left to reach it.
    const maxScroll = ta.scrollHeight - ta.clientHeight;
    if (maxScroll > 0 && ta.scrollTop >= maxScroll - 2) {
      const lastTop = headingTops[headingTops.length - 1];
      if (lastTop <= ta.scrollTop + ta.clientHeight) lastId = typstHeads[typstHeads.length - 1].id;
    }
    activeHeadingId = lastId ?? typstHeads[0]?.id ?? null;
  }

  /** Active item in visual mode, from the preview's own scroll position. */
  function updateActiveFromPreview() {
    const el = previewPaneEl;
    if (!el || typstHeads.length === 0 || headingPositions.length === 0) {
      activeHeadingId = null;
      return;
    }
    const cursor = el.scrollTop + 40;
    let lastId: string | null = null;
    for (let i = 0; i < typstHeads.length; i++) {
      const top = previewOffsetOf(i);
      if (top === null) break;
      if (top <= cursor) lastId = typstHeads[i].id;
      else break;
    }
    activeHeadingId = lastId ?? typstHeads[0]?.id ?? null;
  }

  function handleOutlineSelect(h: OutlineHeading) {
    const idx = typstHeads.findIndex((x) => x.id === h.id);
    if (idx < 0) return;

    if (outlineInPreview) {
      const el = previewPaneEl;
      const top = previewOffsetOf(idx);
      if (!el || top === null) return;
      activeHeadingId = h.id;
      outlineClickScrolling = true;
      el.scrollTo({ top: Math.max(0, Math.round(top - 12)), behavior: 'smooth' });
      setTimeout(() => { outlineClickScrolling = false; }, 400);
      return;
    }

    const ta = textareaEl;
    if (!ta || idx >= headingTops.length) return;
    // Mark it active immediately: the scroll may be a no-op if the target is
    // already in place, and then no scroll event would arrive to do it.
    activeHeadingId = h.id;
    outlineClickScrolling = true;
    ta.scrollTo({ top: Math.max(0, Math.round(headingTops[idx] - 12)), behavior: 'smooth' });
    setTimeout(() => { outlineClickScrolling = false; }, 400);
  }

  // Wrapping changes with width, so every measured top does too.
  $effect(() => {
    void paneHeight;
    void outlineWidth;
    if (outlineInSource && typstHeads.length > 0) scheduleMeasure();
  });

  onDestroy(() => {
    clearTimeout(outlineTimer);
    if (topsRaf !== undefined) cancelAnimationFrame(topsRaf);
    if (activeRaf !== undefined) cancelAnimationFrame(activeRaf);
  });

  function onInput(e: Event) {
    const value = (e.target as HTMLTextAreaElement).value;
    content = value;
    onContentChange?.(value);
  }

  // ── Shared menu / shortcut actions (v0.46.0) ────────────────────────
  // The Paragraph + Format menus and their shortcuts are shared with markdown
  // documents; the markdown path runs ProseMirror commands, and this path
  // rewrites the .typ source. The markup rules live in typst-commands.ts as
  // pure functions so they stay unit-testable without a DOM.

  /**
   * Splice `next` into the textarea through `execCommand` so the edit joins the
   * native undo stack — Edit ▸ Undo on a Typst tab is `execCommand('undo')`, so
   * a direct `value =` assignment would be silently unundoable. Only the changed
   * span is replaced (common prefix/suffix trimmed), which also keeps the caret
   * stable for big documents. Falls back to a plain assignment if the (legacy,
   * but WebKit-supported) command is refused.
   */
  function spliceSource(ta: HTMLTextAreaElement, prev: string, next: string): void {
    let head = 0;
    const max = Math.min(prev.length, next.length);
    while (head < max && prev[head] === next[head]) head++;
    let tail = 0;
    while (tail < max - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    const from = head;
    const to = prev.length - tail;
    const inserted = next.slice(head, next.length - tail);

    ta.setSelectionRange(from, to);
    const ok = inserted
      ? document.execCommand('insertText', false, inserted)
      : document.execCommand('delete');
    if (!ok) {
      // execCommand refused (no undo entry, but the edit must still land).
      ta.value = next;
      content = next;
      onContentChange?.(next);
    }
  }

  /**
   * Apply a shared editing action to the Typst source.
   * Returns false when there is nothing to act on (no textarea / read-only).
   */
  export function runAction(action: TypstAction): boolean {
    const ta = textareaEl;
    if (!ta || readOnly) return false;
    ta.focus();
    const prev = ta.value;
    const next = applyTypstAction(
      { text: prev, start: ta.selectionStart, end: ta.selectionEnd },
      action,
    );
    if (next.text !== prev) spliceSource(ta, prev, next.text);
    // Selection is restored after the splice so the caret lands where the
    // command intended (inside a new mark, over the inserted block, …).
    ta.setSelectionRange(next.start, next.end);
    return true;
  }

  /** Select the whole source buffer (Edit ▸ Select All on a Typst tab). */
  export function selectAll(): boolean {
    const ta = textareaEl;
    if (!ta) return false;
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    return true;
  }

  /** Focus the source textarea. */
  export function focusSource(): void {
    textareaEl?.focus();
  }

  onDestroy(() => {
    preview.dispose();
    paneResizeObserver?.disconnect();
  });
</script>

<div class="typst-editor">
  <div class="typst-panes" bind:clientHeight={panesHeight}>
    {#if showSource}
      <div
        class="typst-source-pane"
        class:full-width={editorMode === 'source'}
        bind:clientHeight={paneHeight}
      >
        {#if outlineInSource}
          <!-- Slot carries the inset: the panel itself is shared with the
               markdown editors, where the surrounding centred content area
               already provides the margin. Here the pane runs to the window
               edge, so the spacing has to come from this side. -->
          <div class="typst-outline-slot edge">
            <OutlinePanel
              headings={outlineHeadings}
              activeId={activeHeadingId}
              width={outlineWidth}
              containerHeight={paneHeight}
              onSelect={handleOutlineSelect}
              onWidthChange={onOutlineWidthChange}
            />
          </div>
        {/if}
        <div class="typst-source-stack">
          <pre class="typst-source typst-highlight" bind:this={highlightEl} aria-hidden="true"><!--
            -->{@html highlighted}</pre>
          <textarea
          bind:this={textareaEl}
          class="typst-source typst-source-input"
          value={content}
          oninput={onInput}
          onscroll={syncScroll}
          readonly={readOnly}
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          placeholder="= My Document&#10;&#10;Write Typst here…"
        ></textarea>
        </div>
      </div>
    {/if}
    {#if showPreview}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="typst-preview-pane"
        class:full-width={editorMode === 'visual'}
        class:panning
        bind:this={previewPaneEl}
        onwheel={onPreviewWheel}
        onpointerdown={onPreviewPointerDown}
        onpointermove={onPreviewPointerMove}
        onpointerup={endPan}
        onpointercancel={endPan}
        onscroll={() => { if (outlineInPreview) scheduleActiveUpdate(); }}
      >
        {#if outlineInPreview}
          <!-- A DIRECT child of the pane, with no wrapper — exactly how the
               markdown editors place it. That matters for more than symmetry:
               OutlinePanel is `position: sticky`, and sticky only holds within its
               containing block, so an intermediate div (which is only as tall as
               the outline itself) would scroll out of view and take the outline
               with it. As a direct flex item its containing block is the pane's
               full content box — as tall as the page stack — so the outline stays
               on screen for the whole scroll and keeps its own inner scrollbar. -->
          <OutlinePanel
            headings={outlineHeadings}
            activeId={activeHeadingId}
            width={outlineWidth}
            containerHeight={panesHeight}
            onSelect={handleOutlineSelect}
            onWidthChange={onOutlineWidthChange}
          />
        {/if}
        <div class="typst-pages">
          <!-- First-use engine download is slow (~14 MB); surface it here since
               the toolbar that used to show it was removed for a cleaner look. -->
          {#if engineDownloading}
            <div class="typst-empty">{$t('typst.downloading_engine')}</div>
          {:else if compileError}
            <pre class="typst-error">{compileError}</pre>
          {:else if pages.length === 0}
            <div class="typst-empty">{compiling ? $t('export.progress.rendering') : ''}</div>
          {:else}
            {#each pages as page, i (i)}
              <!-- Trusted compiler output of the user's own document, rendered in a
                   CSP script-src 'self' webview (inline SVG scripts cannot run). -->
              <div class="typst-page">{@html page}</div>
            {/each}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .typst-editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg-primary);
  }

  .typst-panes {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .typst-source-pane {
    flex: 1 1 50%;
    min-width: 0;
    border-right: 1px solid var(--border-color);
    display: flex;
  }
  .typst-source-pane.full-width {
    flex: 1 1 100%;
    border-right: none;
  }
  .typst-outline-slot {
    flex-shrink: 0;
    /* Same accent the Typst tab underline uses (themed light/dark in
       variables.css), so "which flavor am I in" reads consistently across the
       tab bar and the outline. */
    --outline-active-accent: var(--typst-accent-color);
    --outline-active-text: var(--typst-accent-color);
  }
  /* Source pane only: that pane runs to the window edge and has no padding of
     its own, so the inset comes from here. The top padding matches
     `.typst-source`'s own 16px, putting the first outline entry on the same
     baseline as the first source line. In the preview pane the pane's 20px
     padding already provides it — and OutlinePanel's own 8px right gap is what
     separates it from the content, exactly as in the markdown editors. */
  .typst-outline-slot.edge {
    padding: 16px 8px 16px 20px;
  }

  /* The highlight layer and the textarea are stacked and MUST share every
     metric that affects text layout — any difference shows up as the colored
     text drifting away from the real (invisible) glyphs being edited. */
  .typst-source-stack {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
  }
  .typst-source {
    flex: 1;
    width: 100%;
    resize: none;
    border: none;
    outline: none;
    padding: 16px;
    font-family: var(--font-mono);
    /* Tracks the app zoom (View ▸ Zoom In/Out sets --font-size-base) so the
       shared zoom shortcuts affect the Typst source pane too — a hardcoded size
       made Cmd+= / Cmd+- silently no-ops here. Both layers of the stack read the
       same value, otherwise the highlight <pre> drifts off the glyphs. */
    font-size: calc(var(--font-size-base) - 2px);
    line-height: 1.6;
    tab-size: 2;
    background: var(--bg-primary);
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
  }
  .typst-highlight {
    position: absolute;
    inset: 0;
    margin: 0;
    overflow: auto;
    pointer-events: none;
    z-index: 0;
  }
  .typst-source-input {
    position: relative;
    z-index: 1;
    background: transparent;
    /* Hide the real glyphs but keep the native caret and selection. */
    color: transparent;
    caret-color: var(--text-primary);
  }

  /* Token colors. Categories follow Typst's official `Tag` enum and the
     `typ-*` class convention from typst-syntax/src/highlight.rs. Kept in sync
     with moraya-web's TypstEditor so both platforms look the same. */
  .typst-highlight :global(.typ-comment) { color: #8a8f98; font-style: italic; }
  .typst-highlight :global(.typ-heading) { color: #1f8a98; font-weight: 600; }
  .typst-highlight :global(.typ-strong) { color: var(--text-primary); font-weight: 700; }
  .typst-highlight :global(.typ-emph) { color: var(--text-primary); font-style: italic; }
  .typst-highlight :global(.typ-raw) { color: #b45309; }
  .typst-highlight :global(.typ-math) { color: #7c3aed; }
  .typst-highlight :global(.typ-link) { color: #2563eb; text-decoration: underline; }
  .typst-highlight :global(.typ-label),
  .typst-highlight :global(.typ-ref) { color: #0891b2; }
  .typst-highlight :global(.typ-listmarker) { color: #1f8a98; font-weight: 600; }
  .typst-highlight :global(.typ-escape) { color: #db2777; }
  .typst-highlight :global(.typ-keyword) { color: #7c3aed; font-weight: 600; }
  .typst-highlight :global(.typ-function) { color: #2563eb; }
  .typst-highlight :global(.typ-string) { color: #15803d; }
  .typst-highlight :global(.typ-number) { color: #c2410c; }
  .typst-highlight :global(.typ-operator),
  .typst-highlight :global(.typ-punctuation) { color: #6b7280; }

  /* Dark theme: same hues, lifted for contrast. */
  :global([data-theme='dark']) .typst-highlight :global(.typ-comment) { color: #6b7280; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-heading) { color: #35b4c2; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-raw) { color: #fbbf24; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-math) { color: #c4b5fd; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-link) { color: #60a5fa; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-label),
  :global([data-theme='dark']) .typst-highlight :global(.typ-ref) { color: #22d3ee; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-listmarker) { color: #35b4c2; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-escape) { color: #f472b6; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-keyword) { color: #c4b5fd; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-function) { color: #60a5fa; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-string) { color: #86efac; }
  :global([data-theme='dark']) .typst-highlight :global(.typ-number) { color: #fdba74; }
  .typst-preview-pane {
    flex: 1 1 50%;
    min-width: 0;
    /* min-height:0 keeps this flex item from growing past the pane, so the
       percentage max-height on .typst-page below resolves against a definite
       height instead of collapsing to `none`. */
    min-height: 0;
    overflow: auto;
    /* Reserve the scrollbar track permanently. Without this the pane oscillates:
       scrollbar shows → content box narrows → the page scales down via
       max-width → it no longer overflows → scrollbar hides → box widens →
       overflows again. The loop settles differently across repaints, which is
       why the scrollbar appeared/vanished when focus moved to the source pane. */
    scrollbar-gutter: stable;
    /* Pure white canvas in the light theme (was the slightly grey
       --bg-secondary). Kept as a theme variable rather than a literal #fff so
       the dark theme does not turn into a blinding white slab — with the canvas
       and the page now the same colour, the page's box-shadow is what separates
       them. */
    background: var(--bg-primary);
    padding: 20px;
    /* A ROW holding [outline][pages], centred as one group — the same geometry
       the markdown editors use, so the outline stays against the page edge
       instead of drifting to the window edge as the pane resizes.
       `safe center`: centre the group when it fits, but fall back to
       start-alignment the moment it overflows, so a zoomed-in or multi-page
       document stays scrollable from its real start instead of being clipped
       behind the scrollport. */
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    justify-content: safe center;
    /* Inherited by the OutlinePanel child: same accent as the Typst tab
       underline, so "which flavor am I in" reads consistently. */
    --outline-active-accent: var(--typst-accent-color);
    --outline-active-text: var(--typst-accent-color);
  }
  /* The page stack: keeps the previous column behaviour, including vertical
     `safe center` (via align-self) so a single short page still sits centred. */
  .typst-pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    align-self: safe center;
    gap: 16px;
    min-width: 0;
  }
  /* Default arrow: the pane is a preview first, a pannable canvas second —
     a permanent grab hand overstates it. Panning still works on drag. */
  .typst-preview-pane.panning { user-select: none; }
  .typst-preview-pane.full-width {
    flex: 1 1 100%;
  }
  .typst-page {
    background: #fff;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14);
    width: var(--typst-page-w, auto);
    /* Don't let the column flex layout squeeze pages instead of scrolling. */
    flex: 0 0 auto;
    line-height: 0;
  }
  .typst-page :global(svg) {
    display: block;
    /* "Fit page", as a definite pixel size resolved in JS from the page's own
       aspect ratio (see the ResizeObserver in script). Percentages cannot do
       this — they resolve through an auto-height ancestor chain and collapse —
       and `max-width`/`max-height` only shrink, so a page whose intrinsic SVG
       is smaller than the pane never scaled up and zoom did nothing. */
    width: var(--typst-page-w, auto);
    height: var(--typst-page-h, auto);
    max-width: none;
    max-height: none;
  }
  .typst-error {
    align-self: stretch;
    margin: 0;
    padding: 12px 14px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: #b91c1c;
    background: rgba(229, 62, 62, 0.06);
    border: 1px solid rgba(229, 62, 62, 0.2);
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .typst-empty {
    color: var(--text-secondary);
    font-size: 13px;
    margin-top: 40px;
  }
</style>

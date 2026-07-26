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
  import { t } from '$lib/i18n';
  import type { EditorMode } from '$lib/stores/editor-store';
  import { tauriTypstCompiler } from './typst-compiler';
  import { applyTypstAction, type TypstAction } from './typst-commands';

  let {
    content = $bindable(''),
    editorMode = 'split',
    readOnly = false,
    onContentChange,
  }: {
    content?: string;
    /** Mirrors the app-wide Visual/Source/Split toggle: 'visual' shows only the
     *  compiled preview (Typst's closest equivalent to WYSIWYG — read/rendered,
     *  not editable), 'source' shows only the raw .typ text, 'split' (the
     *  default for Typst tabs) shows both side by side. */
    editorMode?: EditorMode;
    readOnly?: boolean;
    onContentChange?: (source: string) => void;
  } = $props();

  const showSource = $derived(editorMode === 'source' || editorMode === 'split');
  const showPreview = $derived(editorMode === 'visual' || editorMode === 'split');

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
    paneResizeObserver?.disconnect();
    paneResizeObserver = null;
    if (!el) return;
    const apply = () => {
      // clientHeight/clientWidth include padding; subtract it for the content box.
      const style = getComputedStyle(el);
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const availW = Math.max(0, el.clientWidth - padX);
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
  }

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
  <div class="typst-panes">
    {#if showSource}
      <div class="typst-source-pane" class:full-width={editorMode === 'source'}>
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
      >
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
    background: var(--bg-secondary);
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* `safe center`: centre the page when it fits, but fall back to
       start-alignment the moment it overflows, so a zoomed-in or multi-page
       document stays scrollable from its real top instead of being clipped
       behind the scrollport. */
    justify-content: safe center;
    gap: 16px;
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

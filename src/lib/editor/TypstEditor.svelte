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
  import { t } from '$lib/i18n';
  import type { EditorMode } from '$lib/stores/editor-store';
  import { tauriTypstCompiler } from './typst-compiler';

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
  let previewPaneEl = $state<HTMLElement | null>(null);
  let paneResizeObserver: ResizeObserver | null = null;

  $effect(() => {
    const el = previewPaneEl;
    paneResizeObserver?.disconnect();
    paneResizeObserver = null;
    if (!el) return;
    const apply = () => {
      // clientHeight includes padding; subtract it to get the content box.
      const style = getComputedStyle(el);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const usable = Math.max(0, el.clientHeight - padY);
      el.style.setProperty('--typst-page-max-h', `${usable}px`);
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

  function onInput(e: Event) {
    const value = (e.target as HTMLTextAreaElement).value;
    content = value;
    onContentChange?.(value);
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
        <textarea
          class="typst-source"
          value={content}
          oninput={onInput}
          readonly={readOnly}
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          placeholder="= My Document&#10;&#10;Write Typst here…"
        ></textarea>
      </div>
    {/if}
    {#if showPreview}
      <div class="typst-preview-pane" class:full-width={editorMode === 'visual'} bind:this={previewPaneEl}>
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
  .typst-source {
    flex: 1;
    width: 100%;
    resize: none;
    border: none;
    outline: none;
    padding: 16px;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    tab-size: 2;
    background: var(--bg-primary);
    color: var(--text-primary);
  }
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
    gap: 16px;
  }
  .typst-preview-pane.full-width {
    flex: 1 1 100%;
  }
  .typst-page {
    background: #fff;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14);
    max-width: 100%;
    /* Don't let the column flex layout squeeze pages instead of scrolling. */
    flex: 0 0 auto;
    line-height: 0;
  }
  .typst-page :global(svg) {
    display: block;
    max-width: 100%;
    /* Fit a whole page in view (PDF-viewer "fit page") so a single-page
       document — including a blank one — never needs to scroll. The bound is a
       measured pixel value rather than a percentage: percentage max-height
       would have to resolve through an auto-height ancestor chain and would
       collapse to `none`. Set from the ResizeObserver in script. */
    max-height: var(--typst-page-max-h, none);
    width: auto;
    height: auto;
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

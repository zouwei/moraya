<script lang="ts">
  /**
   * v0.60.0 — Hidden print route used by the native PDF export path.
   *
   * Rust opens this route in an offscreen WKWebView / WebView2 / WebKitGTK,
   * then evals `window.__moraya_print.render(payload)` which:
   *   1. parses Markdown to HTML (KaTeX inlined synchronously)
   *   2. renders all Mermaid blocks to SVG (async, serial)
   *   3. applies syntax highlighting via highlight.js
   *   4. waits for all <img> tags to load (5s budget)
   *   5. signals readiness via `invoke('export_print_ready', { jobId })`
   *
   * Rust then calls the platform-native printToPDF API. The viewport itself
   * is never visible to the user.
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { markdownToHtmlBody } from '$lib/services/export-service';
  import { renderMermaid, ensureMermaidLoaded } from '@moraya/core/plugins/mermaid-renderer';
  import 'katex/dist/katex.min.css';

  interface PrintPayload {
    job_id: string;
    output_path: string;
    markdown: string;
    options: {
      paper_size: string;
      orientation: string;
      margins: { top: number; right: number; bottom: number; left: number };
      header_enabled: boolean;
      header_template: string;
      footer_enabled: boolean;
      footer_template: string;
      font_size: number;
      font_family: string;
      enable_highlight: boolean;
      enable_mermaid: boolean;
      enable_math: boolean;
      document_title: string;
    };
  }

  let contentEl: HTMLDivElement | null = $state(null);
  let status: string = $state('Waiting for render call...');

  function injectPageCss(opts: PrintPayload['options']) {
    const styleId = '__moraya_print_pagecss';
    const existing = document.getElementById(styleId);
    if (existing) existing.remove();
    const dim = paperDimensionsMm(opts.paper_size);
    const [w, h] =
      opts.orientation === 'landscape' ? [dim[1], dim[0]] : [dim[0], dim[1]];
    const css = `
      @page {
        size: ${w}mm ${h}mm;
        margin: ${opts.margins.top}mm ${opts.margins.right}mm ${opts.margins.bottom}mm ${opts.margins.left}mm;
      }
      html, body {
        margin: 0;
        padding: 0;
        background: white;
        color: #1a1a1a;
        font-family: ${opts.font_family || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'};
        font-size: ${opts.font_size}pt;
        line-height: 1.6;
      }
      pre, table, blockquote, figure { page-break-inside: avoid; break-inside: avoid; }
      h1, h2, h3 { page-break-after: avoid; break-after: avoid; }
      h1 { font-size: 1.8em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
      h2 { font-size: 1.4em; }
      h3 { font-size: 1.15em; }
      code { background: #f4f4f4; padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.9em; }
      pre { background: #f6f8fa; padding: 1em; border-radius: 6px; overflow-x: auto; }
      pre code { background: none; padding: 0; }
      blockquote { border-left: 3px solid #4a90d9; padding-left: 1em; color: #555; margin: 1em 0; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 0.5em 0.8em; }
      th { background: #f6f8fa; }
      img { max-width: 100%; }
      hr { border: none; border-top: 1px solid #eee; margin: 1.5em 0; }
      a { color: #4a90d9; text-decoration: underline; }
      ul, ol { padding-left: 2em; }
      li { margin: 0.25em 0; }
      .math-block { text-align: center; margin: 1em 0; overflow-x: auto; }
      .mermaid-export svg { max-width: 100%; height: auto; }
      /* Debug status overlay must never appear in the captured PDF. */
      .print-status { display: none !important; }
    `;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function paperDimensionsMm(size: string): [number, number] {
    switch (size) {
      case 'letter': return [215.9, 279.4];
      case 'legal':  return [215.9, 355.6];
      case 'a3':     return [297, 420];
      case 'a5':     return [148, 210];
      case 'a4':
      default:       return [210, 297];
    }
  }

  async function renderAllMermaid(host: HTMLElement): Promise<void> {
    const blocks = Array.from(
      host.querySelectorAll<HTMLDivElement>('.mermaid-export'),
    );
    if (blocks.length === 0) return;
    await ensureMermaidLoaded();
    for (const block of blocks) {
      const codeEl = block.querySelector('code.language-mermaid');
      if (!codeEl) continue;
      const code = codeEl.textContent || '';
      try {
        const result = await renderMermaid(code);
        if ('svg' in result) {
          block.innerHTML = result.svg;
        }
      } catch {
        // Keep code-block fallback if rendering fails.
      }
    }
  }

  async function applyHighlight(host: HTMLElement): Promise<void> {
    const codeBlocks = host.querySelectorAll<HTMLElement>(
      'pre > code[class*="language-"]',
    );
    if (codeBlocks.length === 0) return;
    // Lazy-load hljs only when needed (keeps print route bundle smaller).
    const hljs = (await import('highlight.js')).default;
    for (const el of Array.from(codeBlocks)) {
      const cls = Array.from(el.classList).find((c) => c.startsWith('language-'));
      if (!cls) continue;
      const lang = cls.slice('language-'.length);
      if (!lang || !hljs.getLanguage(lang)) continue;
      try {
        const code = el.textContent || '';
        const out = hljs.highlight(code, { language: lang, ignoreIllegals: true });
        el.innerHTML = out.value;
        el.classList.add('hljs');
      } catch {
        // skip on highlighter error
      }
    }
  }

  async function waitForImages(host: HTMLElement, timeoutMs: number): Promise<void> {
    const imgs = Array.from(host.querySelectorAll<HTMLImageElement>('img'));
    if (imgs.length === 0) return;
    const pending = imgs
      .filter((img) => !img.complete)
      .map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
      );
    if (pending.length === 0) return;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  onMount(() => {
    // Print output is always a light page — pin the light theme up-front so no
    // dark-mode variable (near-white text) can leak in before render() runs.
    document.documentElement.setAttribute('data-theme', 'light');
    // Remove the app boot splash (#moraya-splash, z-index 999999). It only
    // fades out on the main editor's `moraya:app-ready` event, which the print
    // route never fires — so without this it stays on top and createPDF
    // captures the "Moraya + spinner" splash instead of the document.
    document.getElementById('moraya-splash')?.remove();
    // Expose the API the Rust side eval()s into.
    (window as unknown as { __moraya_print: unknown }).__moraya_print = {
      async render(payload: PrintPayload) {
        try {
          status = 'Rendering...';
          if (!contentEl) {
            throw new Error('content root not mounted');
          }
          // Force the LIGHT theme for print. The app's CSS resolves body text to
          // var(--text-primary), which becomes near-white (#d4d4d4) whenever the
          // system is in dark mode and data-theme isn't explicitly "light"
          // (variables.css `:root:not([data-theme="light"])`). Without this the
          // PDF renders white text on the forced-white page = invisible.
          document.documentElement.setAttribute('data-theme', 'light');
          // Belt-and-suspenders: ensure the boot splash is gone before capture.
          document.getElementById('moraya-splash')?.remove();
          const includeStyles = false; // we inject our own print stylesheet
          let html = markdownToHtmlBody(payload.markdown);
          // markdownToHtmlBody returns body content; tear out KaTeX CDN link.
          contentEl.innerHTML = html;
          injectPageCss(payload.options);

          if (payload.options.enable_mermaid) {
            await renderAllMermaid(contentEl);
          }
          if (payload.options.enable_highlight) {
            await applyHighlight(contentEl);
          }
          await waitForImages(contentEl, 5000);

          // Tell Rust we're done; native printToPDF can fire.
          await invoke('export_print_ready', { jobId: payload.job_id });
          status = 'Ready for capture';

          // Suppress unused-var lint while keeping the variable available for
          // future stylesheet customization passes.
          void includeStyles;
        } catch (e) {
          status = `Error: ${e instanceof Error ? e.message : String(e)}`;
          // Signal ready anyway so the parent doesn't hang on timeout; the
          // produced PDF will just show whatever managed to render before
          // the error (or an empty page).
          try {
            await invoke('export_print_ready', { jobId: payload.job_id });
          } catch {
            // ignore
          }
        }
      },
    };
  });
</script>

<svelte:head>
  <title>Moraya Print</title>
</svelte:head>

<main class="print-root">
  <div bind:this={contentEl} class="print-content"></div>
  <div class="print-status" aria-hidden="true">{status}</div>
</main>

<style>
  :global(html), :global(body) {
    margin: 0;
    padding: 0;
    background: white;
  }
  .print-root {
    background: white;
    color: #1a1a1a;
    padding: 1rem 1.25rem;
    max-width: 100%;
  }
  .print-content {
    width: 100%;
  }
  .print-status {
    position: fixed;
    top: 4px;
    right: 4px;
    font-size: 8px;
    color: #aaa;
    pointer-events: none;
    user-select: none;
  }
</style>

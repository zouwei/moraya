import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { t } from '$lib/i18n';
import { settingsStore } from '$lib/stores/settings-store';
import { exportProgressStore } from '$lib/stores/export-progress-store';
// Same module the editor's code-block NodeView uses. mermaid.render() mutates
// global DOM state, so every caller in the app must share ONE serial queue —
// a second copy of this module would give export its own queue and let an
// export render overlap an editor render.
import { renderMermaid } from '@moraya/core/plugins/mermaid-renderer';
import {
  exportDocument as coreExportDocument,
  markdownToHtml as coreMarkdownToHtml,
  markdownToHtmlBody as coreMarkdownToHtmlBody,
  inferDocumentTitle,
  type ExportFormat,
  type ExportProgress,
  type FileSink,
} from '@moraya/core/export';
import {
  exportPdfNative,
  defaultExportOptions,
  type PdfExportOptions,
} from './pdf-export-native';

// The document-export engine now lives in @moraya/core/export (extracted in core
// v0.11.0 so PC / Web / Mobile share one implementation). This module is the PC
// adapter: it supplies the Tauri file sink (save-dialog + write_file / bytes),
// the mermaid renderer, and the progress-store bridge, plus keeps the native
// print-to-PDF path (Tauri/Rust only) and the frozen public surface consumed by
// rss-publisher.ts, routes/print/+page.svelte, and routes/+page.svelte.

export type { ExportFormat };
// Re-exported for downstream consumers (rss-publisher, print route). Mermaid is
// unresolved here (async injected in export paths) — these text renderers keep
// mermaid as <pre><code> unless a renderer is passed, matching prior behavior.
export const markdownToHtml = (markdown: string, includeStyles = true) =>
  coreMarkdownToHtml(markdown, includeStyles, renderMermaid);
export const markdownToHtmlBody = coreMarkdownToHtmlBody;

interface ExportOption {
  format: ExportFormat;
  labelKey: string;
  extension: string;
  mimeType: string;
}

export const exportOptions: ExportOption[] = [
  { format: 'pdf', labelKey: 'export.pdf', extension: 'pdf', mimeType: 'application/pdf' },
  { format: 'html', labelKey: 'export.html', extension: 'html', mimeType: 'text/html' },
  { format: 'html-plain', labelKey: 'export.html_plain', extension: 'html', mimeType: 'text/html' },
  { format: 'image', labelKey: 'export.image', extension: 'png', mimeType: 'image/png' },
  { format: 'doc', labelKey: 'export.doc', extension: 'doc', mimeType: 'application/msword' },
  { format: 'latex', labelKey: 'export.latex', extension: 'tex', mimeType: 'application/x-latex' },
];

const TEXT_MIMES = new Set(['text/html', 'application/x-latex', 'text/plain', 'application/msword']);

/** Build a Tauri file sink bound to a pre-chosen save path. */
function tauriSink(path: string): FileSink {
  return {
    async save(_name, bytes, mime) {
      if (TEXT_MIMES.has(mime) || mime.startsWith('text/')) {
        // Text formats: write as a UTF-8 string via the existing command.
        await invoke('write_file', { path, content: new TextDecoder().decode(bytes) });
      } else {
        // Binary (PDF/PNG): raw-body IPC (no base64 inflation).
        await invoke('write_file_bytes', bytes, { headers: { 'X-File-Path': path } });
      }
    },
  };
}

/** Bridge core export progress phases onto the PC status-bar store. */
function bridgeProgress(p: ExportProgress): void {
  switch (p.phase) {
    case 'rendering':
      exportProgressStore.setPhase('rendering');
      break;
    case 'paginating':
      if (p.current != null && p.total != null) exportProgressStore.setPaginating(p.current, p.total);
      break;
    case 'writing':
      exportProgressStore.setPhase('writing');
      break;
    // 'preparing' / 'done' / 'error' handled by the caller around the core call.
  }
}

/**
 * Build a PdfExportOptions value from the user's settings + document title.
 */
function buildNativeOptions(documentTitle: string): PdfExportOptions {
  const opts = defaultExportOptions(documentTitle);
  const settings = get(settingsStore);
  const e = settings.exportSettings;
  if (!e) return opts;
  return {
    paper_size: e.pageSize,
    orientation: e.orientation,
    margins: { ...e.margins },
    header_enabled: e.headerEnabled,
    header_template: e.headerTemplate,
    footer_enabled: e.footerEnabled,
    footer_template: e.footerTemplate,
    font_size: e.fontSize,
    font_family: e.fontFamily,
    enable_highlight: e.enableHighlight,
    enable_mermaid: e.enableMermaid,
    enable_math: e.enableMath,
    document_title: documentTitle,
  };
}

/**
 * Export markdown content to the specified format.
 *
 * Accepts either a markdown string OR a lazy getter. For huge documents,
 * markdown serialization (ProseMirror → text) can take seconds-to-minutes;
 * passing a getter lets us show the save dialog FIRST and only pay that cost
 * after the user has actually committed to exporting.
 */
export async function exportDocument(
  markdownOrGetter: string | (() => string),
  format: ExportFormat,
): Promise<boolean> {
  const option = exportOptions.find((o) => o.format === format);
  if (!option) return false;

  const tr = get(t);
  const label = tr(option.labelKey);
  // Show the save dialog FIRST — it depends only on the format, so it can
  // appear instantly even while the editor is still busy. Resolving markdown
  // beforehand would block the JS main thread and delay the dialog.
  const path = await saveDialog({
    title: tr('export.export_as', { format: label }),
    defaultPath: `document.${option.extension}`,
    filters: [{ name: label, extensions: [option.extension] }],
  });
  if (!path || typeof path !== 'string') return false;

  // For PDF, show "preparing" BEFORE the blocking markdown serialization; yield
  // one frame so the status pill renders before we block the main thread.
  if (format === 'pdf') {
    exportProgressStore.start();
    await new Promise((r) => setTimeout(r, 0));
  }

  const markdown =
    typeof markdownOrGetter === 'function' ? markdownOrGetter() : markdownOrGetter;

  // Native print-to-PDF (Tauri/Rust) — opt-in, PC-only, not part of core.
  if (format === 'pdf') {
    const settings = get(settingsStore);
    const preferNative =
      (settings.exportSettings as { preferNativePdf?: boolean } | undefined)?.preferNativePdf ?? false;
    if (preferNative) {
      try {
        const opts = buildNativeOptions(inferDocumentTitle(markdown));
        await exportPdfNative(markdown, path, opts, (update) => {
          if (update.phase) exportProgressStore.setPhase(update.phase);
          if (update.phase === 'paginating' && update.current != null && update.total != null) {
            exportProgressStore.setPaginating(update.current, update.total);
          }
        });
        exportProgressStore.done();
        return true;
      } catch {
        // Native failed — fall through to the shared canvas pipeline.
        exportProgressStore.fallback();
      }
    }
  }

  // Shared @moraya/core/export path for every format (canvas PDF, long-image,
  // HTML/DOC/LaTeX). html2canvas/jsPDF resolve from PC's own dependencies.
  //
  // Only the canvas formats (PDF / image) surface the StatusBar progress pill —
  // they do the slow html2canvas work. Text formats (html / html-plain / doc /
  // latex) are near-instant, so we DON'T wire onProgress for them: otherwise
  // core's `writing` phase would light the pill with no matching done()/error()
  // to clear it, leaving "正在写入…" stuck forever.
  const usesProgress = format === 'pdf' || format === 'image';
  const result = await coreExportDocument(format, {
    sink: tauriSink(path),
    getMarkdown: () => markdown,
    documentTitle: inferDocumentTitle(markdown),
    mermaid: renderMermaid,
    ...(usesProgress ? { onProgress: bridgeProgress } : {}),
  });

  if (usesProgress) {
    if (result.ok) exportProgressStore.done();
    else exportProgressStore.error(result.message ?? 'Export failed');
  }
  if (!result.ok) throw new Error(result.message ?? 'Export failed');
  return true;
}

/**
 * Export the current markdown as a genuinely typeset PDF via the on-demand
 * Typst engine (P0). Unlike `exportDocument(..., 'pdf')` — which screenshots the
 * rendered DOM into a raster PDF — this compiles the markdown through Typst
 * (`cmarker`) for true vector typesetting. The engine (~30 MB) is downloaded and
 * cached on first use; `onToast` surfaces that one-time notice. Errors (incl.
 * trimmed Typst compiler diagnostics) surface in the StatusBar progress pill.
 */
export async function exportTypstPdf(
  markdownOrGetter: string | (() => string),
  opts?: { onToast?: (message: string, type?: 'success' | 'error') => void },
): Promise<boolean> {
  const tr = get(t);
  const path = await saveDialog({
    title: tr('export.export_as', { format: 'PDF (Typst)' }),
    defaultPath: 'document.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!path || typeof path !== 'string') return false;

  const markdown =
    typeof markdownOrGetter === 'function' ? markdownOrGetter() : markdownOrGetter;

  exportProgressStore.start();
  // Yield one frame so the pill paints before the (potentially long) first-use
  // engine download + compile blocks on the IPC round-trip.
  await new Promise((r) => setTimeout(r, 0));
  try {
    const engineReady = await invoke<boolean>('typst_engine_status');
    if (!engineReady) {
      // First use downloads the engine inside the command — tell the user.
      opts?.onToast?.(tr('typst.downloading_engine'), 'success');
    }
    exportProgressStore.setPhase('rendering');
    await invoke('typst_export_markdown_pdf', { markdown, outputPath: path });
    exportProgressStore.done();
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    exportProgressStore.error(msg || tr('typst.export_failed'));
    return false;
  }
}

/**
 * Export a Typst *source* document (a `.typ` tab) via the File → Export menu.
 *
 * Mirrors `exportDocument`'s format menu, but nothing goes through markdown-it
 * or a DOM screenshot:
 *   - pdf   → the engine's native typeset PDF (real vector text)
 *   - image → ONE long PNG of every page, matching what "export as image" means
 *             for a markdown document
 *   - html  → the compiled pages embedded as SVG in a standalone document
 *   - doc   → the same pages as raster <img> (Word's HTML import cannot render
 *             SVG), matching how the markdown `.doc` export already works
 *
 * Only PDF still uses the CLI's own writer; the rest are built by
 * `@moraya/core/export` from the compiled SVG, so desktop, web and mobile
 * produce byte-identical files. Typst's own HTML writer is deliberately NOT
 * used here — it is an experimental, layout-losing feature, fine for the
 * Typst → Markdown *conversion* route (where semantics matter more than
 * fidelity) but wrong for an export that should look like the document.
 *
 * `html-plain` / `latex` are markdown-only and are rejected here.
 */
export async function exportTypstSource(
  format: ExportFormat,
  sourceOrGetter: string | (() => string),
  opts?: { onToast?: (message: string, type?: 'success' | 'error') => void },
): Promise<boolean> {
  const tr = get(t);

  // Map the shared ExportFormat menu onto what the Typst compiler can emit.
  const spec: Record<string, { ext: string; label: string } | undefined> = {
    pdf: { ext: 'pdf', label: 'PDF' },
    image: { ext: 'png', label: tr('export.image') },
    html: { ext: 'html', label: tr('export.html') },
    doc: { ext: 'doc', label: tr('export.doc') },
  };
  const target = spec[format];
  if (!target) {
    opts?.onToast?.(tr('typst.export_unsupported_format'), 'error');
    return false;
  }

  const path = await saveDialog({
    title: tr('export.export_as', { format: target.label }),
    defaultPath: `document.${target.ext}`,
    filters: [{ name: target.label, extensions: [target.ext] }],
  });
  if (!path || typeof path !== 'string') return false;

  const source = typeof sourceOrGetter === 'function' ? sourceOrGetter() : sourceOrGetter;

  exportProgressStore.start();
  await new Promise((r) => setTimeout(r, 0));
  try {
    const engineReady = await invoke<boolean>('typst_engine_status');
    if (!engineReady) opts?.onToast?.(tr('typst.downloading_engine'), 'success');
    exportProgressStore.setPhase('rendering');

    if (format === 'pdf') {
      // The CLI writes the PDF itself — keeping vector text, which rebuilding
      // it from rendered pages would destroy.
      await invoke('typst_compile_source', { source, format: 'pdf', outputPath: path });
      exportProgressStore.done();
      return true;
    }

    const { exportTypstDocument } = await import('@moraya/core/export');
    const { tauriTypstCompiler } = await import('$lib/editor/typst-compiler');
    const result = await exportTypstDocument(format as 'html' | 'doc' | 'image', source, {
      compiler: tauriTypstCompiler,
      sink: tauriSink(path),
      documentTitle: path.split('/').pop()?.replace(/\.[^.]+$/, ''),
      onProgress: bridgeProgress,
    });
    if (!result.ok) throw new Error(result.message ?? tr('typst.export_failed'));
    exportProgressStore.done();
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    exportProgressStore.error(msg || tr('typst.export_failed'));
    return false;
  }
}

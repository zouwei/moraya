import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { t } from '$lib/i18n';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import katex from 'katex';

export type ExportFormat =
  | 'pdf'
  | 'html'
  | 'html-plain'
  | 'doc'
  | 'latex'
  | 'image';

interface ExportOption {
  format: ExportFormat;
  labelKey: string;
  extension: string;
  mimeType: string;
}

export const exportOptions: ExportOption[] = [
  { format: 'pdf', labelKey: 'export.pdf', extension: 'pdf', mimeType: 'application/pdf' },
  { format: 'html', labelKey: 'export.html', extension: 'html', mimeType: 'text/html' },
  { format: 'html-plain', labelKey: 'export.htmlPlain', extension: 'html', mimeType: 'text/html' },
  { format: 'image', labelKey: 'export.image', extension: 'png', mimeType: 'image/png' },
  { format: 'doc', labelKey: 'export.doc', extension: 'doc', mimeType: 'application/msword' },
  { format: 'latex', labelKey: 'export.latex', extension: 'tex', mimeType: 'application/x-latex' },
];

/**
 * Convert Markdown to HTML with Moraya styling.
 * Uses KaTeX for math rendering and proper code block handling.
 */
export function markdownToHtml(markdown: string, includeStyles: boolean = true): string {
  const bodyHtml = markdownToHtmlBody(markdown);

  if (!includeStyles) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Exported from Moraya</title></head>
<body>${bodyHtml}</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Exported from Moraya</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.28/dist/katex.min.css">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    max-width: 800px;
    margin: 2rem auto;
    padding: 0 1rem;
    line-height: 1.75;
    color: #1a1a1a;
  }
  h1 { font-size: 2em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; }
  h3 { font-size: 1.25em; }
  code { background: #f4f4f4; padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f4f4f4; padding: 1em; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #4a90d9; padding-left: 1em; color: #666; margin: 1em 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.5em 0.8em; }
  th { background: #f4f4f4; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #eee; margin: 1.5em 0; }
  a { color: #4a90d9; }
  ul, ol { padding-left: 2em; }
  li { margin: 0.25em 0; }
  .math-block { text-align: center; margin: 1em 0; overflow-x: auto; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

/**
 * Convert markdown to HTML body content with KaTeX math and proper code blocks.
 */
export function markdownToHtmlBody(md: string): string {
  // Use a placeholder system to protect already-processed content
  const placeholders: string[] = [];
  function ph(content: string): string {
    const idx = placeholders.length;
    placeholders.push(content);
    return `\x00PH${idx}\x00`;
  }

  let html = md;

  // 1. Code blocks (``` ... ```) — protect from further processing
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    const langAttr = lang ? ` class="language-${lang}"` : '';
    return ph(`<pre><code${langAttr}>${escaped}</code></pre>`);
  });

  // 2. Math blocks ($$...$$) — render with KaTeX
  html = html.replace(/\$\$([\s\S]*?)\$\$/g, (_m, tex) => {
    try {
      const rendered = katex.renderToString(tex.trim(), {
        displayMode: true,
        throwOnError: false,
      });
      return ph(`<div class="math-block">${rendered}</div>`);
    } catch {
      return ph(`<div class="math-block"><code>${escapeHtml(tex.trim())}</code></div>`);
    }
  });

  // 3. Inline math ($...$) — render with KaTeX
  html = html.replace(/\$([^\$\n]+?)\$/g, (_m, tex) => {
    try {
      const rendered = katex.renderToString(tex.trim(), {
        displayMode: false,
        throwOnError: false,
      });
      return ph(rendered);
    } catch {
      return ph(`<code>${escapeHtml(tex.trim())}</code>`);
    }
  });

  // 4. Inline code
  html = html.replace(/`([^`]+)`/g, (_m, code) => {
    return ph(`<code>${escapeHtml(code)}</code>`);
  });

  // 5. Headers
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // 6. Bold & Italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // 7. Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // 8. Images (must be before links, so ![alt](url) isn't consumed by link regex)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
    return ph(`<img src="${src}" alt="${escapeHtml(alt)}">`);
  });

  // 9. Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 10. Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^\*\*\*$/gm, '<hr>');

  // 11. Blockquotes
  html = html.replace(/^>\s+(.+)$/gm, '<blockquote><p>$1</p></blockquote>');

  // 12a. Task list checkboxes (must come before generic list items)
  html = html.replace(/^(\s*)[-*]\s+\[x\]\s+(.+)$/gm, (_m, _indent, text) => {
    return ph(`<li class="task-item checked"><span class="task-checkbox checked">✓</span>${text}</li>`);
  });
  html = html.replace(/^(\s*)[-*]\s+\[ \]\s+(.+)$/gm, (_m, _indent, text) => {
    return ph(`<li class="task-item"><span class="task-checkbox"></span>${text}</li>`);
  });

  // 12b. Unordered lists
  html = html.replace(/^(\s*)[-*]\s+(.+)$/gm, '<li>$2</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // 13. Paragraphs — wrap remaining plain text lines
  html = html.replace(/^(?!<[a-zA-Z/]|\x00)(.+)$/gm, (match) => {
    const trimmed = match.trim();
    if (trimmed) {
      return `<p>${trimmed}</p>`;
    }
    return match;
  });

  // Restore placeholders
  for (let i = 0; i < placeholders.length; i++) {
    html = html.split(`\x00PH${i}\x00`).join(placeholders[i]);
  }

  // Clean up excessive empty lines
  html = html.replace(/\n{3,}/g, '\n\n');

  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Capture the live Milkdown editor DOM as a canvas.
 * This preserves KaTeX-rendered math, styled code blocks, tables, etc.
 */
async function captureEditorToCanvas(): Promise<HTMLCanvasElement> {
  const editorEl = document.querySelector('.moraya-editor') as HTMLElement | null;
  if (!editorEl) {
    throw new Error('no-editor');
  }

  // Clone the editor into a hidden container with white background
  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;left:-9999px;top:0;width:800px;background:#fff;padding:2rem 1rem;';

  const clone = editorEl.cloneNode(true) as HTMLElement;
  clone.removeAttribute('contenteditable');
  clone.style.outline = 'none';
  clone.style.caretColor = 'transparent';
  // Remove ProseMirror selection artifacts
  clone.querySelectorAll('.ProseMirror-selectednode, .ProseMirror-gapcursor').forEach((el) => el.remove());

  container.appendChild(clone);
  document.body.appendChild(container);

  try {
    return await html2canvas(container, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
    });
  } finally {
    document.body.removeChild(container);
  }
}

/**
 * Render markdown HTML in a hidden container and capture as canvas.
 * Fallback when live editor is not available (e.g. source mode).
 */
async function renderHtmlToCanvas(htmlContent: string): Promise<HTMLCanvasElement> {
  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed;left:-9999px;top:0;width:800px;background:#fff;padding:2rem 1rem;';

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');

  // Apply styles from the parsed document
  doc.querySelectorAll('style').forEach((style) => {
    container.appendChild(style.cloneNode(true));
  });

  const contentDiv = document.createElement('div');
  contentDiv.innerHTML = doc.body.innerHTML;
  container.appendChild(contentDiv);

  document.body.appendChild(container);

  try {
    return await html2canvas(container, {
      backgroundColor: '#ffffff',
      scale: 2,
      useCORS: true,
      logging: false,
    });
  } finally {
    document.body.removeChild(container);
  }
}

/**
 * Get a canvas of the current document content.
 * Tries the live editor first (best quality), falls back to HTML conversion.
 */
async function getDocumentCanvas(markdown: string): Promise<HTMLCanvasElement> {
  try {
    return await captureEditorToCanvas();
  } catch {
    const htmlContent = markdownToHtml(markdown, true);
    return await renderHtmlToCanvas(htmlContent);
  }
}

/**
 * Export as PNG image
 */
async function exportAsImage(markdown: string, path: string): Promise<void> {
  const canvas = await getDocumentCanvas(markdown);
  const dataUrl = canvas.toDataURL('image/png');
  await invoke('write_file_binary', { path, base64Data: dataUrl });
}

/**
 * Export as PDF
 */
async function exportAsPdf(markdown: string, path: string): Promise<void> {
  const canvas = await getDocumentCanvas(markdown);

  const imgWidth = canvas.width;
  const imgHeight = canvas.height;

  // A4: 210 x 297 mm
  const pdfWidth = 210;
  const pdfContentWidth = pdfWidth - 20; // 10mm margins
  const scale = pdfContentWidth / imgWidth;
  const pdfContentHeight = imgHeight * scale;

  const pageHeight = 297 - 20; // 10mm margins
  const totalPages = Math.ceil(pdfContentHeight / pageHeight);

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) {
      pdf.addPage();
    }

    const sourceY = (page * pageHeight) / scale;
    const sourceHeight = Math.min(pageHeight / scale, imgHeight - sourceY);

    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = imgWidth;
    pageCanvas.height = sourceHeight;
    const ctx = pageCanvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, imgWidth, sourceHeight);
    ctx.drawImage(canvas, 0, sourceY, imgWidth, sourceHeight, 0, 0, imgWidth, sourceHeight);

    const pageDataUrl = pageCanvas.toDataURL('image/png');
    const drawHeight = sourceHeight * scale;
    pdf.addImage(pageDataUrl, 'PNG', 10, 10, pdfContentWidth, drawHeight);
  }

  const pdfBase64 = pdf.output('datauristring');
  await invoke('write_file_binary', { path, base64Data: pdfBase64 });
}

/**
 * Export markdown content to the specified format
 */
export async function exportDocument(markdown: string, format: ExportFormat): Promise<boolean> {
  const option = exportOptions.find(o => o.format === format);
  if (!option) return false;

  const tr = get(t);
  const label = tr(option.labelKey);
  const path = await saveDialog({
    title: tr('export.exportAs', { format: label }),
    defaultPath: `document.${option.extension}`,
    filters: [{ name: label, extensions: [option.extension] }],
  });

  if (!path || typeof path !== 'string') return false;

  switch (format) {
    case 'html':
      await invoke('write_file', { path, content: markdownToHtml(markdown, true) });
      break;
    case 'html-plain':
      await invoke('write_file', { path, content: markdownToHtml(markdown, false) });
      break;
    case 'latex':
      await invoke('write_file', { path, content: markdownToLatex(markdown) });
      break;
    case 'pdf':
      await exportAsPdf(markdown, path);
      break;
    case 'image':
      await exportAsImage(markdown, path);
      break;
    case 'doc':
      await invoke('write_file', { path, content: markdownToHtml(markdown, true) });
      break;
    default:
      await invoke('write_file', { path, content: markdown });
  }

  return true;
}

/**
 * Basic Markdown to LaTeX converter
 */
function markdownToLatex(md: string): string {
  let tex = md;

  tex = tex.replace(/^#\s+(.+)$/gm, '\\section{$1}');
  tex = tex.replace(/^##\s+(.+)$/gm, '\\subsection{$1}');
  tex = tex.replace(/^###\s+(.+)$/gm, '\\subsubsection{$1}');
  tex = tex.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}');
  tex = tex.replace(/\*(.+?)\*/g, '\\textit{$1}');
  tex = tex.replace(/`([^`]+)`/g, '\\texttt{$1}');
  tex = tex.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '\\href{$2}{$1}');

  return `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{hyperref}
\\usepackage{amsmath}
\\begin{document}

${tex}

\\end{document}`;
}

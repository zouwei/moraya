import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

export type ExportFormat =
  | 'pdf'
  | 'html'
  | 'html-plain'
  | 'docx'
  | 'rtf'
  | 'epub'
  | 'latex'
  | 'mediawiki'
  | 'rst'
  | 'textile'
  | 'opml'
  | 'image';

interface ExportOption {
  format: ExportFormat;
  label: string;
  extension: string;
  mimeType: string;
}

export const exportOptions: ExportOption[] = [
  { format: 'pdf', label: 'PDF', extension: 'pdf', mimeType: 'application/pdf' },
  { format: 'html', label: 'HTML (with styles)', extension: 'html', mimeType: 'text/html' },
  { format: 'html-plain', label: 'HTML (without styles)', extension: 'html', mimeType: 'text/html' },
  { format: 'image', label: 'Image (PNG)', extension: 'png', mimeType: 'image/png' },
  { format: 'docx', label: 'Word (.docx)', extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { format: 'rtf', label: 'RTF', extension: 'rtf', mimeType: 'application/rtf' },
  { format: 'epub', label: 'Epub', extension: 'epub', mimeType: 'application/epub+zip' },
  { format: 'latex', label: 'LaTeX', extension: 'tex', mimeType: 'application/x-latex' },
  { format: 'mediawiki', label: 'MediaWiki', extension: 'wiki', mimeType: 'text/plain' },
  { format: 'rst', label: 'reStructuredText', extension: 'rst', mimeType: 'text/plain' },
  { format: 'textile', label: 'Textile', extension: 'textile', mimeType: 'text/plain' },
  { format: 'opml', label: 'OPML', extension: 'opml', mimeType: 'text/xml' },
];

/**
 * Convert Markdown to HTML with Moraya styling
 */
export function markdownToHtml(markdown: string, includeStyles: boolean = true): string {
  // For Phase 1, we use a simple markdown-to-html approach
  // In future phases, this will use remark/unified pipeline
  const bodyHtml = simpleMarkdownToHtml(markdown);

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
  blockquote { border-left: 3px solid #4a90d9; padding-left: 1em; color: #666; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.5em 0.8em; }
  th { background: #f4f4f4; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #eee; margin: 1.5em 0; }
  a { color: #4a90d9; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

/**
 * Simple markdown to HTML converter for export
 * Note: This is a basic implementation. Full conversion will use remark/unified.
 */
function simpleMarkdownToHtml(md: string): string {
  let html = md;

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold & Italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Blockquotes
  html = html.replace(/^>\s+(.+)$/gm, '<blockquote><p>$1</p></blockquote>');

  // Paragraphs (remaining text)
  html = html.replace(/^(?!<[a-z])((?:(?!<[a-z]).)+)$/gm, (match) => {
    const trimmed = match.trim();
    if (trimmed && !trimmed.startsWith('<')) {
      return `<p>${trimmed}</p>`;
    }
    return match;
  });

  return html;
}

/**
 * Export markdown content to the specified format
 */
export async function exportDocument(markdown: string, format: ExportFormat): Promise<boolean> {
  const option = exportOptions.find(o => o.format === format);
  if (!option) return false;

  const path = await saveDialog({
    title: `Export as ${option.label}`,
    defaultPath: `document.${option.extension}`,
    filters: [{ name: option.label, extensions: [option.extension] }],
  });

  if (!path || typeof path !== 'string') return false;

  let content: string;

  switch (format) {
    case 'html':
      content = markdownToHtml(markdown, true);
      break;
    case 'html-plain':
      content = markdownToHtml(markdown, false);
      break;
    case 'latex':
      content = markdownToLatex(markdown);
      break;
    case 'pdf':
    case 'docx':
    case 'rtf':
    case 'epub':
    case 'image':
    case 'mediawiki':
    case 'rst':
    case 'textile':
    case 'opml':
      // These formats require pandoc or specialized conversion
      // For Phase 1, export as HTML with a note
      content = markdownToHtml(markdown, true);
      // TODO: Implement proper conversion using pandoc or Rust-side libraries
      break;
    default:
      content = markdown;
  }

  await invoke('write_file', { path, content });
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

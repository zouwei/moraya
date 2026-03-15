/**
 * Unified ProseMirror Schema for Moraya editor.
 *
 * All node and mark specs are defined here in a single Schema instance.
 * Node names and attributes replicate Milkdown's definitions exactly
 * to maintain CSS selector compatibility.
 *
 * Nodes (22): doc, text, paragraph, heading, blockquote, code_block,
 *   horizontal_rule, bullet_list, ordered_list, list_item, image,
 *   hardbreak, html_block, html_inline, table, table_header_row, table_row,
 *   table_header, table_cell, math_inline, math_block,
 *   defList, defListTerm, defListDescription
 *
 * Marks (6): html_mark, strong, em, code, link, strike_through
 */

import { Schema, Fragment } from 'prosemirror-model';
import type { NodeSpec, MarkSpec } from 'prosemirror-model';
import katex from 'katex';

// ── Helpers ──────────────────────────────────────────────────────

/** Extract a quoted attribute value from an HTML tag string. */
function extractHtmlAttr(html: string, name: string): string | null {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = html.match(re);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** Replace element content with broken-image icon + source code display. */
function showBrokenImage(container: HTMLElement, sourceText: string): void {
  container.textContent = '';
  container.className = (container.className.replace(/\bhtml-img-wrapper\b|\bimage-node\b/, '').trim()
    + ' broken-image').trim();
  const icon = document.createElement('span');
  icon.className = 'broken-image-icon';
  container.appendChild(icon);
  const code = document.createElement('code');
  code.className = 'broken-image-src';
  code.textContent = sourceText;
  container.appendChild(code);
}

/** Convert HTML tag attributes to CSS inline styles for visual rendering. */
function htmlTagToStyle(openTag: string): string {
  const tagMatch = openTag.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
  if (!tagMatch) return '';
  const tagName = tagMatch[1].toLowerCase();
  switch (tagName) {
    case 'font': {
      const parts: string[] = [];
      const color = extractHtmlAttr(openTag, 'color');
      if (color) parts.push(`color: ${color}`);
      const size = extractHtmlAttr(openTag, 'size');
      if (size) {
        // HTML <font size=N> approximate CSS equivalents
        const sizeMap: Record<string, string> = {
          '1': '0.63em', '2': '0.82em', '3': '1em', '4': '1.13em',
          '5': '1.5em', '6': '2em', '7': '3em',
        };
        parts.push(`font-size: ${sizeMap[size] || size}`);
      }
      const face = extractHtmlAttr(openTag, 'face');
      if (face) parts.push(`font-family: ${face}`);
      return parts.join('; ');
    }
    case 'span':
    case 'div':
      return extractHtmlAttr(openTag, 'style') || '';
    default:
      return '';
  }
}

/** Check if a path is a local file path (absolute Unix or Windows path). */
function isLocalFilePath(src: string): boolean {
  if (!src) return false;
  if (src.startsWith('/') && !src.startsWith('//')) return true;
  if (/^[A-Z]:[\\\/]/i.test(src)) return true;
  return false;
}

/** Cache for local image blob URLs (path → blob:...) */
const localImageBlobCache = new Map<string, string>();

/**
 * Load a local image file via Tauri IPC and set the img src to a blob URL.
 * Uses the `read_file_binary` command (validate_path → home directory scope)
 * rather than the fs plugin (narrower scope), so images from any location
 * within the user's home directory are loadable.
 * Caches results so repeated calls for the same path are instant.
 */
function loadLocalImageSrc(img: HTMLImageElement, src: string): void {
  const cached = localImageBlobCache.get(src);
  if (cached) {
    img.src = cached;
    return;
  }
  import('@tauri-apps/api/core').then(({ invoke }) => {
    invoke<number[]>('read_file_binary', { path: src }).then(data => {
      const bytes = new Uint8Array(data);
      const ext = src.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
        ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
      };
      const blob = new Blob([bytes], { type: mimeMap[ext] || 'image/png' });
      const blobUrl = URL.createObjectURL(blob);
      localImageBlobCache.set(src, blobUrl);
      img.src = blobUrl;
    }).catch(() => {
      img.dispatchEvent(new Event('error'));
    });
  }).catch(() => {
    img.dispatchEvent(new Event('error'));
  });
}

// ── Node Specs ──────────────────────────────────────────────────

const doc: NodeSpec = {
  content: 'block+',
};

const paragraph: NodeSpec = {
  content: 'inline*',
  group: 'block',
  parseDOM: [{ tag: 'p' }],
  toDOM() { return ['p', 0]; },
};

const heading: NodeSpec = {
  attrs: {
    id: { default: '' },
    level: { default: 1 },
  },
  content: 'inline*',
  group: 'block',
  defining: true,
  parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({
    tag: `h${level}`,
    getAttrs(dom: HTMLElement) {
      return { level, id: dom.getAttribute('id') || '' };
    },
  })),
  toDOM(node) {
    const attrs: Record<string, string> = {};
    if (node.attrs.id) attrs.id = node.attrs.id;
    return [`h${node.attrs.level}`, attrs, 0];
  },
};

const blockquote: NodeSpec = {
  content: 'block+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'blockquote' }],
  toDOM() { return ['blockquote', 0]; },
};

const code_block: NodeSpec = {
  content: 'text*',
  group: 'block',
  marks: '',
  defining: true,
  code: true,
  attrs: {
    language: { default: 'text' },
  },
  parseDOM: [{
    tag: 'pre',
    preserveWhitespace: 'full' as const,
    getAttrs(dom: HTMLElement) {
      return { language: dom.dataset.language || 'text' };
    },
  }],
  toDOM(node) {
    return ['pre', { 'data-language': node.attrs.language || undefined }, ['code', 0]];
  },
};

const horizontal_rule: NodeSpec = {
  group: 'block',
  parseDOM: [{ tag: 'hr' }],
  toDOM() { return ['hr']; },
};

const bullet_list: NodeSpec = {
  content: 'list_item+',
  group: 'block',
  parseDOM: [{ tag: 'ul' }],
  toDOM() { return ['ul', 0]; },
};

const ordered_list: NodeSpec = {
  content: 'list_item+',
  group: 'block',
  attrs: {
    order: { default: 1 },
  },
  parseDOM: [{
    tag: 'ol',
    getAttrs(dom: HTMLElement) {
      return { order: dom.hasAttribute('start') ? +(dom.getAttribute('start') || 1) : 1 };
    },
  }],
  toDOM(node) {
    return node.attrs.order === 1
      ? ['ol', 0]
      : ['ol', { start: node.attrs.order }, 0];
  },
};

const list_item: NodeSpec = {
  content: 'paragraph block*',
  group: 'listItem',
  defining: true,
  attrs: {
    label: { default: '•' },
    listType: { default: 'bullet' },
    spread: { default: 'true' },
    checked: { default: null },
  },
  parseDOM: [
    {
      tag: 'li[data-item-type="task"]',
      getAttrs(dom: HTMLElement) {
        return {
          label: dom.dataset.label,
          listType: dom.dataset.listType,
          spread: dom.dataset.spread,
          checked: dom.dataset.checked ? dom.dataset.checked === 'true' : null,
        };
      },
    },
    {
      tag: 'li',
      getAttrs(dom: HTMLElement) {
        return {
          label: dom.dataset.label || '•',
          listType: dom.dataset.listType || 'bullet',
          spread: dom.dataset.spread || 'true',
        };
      },
    },
  ],
  toDOM(node) {
    if (node.attrs.checked != null) {
      return ['li', {
        'data-item-type': 'task',
        'data-label': node.attrs.label,
        'data-list-type': node.attrs.listType,
        'data-spread': node.attrs.spread,
        'data-checked': node.attrs.checked,
      }, 0];
    }
    return ['li', {
      'data-label': node.attrs.label,
      'data-list-type': node.attrs.listType,
      'data-spread': node.attrs.spread,
    }, 0];
  },
};

const image: NodeSpec = {
  inline: true,
  group: 'inline',
  selectable: true,
  draggable: true,
  marks: '',
  atom: true,
  defining: true,
  isolating: true,
  attrs: {
    src: { default: '' },
    alt: { default: '' },
    title: { default: '' },
  },
  parseDOM: [{
    tag: 'img[src]',
    getAttrs(dom: HTMLElement) {
      return {
        src: dom.getAttribute('src') || '',
        alt: dom.getAttribute('alt') || '',
        title: dom.getAttribute('title') || dom.getAttribute('alt') || '',
      };
    },
  }],
  toDOM(node) {
    const container = document.createElement('span');
    container.className = 'image-node';

    const img = document.createElement('img');
    if (node.attrs.alt) img.alt = node.attrs.alt;
    if (node.attrs.title) img.title = node.attrs.title;

    // Apply width from title attr (e.g. title="width=70%")
    const titleStr = (node.attrs.title || '') as string;
    const widthMatch = titleStr.match(/^width=(\d+%?)$/);
    if (widthMatch) {
      img.style.width = widthMatch[1].includes('%') ? widthMatch[1] : `${widthMatch[1]}px`;
      img.style.maxWidth = 'none';
    }

    img.onerror = () => {
      const alt = node.attrs.alt ? `![${node.attrs.alt}]` : '![]';
      const title = node.attrs.title ? ` "${node.attrs.title}"` : '';
      showBrokenImage(container, `${alt}(${node.attrs.src}${title})`);
    };

    const src = node.attrs.src as string;
    if (isLocalFilePath(src)) {
      loadLocalImageSrc(img, src);
    } else {
      img.src = src;
    }

    container.appendChild(img);
    return container;
  },
};

const hardbreak: NodeSpec = {
  inline: true,
  group: 'inline',
  selectable: false,
  attrs: {
    isInline: { default: false },
  },
  parseDOM: [
    { tag: 'br' },
    {
      tag: 'span[data-type="hardbreak"]',
      getAttrs() { return { isInline: true }; },
    },
  ],
  toDOM(node) {
    if (node.attrs.isInline) {
      return ['span', { 'data-type': 'hardbreak', 'data-is-inline': 'true' }, ' '];
    }
    return ['br', { 'data-type': 'hardbreak' }];
  },
  leafText() { return '\n'; },
};

const html_block: NodeSpec = {
  content: 'text*',
  group: 'block',
  marks: '',
  code: true,
  defining: true,
  parseDOM: [{
    tag: 'div[data-type="html"]',
    preserveWhitespace: 'full' as const,
  }],
  toDOM() {
    return ['div', { 'data-type': 'html' }, ['pre', 0]];
  },
};

/**
 * Inline HTML preserved as an opaque leaf atom (e.g. <br>, <span>, <!-- comments -->).
 * markdown-it emits `html_inline` tokens for these; without this node the
 * parser throws "Token type `html_inline` not supported", causing silently
 * blank editor content for any document that contains inline HTML tags.
 *
 * Implemented as a TRUE LEAF (no content) to avoid ProseMirror position
 * arithmetic issues with non-leaf atoms, and to ensure heading.textContent
 * is clean (no raw HTML injected into the document outline text).
 * The raw HTML is stored in the `value` attribute for lossless round-trip.
 */
const html_inline: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    value: { default: '' },
  },
  parseDOM: [{
    tag: 'span[data-type="html-inline"]',
    getAttrs(dom: HTMLElement) {
      return { value: dom.dataset.value ?? '' };
    },
  }],
  toDOM(node) {
    const value = node.attrs.value as string;

    // Render <img> tags as actual images (with broken image fallback)
    if (/^<img\s/i.test(value)) {
      const wrapper = document.createElement('span');
      wrapper.dataset.type = 'html-inline';
      wrapper.dataset.value = value;
      wrapper.className = 'html-img-wrapper';

      const src = extractHtmlAttr(value, 'src') || '';
      if (src) {
        const img = document.createElement('img');
        img.alt = extractHtmlAttr(value, 'alt') || '';
        img.onerror = () => {
          showBrokenImage(wrapper, value);
        };
        if (isLocalFilePath(src)) {
          loadLocalImageSrc(img, src);
        } else {
          img.src = src;
        }
        wrapper.appendChild(img);
      } else {
        showBrokenImage(wrapper, value);
      }
      return wrapper;
    }

    // Default: invisible span for other inline HTML (<font>, <br>, etc.)
    return ['span', { 'data-type': 'html-inline', 'data-value': value }];
  },
};

// ── Table Nodes ─────────────────────────────────────────────────

const table: NodeSpec = {
  content: 'table_header_row table_row+',
  group: 'block',
  tableRole: 'table',
  isolating: true,
  parseDOM: [{ tag: 'table' }],
  toDOM() { return ['table', ['tbody', 0]]; },
};

const table_header_row: NodeSpec = {
  content: '(table_header)*',
  tableRole: 'row',
  parseDOM: [
    { tag: 'tr[data-is-header]' },
    {
      tag: 'tr',
      getAttrs(dom: HTMLElement) {
        const hasHeader = dom.querySelector('th');
        return hasHeader ? {} : false;
      },
    },
  ],
  toDOM() { return ['tr', { 'data-is-header': 'true' }, 0]; },
};

const table_row: NodeSpec = {
  content: '(table_cell)*',
  tableRole: 'row',
  parseDOM: [{ tag: 'tr' }],
  toDOM() { return ['tr', 0]; },
};

const table_header: NodeSpec = {
  content: 'paragraph+',
  tableRole: 'header_cell',
  attrs: {
    alignment: { default: 'left' },
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
  },
  isolating: true,
  parseDOM: [{
    tag: 'th',
    getAttrs(dom: HTMLElement) {
      return {
        alignment: dom.style.textAlign || 'left',
        colspan: Number(dom.getAttribute('colspan') || 1),
        rowspan: Number(dom.getAttribute('rowspan') || 1),
        colwidth: null,
      };
    },
  }],
  toDOM(node) {
    return ['th', { style: `text-align: ${node.attrs.alignment || 'left'}` }, 0];
  },
};

const table_cell: NodeSpec = {
  content: 'paragraph+',
  tableRole: 'cell',
  attrs: {
    alignment: { default: 'left' },
    colspan: { default: 1 },
    rowspan: { default: 1 },
    colwidth: { default: null },
  },
  isolating: true,
  parseDOM: [{
    tag: 'td',
    getAttrs(dom: HTMLElement) {
      return {
        alignment: dom.style.textAlign || 'left',
        colspan: Number(dom.getAttribute('colspan') || 1),
        rowspan: Number(dom.getAttribute('rowspan') || 1),
        colwidth: null,
      };
    },
  }],
  toDOM(node) {
    return ['td', { style: `text-align: ${node.attrs.alignment || 'left'}` }, 0];
  },
};

// ── Math Nodes ──────────────────────────────────────────────────

const math_inline: NodeSpec = {
  group: 'inline',
  content: 'text*',
  inline: true,
  atom: true,
  parseDOM: [{
    tag: 'span[data-type="math_inline"]',
    getContent(dom: Node, schema: Schema) {
      if (!(dom instanceof HTMLElement)) return Fragment.empty;
      const value = dom.dataset.value ?? '';
      if (!value) return Fragment.empty;
      return Fragment.from(schema.text(value));
    },
  }],
  toDOM(node) {
    const code = node.textContent;
    const dom = document.createElement('span');
    dom.dataset.type = 'math_inline';
    dom.dataset.value = code;
    try {
      katex.render(code, dom);
    } catch {
      dom.textContent = code;
    }
    return dom;
  },
};

const math_block: NodeSpec = {
  content: 'text*',
  group: 'block',
  marks: '',
  defining: true,
  atom: true,
  isolating: true,
  attrs: {
    value: { default: '' },
  },
  parseDOM: [{
    tag: 'div[data-type="math_block"]',
    preserveWhitespace: 'full' as const,
    getAttrs(dom: HTMLElement) {
      return { value: dom.dataset.value ?? '' };
    },
  }],
  toDOM(node) {
    const code = node.attrs.value as string;
    const dom = document.createElement('div');
    dom.dataset.type = 'math_block';
    dom.dataset.value = code;
    try {
      katex.render(code, dom, { displayMode: true });
    } catch {
      dom.textContent = code;
    }
    return dom;
  },
};

// ── Definition List Nodes ───────────────────────────────────────

const defList: NodeSpec = {
  content: '(defListTerm | defListDescription)+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dl' }],
  toDOM() { return ['dl', { class: 'definition-list' }, 0]; },
};

const defListTerm: NodeSpec = {
  content: 'inline*',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dt' }],
  toDOM() { return ['dt', 0]; },
};

const defListDescription: NodeSpec = {
  content: 'block+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dd' }],
  toDOM() { return ['dd', 0]; },
};

// ── Mark Specs ──────────────────────────────────────────────────

const strong: MarkSpec = {
  parseDOM: [
    {
      tag: 'b',
      getAttrs(dom: HTMLElement) {
        return dom.style.fontWeight !== 'normal' && null;
      },
    },
    { tag: 'strong' },
    {
      style: 'font-weight',
      getAttrs(value: string) {
        return /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null;
      },
    },
  ],
  toDOM() { return ['strong', 0]; },
};

const em: MarkSpec = {
  parseDOM: [
    { tag: 'i' },
    { tag: 'em' },
    {
      style: 'font-style',
      getAttrs(value: string) {
        return value === 'italic' && null;
      },
    },
  ],
  toDOM() { return ['em', 0]; },
};

const code: MarkSpec = {
  priority: 100,
  code: true,
  parseDOM: [{ tag: 'code' }],
  toDOM() { return ['code', 0]; },
};

const link: MarkSpec = {
  attrs: {
    href: {},
    title: { default: null },
  },
  inclusive: false,
  parseDOM: [{
    tag: 'a[href]',
    getAttrs(dom: HTMLElement) {
      return {
        href: dom.getAttribute('href'),
        title: dom.getAttribute('title'),
      };
    },
  }],
  toDOM(mark) {
    const attrs: Record<string, string> = { href: mark.attrs.href };
    if (mark.attrs.title) attrs.title = mark.attrs.title;
    return ['a', attrs, 0];
  },
};

const strike_through: MarkSpec = {
  parseDOM: [
    { tag: 'del' },
    { tag: 's' },
    {
      style: 'text-decoration',
      getAttrs(value: string) {
        return value === 'line-through' && null;
      },
    },
  ],
  toDOM() { return ['del', 0]; },
};

/**
 * Mark for paired inline HTML tags (e.g., <font>, <span>, <sub>, <sup>).
 * Paired opening/closing tags are rendered with their styling in the visual
 * editor while the original HTML is preserved in serialization.
 * Only truly paired tags (detected via pre-scan) use this mark;
 * unpaired tags remain as html_inline atom nodes for roundtrip fidelity.
 */
const html_mark: MarkSpec = {
  attrs: {
    openTag: { default: '' },
    closeTag: { default: '' },
  },
  excludes: '', // Allow nesting multiple html_marks (e.g., <font><u>text</u></font>)
  parseDOM: [{
    tag: '[data-type="html-mark"]',
    getAttrs(dom: HTMLElement) {
      return {
        openTag: dom.dataset.openTag ?? '',
        closeTag: dom.dataset.closeTag ?? '',
      };
    },
  }],
  toDOM(mark) {
    const openTag = mark.attrs.openTag as string;
    const tagMatch = openTag.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
    const tagName = tagMatch ? tagMatch[1].toLowerCase() : 'span';

    const attrs: Record<string, string> = {
      'data-type': 'html-mark',
      'data-open-tag': openTag,
      'data-close-tag': mark.attrs.closeTag as string,
    };

    // Use actual semantic elements for common tags
    const semanticTags = ['sub', 'sup', 'u', 'ins', 'mark', 'small', 'big', 'kbd', 'abbr'];
    if (semanticTags.includes(tagName)) {
      return [tagName, attrs, 0];
    }

    // Others (font, span, etc.): styled span
    const style = htmlTagToStyle(openTag);
    if (style) attrs.style = style;
    return ['span', attrs, 0];
  },
};

// ── Schema ──────────────────────────────────────────────────────

export const schema = new Schema({
  nodes: {
    doc,
    text: { group: 'inline' },
    paragraph,
    heading,
    blockquote,
    code_block,
    horizontal_rule,
    bullet_list,
    ordered_list,
    list_item,
    image,
    hardbreak,
    html_block,
    html_inline,
    table,
    table_header_row,
    table_row,
    table_header,
    table_cell,
    math_inline,
    math_block,
    defList,
    defListTerm,
    defListDescription,
  },
  marks: {
    html_mark,
    strong,
    em,
    code,
    link,
    strike_through,
  },
});

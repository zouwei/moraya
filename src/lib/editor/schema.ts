/**
 * Unified ProseMirror Schema for Moraya editor.
 *
 * All node and mark specs are defined here in a single Schema instance.
 * Node names and attributes replicate Milkdown's definitions exactly
 * to maintain CSS selector compatibility.
 *
 * Nodes (21): doc, text, paragraph, heading, blockquote, code_block,
 *   horizontal_rule, bullet_list, ordered_list, list_item, image,
 *   hardbreak, html_block, table, table_header_row, table_row,
 *   table_header, table_cell, math_inline, math_block,
 *   defList, defListTerm, defListDescription
 *
 * Marks (5): strong, em, code, link, strike_through
 */

import { Schema, Fragment } from 'prosemirror-model';
import type { NodeSpec, MarkSpec } from 'prosemirror-model';
import katex from 'katex';

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
    language: { default: '' },
  },
  parseDOM: [{
    tag: 'pre',
    preserveWhitespace: 'full' as const,
    getAttrs(dom: HTMLElement) {
      return { language: dom.dataset.language || '' };
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
    return ['img', { ...node.attrs }];
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
    strong,
    em,
    code,
    link,
    strike_through,
  },
});

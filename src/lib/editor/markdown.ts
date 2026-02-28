/**
 * Markdown parser and serializer for Moraya editor.
 *
 * Uses prosemirror-markdown with markdown-it as the tokenizer.
 * Supports: CommonMark + GFM (tables, strikethrough, task lists) +
 *           math (via markdown-it-texmath) + definition lists.
 *
 * Configuration matches Milkdown output conventions:
 *   - bullet: '-'
 *   - horizontal rule: '---'
 *   - strong: '**'
 *   - emphasis: '*'
 */

import MarkdownIt from 'markdown-it';
import deflistPlugin from 'markdown-it-deflist';
import texmathPlugin from 'markdown-it-texmath';
import { MarkdownParser, MarkdownSerializer } from 'prosemirror-markdown';
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import type { Node as PmNode, Mark } from 'prosemirror-model';
import { schema } from './schema';

// ── markdown-it instance ────────────────────────────────────────

const md = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false,
})
  .enable(['table', 'strikethrough'])
  .use(deflistPlugin)
  .use(texmathPlugin);

// ── Parser ──────────────────────────────────────────────────────

/**
 * Token-to-node mapping for prosemirror-markdown's MarkdownParser.
 *
 * markdown-it token names → ProseMirror node/mark names from schema.ts
 */
const parserTokens: Record<string, import('prosemirror-markdown').ParseSpec> = {
  // ── Block tokens ──
  paragraph: { block: 'paragraph' },
  blockquote: { block: 'blockquote' },
  heading: {
    block: 'heading',
    getAttrs(token) {
      return { level: Number(token.tag.slice(1)) };
    },
  },
  hr: { node: 'horizontal_rule' },
  bullet_list: { block: 'bullet_list' },
  ordered_list: {
    block: 'ordered_list',
    getAttrs(token) {
      return { order: Number(token.attrGet('start') || 1) };
    },
  },
  list_item: {
    block: 'list_item',
    getAttrs(_token, tokens, index) {
      // Check for task list checkbox in the first inline child
      // The inline content starts with [x] or [ ]
      let checked: boolean | null = null;
      for (let i = index + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'inline' && t.content) {
          const match = t.content.match(/^\[( |x|X)\]\s?/);
          if (match) {
            checked = match[1] !== ' ';
            // Strip the checkbox text from the token content
            t.content = t.content.slice(match[0].length);
            // Also update children if they exist
            if (t.children && t.children.length > 0) {
              const firstChild = t.children[0];
              if (firstChild.type === 'text') {
                firstChild.content = firstChild.content.slice(match[0].length);
                if (!firstChild.content) {
                  t.children.shift();
                }
              }
            }
          }
          break;
        }
        if (t.type === 'list_item_close') break;
      }
      return { checked };
    },
  },
  code_block: {
    block: 'code_block',
    noCloseToken: true,
  },
  fence: {
    block: 'code_block',
    getAttrs(token) {
      return { language: token.info || '' };
    },
    noCloseToken: true,
  },
  html_block: {
    block: 'html_block',
    noCloseToken: true,
  },

  // ── Table tokens ──
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: {
    block: 'table_row',
    getAttrs(_token, tokens, index) {
      // Determine if this is a header row: check if parent is thead
      // by looking backwards for thead_open
      for (let i = index - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t.type === 'thead_open') return { __header: true };
        if (t.type === 'thead_close' || t.type === 'tbody_open') break;
      }
      return {};
    },
  },
  th: {
    block: 'table_header',
    getAttrs(token) {
      const style = token.attrGet('style') || '';
      const match = style.match(/text-align:\s*(\w+)/);
      return { alignment: match ? match[1] : 'left' };
    },
  },
  td: {
    block: 'table_cell',
    getAttrs(token) {
      const style = token.attrGet('style') || '';
      const match = style.match(/text-align:\s*(\w+)/);
      return { alignment: match ? match[1] : 'left' };
    },
  },

  // ── Definition list tokens ──
  dl: { block: 'defList' },
  dt: { block: 'defListTerm' },
  dd: { block: 'defListDescription' },

  // ── Math tokens (from markdown-it-texmath) ──
  math_inline: {
    node: 'math_inline',
    noCloseToken: true,
    getAttrs(token) {
      return { __text: token.content };
    },
  },
  math_block: {
    node: 'math_block',
    noCloseToken: true,
    getAttrs(token) {
      return { value: token.content.trim() };
    },
  },

  // ── Inline tokens ──
  image: {
    node: 'image',
    getAttrs(token) {
      return {
        src: token.attrGet('src') || '',
        alt: (token.children || []).map(c => c.content).join('') || '',
        title: token.attrGet('title') || '',
      };
    },
  },
  hardbreak: { node: 'hardbreak' },
  softbreak: { node: 'hardbreak', attrs: { isInline: true } },

  // ── Mark tokens ──
  em: { mark: 'em' },
  strong: { mark: 'strong' },
  s: { mark: 'strike_through' },
  code_inline: { mark: 'code', noCloseToken: true },
  link: {
    mark: 'link',
    getAttrs(token) {
      return {
        href: token.attrGet('href') || '',
        title: token.attrGet('title') || null,
      };
    },
  },
};

/**
 * Custom MarkdownParser that handles table header rows.
 *
 * prosemirror-markdown's default parser maps `tr` tokens uniformly,
 * but our schema requires `table_header_row` for <thead> rows.
 * We post-process the parsed doc to convert header rows.
 */
class MorayaMarkdownParser extends MarkdownParser {
  override parse(text: string, markdownEnv?: object) {
    const doc = super.parse(text, markdownEnv);
    // Post-process: convert table_row nodes that were in <thead>
    // to table_header_row nodes
    return transformHeaderRows(doc);
  }
}

/**
 * Walk the document and replace table_row nodes containing table_header
 * cells with table_header_row nodes.
 */
function transformHeaderRows(doc: PmNode): PmNode {
  const result: PmNode[] = [];
  let changed = false;

  doc.forEach((child, _offset) => {
    if (child.type === schema.nodes.table) {
      const tableChildren: PmNode[] = [];
      let tableChanged = false;

      child.forEach((row, _rowOffset, rowIndex) => {
        // First row of a table that contains table_header cells → table_header_row
        if (rowIndex === 0 && row.type === schema.nodes.table_row) {
          let hasHeaders = false;
          row.forEach(cell => {
            if (cell.type === schema.nodes.table_header) hasHeaders = true;
          });

          if (hasHeaders) {
            // Wrap cells in paragraph if they're inline content
            const headerRow = schema.nodes.table_header_row.create(null, row.content);
            tableChildren.push(headerRow);
            tableChanged = true;
            return;
          }
        }
        tableChildren.push(row);
      });

      if (tableChanged) {
        result.push(schema.nodes.table.create(child.attrs, tableChildren));
        changed = true;
      } else {
        result.push(child);
      }
    } else if (child.childCount > 0) {
      const transformed = transformHeaderRows(child);
      if (transformed !== child) {
        changed = true;
        result.push(transformed);
      } else {
        result.push(child);
      }
    } else {
      result.push(child);
    }
  });

  if (!changed) return doc;
  return doc.copy(schema.nodes.doc.contentMatch.defaultType
    ? doc.type.create(doc.attrs, result).content
    : doc.type.create(doc.attrs, result).content);
}

const parser = new MorayaMarkdownParser(schema, md, parserTokens);

// ── Serializer ──────────────────────────────────────────────────

const serializer = new MarkdownSerializer(
  {
    // ── Block nodes ──
    doc(state, node) {
      state.renderContent(node);
    },
    paragraph(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(`${'#'.repeat(node.attrs.level)} `);
      state.renderInline(node);
      state.closeBlock(node);
    },
    blockquote(state, node) {
      state.wrapBlock('> ', null, node, () => state.renderContent(node));
    },
    code_block(state, node) {
      const lang = node.attrs.language || '';
      state.write(`\`\`\`${lang}\n`);
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write('```');
      state.closeBlock(node);
    },
    horizontal_rule(state, node) {
      state.write('---');
      state.closeBlock(node);
    },
    bullet_list(state, node) {
      state.renderList(node, '  ', () => '- ');
    },
    ordered_list(state, node) {
      const start = node.attrs.order || 1;
      state.renderList(node, '   ', (i: number) => `${start + i}. `);
    },
    list_item(state, node, parent, index) {
      // Task list checkbox prefix
      if (node.attrs.checked != null) {
        const checkbox = node.attrs.checked ? '[x] ' : '[ ] ';
        state.write(checkbox);
      }
      state.renderContent(node);
    },
    image(state, node) {
      const alt = state.esc(node.attrs.alt || '', false);
      const src = node.attrs.src || '';
      const title = node.attrs.title;
      if (title) {
        state.write(`![${alt}](${src} "${state.esc(title, false)}")`);
      } else {
        state.write(`![${alt}](${src})`);
      }
    },
    hardbreak(state, node) {
      if (node.attrs.isInline) {
        state.write('\n');
      } else {
        state.write('  \n');
      }
    },
    html_block(state, node) {
      state.text(node.textContent, false);
      state.closeBlock(node);
    },

    // ── Table nodes ──
    table(state, node) {
      // Collect alignment from header row
      const alignments: string[] = [];
      const headerRow = node.child(0);
      headerRow.forEach(cell => {
        alignments.push(cell.attrs.alignment || 'left');
      });

      // Render header row
      renderTableRow(state, headerRow);

      // Render separator
      const sep = alignments.map(a => {
        switch (a) {
          case 'center': return ':---:';
          case 'right': return '---:';
          default: return '---';
        }
      });
      state.write(`| ${sep.join(' | ')} |`);
      state.ensureNewLine();

      // Render data rows
      for (let i = 1; i < node.childCount; i++) {
        renderTableRow(state, node.child(i));
      }
      state.closeBlock(node);
    },
    table_header_row() { /* handled by table */ },
    table_row() { /* handled by table */ },
    table_header(state, node) {
      state.renderInline(node.firstChild!);
    },
    table_cell(state, node) {
      state.renderInline(node.firstChild!);
    },

    // ── Math nodes ──
    math_inline(state, node) {
      state.write(`$${node.textContent}$`);
    },
    math_block(state, node) {
      state.write('$$\n');
      state.text(node.attrs.value || node.textContent, false);
      state.ensureNewLine();
      state.write('$$');
      state.closeBlock(node);
    },

    // ── Definition list nodes ──
    defList(state, node) {
      state.renderContent(node);
    },
    defListTerm(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    defListDescription(state, node) {
      state.write(':   ');
      state.renderContent(node);
    },

    // ── Fallback for text node (shouldn't be needed but safe) ──
    text(state, node) {
      state.text(node.text || '');
    },
  },
  {
    // ── Mark serializers ──
    strong: {
      open: '**',
      close: '**',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    em: {
      open: '*',
      close: '*',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    code: {
      open(_state: MarkdownSerializerState, _mark: Mark, parent: PmNode, index: number) {
        return isPlainURL(_mark, parent, index, 1) ? '' : '`';
      },
      close(_state: MarkdownSerializerState, _mark: Mark, parent: PmNode, index: number) {
        return isPlainURL(_mark, parent, index, -1) ? '' : '`';
      },
      escape: false,
    },
    link: {
      open(state, mark, parent, index) {
        return isPlainURL(mark, parent, index, 1) ? '<' : '[';
      },
      close(state, mark, parent, index) {
        const { href, title } = mark.attrs;
        if (isPlainURL(mark, parent, index, -1)) {
          return '>';
        }
        return title
          ? `](${href} "${state.esc(title, false)}")`
          : `](${href})`;
      },
      mixable: false,
    },
    strike_through: {
      open: '~~',
      close: '~~',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
  },
  {
    hardBreakNodeName: 'hardbreak',
    strict: false,
  },
);

/**
 * Helper: render a table row as `| cell1 | cell2 | ... |`
 */
function renderTableRow(state: MarkdownSerializerState, row: PmNode) {
  const cells: string[] = [];
  row.forEach(cell => {
    // Serialize cell content inline
    const para = cell.firstChild;
    if (para && para.textContent) {
      // Use a temporary serializer state to render inline content
      const cellText = serializeCellContent(para);
      cells.push(cellText);
    } else {
      cells.push('');
    }
  });
  state.write(`| ${cells.join(' | ')} |`);
  state.ensureNewLine();
}

/**
 * Serialize a paragraph node's inline content to a plain markdown string.
 * Used for table cells where we need inline content without block wrappers.
 */
function serializeCellContent(para: PmNode): string {
  // Simple inline serialization: walk through marks and text
  let result = '';
  para.forEach(child => {
    let text = child.text || '';
    // Apply marks
    for (const mark of child.marks) {
      const spec = serializer.marks[mark.type.name];
      if (spec) {
        const open = typeof spec.open === 'function'
          ? spec.open({} as MarkdownSerializerState, mark, para, 0)
          : spec.open;
        const close = typeof spec.close === 'function'
          ? spec.close({} as MarkdownSerializerState, mark, para, 0)
          : spec.close;
        text = `${open}${text}${close}`;
      }
    }
    result += text;
  });
  return result;
}

/**
 * Check if a link mark represents a plain URL (autolink style).
 * If so, serialize as `<url>` instead of `[text](url)`.
 */
function isPlainURL(mark: Mark, parent: PmNode, index: number, side: number): boolean {
  if (mark.attrs.title || !/^\w+:/.test(mark.attrs.href)) return false;
  const content = parent.child(index + (side < 0 ? -1 : 0));
  if (
    !content.isText ||
    content.text !== mark.attrs.href ||
    content.marks[content.marks.length - 1] !== mark
  ) {
    return false;
  }
  if (index === (side < 0 ? 1 : parent.childCount - 1)) return true;
  const next = parent.child(index + (side < 0 ? -2 : 1));
  return !mark.isInSet(next.marks);
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Parse a markdown string into a ProseMirror document node.
 */
export function parseMarkdown(markdown: string): PmNode {
  return parser.parse(markdown);
}

/**
 * Serialize a ProseMirror document node to a markdown string.
 */
export function serializeMarkdown(doc: PmNode): string {
  return serializer.serialize(doc, { tightLists: true });
}

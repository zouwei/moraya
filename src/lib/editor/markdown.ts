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
    getAttrs() {
      return { language: 'text' };
    },
    noCloseToken: true,
  },
  fence: {
    block: 'code_block',
    getAttrs(token) {
      return { language: token.info.trim() || 'text' };
    },
    noCloseToken: true,
  },
  html_block: {
    block: 'html_block',
    noCloseToken: true,
  },
  html_inline: {
    // markdown-it emits this token for inline HTML like <br>, <span>, <sup>,
    // and HTML comments <!-- ... -->. Store raw HTML in the `value` attr.
    node: 'html_inline',
    noCloseToken: true,
    getAttrs(token) {
      return { value: token.content };
    },
  },

  // ── Table tokens ──
  // NOTE: tr/th/td are NOT listed here — they are handled by custom tokenHandler
  // overrides in MorayaMarkdownParser below. The `block:` spec alone can't
  // handle (a) thead-row → table_header_row vs table_row dispatch, or
  // (b) wrapping inline content in the required paragraph child of each cell.
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },

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
 * Custom MarkdownParser that correctly handles GFM table structure.
 *
 * Two problems with the default prosemirror-markdown `block:` approach for tables:
 *
 * 1. `table_header` and `table_cell` both have `content: 'paragraph+'` in our schema.
 *    prosemirror-markdown opens the cell block, then adds raw inline text via addText().
 *    When closeNode() calls createAndFill(attrs, [text("A")]), the content match
 *    for `paragraph+` cannot fit a bare text node, so createAndFill() returns null
 *    and the cell (and all its content) is silently dropped → empty table.
 *
 * 2. `table: content: 'table_header_row table_row+'` requires the first child to be
 *    a `table_header_row`, but the default `tr` handler always creates `table_row`.
 *    ProseMirror's createAndFill() then auto-inserts an empty `table_header_row`
 *    at the front, leaving the real header data in a wrongly-typed `table_row`.
 *
 * Fix: override tr/th/td tokenHandlers in the constructor to:
 *  - tr_open inside <thead> → open `table_header_row` instead of `table_row`
 *  - th_open → open `table_header`, then open an inner `paragraph`
 *  - th_close → close `paragraph`, then close `table_header`
 *  - td_open/close → same pattern with `table_cell`
 */
class MorayaMarkdownParser extends MarkdownParser {
  constructor() {
    super(schema, md, parserTokens);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h: Record<string, (state: any, tok: any, tokens: any[], i: number) => void> =
      (this as any).tokenHandlers;

    function cellAlignment(tok: { attrGet(s: string): string | null }): string {
      const style = tok.attrGet('style') || '';
      const m = style.match(/text-align:\s*(\w+)/);
      return m ? m[1] : 'left';
    }

    // tr_open: dispatch to table_header_row or table_row based on parent context
    h['tr_open'] = (state, _tok, tokens, i) => {
      let inThead = false;
      for (let j = i - 1; j >= 0; j--) {
        if (tokens[j].type === 'thead_open') { inThead = true; break; }
        if (tokens[j].type === 'thead_close' || tokens[j].type === 'tbody_open') break;
      }
      state.openNode(inThead ? schema.nodes.table_header_row : schema.nodes.table_row, null);
    };
    h['tr_close'] = (state) => state.closeNode();

    // th_open/close: open table_header + inner paragraph so inline text lands correctly
    h['th_open'] = (state, tok) => {
      state.openNode(schema.nodes.table_header, { alignment: cellAlignment(tok) });
      state.openNode(schema.nodes.paragraph, null);
    };
    h['th_close'] = (state) => {
      state.closeNode(); // close paragraph
      state.closeNode(); // close table_header
    };

    // td_open/close: open table_cell + inner paragraph
    h['td_open'] = (state, tok) => {
      state.openNode(schema.nodes.table_cell, { alignment: cellAlignment(tok) });
      state.openNode(schema.nodes.paragraph, null);
    };
    h['td_close'] = (state) => {
      state.closeNode(); // close paragraph
      state.closeNode(); // close table_cell
    };
  }

}

const parser = new MorayaMarkdownParser();

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
    html_inline(state, node) {
      // Write the raw HTML back verbatim (no escaping); value attr holds the original HTML.
      state.text(node.attrs.value as string, false);
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
 *
 * Uses ProseMirror's built-in renderInline via output-buffer capture so that
 * ALL inline content (text, marks, hard breaks, math, images, etc.) is
 * serialized correctly — the same path used for headings and paragraphs.
 */
function renderTableRow(state: MarkdownSerializerState, row: PmNode) {
  const cells: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = state as any;
  row.forEach(cell => {
    // Cells with 'paragraph+' content: each paragraph is one "line" in the cell.
    // GFM cells are single-line, so join multiple paragraphs with a space.
    const parts: string[] = [];
    cell.forEach(para => {
      if (para.type.name !== 'paragraph') return;
      // Capture renderInline output by swapping the serializer's output buffer.
      //
      // IMPORTANT: prosemirror-markdown's text() calls write() for every line,
      // and write() calls flushClose() which resets this.closed. We must save
      // and restore BOTH out AND closed so the pending block-separator (the
      // blank line between the preceding paragraph and this table) is not
      // accidentally consumed here — it must survive until state.write('| … |')
      // fires at the end of this function, where flushClose() will emit it.
      const savedOut: string = s.out;
      const savedClosed = s.closed;
      s.out = '';
      s.closed = null; // nothing to flush into the temp buffer
      state.renderInline(para);
      const piece: string = (s.out as string).replace(/\n/g, ' ').trim();
      s.out = savedOut;
      s.closed = savedClosed; // restore so state.write() below emits the blank line
      parts.push(piece);
    });
    cells.push(parts.join(' '));
  });
  state.write(`| ${cells.join(' | ')} |`);
  state.ensureNewLine();
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

const ASYNC_PARSE_THRESHOLD = 50_000;

/**
 * Async version of parseMarkdown. For large files (≥50KB), yields to the
 * event loop via setTimeout(0) so the main thread stays responsive.
 */
export function parseMarkdownAsync(markdown: string): Promise<PmNode> {
  if (markdown.length < ASYNC_PARSE_THRESHOLD) {
    return Promise.resolve(parser.parse(markdown));
  }
  return new Promise(resolve => setTimeout(() => resolve(parser.parse(markdown)), 0));
}

/**
 * Serialize a ProseMirror document node to a markdown string.
 */
export function serializeMarkdown(doc: PmNode): string {
  return serializer.serialize(doc, { tightLists: true });
}

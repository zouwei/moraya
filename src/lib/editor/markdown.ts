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

// ── Paired HTML tag pre-processing ──────────────────────────────

/**
 * Pre-scan inline tokens to identify paired HTML opening/closing tags.
 * Sets `meta.htmlPaired = true` on paired tokens so the parser converts
 * them to marks (styled rendering) instead of atom nodes (invisible).
 * Unpaired tags remain unmarked → atom nodes → exact roundtrip fidelity.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tagPairedHtmlInline(tokens: any[]): void {
  const VOID_RE = /^<(?:br|hr|img|input|wbr|area|base|col|embed|link|meta|param|source|track)[\s/>]/i;
  for (const token of tokens) {
    if (token.type !== 'inline' || !token.children) continue;
    const children = token.children;
    const stack: { tagName: string; index: number }[] = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.type !== 'html_inline') continue;
      const content: string = child.content;
      // Skip void/self-closing elements and comments
      if (VOID_RE.test(content) || /\/>$/.test(content) || /^<!--/.test(content)) continue;
      // Closing tag?
      const closeMatch = content.match(/^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>$/);
      if (closeMatch) {
        const tagName = closeMatch[1].toLowerCase();
        for (let j = stack.length - 1; j >= 0; j--) {
          if (stack[j].tagName === tagName) {
            children[stack[j].index].meta = { ...(children[stack[j].index].meta || {}), htmlPaired: true };
            child.meta = { ...(child.meta || {}), htmlPaired: true };
            stack.splice(j, 1);
            break;
          }
        }
        continue;
      }
      // Opening tag?
      const openMatch = content.match(/^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>$/);
      if (openMatch) {
        stack.push({ tagName: openMatch[1].toLowerCase(), index: i });
      }
    }
  }
}

// Patch md.parse to inject paired-tag pre-processing before prosemirror-markdown
// processes the tokens. This allows the html_inline handler to distinguish
// paired tags (→ marks with styling) from unpaired tags (→ atom nodes).
const _origMdParse = md.parse.bind(md);
md.parse = function (src: string, env: unknown) {
  const tokens = _origMdParse(src, env);
  tagPairedHtmlInline(tokens);
  return tokens;
};

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
  // Use block: spec (not node:) so token.content is added as text children,
  // correctly filling math_inline's `content: 'text*'`.
  math_inline: {
    block: 'math_inline',
    noCloseToken: true,
  },
  // markdown-it-texmath emits math_inline_double for $$...$$ in inline context.
  // Map to math_inline to prevent "Token type not supported" crash.
  math_inline_double: {
    block: 'math_inline',
    noCloseToken: true,
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
      let href = token.attrGet('href') || '';
      // Decode percent-encoded non-ASCII UTF-8 characters (e.g. Chinese/Japanese/Korean)
      // so URLs preserve original characters through roundtrips.
      // Only decodes multi-byte UTF-8 sequences (C2-FF start bytes + 80-BF continuations),
      // leaving ASCII encodings like %20 (space), %28/%29 (parens) intact.
      href = href.replace(
        /%[C-F][0-9A-F](?:%[89AB][0-9A-F])+/gi,
        (m) => { try { return decodeURIComponent(m); } catch { return m; } },
      );
      return {
        href,
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

    // ── Empty link preservation ────────────────────────────────────
    // When markdown-it parses `[]()` or `[](url)`, it emits link_open → link_close
    // with no text token between them. ProseMirror discards marks with no content,
    // so the link completely disappears. Fix: detect empty-text links and insert
    // the raw markdown syntax as literal text instead of creating a mark.
    const defaultLinkOpen = h['link_open'];
    const defaultLinkClose = h['link_close'];

    h['link_open'] = (state: any, tok: any, tokens: any[], i: number) => {
      // Check if there's actual content between link_open and link_close
      let hasContent = false;
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].type === 'link_close') break;
        if (tokens[j].type === 'text' && tokens[j].content) {
          hasContent = true;
          break;
        }
        if (['image', 'code_inline', 'softbreak', 'hardbreak', 'html_inline'].includes(tokens[j].type)) {
          hasContent = true;
          break;
        }
      }

      if (!hasContent) {
        // Empty-text link: insert raw markdown syntax as literal text
        let href = tok.attrGet('href') || '';
        // Decode non-ASCII characters for readability
        href = href.replace(
          /%[C-F][0-9A-F](?:%[89AB][0-9A-F])+/gi,
          (m: string) => { try { return decodeURIComponent(m); } catch { return m; } },
        );
        const title = tok.attrGet('title');
        let literal = `[](${href}`;
        if (title) literal += ` "${title}"`;
        literal += ')';
        state.addText(literal);
        // Mark the corresponding link_close to be skipped
        for (let j = i + 1; j < tokens.length; j++) {
          if (tokens[j].type === 'link_close') {
            tokens[j].meta = { ...(tokens[j].meta || {}), skipClose: true };
            break;
          }
        }
        return;
      }

      defaultLinkOpen(state, tok, tokens, i);
    };

    h['link_close'] = (state: any, tok: any, tokens: any[], i: number) => {
      if (tok.meta?.skipClose) return;
      defaultLinkClose(state, tok, tokens, i);
    };

    // ── Paired inline HTML → marks ─────────────────────────────────
    // Pre-scanned paired tags (meta.htmlPaired) become openMark/closeMark
    // so the visual editor renders them with styling. Unpaired tags stay
    // as html_inline atom nodes for exact roundtrip fidelity.
    //
    // Special case: <audio>/<video> inline tags (single-line, e.g.
    // `<audio src="..." controls></audio>`) are combined into a single
    // html_inline atom node so toDOM renders them as media players.
    // markdown-it treats these as inline HTML (not html_block) because
    // <audio>/<video> are not in the CommonMark block-level tag list.

    // Override text handler to respect mediaSkip flag (intermediate content
    // between <audio>/<video> opening and closing tags).
    const defaultTextHandler = h['text'];
    h['text'] = (state: any, tok: any, toks: any[], ii: number) => {
      if (tok.meta?.mediaSkip) return;
      defaultTextHandler(state, tok, toks, ii);
    };

    h['html_inline'] = (state, tok, tokens, i) => {
      // Skip tokens already consumed by audio/video combination
      if (tok.meta?.mediaSkip) return;

      const content: string = tok.content;

      // <audio>/<video> inline: combine opening + closing into single atom.
      // This handles cases like `<audio src="..." controls></audio>` on one line,
      // or `<audio><source src="..." type="audio/mpeg"></audio>`.
      const mediaMatch = content.match(/^<(audio|video)\b/i);
      if (mediaMatch) {
        const tagName = mediaMatch[1].toLowerCase();
        const closeRe = new RegExp(`^</${tagName}\\s*>$`, 'i');
        let fullHtml = content;
        for (let j = i + 1; j < tokens.length; j++) {
          const t = tokens[j];
          if (t.type === 'html_inline' && closeRe.test(t.content.trim())) {
            fullHtml += t.content;
            t.meta = { ...(t.meta || {}), mediaSkip: true };
            break;
          }
          // Include intermediate tokens (e.g. <source>, fallback text)
          if (t.content) fullHtml += t.content;
          t.meta = { ...(t.meta || {}), mediaSkip: true };
        }
        state.addNode(schema.nodes.html_inline, { value: fullHtml });
        return;
      }

      if (tok.meta?.htmlPaired) {
        if (!content.startsWith('</')) {
          // Opening tag → open mark
          const tagMatch = content.match(/^<([a-zA-Z][a-zA-Z0-9]*)/);
          const tagName = tagMatch ? tagMatch[1].toLowerCase() : '';
          state.openMark(schema.marks.html_mark.create({
            openTag: content,
            closeTag: `</${tagName}>`,
          }));
        } else {
          // Closing tag → close mark
          state.closeMark(schema.marks.html_mark);
        }
        return;
      }
      // Not paired → atom node (preserves current behavior)
      state.addNode(schema.nodes.html_inline, { value: content });
    };

    // ── HTML <img> tag: block → inline promotion ──────────────────
    // markdown-it tokenizes standalone <img> as html_block (renders as code block).
    // Promote to paragraph(html_inline) so the toDOM can render it as an image.
    // Source format is preserved: html_inline serializes attrs.value (original HTML).
    const defaultHtmlBlock = h['html_block'];
    h['html_block'] = (state, tok, tokens, i) => {
      const content = tok.content.trim();
      // Check if the block contains <img> tag(s)
      if (/^<img\s/i.test(content)) {
        // Extract all <img> tags — put them in ONE paragraph with inline
        // hardbreaks between them, matching markdown image behavior.
        // This prevents the serializer from inserting blank lines between images.
        const imgPattern = /<img\s[^>]*\/?>/gi;
        const imgs = content.match(imgPattern);
        state.openNode(schema.nodes.paragraph, null);
        if (imgs && imgs.length > 0) {
          for (let j = 0; j < imgs.length; j++) {
            if (j > 0) {
              state.addNode(schema.nodes.hardbreak, { isInline: true });
            }
            state.addNode(schema.nodes.html_inline, { value: imgs[j] });
          }
        } else {
          state.addNode(schema.nodes.html_inline, { value: content });
        }
        state.closeNode();
      } else if (/^<(video|audio)\b/i.test(content)) {
        // Promote <video>/<audio> blocks to paragraph(html_inline) so toDOM
        // renders them as actual media players instead of code blocks.
        // The entire raw HTML (including child <source> tags) is stored in
        // the html_inline value attribute for lossless roundtrip.
        state.openNode(schema.nodes.paragraph, null);
        state.addNode(schema.nodes.html_inline, { value: content });
        state.closeNode();
      } else {
        defaultHtmlBlock(state, tok, tokens, i);
      }
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
      // fromBlockStart=false: the `## ` prefix already prevents text from being
      // parsed as list markers / blockquote, so don't escape `1.`, `-`, `>` etc.
      state.renderInline(node, false);
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
    html_mark: {
      open(_state: MarkdownSerializerState, mark: Mark) {
        return mark.attrs.openTag as string;
      },
      close(_state: MarkdownSerializerState, mark: Mark) {
        return mark.attrs.closeTag as string;
      },
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
 * Ensure display math blocks ($$…$$) are surrounded by blank lines so
 * markdown-it-texmath parses them as math_block, not math_inline_double.
 * Without blank lines, they get absorbed into the preceding paragraph as
 * inline tokens, causing wrong rendering and roundtrip corruption.
 */
function normalizeMathBlocks(text: string): string {
  if (!text.includes('$$')) return text;

  const lines = text.split('\n');
  const result: string[] = [];
  let inFence = false;
  let inMathBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Skip fenced code blocks
    if (!inMathBlock && /^(`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence;
      result.push(lines[i]);
      continue;
    }
    if (inFence) {
      result.push(lines[i]);
      continue;
    }

    if (trimmed === '$$') {
      if (!inMathBlock) {
        // Opening $$: ensure blank line before
        if (result.length > 0 && result[result.length - 1].trim() !== '') {
          result.push('');
        }
        result.push(lines[i]);
        inMathBlock = true;
      } else {
        // Closing $$
        result.push(lines[i]);
        inMathBlock = false;
        // Ensure blank line after if next line is non-empty
        if (i + 1 < lines.length && lines[i + 1].trim() !== '') {
          result.push('');
        }
      }
    } else {
      result.push(lines[i]);
    }
  }

  return result.join('\n');
}

/**
 * Parse a markdown string into a ProseMirror document node.
 */
/**
 * Normalize smart/curly quotes to straight quotes in markdown syntax positions.
 * Only targets image/link title delimiters to preserve intentional smart quotes in prose.
 * Pattern: `](url "title")` or `](url 'title')` with curly quotes.
 */
function normalizeSmartQuotes(text: string): string {
  // Quick bail: no curly quotes at all
  if (!/[\u201C\u201D\u201E\u201F\u2018\u2019\u201A\u201B]/.test(text)) return text;

  // Normalize curly double quotes in markdown link/image title positions:
  // Matches: (url "title") where " are curly quotes
  return text
    .replace(
      /(\]\([^\n)]*\s)\u201C([^\u201D\n]*)\u201D(\s*\))/g,
      (_m, pre, title, post) => `${pre}"${title}"${post}`,
    )
    .replace(
      /(\]\([^\n)]*\s)\u201C([^\u201D\n]*)\u201D(\s*\))/g,
      (_m, pre, title, post) => `${pre}"${title}"${post}`,
    )
    // Also handle single curly quotes as title delimiters
    .replace(
      /(\]\([^\n)]*\s)\u2018([^\u2019\n]*)\u2019(\s*\))/g,
      (_m, pre, title, post) => `${pre}'${title}'${post}`,
    );
}

export function parseMarkdown(markdown: string): PmNode {
  return parser.parse(normalizeSmartQuotes(normalizeMathBlocks(markdown)));
}

const ASYNC_PARSE_THRESHOLD = 50_000;

/**
 * Async version of parseMarkdown. For large files (≥50KB), yields to the
 * event loop via setTimeout(0) so the main thread stays responsive.
 */
export function parseMarkdownAsync(markdown: string): Promise<PmNode> {
  const normalized = normalizeSmartQuotes(normalizeMathBlocks(markdown));
  if (normalized.length < ASYNC_PARSE_THRESHOLD) {
    return Promise.resolve(parser.parse(normalized));
  }
  return new Promise(resolve => setTimeout(() => resolve(parser.parse(normalized)), 0));
}

/**
 * Serialize a ProseMirror document node to a markdown string.
 */
export function serializeMarkdown(doc: PmNode): string {
  let result = serializer.serialize(doc, { tightLists: true });
  // Un-escape markdown link syntax that the serializer's esc() over-escapes.
  // \[\](url) → [](url)  — empty-text links (user placeholder)
  // \[text\](url) → [text](url) — literal link syntax typed as text
  // This is safe: re-parsing produces the same ProseMirror doc (empty links →
  // literal text via our custom handler; non-empty links → link marks).
  result = result.replace(/\\\[([^\\\[\]]*)\\\]\(([^)]*)\)/g, '[$1]($2)');
  // Strip zero-width spaces used as cursor targets after inline code marks.
  // These are inserted by the inline-code-convert plugin so WebKit can
  // position the caret outside <code> elements at textblock boundaries.
  result = result.replace(/\u200B/g, '');
  return result;
}

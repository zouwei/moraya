/**
 * Typst source-text editing primitives (v0.46.0).
 *
 * The Typst editor is a plain textarea over a compiler — there is no
 * ProseMirror document to run commands against. To make the shared menu items
 * and shortcuts (Heading 1-6, Bold, Italic, …) work identically in both
 * document flavors, each shared action gets a Typst counterpart here that
 * rewrites the source text + selection.
 *
 * Every command is a PURE function `(TextSel) => TextSel`, which keeps the
 * markup rules unit-testable without a DOM and makes this module trivial to
 * lift into `@moraya/core/typst` when the alignment is extended to Web /
 * Mobile (same path the export pipeline took into `@moraya/core/export`).
 *
 * Syntax emitted matches the markdown→Typst converter in `@moraya/core/convert`
 * so a document keeps the same shape whichever way it was authored:
 *   heading      `= ` … `====== `      bold        `*text*`
 *   italic       `_text_`              strike      `#strike[text]`
 *   inline code  `` `text` ``          link        `#link("url")[text]`
 *   image        `#image("src")`       figure      `#figure(…, caption: […])`
 *   bullet list  `- `                  ordered     `+ `
 *   code block   ``` fence             math block  `$ … $`
 *   quote        `#quote(block: true)[…]`          rule  `#line(length: 100%)`
 *   table        `#table(columns: n, [..], …)`
 */

/** Editable text plus the current selection range (caret when start === end). */
export interface TextSel {
  text: string;
  start: number;
  end: number;
}

/** Characters that carry meaning in Typst markup and must be escaped in content. */
const TYPST_SPECIAL = /[\\#*_`$<>@[\]]/g;

/** Escape user-supplied text for safe embedding in Typst content (`[…]`). */
export function escapeTypst(text: string): string {
  return text.replace(TYPST_SPECIAL, (c) => `\\${c}`);
}

/** Escape a string for a Typst string literal (`"…"`). */
function quoteTypst(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ── line helpers ─────────────────────────────────────────────────────────────

/** Start offset of the line containing `pos`. */
function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
}

/** End offset (exclusive of the newline) of the line containing `pos`. */
function lineEnd(text: string, pos: number): number {
  const nl = text.indexOf('\n', pos);
  return nl === -1 ? text.length : nl;
}

/**
 * Expand a selection to whole lines, then map over them.
 *
 * The returned selection covers the rewritten block so a follow-up command
 * (or the user) keeps operating on the same logical lines.
 */
function mapLines(s: TextSel, fn: (lines: string[]) => string[]): TextSel {
  const from = lineStart(s.text, s.start);
  const to = lineEnd(s.text, s.end);
  const block = s.text.slice(from, to);
  const replaced = fn(block.split('\n')).join('\n');
  return {
    text: s.text.slice(0, from) + replaced + s.text.slice(to),
    start: from,
    end: from + replaced.length,
  };
}

// ── inline wrap / unwrap ─────────────────────────────────────────────────────

/**
 * Toggle a symmetric inline delimiter around the selection.
 *
 * - Selection already wrapped (inside or including the delimiters) → unwrap.
 * - Otherwise wrap; an empty selection leaves the caret between the markers so
 *   typing continues inside the new mark.
 */
function toggleWrap(s: TextSel, open: string, close: string = open): TextSel {
  const { text, start, end } = s;
  const selected = text.slice(start, end);

  // Case 1: the delimiters are part of the selection — strip them.
  if (
    selected.length >= open.length + close.length &&
    selected.startsWith(open) &&
    selected.endsWith(close)
  ) {
    const inner = selected.slice(open.length, selected.length - close.length);
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      start,
      end: start + inner.length,
    };
  }

  // Case 2: the delimiters sit just outside the selection — strip them.
  const before = text.slice(Math.max(0, start - open.length), start);
  const after = text.slice(end, end + close.length);
  if (before === open && after === close) {
    const outerStart = start - open.length;
    return {
      text: text.slice(0, outerStart) + selected + text.slice(end + close.length),
      start: outerStart,
      end: outerStart + selected.length,
    };
  }

  // Case 3: wrap.
  const wrapped = open + selected + close;
  return {
    text: text.slice(0, start) + wrapped + text.slice(end),
    // Empty selection → caret between the markers; otherwise keep the content
    // selected so a second invocation toggles back off.
    start: start + open.length,
    end: start + open.length + selected.length,
  };
}

/** Replace the selection with `replacement`, selecting the inserted text. */
function replaceSel(s: TextSel, replacement: string): TextSel {
  return {
    text: s.text.slice(0, s.start) + replacement + s.text.slice(s.end),
    start: s.start,
    end: s.start + replacement.length,
  };
}

/**
 * Insert a block construct on its own line(s).
 *
 * With a selection, the selected lines are REPLACED by the block — commands
 * like code/math block fold the selection into the construct's body, so the
 * original text must be consumed rather than left behind. With a bare caret the
 * block reuses a blank line, or opens a new one below so it never runs into
 * neighbouring content (Typst separates block-level content by blank lines).
 */
function insertBlock(s: TextSel, block: string): TextSel {
  const from = lineStart(s.text, s.start);
  const to = lineEnd(s.text, s.end);

  if (s.end > s.start) {
    return {
      text: s.text.slice(0, from) + block + s.text.slice(to),
      start: from,
      end: from + block.length,
    };
  }

  const currentLine = s.text.slice(from, to);
  // Reuse the current line when it is blank, otherwise open a new one below.
  const blankLine = currentLine.trim() === '';
  const anchor = blankLine ? from : to;
  const prefix = blankLine ? '' : '\n\n';
  const trailing = s.text.slice(blankLine ? to : anchor);
  const suffix = trailing.startsWith('\n') || trailing === '' ? '' : '\n';
  const inserted = prefix + block + suffix;
  return {
    text: s.text.slice(0, anchor) + inserted + trailing,
    start: anchor + prefix.length,
    end: anchor + prefix.length + block.length,
  };
}

// ── inline commands ──────────────────────────────────────────────────────────

/** `*bold*` */
export function toggleBold(s: TextSel): TextSel {
  return toggleWrap(s, '*');
}

/** `_italic_` */
export function toggleItalic(s: TextSel): TextSel {
  return toggleWrap(s, '_');
}

/** `#strike[struck]` */
export function toggleStrike(s: TextSel): TextSel {
  return toggleWrap(s, '#strike[', ']');
}

/** `` `code` `` */
export function toggleInlineCode(s: TextSel): TextSel {
  return toggleWrap(s, '`');
}

/**
 * `#link("href")[label]` — the selection becomes the label.
 *
 * With no `href` the caret is placed inside the empty URL string so the user
 * can type it immediately.
 */
export function insertLink(s: TextSel, href = ''): TextSel {
  const label = s.text.slice(s.start, s.end);
  const call = `#link(${quoteTypst(href)})[${label}]`;
  const out = replaceSel(s, call);
  if (href === '') {
    // Caret inside the quotes: `#link("|")[label]`
    const caret = s.start + '#link("'.length;
    return { ...out, start: caret, end: caret };
  }
  return out;
}

/**
 * `#image("src")`, or `#figure(image("src"), caption: [alt])` when `alt` is given.
 *
 * The `#` only switches markup mode into code mode. Inside `#figure(…)` the
 * arguments are ALREADY code, so a nested `#image(…)` is a syntax error there
 * ("the character `#` is not valid in code") — the call must be bare.
 */
export function insertImage(s: TextSel, src: string, alt?: string): TextSel {
  const call = `image(${quoteTypst(src)})`;
  const markup = alt
    ? `#figure(${call}, caption: [${escapeTypst(alt)}])`
    : `#${call}`;
  return replaceSel(s, markup);
}

// ── block commands ───────────────────────────────────────────────────────────

/** Existing Typst heading prefix, e.g. `== `. */
const HEADING_RE = /^(\s*)(=+)\s+/;

/**
 * `= Heading` … `====== Heading` (level 1-6).
 *
 * Re-applying the level a line already has strips the markup (same toggle
 * behavior as the markdown editor's `setHeading`).
 */
export function setHeading(s: TextSel, level: number): TextSel {
  const marker = '='.repeat(Math.min(Math.max(Math.round(level), 1), 6));
  return mapLines(s, (lines) =>
    lines.map((line) => {
      const m = HEADING_RE.exec(line);
      if (m && m[2] === marker) return m[1] + line.slice(m[0].length); // toggle off
      const indent = m ? m[1] : /^\s*/.exec(line)?.[0] ?? '';
      const body = m ? line.slice(m[0].length) : line.slice(indent.length);
      return `${indent}${marker} ${body}`;
    }),
  );
}

/** Toggle a line-prefix list marker (`- ` bullet, `+ ` ordered). */
function toggleListMarker(s: TextSel, marker: '-' | '+'): TextSel {
  const prefix = `${marker} `;
  const anyMarker = /^(\s*)([-+])\s+/;
  return mapLines(s, (lines) => {
    // Only treat the block as "already this list" when every non-blank line is.
    const meaningful = lines.filter((l) => l.trim() !== '');
    const allSame =
      meaningful.length > 0 &&
      meaningful.every((l) => {
        const m = anyMarker.exec(l);
        return m?.[2] === marker;
      });
    return lines.map((line) => {
      if (line.trim() === '') return line;
      const m = anyMarker.exec(line);
      if (allSame && m) return m[1] + line.slice(m[0].length); // toggle off
      const indent = m ? m[1] : /^\s*/.exec(line)?.[0] ?? '';
      const body = m ? line.slice(m[0].length) : line.slice(indent.length);
      return `${indent}${prefix}${body}`;
    });
  });
}

/** `- item` */
export function toggleBulletList(s: TextSel): TextSel {
  return toggleListMarker(s, '-');
}

/** `+ item` (Typst numbers ordered lists automatically). */
export function toggleOrderedList(s: TextSel): TextSel {
  return toggleListMarker(s, '+');
}

/**
 * `#quote(block: true)[…]` around the selected lines; re-running unwraps.
 */
export function toggleQuote(s: TextSel): TextSel {
  const from = lineStart(s.text, s.start);
  const to = lineEnd(s.text, s.end);
  const block = s.text.slice(from, to);
  const QUOTE_RE = /^#quote\(block:\s*true\)\[([\s\S]*)\]$/;
  const m = QUOTE_RE.exec(block.trim());
  if (m) {
    const inner = m[1].trim();
    return {
      text: s.text.slice(0, from) + inner + s.text.slice(to),
      start: from,
      end: from + inner.length,
    };
  }
  const quoted = `#quote(block: true)[${block.trim()}]`;
  return {
    text: s.text.slice(0, from) + quoted + s.text.slice(to),
    start: from,
    end: from + quoted.length,
  };
}

/** Fenced code block; the selection becomes its body. */
export function insertCodeBlock(s: TextSel, lang = ''): TextSel {
  const body = s.text.slice(s.start, s.end);
  const block = `\`\`\`${lang}\n${body}\n\`\`\``;
  const out = insertBlock(s, block);
  // Put the caret on the (possibly empty) body line.
  const caret = out.start + `\`\`\`${lang}\n`.length + body.length;
  return { ...out, start: caret - body.length, end: caret };
}

/** Display math `$ … $` (Typst uses spaces inside `$` to mean block math). */
export function insertMathBlock(s: TextSel): TextSel {
  const body = s.text.slice(s.start, s.end);
  const block = `$ ${body} $`;
  const out = insertBlock(s, block);
  const caret = out.start + '$ '.length;
  return { ...out, start: caret, end: caret + body.length };
}

/** `#line(length: 100%)` on its own line. */
export function insertHorizontalRule(s: TextSel): TextSel {
  return insertBlock(s, '#line(length: 100%)');
}

/** `#table(columns: n, …)` with empty cells. */
export function insertTable(s: TextSel, rows = 3, cols = 3): TextSel {
  const bodyRows: string[] = [];
  for (let r = 0; r < Math.max(1, rows); r++) {
    bodyRows.push(`  ${Array.from({ length: Math.max(1, cols) }, () => '[]').join(', ')},`);
  }
  const block = `#table(\n  columns: ${Math.max(1, cols)},\n${bodyRows.join('\n')}\n)`;
  return insertBlock(s, block);
}

/** Raw text insertion (AI output, cloud-media markup, …). */
export function insertText(s: TextSel, text: string): TextSel {
  return replaceSel(s, text);
}

// ── action dispatch ──────────────────────────────────────────────────────────

/**
 * One shared action vocabulary for the flavor-aware menu/shortcut dispatcher:
 * `+page.svelte` names an action, the markdown path runs the matching
 * ProseMirror command and the Typst path resolves it here.
 */
export type TypstAction =
  | { type: 'heading'; level: number }
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'inlineCode' }
  | { type: 'link'; href?: string }
  | { type: 'image'; src: string; alt?: string }
  | { type: 'bulletList' }
  | { type: 'orderedList' }
  | { type: 'quote' }
  | { type: 'codeBlock'; lang?: string }
  | { type: 'mathBlock' }
  | { type: 'horizontalRule' }
  | { type: 'table'; rows?: number; cols?: number }
  | { type: 'insertText'; text: string };

/** Resolve an action against a text/selection state. Pure. */
export function applyTypstAction(s: TextSel, action: TypstAction): TextSel {
  switch (action.type) {
    case 'heading':        return setHeading(s, action.level);
    case 'bold':           return toggleBold(s);
    case 'italic':         return toggleItalic(s);
    case 'strike':         return toggleStrike(s);
    case 'inlineCode':     return toggleInlineCode(s);
    case 'link':           return insertLink(s, action.href);
    case 'image':          return insertImage(s, action.src, action.alt);
    case 'bulletList':     return toggleBulletList(s);
    case 'orderedList':    return toggleOrderedList(s);
    case 'quote':          return toggleQuote(s);
    case 'codeBlock':      return insertCodeBlock(s, action.lang);
    case 'mathBlock':      return insertMathBlock(s);
    case 'horizontalRule': return insertHorizontalRule(s);
    case 'table':          return insertTable(s, action.rows, action.cols);
    case 'insertText':     return insertText(s, action.text);
  }
}

import { describe, it, expect } from 'vitest';
import {
  escapeTypst,
  toggleBold,
  toggleItalic,
  toggleStrike,
  toggleInlineCode,
  insertLink,
  insertImage,
  setHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleQuote,
  insertCodeBlock,
  insertMathBlock,
  insertHorizontalRule,
  insertTable,
  type TextSel,
} from './typst-commands';

/** Build a TextSel from a string with `|` marking the caret, or `[..]` a range. */
function sel(text: string, start: number, end = start): TextSel {
  return { text, start, end };
}

/** Render a result as `text` with the selection shown as «…» for readable assertions. */
function show(s: TextSel): string {
  return s.text.slice(0, s.start) + '«' + s.text.slice(s.start, s.end) + '»' + s.text.slice(s.end);
}

describe('escapeTypst', () => {
  it('escapes Typst markup characters', () => {
    expect(escapeTypst('a*b_c#d')).toBe('a\\*b\\_c\\#d');
  });
  it('leaves plain text (incl. CJK) untouched', () => {
    expect(escapeTypst('中文 text 123')).toBe('中文 text 123');
  });
});

describe('inline marks', () => {
  it('bold wraps the selection with single asterisks', () => {
    expect(show(toggleBold(sel('hello world', 0, 5)))).toBe('*«hello»* world');
  });

  it('bold with an empty selection leaves the caret between the markers', () => {
    const out = toggleBold(sel('ab', 1));
    expect(out.text).toBe('a**b');
    expect(out.start).toBe(2);
    expect(out.end).toBe(2);
  });

  it('bold unwraps when the delimiters are inside the selection', () => {
    expect(show(toggleBold(sel('*hello*', 0, 7)))).toBe('«hello»');
  });

  it('bold unwraps when the delimiters sit just outside the selection', () => {
    expect(show(toggleBold(sel('*hello*', 1, 6)))).toBe('«hello»');
  });

  it('italic uses underscores (Typst emphasis)', () => {
    expect(show(toggleItalic(sel('hi', 0, 2)))).toBe('_«hi»_');
  });

  it('strike uses the #strike[..] function', () => {
    expect(show(toggleStrike(sel('gone', 0, 4)))).toBe('#strike[«gone»]');
  });

  it('strike toggles back off', () => {
    const once = toggleStrike(sel('gone', 0, 4));
    expect(toggleStrike(once).text).toBe('gone');
  });

  it('inline code uses backticks', () => {
    expect(show(toggleInlineCode(sel('x', 0, 1)))).toBe('`«x»`');
  });
});

describe('insertLink', () => {
  it('wraps the selection as the link label', () => {
    expect(insertLink(sel('docs', 0, 4), 'https://a.b').text).toBe('#link("https://a.b")[docs]');
  });

  it('places the caret inside the empty URL when no href is given', () => {
    const out = insertLink(sel('docs', 0, 4));
    expect(out.text).toBe('#link("")[docs]');
    expect(out.text.slice(out.start, out.start + 2)).toBe('")');
    expect(out.start).toBe(out.end);
  });

  it('escapes quotes in the href', () => {
    expect(insertLink(sel('', 0, 0), 'a"b').text).toBe('#link("a\\"b")[]');
  });
});

describe('insertImage', () => {
  it('emits a bare #image call without alt text', () => {
    expect(insertImage(sel('', 0), 'pic.png').text).toBe('#image("pic.png")');
  });

  it('wraps in #figure with an escaped caption when alt is given', () => {
    expect(insertImage(sel('', 0), 'p.png', 'a*b').text).toBe(
      '#figure(#image("p.png"), caption: [a\\*b])',
    );
  });
});

describe('setHeading', () => {
  it('prefixes the current line with = markers', () => {
    expect(setHeading(sel('Title', 2), 1).text).toBe('= Title');
    expect(setHeading(sel('Title', 2), 3).text).toBe('=== Title');
  });

  it('clamps the level to 1..6', () => {
    expect(setHeading(sel('T', 0), 9).text).toBe('====== T');
    expect(setHeading(sel('T', 0), 0).text).toBe('= T');
  });

  it('replaces an existing heading level', () => {
    expect(setHeading(sel('== Section', 4), 4).text).toBe('==== Section');
  });

  it('toggles off when the line already has that level', () => {
    expect(setHeading(sel('=== Deep', 5), 3).text).toBe('Deep');
  });

  it('applies to every line in a multi-line selection', () => {
    expect(setHeading(sel('one\ntwo', 0, 7), 2).text).toBe('== one\n== two');
  });

  it('preserves leading indentation', () => {
    expect(setHeading(sel('  Indented', 4), 2).text).toBe('  == Indented');
  });

  it('only touches the selected line in a larger document', () => {
    const doc = 'first\nsecond\nthird';
    expect(setHeading(sel(doc, 7), 1).text).toBe('first\n= second\nthird');
  });
});

describe('lists', () => {
  it('bullet list prefixes lines with "- "', () => {
    expect(toggleBulletList(sel('a\nb', 0, 3)).text).toBe('- a\n- b');
  });

  it('ordered list uses Typst "+ " markers', () => {
    expect(toggleOrderedList(sel('a\nb', 0, 3)).text).toBe('+ a\n+ b');
  });

  it('toggles a list off when every line already has the marker', () => {
    expect(toggleBulletList(sel('- a\n- b', 0, 7)).text).toBe('a\nb');
  });

  it('switches bullet → ordered rather than stacking markers', () => {
    expect(toggleOrderedList(sel('- a\n- b', 0, 7)).text).toBe('+ a\n+ b');
  });

  it('skips blank lines', () => {
    expect(toggleBulletList(sel('a\n\nb', 0, 4)).text).toBe('- a\n\n- b');
  });

  it('converts a mixed block to a uniform list instead of unwrapping', () => {
    expect(toggleBulletList(sel('- a\nplain', 0, 9)).text).toBe('- a\n- plain');
  });
});

describe('toggleQuote', () => {
  it('wraps the line in a block quote', () => {
    expect(toggleQuote(sel('cited', 0)).text).toBe('#quote(block: true)[cited]');
  });

  it('unwraps an existing block quote', () => {
    expect(toggleQuote(sel('#quote(block: true)[cited]', 0)).text).toBe('cited');
  });
});

describe('block inserts', () => {
  it('code block fences the selection and selects the body', () => {
    const out = insertCodeBlock(sel('let x = 1', 0, 9));
    expect(out.text).toBe('```\nlet x = 1\n```');
    expect(out.text.slice(out.start, out.end)).toBe('let x = 1');
  });

  it('code block honors a language tag', () => {
    expect(insertCodeBlock(sel('', 0), 'rust').text).toBe('```rust\n\n```');
  });

  it('math block uses spaced $ … $ (Typst display math)', () => {
    const out = insertMathBlock(sel('x^2', 0, 3));
    expect(out.text).toBe('$ x^2 $');
    expect(out.text.slice(out.start, out.end)).toBe('x^2');
  });

  it('horizontal rule emits #line', () => {
    expect(insertHorizontalRule(sel('', 0)).text).toBe('#line(length: 100%)');
  });

  it('opens a new line when the current one has content', () => {
    expect(insertHorizontalRule(sel('text', 4)).text).toBe('text\n\n#line(length: 100%)');
  });

  it('table emits #table with the requested shape', () => {
    expect(insertTable(sel('', 0), 2, 2).text).toBe(
      '#table(\n  columns: 2,\n  [], [],\n  [], [],\n)',
    );
  });

  it('table clamps degenerate dimensions to at least 1', () => {
    expect(insertTable(sel('', 0), 0, 0).text).toBe('#table(\n  columns: 1,\n  [],\n)');
  });
});

describe('selection bookkeeping', () => {
  it('keeps offsets inside the document for every command', () => {
    const doc = 'alpha\nbeta\ngamma';
    const cmds = [
      (s: TextSel) => toggleBold(s),
      (s: TextSel) => toggleItalic(s),
      (s: TextSel) => setHeading(s, 2),
      (s: TextSel) => toggleBulletList(s),
      (s: TextSel) => toggleQuote(s),
      (s: TextSel) => insertHorizontalRule(s),
      (s: TextSel) => insertTable(s),
    ];
    for (const cmd of cmds) {
      const out = cmd(sel(doc, 6, 10));
      expect(out.start).toBeGreaterThanOrEqual(0);
      expect(out.end).toBeLessThanOrEqual(out.text.length);
      expect(out.start).toBeLessThanOrEqual(out.end);
    }
  });
});

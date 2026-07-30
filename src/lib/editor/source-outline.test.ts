import { describe, it, expect } from 'vitest';
import { extractSourceHeadings } from './source-outline';

const texts = (md: string) => extractSourceHeadings(md).map(h => h.text);

describe('extractSourceHeadings', () => {
  it('extracts ATX headings with their level and line', () => {
    const md = '# One\n\ntext\n\n### Three';
    expect(extractSourceHeadings(md)).toEqual([
      { line: 0, level: 1, text: 'One' },
      { line: 4, level: 3, text: 'Three' },
    ]);
  });

  it('ignores # inside a fenced code block', () => {
    // The reported bug: `# 代码块内部` in a ```java block became an outline row.
    const md = ['# Real', '', '``` java', '# 代码块内部', '```', '', '## Also real'].join('\n');
    expect(texts(md)).toEqual(['Real', 'Also real']);
  });

  it('ignores # inside a tilde fence', () => {
    const md = ['# Real', '~~~python', '# not a heading', '~~~'].join('\n');
    expect(texts(md)).toEqual(['Real']);
  });

  it('does not let a tilde fence close a backtick fence', () => {
    // The naive `inFence = !inFence` toggle reopens here and leaks the rest.
    const md = ['```sh', '~~~', '# still code', '```', '# real'].join('\n');
    expect(texts(md)).toEqual(['real']);
  });

  it('treats a shorter fence inside a longer one as content', () => {
    const md = ['````md', '```', '# nested sample', '```', '````', '# real'].join('\n');
    expect(texts(md)).toEqual(['real']);
  });

  it('does not close a fence on a line that has an info string', () => {
    const md = ['```sh', '``` still code', '# code', '```', '# real'].join('\n');
    expect(texts(md)).toEqual(['real']);
  });

  it('handles an unterminated fence by swallowing the rest', () => {
    const md = ['# real', '```sh', '# code', '# more code'].join('\n');
    expect(texts(md)).toEqual(['real']);
  });

  it('allows up to three spaces of fence indent', () => {
    const md = ['   ```sh', '   # code', '   ```', '# real'].join('\n');
    expect(texts(md)).toEqual(['real']);
  });

  it('skips YAML frontmatter comments', () => {
    const md = ['---', 'title: X', '# a yaml comment', '---', '# real'].join('\n');
    expect(texts(md)).toEqual(['real']);
  });

  it('only treats leading --- as frontmatter', () => {
    const md = ['# real', '', '---', '# after a rule'].join('\n');
    expect(texts(md)).toEqual(['real', 'after a rule']);
  });

  it('strips a closing hash sequence', () => {
    expect(texts('## Title ##')).toEqual(['Title']);
  });

  it('requires whitespace after the hashes', () => {
    expect(texts('#NotAHeading\n# Yes')).toEqual(['Yes']);
  });

  it('does not read inline double-backtick code as a fence', () => {
    const md = ['# real', 'text with ``a `b` c`` inline', '## also real'].join('\n');
    expect(texts(md)).toEqual(['real', 'also real']);
  });

  it('returns nothing for empty input', () => {
    expect(extractSourceHeadings('')).toEqual([]);
  });
});

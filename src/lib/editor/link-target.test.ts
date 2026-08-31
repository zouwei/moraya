import { describe, it, expect } from 'vitest';
import { resolveLinkTarget } from './link-target';

const HERE = '/Users/me/kb/notes/alpha.md';

describe('resolveLinkTarget', () => {
  it('ignores nothing-links', () => {
    expect(resolveLinkTarget('', HERE)).toBeNull();
    expect(resolveLinkTarget('   ', HERE)).toBeNull();
    expect(resolveLinkTarget(null, HERE)).toBeNull();
    expect(resolveLinkTarget(undefined, HERE)).toBeNull();
    expect(resolveLinkTarget('#', HERE)).toBeNull();
  });

  it('reads a bare fragment as a same-document jump', () => {
    expect(resolveLinkTarget('#section-two', HERE)).toEqual({ kind: 'anchor', id: 'section-two' });
  });

  it('sends real URLs to the OS untouched', () => {
    for (const href of [
      'https://example.com/a?b=c#d',
      'http://example.com',
      'mailto:someone@example.com',
      'obsidian://open?vault=x',
    ]) {
      expect(resolveLinkTarget(href, HERE)).toEqual({ kind: 'external', href });
    }
  });

  it('opens a sibling markdown file as a document', () => {
    expect(resolveLinkTarget('beta.md', HERE)).toEqual({
      kind: 'document',
      path: '/Users/me/kb/notes/beta.md',
    });
  });

  it('walks up out of the current directory', () => {
    expect(resolveLinkTarget('../index.md', HERE)).toEqual({
      kind: 'document',
      path: '/Users/me/kb/index.md',
    });
    expect(resolveLinkTarget('../../top.md', HERE)).toEqual({
      kind: 'document',
      path: '/Users/me/top.md',
    });
  });

  it('collapses redundant segments', () => {
    expect(resolveLinkTarget('./sub/./deep/../beta.md', HERE)).toEqual({
      kind: 'document',
      path: '/Users/me/kb/notes/sub/beta.md',
    });
  });

  it('never climbs above the root', () => {
    const t = resolveLinkTarget('../../../../../../etc/passwd.md', HERE);
    expect(t).toEqual({ kind: 'document', path: '/etc/passwd.md' });
  });

  it('recognises every document extension, case-insensitively', () => {
    for (const name of ['b.md', 'b.MARKDOWN', 'b.mdown', 'b.mkd', 'b.mdx', 'b.typ']) {
      expect(resolveLinkTarget(name, HERE)?.kind).toBe('document');
    }
  });

  it('hands non-document files to the OS, resolved to an absolute path', () => {
    expect(resolveLinkTarget('report.pdf', HERE)).toEqual({
      kind: 'external',
      href: '/Users/me/kb/notes/report.pdf',
    });
    expect(resolveLinkTarget('../assets/shot.png', HERE)).toEqual({
      kind: 'external',
      href: '/Users/me/kb/assets/shot.png',
    });
  });

  it('accepts an absolute path with no current file', () => {
    expect(resolveLinkTarget('/tmp/x.md', null)).toEqual({ kind: 'document', path: '/tmp/x.md' });
  });

  it('gives up on a relative path in an unsaved document', () => {
    // Nothing to resolve against — pass it through rather than inventing a
    // base directory and opening the wrong file.
    expect(resolveLinkTarget('beta.md', null)).toEqual({ kind: 'external', href: 'beta.md' });
  });

  it('unwraps file:// URLs', () => {
    expect(resolveLinkTarget('file:///Users/me/kb/notes/beta.md', HERE)).toEqual({
      kind: 'document',
      path: '/Users/me/kb/notes/beta.md',
    });
  });

  it('decodes percent-escapes in file:// URLs', () => {
    expect(resolveLinkTarget('file:///Users/me/my%20notes/beta.md', HERE)).toEqual({
      kind: 'document',
      path: '/Users/me/my notes/beta.md',
    });
  });

  it('strips a query or fragment before judging the extension', () => {
    expect(resolveLinkTarget('beta.md#heading', HERE)).toEqual({
      kind: 'document',
      path: '/Users/me/kb/notes/beta.md',
    });
  });

  it('does not mistake a Windows drive letter for a URL scheme', () => {
    const t = resolveLinkTarget('C:\\kb\\beta.md', 'C:\\kb\\alpha.md');
    expect(t).toEqual({ kind: 'document', path: 'C:/kb/beta.md' });
  });

  it('resolves a relative link against a Windows current file', () => {
    expect(resolveLinkTarget('sub\\beta.md', 'C:\\kb\\alpha.md')).toEqual({
      kind: 'document',
      path: 'C:/kb/sub/beta.md',
    });
  });
});

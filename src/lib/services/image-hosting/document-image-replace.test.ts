import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '$lib/editor/schema';
import { parseMarkdown, serializeMarkdown } from '$lib/editor/markdown';
import { replaceDocumentImageUrl } from './document-image-replace';

describe('replaceDocumentImageUrl', () => {
  it('replaces all matching markdown images without changing other images', () => {
    const oldUrl = 'https://example.com/old.png';
    const state = EditorState.create({ schema, doc: parseMarkdown(`![](${oldUrl})\n\n![](${oldUrl})\n\n![](https://example.com/other.png)`) });
    const { transaction } = replaceDocumentImageUrl(state, oldUrl, 'https://host.test/new.png');

    expect(serializeMarkdown(transaction.doc)).not.toContain(oldUrl);
  });

  it('does not claim a replacement when the source is absent', () => {
    const state = EditorState.create({ schema, doc: parseMarkdown('![](https://example.com/a.png)') });
    const { count } = replaceDocumentImageUrl(state, 'https://example.com/missing.png', 'https://host.test/new.png');

    expect(count).toBe(0);
  });

  it('replaces an HTML image source', () => {
    const state = EditorState.create({ schema, doc: parseMarkdown('<img src="https://example.com/old.png" alt="cover">') });
    const { transaction } = replaceDocumentImageUrl(state, 'https://example.com/old.png', 'https://host.test/new.png');

    expect(serializeMarkdown(transaction.doc)).toContain('src="https://host.test/new.png"');
  });
});

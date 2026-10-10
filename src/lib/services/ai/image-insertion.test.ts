import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '@moraya/core';
import { insertGeneratedImagesIntoMarkdown } from './image-insertion';

describe('generated image insertion', () => {
  it('keeps heading and body block types when inserting after paragraphs', () => {
    const source = [
      '## Section title',
      'First body paragraph.',
      '',
      'Second body paragraph.',
      '',
      '```prompt',
      'An illustration',
      '```',
    ].join('\n');

    const result = insertGeneratedImagesIntoMarkdown(source, [
      { url: 'https://example.com/one.png', target: 0 },
      { url: 'https://example.com/two.png', target: 1 },
    ], 'paragraph');
    const blocks = parseMarkdown(result).content.content;

    expect(blocks.filter(block => block.type.name === 'heading').map(block => block.textContent)).toEqual(['Section title']);
    expect(blocks.filter(block => block.type.name === 'paragraph').map(block => block.textContent)).toContain('First body paragraph.');
    expect(blocks.filter(block => block.type.name === 'paragraph').map(block => block.textContent)).toContain('Second body paragraph.');
  });

  it('keeps the body a paragraph when a prompt block sat between it and a heading', () => {
    const source = '## Section title\n```prompt\nAn illustration\n```\nBody text.';

    const result = insertGeneratedImagesIntoMarkdown(source, [
      { url: 'https://example.com/image.png', target: 0 },
    ], 'paragraph');
    const blocks = parseMarkdown(result).content.content;

    expect(blocks.some(block => block.type.name === 'paragraph' && block.textContent === 'Body text.')).toBe(true);
    expect(result).not.toContain('```prompt');
  });

  it('replaces an existing image without changing nearby headings', () => {
    const source = '## Section title\n\nBody text.\n\n![](old.png)';

    const result = insertGeneratedImagesIntoMarkdown(source, [
      { url: 'https://example.com/new.png', target: 0 },
    ], 'replace');

    expect(result).toContain('![](https://example.com/new.png)');
    expect(result).toContain('## Section title\n\nBody text.');
  });

  it('appends images after the article', () => {
    const result = insertGeneratedImagesIntoMarkdown('## Section title\n\nBody text.', [
      { url: 'https://example.com/new.png', target: 0 },
    ], 'end');

    expect(result).toContain('Body text.\n\n![](https://example.com/new.png)');
  });

  it('does not leave empty paragraphs where prompt blocks were removed', () => {
    const source = [
      '## First scene',
      '',
      'First body paragraph.',
      '',
      '```prompt',
      'First image prompt',
      '```',
      '',
      '---',
      '',
      '## Second scene',
      '',
      'Second body paragraph.',
      '',
      '```prompt',
      'Second image prompt',
      '```',
      '',
      '---',
    ].join('\n');

    const result = insertGeneratedImagesIntoMarkdown(source, [
      { url: 'https://example.com/one.png', target: 1 },
      { url: 'https://example.com/two.png', target: 5 },
    ], 'paragraph');

    expect(parseMarkdown(result).content.content.filter(block => block.type.name === 'paragraph' && block.content.size === 0)).toHaveLength(0);
  });
});

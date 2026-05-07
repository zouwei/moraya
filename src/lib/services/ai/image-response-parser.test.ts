import { describe, it, expect } from 'vitest';
import { extractOpenAICompatImageUrl } from './image-response-parser';

describe('extractOpenAICompatImageUrl', () => {
  it('parses OpenAI standard { data: [{ url }] }', () => {
    const r = extractOpenAICompatImageUrl({ data: [{ url: 'https://cdn.example.com/a.png' }] });
    expect(r).toBe('https://cdn.example.com/a.png');
  });

  it('parses OpenAI b64 { data: [{ b64_json }] } as data URI', () => {
    const r = extractOpenAICompatImageUrl({ data: [{ b64_json: 'AAAA' }] });
    expect(r).toBe('data:image/png;base64,AAAA');
  });

  it('parses aggregator { data: [{ image_url }] }', () => {
    const r = extractOpenAICompatImageUrl({ data: [{ image_url: 'https://x/y.jpg' }] });
    expect(r).toBe('https://x/y.jpg');
  });

  it('parses aggregator { data: [{ image }] }', () => {
    const r = extractOpenAICompatImageUrl({ data: [{ image: 'https://x/y.jpg' }] });
    expect(r).toBe('https://x/y.jpg');
  });

  it('parses DashScope multimodal passthrough (z-image-turbo via aggregator)', () => {
    const r = extractOpenAICompatImageUrl({
      output: {
        choices: [{ message: { content: [{ image: 'https://dashscope-result.oss/img.png' }] } }],
      },
    });
    expect(r).toBe('https://dashscope-result.oss/img.png');
  });

  it('parses DashScope task passthrough { output: { results: [{ url }] } }', () => {
    const r = extractOpenAICompatImageUrl({
      output: { results: [{ url: 'https://wanx.example/img.png' }] },
    });
    expect(r).toBe('https://wanx.example/img.png');
  });

  it('parses { images: [string] } shape', () => {
    const r = extractOpenAICompatImageUrl({ images: ['https://cdn/a.png'] });
    expect(r).toBe('https://cdn/a.png');
  });

  it('parses { images: [{ url }] } shape', () => {
    const r = extractOpenAICompatImageUrl({ images: [{ url: 'https://cdn/a.png' }] });
    expect(r).toBe('https://cdn/a.png');
  });

  it('parses flat { url } shape', () => {
    const r = extractOpenAICompatImageUrl({ url: 'https://cdn/a.png' });
    expect(r).toBe('https://cdn/a.png');
  });

  it('returns null when no recognized URL field is present', () => {
    expect(extractOpenAICompatImageUrl({ error: 'something' })).toBeNull();
    expect(extractOpenAICompatImageUrl({ data: [] })).toBeNull();
    expect(extractOpenAICompatImageUrl({ data: [{ irrelevant: 1 }] })).toBeNull();
  });

  it('ignores empty strings', () => {
    expect(extractOpenAICompatImageUrl({ data: [{ url: '' }] })).toBeNull();
    expect(extractOpenAICompatImageUrl({ url: '' })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(extractOpenAICompatImageUrl(null)).toBeNull();
    expect(extractOpenAICompatImageUrl('string')).toBeNull();
    expect(extractOpenAICompatImageUrl(undefined)).toBeNull();
  });

  it('prefers OpenAI standard over flat fallbacks when both are present', () => {
    const r = extractOpenAICompatImageUrl({
      data: [{ url: 'https://primary' }],
      url: 'https://fallback',
    });
    expect(r).toBe('https://primary');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./ai-service', () => ({ generateBaseUrlCandidates: vi.fn() }));
vi.mock('./providers', () => ({
  sendAIRequest: vi.fn(),
  openaiEndpoint: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { openaiEndpoint } from './providers';
import { extractImagePrompts, generateImage, hasUnimportedDocumentImagePrompts, testImageConnection, testImageConnectionWithResolve } from './image-service';
import type { ImageProviderConfig } from './types';

const config: ImageProviderConfig = {
  id: 'qwen-image-3-test',
  provider: 'qwen',
  baseURL: 'https://dashscope.aliyuncs.com',
  apiKey: '***',
  model: 'qwen-image-3.0',
  defaultRatio: '1:1',
  defaultSizeLevel: 'medium',
};

describe('document image prompts', () => {
  it('collects new prompt blocks alongside existing ones', () => {
    const before = '```prompt\nFirst image\n```\n\n```prompt\nSecond image\n```';
    const after = `${before}\n\n\`\`\`prompt\nThird image\n\`\`\``;

    expect(extractImagePrompts(after)?.map(item => item.prompt)).toEqual([
      'First image', 'Second image', 'Third image',
    ]);
  });

  it('shows import when the document adds a prompt', () => {
    const before = extractImagePrompts('```prompt\nFirst image\n```');
    const after = extractImagePrompts('```prompt\nFirst image\n```\n\n```prompt\nSecond image\n```');

    expect(hasUnimportedDocumentImagePrompts(after, before!)).toBe(true);
  });

  it('shows import after removing a document prompt', () => {
    const source = extractImagePrompts('```prompt\nFirst image\n```\n\n```prompt\nSecond image\n```');

    expect(hasUnimportedDocumentImagePrompts(source, source!.slice(1))).toBe(true);
  });

  it('shows import after removing the last document prompt', () => {
    const source = extractImagePrompts('```prompt\nFirst image\n```');

    expect(hasUnimportedDocumentImagePrompts(source, [])).toBe(true);
  });

  it('shows import after editing one prompt', () => {
    const source = extractImagePrompts('```prompt\nFirst image\n```');

    expect(hasUnimportedDocumentImagePrompts(source, [{ ...source![0], prompt: 'Edited image' }])).toBe(true);
  });

  it('hides import when all document prompts are present', () => {
    const source = extractImagePrompts('```prompt\nFirst image\n```');

    expect(hasUnimportedDocumentImagePrompts(source, source!)).toBe(false);
  });

  it('hides import when the document has no prompt blocks', () => {
    expect(hasUnimportedDocumentImagePrompts(null, [])).toBe(false);
  });
});

describe('Qwen Image 3.0 routing', () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); });

  it('rejects an unrelated 400 and does not probe legacy endpoints', async () => {
    vi.mocked(invoke).mockImplementation(() => { throw new Error('API error (400): invalid model'); });

    const result = await testImageConnection(config);

    expect(result.success).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({
      url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      apiKeyOverride: undefined,
    });
  });

  it('accepts the invalid-area response from the native endpoint', async () => {
    vi.mocked(invoke).mockImplementation(() => {
      throw new Error('API error (400): Image area must be between 262144 and 6553600 pixels. Got area=1.');
    });

    const result = await testImageConnectionWithResolve(config);

    expect(result.success).toBe(true);
    const body = JSON.parse((vi.mocked(invoke).mock.calls[0][1] as { body: string }).body);
    expect(body.parameters.size).toBe('1*1');
    expect(body.input.messages[0].content[0].text).toBe('test');
  });

  it('does not report a URL mismatch as a successful connection', async () => {
    vi.mocked(invoke).mockImplementation(() => { throw new Error('API error (400): url error, please check url!'); });

    const result = await testImageConnectionWithResolve(config);

    expect(result.success).toBe(false);
    expect(result.error).toContain('url error');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects the same URL mismatch for a custom compatible provider', async () => {
    vi.mocked(openaiEndpoint).mockReturnValue('https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations');
    vi.mocked(invoke).mockImplementation(() => { throw new Error('API error (400): url error, please check url!'); });

    const result = await testImageConnection({ ...config, provider: 'custom' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('url error');
  });

  it('generates through the native endpoint with the saved key', async () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({
      output: { choices: [{ message: { content: [{ image: 'https://example.com/image.png' }] } }] },
    }));

    const result = await generateImage(config, 'A mountain', '1024x1024');

    expect(result.url).toBe('https://example.com/image.png');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({
      url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      apiKeyOverride: undefined,
    });
    const body = JSON.parse((vi.mocked(invoke).mock.calls[0][1] as { body: string }).body);
    expect(body.parameters.size).toBe('1024*1024');
  });

  it('normalizes a compatible-mode base URL for Qwen Image 3.0 Pro', async () => {
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({
      output: { choices: [{ message: { content: [{ image: 'https://example.com/pro.png' }] } }] },
    }));

    const result = await generateImage({
      ...config,
      model: 'qwen-image-3.0-pro',
      baseURL: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    }, 'A mountain', '1024x1024');

    expect(result.url).toBe('https://example.com/pro.png');
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({
      url: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    });
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  createDefaultImageHostTarget,
  isImageHostTargetConfigured,
  PICORA_DEFAULT_API_URL,
  PICORA_DEFAULT_IMG_DOMAIN,
} from './types';
import { providers } from './providers';

const mockedInvoke = vi.mocked(invoke);

describe('isImageHostTargetConfigured', () => {
  it('rejects a missing target', () => {
    expect(isImageHostTargetConfigured(null)).toBe(false);
  });

  it('rejects an incomplete saved target', () => {
    expect(isImageHostTargetConfigured(createDefaultImageHostTarget('custom'))).toBe(false);
  });

  it('accepts a configured custom endpoint', () => {
    expect(isImageHostTargetConfigured({
      ...createDefaultImageHostTarget('custom'),
      customEndpoint: 'https://images.example/upload',
    })).toBe(true);
  });

  it('accepts a Picora key stored in the keychain', () => {
    expect(isImageHostTargetConfigured({
      ...createDefaultImageHostTarget('picora'),
      picoraKeyMigratedV069: true,
    })).toBe(true);
  });
});

describe('createDefaultImageHostTarget(picora)', () => {
  it('seeds Picora defaults', () => {
    const target = createDefaultImageHostTarget('picora');
    expect(target.provider).toBe('picora');
    expect(target.name).toBe('Picora');
    expect(target.autoUpload).toBe(true);
    expect(target.picoraApiUrl).toBe(PICORA_DEFAULT_API_URL);
    expect(target.picoraImgDomain).toBe(PICORA_DEFAULT_IMG_DOMAIN);
    expect(target.picoraApiKey).toBe('');
  });

  it('does not seed Picora fields for other providers', () => {
    const t = createDefaultImageHostTarget('custom');
    expect(t.name).toBe('');
    expect(t.autoUpload).toBe(false);
    expect(t.picoraApiKey).toBe('');
  });
});

describe('uploadToPicora', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('invokes upload_to_picora with the right shape', async () => {
    mockedInvoke.mockResolvedValueOnce('https://media.picora.me/abc.png');
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    Object.defineProperty(blob, 'name', { value: 'test.png' });
    const result = await providers.picora(blob, {
      ...createDefaultImageHostTarget('picora'),
      picoraApiKey: 'sk_live_abc',
    } as never);
    expect(result.url).toBe('https://media.picora.me/abc.png');
    expect(mockedInvoke).toHaveBeenCalledWith(
      'upload_to_picora',
      expect.objectContaining({
        apiUrl: PICORA_DEFAULT_API_URL,
        apiKey: 'sk_live_abc',
        mimeType: 'image/png',
      }),
    );
    const args = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(Array.isArray(args.fileBytes)).toBe(true);
    expect((args.fileBytes as number[]).slice(0, 3)).toEqual([1, 2, 3]);
    expect(args.filename).toMatch(/\.png$/);
  });

  it('rejects when not configured', async () => {
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    await expect(
      providers.picora(blob, { picoraApiUrl: '', picoraApiKey: '' } as never),
    ).rejects.toThrow(/not configured/i);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { saveGeneratedImage } from './generated-image-storage';

vi.mock('@tauri-apps/api/path', () => ({ appDataDir: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);
const mockedAppDataDir = vi.mocked(appDataDir);

describe('saveGeneratedImage', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedAppDataDir.mockReset();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it('saves next to a document and returns a relative image path', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const path = await saveGeneratedImage(blob, '/notes/article.md');

    expect(path).toMatch(/^images\/ai-[\w-]+\.png$/);
    expect(mockedInvoke).toHaveBeenCalledWith('write_file_binary', {
      path: `/notes/${path}`,
      base64Data: 'AQID',
    });
  });

  it('uses persistent app storage for an unsaved document', async () => {
    mockedAppDataDir.mockResolvedValue('/app/data/');
    const blob = new Blob([new Uint8Array([1])], { type: 'image/jpeg' });
    const path = await saveGeneratedImage(blob, null);

    expect(path).toMatch(/^\/app\/data\/image-cache\/ai-[\w-]+\.jpg$/);
  });

  it('accepts a Windows document path', async () => {
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    await saveGeneratedImage(blob, 'C:\\notes\\article.md');

    expect(mockedInvoke).toHaveBeenCalledWith('write_file_binary', expect.objectContaining({
      path: expect.stringMatching(/^C:\/notes\/images\/ai-[\w-]+\.png$/),
    }));
  });
});

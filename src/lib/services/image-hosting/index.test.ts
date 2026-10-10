import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchImageAsBlob } from './index';

describe('fetchImageAsBlob', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads generated data URLs in the webview', async () => {
    const browserFetch = vi.fn().mockResolvedValue(new Response(new Blob([new Uint8Array([1])], { type: 'image/png' })));
    vi.stubGlobal('fetch', browserFetch);

    await fetchImageAsBlob('data:image/png;base64,AQ==');

    expect(browserFetch).toHaveBeenCalledWith('data:image/png;base64,AQ==');
  });
});

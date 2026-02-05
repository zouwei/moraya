export type { ImageHostProvider, ImageHostConfig, UploadResult, GitHubCdnMode } from './types';
export { DEFAULT_IMAGE_HOST_CONFIG } from './types';
import type { ImageHostConfig, UploadResult } from './types';
import { providers } from './providers';

/**
 * Upload an image blob to the configured image hosting provider.
 */
export async function uploadImage(
  blob: Blob,
  config: ImageHostConfig,
): Promise<UploadResult> {
  const uploader = providers[config.provider];
  if (!uploader) {
    throw new Error(`Unknown image hosting provider: ${config.provider}`);
  }
  return uploader(blob, config);
}

/**
 * Fetch a blob URL and return the underlying Blob.
 */
export async function blobUrlToBlob(blobUrl: string): Promise<Blob> {
  const res = await fetch(blobUrl);
  return res.blob();
}

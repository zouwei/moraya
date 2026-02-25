export type { ImageHostProvider, ImageHostConfig, UploadResult, GitHubCdnMode, ImageHostTarget } from './types';
export { DEFAULT_IMAGE_HOST_CONFIG, generateImageHostTargetId, createDefaultImageHostTarget, targetToConfig, isObjectStorageProvider, isGitProvider } from './types';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
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

/**
 * Fetch any image URL and return it as a Blob.
 * Uses tauriFetch for remote URLs (bypasses CORS) and browser fetch for blob: URLs.
 */
export async function fetchImageAsBlob(src: string): Promise<Blob> {
  if (src.startsWith('blob:')) {
    const res = await fetch(src);
    return res.blob();
  }
  const res = await tauriFetch(src, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`Failed to fetch image: ${res.status}`);
  }
  return await res.blob();
}

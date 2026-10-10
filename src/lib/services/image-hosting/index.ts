export type { ImageHostProvider, ImageHostConfig, UploadResult, GitHubCdnMode, ImageHostTarget } from './types';
export {
  DEFAULT_IMAGE_HOST_CONFIG,
  generateImageHostTargetId,
  createDefaultImageHostTarget,
  targetToConfig,
  isObjectStorageProvider,
  isGitProvider,
  isImageHostTargetConfigured,
  PICORA_DEFAULT_API_URL,
  PICORA_DEFAULT_IMG_DOMAIN,
  PICORA_DEFAULT_API_BASE,
} from './types';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { ImageHostConfig, UploadResult } from './types';
import { providers } from './providers';

/**
 * Upload an image blob to the configured image hosting provider.
 * Retries once after 600ms on transient failures (e.g. tauriFetch cold-start).
 */
export async function uploadImage(
  blob: Blob,
  config: ImageHostConfig,
): Promise<UploadResult> {
  const uploader = providers[config.provider];
  if (!uploader) {
    throw new Error(`Unknown image hosting provider: ${config.provider}`);
  }
  try {
    return await uploader(blob, config);
  } catch (firstErr) {
    await new Promise<void>(resolve => setTimeout(resolve, 600));
    return uploader(blob, config);
  }
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
 * Uses tauriFetch for remote URLs (bypasses CORS) and browser fetch for local data/blob URLs.
 *
 * If the server returns a generic/missing Content-Type (e.g. `application/octet-stream`,
 * common for OSS-signed URLs), infer the image MIME from the URL extension so that
 * downstream uploads don't trip servers that reject non-image MIMEs with 415.
 */
export async function fetchImageAsBlob(src: string): Promise<Blob> {
  let blob: Blob;
  if (src.startsWith('blob:') || src.startsWith('data:')) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    blob = await res.blob();
  } else {
    const res = await tauriFetch(src, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Failed to fetch image: ${res.status}`);
    }
    blob = await res.blob();
  }
  return ensureImageMime(blob, src);
}

/** Re-tag a blob with a proper image MIME when the current type is missing or generic. */
function ensureImageMime(blob: Blob, src: string): Blob {
  const t = (blob.type || '').toLowerCase();
  if (t.startsWith('image/')) return blob;
  const inferred = mimeFromExtension(src);
  if (!inferred) return blob;
  return new Blob([blob], { type: inferred });
}

/** Infer an image MIME from the URL's path extension (ignores query string). */
function mimeFromExtension(src: string): string | null {
  // Strip query + fragment so we look only at the pathname
  const pathOnly = src.split('?')[0].split('#')[0];
  const dot = pathOnly.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = pathOnly.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg':  return 'image/svg+xml';
    case 'bmp':  return 'image/bmp';
    case 'ico':  return 'image/x-icon';
    case 'avif': return 'image/avif';
    case 'tif':
    case 'tiff': return 'image/tiff';
    case 'heic': return 'image/heic';
    default: return null;
  }
}

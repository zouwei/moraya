/**
 * Image compression and conversion utilities for AI vision input.
 * Resizes large images via Canvas and converts to base64 for API payloads.
 */

const MAX_DIMENSION = 1568; // Claude's recommended max edge length
const JPEG_QUALITY = 0.8;
const SIZE_THRESHOLD = 1 * 1024 * 1024; // 1MB — skip compression for small images

/**
 * Compress an image blob if it exceeds size/dimension limits.
 * - Long edge >maxDimension → Canvas resize
 * - Converts to JPEG at given quality (except GIFs, which are returned as-is)
 * - Small images within limits are returned unchanged
 */
export async function compressImage(
  blob: Blob,
  maxDimension = MAX_DIMENSION,
  quality = JPEG_QUALITY,
): Promise<{ blob: Blob; mimeType: string }> {
  // GIF: skip compression to preserve animation
  if (blob.type === 'image/gif') {
    return { blob, mimeType: blob.type };
  }

  const img = await loadImage(blob);
  const { width, height } = img;

  // If within both size and dimension limits, return as-is
  const needsResize = Math.max(width, height) > maxDimension;
  if (!needsResize && blob.size < SIZE_THRESHOLD) {
    return { blob, mimeType: blob.type };
  }

  // Calculate scaled dimensions
  let newWidth = width;
  let newHeight = height;
  if (needsResize) {
    const scale = maxDimension / Math.max(width, height);
    newWidth = Math.round(width * scale);
    newHeight = Math.round(height * scale);
  }

  // Draw to canvas and export as JPEG
  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, newWidth, newHeight);

  const compressed = await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b!), 'image/jpeg', quality);
  });

  return { blob: compressed, mimeType: 'image/jpeg' };
}

/**
 * Convert a Blob to a base64 string (without the `data:...;base64,` prefix).
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Strip the "data:...;base64," prefix
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

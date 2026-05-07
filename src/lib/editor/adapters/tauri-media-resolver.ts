/**
 * Tauri implementation of `MediaResolver` from `@moraya/core`.
 *
 * Routes:
 *   - `loadLocalImage(path)` → `invoke('read_file_binary', { path })` → Blob URL
 *   - `loadLocalMedia(path)` → same as image (Rust validate_path covers all)
 *   - `loadRemoteMedia(url)` → `@tauri-apps/plugin-http` fetch → Blob URL
 *
 * Maintains an internal cache of `path → blob:URL` so repeated renders
 * (NodeView re-creates / file switches back) don't re-IPC. Cache is
 * never invalidated within a session — blob URLs remain valid until the
 * window unloads.
 */

import { invoke } from '@tauri-apps/api/core'
import type { MediaResolver } from '@moraya/core'

const blobCache = new Map<string, string>()

/** MIME map for binary buffer → Blob conversion. Mirrors the moraya schema.ts table. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
}

const MEDIA_MIME: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', ogv: 'video/ogg',
  mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
  m4a: 'audio/mp4', oga: 'audio/ogg', opus: 'audio/opus', weba: 'audio/webm',
}

function pathExt(path: string): string {
  return path.split('.').pop()?.toLowerCase() || ''
}

function buildBlob(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes], { type: mime })
  return URL.createObjectURL(blob)
}

export class TauriMediaResolver implements MediaResolver {
  async loadLocalImage(absolutePath: string): Promise<string> {
    const cached = blobCache.get(absolutePath)
    if (cached) return cached
    try {
      const data = await invoke<number[]>('read_file_binary', { path: absolutePath })
      const bytes = new Uint8Array(data)
      const mime = IMAGE_MIME[pathExt(absolutePath)] || 'image/png'
      const url = buildBlob(bytes, mime)
      blobCache.set(absolutePath, url)
      return url
    } catch {
      // Per @moraya/core §4.5 contract: resolve a fallback URL,
      // never reject. The schema's onerror handler shows a "broken image"
      // icon when the empty resolution can't be applied.
      return ''
    }
  }

  async loadLocalMedia(absolutePath: string): Promise<string> {
    const cached = blobCache.get(absolutePath)
    if (cached) return cached
    try {
      const data = await invoke<number[]>('read_file_binary', { path: absolutePath })
      const bytes = new Uint8Array(data)
      const mime = MEDIA_MIME[pathExt(absolutePath)] || 'application/octet-stream'
      const url = buildBlob(bytes, mime)
      blobCache.set(absolutePath, url)
      return url
    } catch {
      return ''
    }
  }

  async loadRemoteMedia(url: string): Promise<string> {
    const cached = blobCache.get(url)
    if (cached) return cached
    try {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
      const resp = await tauriFetch(url)
      if (!resp.ok) {
        console.warn('[TauriMediaResolver] HTTP', resp.status, url)
        return url
      }
      const buffer = await resp.arrayBuffer()
      const contentType = resp.headers.get('content-type') || ''
      // Reject HTML responses (CDN expired URL → HTML error page)
      if (contentType.startsWith('text/html')) {
        console.warn('[TauriMediaResolver] CDN returned HTML instead of media:', url)
        return url
      }
      let mime = contentType
      if (!mime || mime === 'application/octet-stream') {
        mime = MEDIA_MIME[pathExt(url.split(/[?#]/)[0])] || 'application/octet-stream'
      }
      const blob = new Blob([buffer], { type: mime })
      const blobUrl = URL.createObjectURL(blob)
      blobCache.set(url, blobUrl)
      return blobUrl
    } catch (e) {
      console.warn('[TauriMediaResolver] fetch failed:', url, e)
      return url
    }
  }
}

export const tauriMediaResolver = new TauriMediaResolver()

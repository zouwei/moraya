/**
 * Tauri implementation of `LinkOpener` from `@moraya/core`.
 *
 * Routes by the href shape:
 *   - Local file path (absolute / relative / file://) → `plugin-opener.openPath`
 *   - HTTP(S) / mailto / etc. URL → `plugin-opener.openUrl`
 *
 * The core's editor-props-plugin already runs the relative-path resolution
 * via `Platform.getCurrentFilePath()` before calling `linkOpener.open(href)`,
 * so the href received here is always either an absolute file path, an
 * absolute URL, or a verbatim string the consumer can pass through unchanged.
 */

import type { LinkOpener } from '@moraya/core'

function isLocalFilePath(href: string): boolean {
  if (href.startsWith('/')) return true
  if (/^[A-Za-z]:[/\\]/.test(href)) return true
  if (href.startsWith('file://')) return true
  return false
}

export class TauriLinkOpener implements LinkOpener {
  open(href: string): void {
    if (isLocalFilePath(href)) {
      // Strip file:// prefix if present
      let path = href
      if (path.startsWith('file:///')) path = path.slice(7)
      else if (path.startsWith('file://')) path = path.slice(5)
      try { path = decodeURIComponent(path) } catch { /* keep */ }

      import('@tauri-apps/plugin-opener')
        .then(({ openPath }) => openPath(path))
        .catch((e) => { console.warn('[TauriLinkOpener] openPath failed:', path, e) })
    } else {
      import('@tauri-apps/plugin-opener')
        .then(({ openUrl }) => openUrl(href))
        .catch((e) => { console.warn('[TauriLinkOpener] openUrl failed:', href, e) })
    }
  }
}

export const tauriLinkOpener = new TauriLinkOpener()

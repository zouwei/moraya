/**
 * Platform detection utilities for Moraya.
 *
 * iPadOS Safari reports a macOS user agent by default,
 * so we use `navigator.maxTouchPoints > 1` to distinguish iPad from Mac.
 */

const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
const maxTouch = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;

/**
 * Dev-only override: set `?ipad=1` in URL to force iPad mode on desktop.
 * Example: http://localhost:5173/?ipad=1
 */
const forceIPad: boolean =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('ipad') === '1';

/** Running on iPadOS (Tauri iOS build or iPadOS Safari) */
export const isIPadOS: boolean =
  forceIPad || ua.includes('ipad') || (ua.includes('mac') && maxTouch > 1);

/** Running on any iOS device (iPad or iPhone) */
export const isIOS: boolean =
  isIPadOS || ua.includes('iphone') || /\biOS\b/i.test(ua);

/** Running on macOS desktop (excludes iPadOS) */
export const isMacOS: boolean = ua.includes('mac') && !isIPadOS;

/** Running on Windows */
export const isWindows: boolean = ua.includes('win');

/** Running on Linux (excludes Android) */
export const isLinux: boolean = ua.includes('linux') && !ua.includes('android');

/** Device has touch as primary input (no hover, coarse pointer) */
export const isTouchDevice: boolean =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || maxTouch > 0);

/** Running inside Tauri runtime (false in plain browser) */
export const isTauri: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Detect the CSS platform class for `document.body`.
 * Returns 'platform-ipados' | 'platform-macos' | 'platform-windows' | 'platform-linux'
 */
export function getPlatformClass(): string {
  if (isIPadOS) return 'platform-ipados';
  if (isMacOS) return 'platform-macos';
  if (isWindows) return 'platform-windows';
  return 'platform-linux';
}

/**
 * On iPadOS, detect if a virtual keyboard is visible by
 * comparing visualViewport height to window innerHeight.
 * When the software keyboard is up, visualViewport shrinks.
 *
 * Usage: call inside a visualViewport 'resize' listener.
 */
export function isVirtualKeyboardVisible(): boolean {
  if (!isIPadOS || typeof window === 'undefined') return false;
  const vv = window.visualViewport;
  if (!vv) return false;
  // The virtual keyboard typically takes >100px; use a threshold
  return window.innerHeight - vv.height > 100;
}

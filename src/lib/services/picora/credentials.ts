/**
 * Picora credentials helper — v0.69.0.
 *
 * Replaces direct reads of `ImageHostTarget.picoraApiKey` (plaintext in
 * Tauri Store, set in v0.33.0 — predates the v0.6.0 Keychain migration that
 * moved AI/speech/image-host secrets). All Picora-related call sites must
 * route their key lookup through `getPicoraApiKey()`.
 *
 * Storage layout:
 *   - Keychain key: `picora-api-key:{targetId}` (single-secret-per-target)
 *   - Backing store: AIProxyState.key_cache (shared with ai-key / speech-key)
 *
 * Backward compatibility:
 *   - Targets where `picoraApiKey` is still populated continue to work; reads
 *     prefer the inline value (legacy path) until startup migration moves it.
 *   - `setPicoraApiKey('', …)` deletes the keychain entry (sign-out path).
 *
 * NOT a service worker: cache is per-window; refreshes lazily on each call.
 */

import { invoke } from '@tauri-apps/api/core';
import type { ImageHostTarget, ImageHostConfig } from '$lib/services/image-hosting/types';
import { targetToConfig } from '$lib/services/image-hosting/types';

const KEY_PREFIX = 'picora-api-key:';

/** In-window memoization of resolved keys; avoids repeated keychain_get round-trips. */
const memCache = new Map<string, string>();

export function picoraKeychainKey(targetId: string): string {
  return `${KEY_PREFIX}${targetId}`;
}

/**
 * Derive the OAuth API base URL from a target's image-upload endpoint.
 *
 * `picoraApiUrl` is typed for v0.33-era image uploads (e.g.
 * `https://api.picora.me/v1/images`). The OAuth flow needs the host root.
 * Strip the documented `/v1/...` suffix; return `null` for an empty / missing
 * value so the Rust side falls through to its compiled-in default.
 *
 * Exported for tests; production callers should let `getPicoraApiKey()` use it.
 */
export function picoraOAuthApiBase(picoraApiUrl: string | undefined): string | null {
  if (!picoraApiUrl) return null;
  return picoraApiUrl.replace(/\/v1\/.*$/, '');
}

/**
 * Returns a Bearer credential for a Picora target. Resolution order:
 *
 *   1. OAuth (v0.69.0 Phase 2): if `target.picoraAuthRef.kind === 'oauth'`,
 *      invoke `picora_oauth_get_token` (auto-refreshes). NOT memoized — the
 *      Rust side already caches and refresh-rotates; double-caching would
 *      serve stale tokens.
 *   2. Legacy inline: if `target.picoraApiKey` is non-empty.
 *   3. Migrated API key: read from Keychain `picora-api-key:{id}`.
 *
 * Throws when the target has no usable credential (caller should surface a
 * clear "Picora not connected" or "API key not configured" message).
 */
export async function getPicoraApiKey(target: ImageHostTarget): Promise<string> {
  if (target.picoraAuthRef?.kind === 'oauth') {
    const token = await invoke<string | null>('picora_oauth_get_token', {
      apiBase: picoraOAuthApiBase(target.picoraApiUrl),
      accountId: target.picoraAuthRef.accountId,
    });
    if (!token) throw new Error('Picora session expired — please reconnect');
    return token;
  }
  if (target.picoraApiKey) return target.picoraApiKey;
  const cacheKey = picoraKeychainKey(target.id);
  const cached = memCache.get(cacheKey);
  if (cached) return cached;
  const val = await invoke<string | null>('keychain_get', { key: cacheKey });
  if (!val) throw new Error('Picora API key not configured');
  memCache.set(cacheKey, val);
  return val;
}

/**
 * Like `getPicoraApiKey` but returns empty string instead of throwing. Useful
 * for UI status checks (e.g. "Picora connected?") that don't need an error.
 */
export async function getPicoraApiKeyOrEmpty(target: ImageHostTarget): Promise<string> {
  try {
    return await getPicoraApiKey(target);
  } catch {
    return '';
  }
}

/**
 * Shown in an API-key input when a key is already stored. Never a real key:
 * saving the field unchanged must leave the stored key alone.
 */
export const PICORA_KEY_MASK = '************';

/**
 * Whether an API key is actually stored for this target (inline or in the
 * Keychain) — the `picoraKeyMigratedV069` flag alone does not prove the
 * Keychain entry still exists.
 */
export async function hasStoredPicoraApiKey(target: ImageHostTarget): Promise<boolean> {
  if (target.picoraApiKey) return true;
  try {
    return !!(await invoke<string | null>('keychain_get', { key: picoraKeychainKey(target.id) }));
  } catch {
    return false;
  }
}

/**
 * Write or delete a key for a target. Empty string deletes the keychain
 * entry. Updates the in-memory cache to match.
 */
export async function setPicoraApiKey(targetId: string, value: string): Promise<void> {
  const cacheKey = picoraKeychainKey(targetId);
  if (!value) {
    await invoke('keychain_delete', { key: cacheKey });
    memCache.delete(cacheKey);
    return;
  }
  await invoke('keychain_set', { key: cacheKey, value });
  memCache.set(cacheKey, value);
}

export interface MigrationReport {
  migrated: number;
  alreadyMigrated: number;
  skipped: number;
  errors: { targetId: string; error: string }[];
}

/**
 * One-shot startup migration. Returns a per-target verdict. Caller is
 * responsible for clearing `picoraApiKey` + setting `picoraKeyMigratedV069`
 * on each successfully migrated target.
 *
 * Idempotent — running twice is safe; targets already flagged
 * `picoraKeyMigratedV069: true` are counted as `alreadyMigrated`.
 */
export async function migratePicoraKeysToKeychain(
  targets: ImageHostTarget[],
): Promise<{ report: MigrationReport; migratedIds: string[] }> {
  const report: MigrationReport = { migrated: 0, alreadyMigrated: 0, skipped: 0, errors: [] };
  const migratedIds: string[] = [];

  for (const t of targets) {
    if (t.provider !== 'picora') {
      report.skipped++;
      continue;
    }
    if (t.picoraKeyMigratedV069) {
      report.alreadyMigrated++;
      continue;
    }
    if (!t.picoraApiKey) {
      report.skipped++;
      continue;
    }
    try {
      await setPicoraApiKey(t.id, t.picoraApiKey);
      report.migrated++;
      migratedIds.push(t.id);
    } catch (e) {
      report.errors.push({
        targetId: t.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { report, migratedIds };
}

/**
 * Async version of `targetToConfig`. For Picora targets it injects the
 * resolved key into `config.picoraApiKey` so downstream `uploadImage()` /
 * provider code can read it synchronously as before.
 *
 * Non-Picora targets are passed through `targetToConfig` unchanged (no
 * await round-trip).
 */
export async function targetToConfigAsync(target: ImageHostTarget): Promise<ImageHostConfig> {
  const config = targetToConfig(target);
  if (target.provider === 'picora' && !config.picoraApiKey) {
    config.picoraApiKey = await getPicoraApiKeyOrEmpty(target);
  }
  return config;
}

/** Test seam — clears the in-window cache. Production code does not need this. */
export function _clearPicoraCredentialCache(): void {
  memCache.clear();
}

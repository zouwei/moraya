import { invoke } from '@tauri-apps/api/core';
import type { PicoraKb, ManifestEntryWithDocId, SyncOp, SyncBatchResult } from './types';

/** Derive the Picora API base URL from the image upload URL. */
export function picoraApiBase(picoraApiUrl: string): string {
  // picoraApiUrl is like https://api.picora.me/v1/images
  // Strip the path component to get the base
  try {
    const u = new URL(picoraApiUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return picoraApiUrl.replace(/\/v1\/.*$/, '');
  }
}

/** List all Knowledge Bases for the authenticated user. */
export async function listKbs(apiBase: string, apiKey: string): Promise<PicoraKb[]> {
  return invoke<PicoraKb[]>('picora_kb_list', { apiBase, apiKey });
}

/** Create a new Knowledge Base on Picora. */
export async function createKb(
  apiBase: string,
  apiKey: string,
  name: string,
  slug?: string,
): Promise<PicoraKb> {
  return invoke<PicoraKb>('picora_kb_create', { apiBase, apiKey, name, slug: slug ?? null });
}

/**
 * Fetch the full manifest (all active docs) for a KB.
 *
 * Each entry carries the server-side `docId` (v1.22.0) — the key into the
 * doc-revisions API. Look it up FRESH per use: the server assigns a NEW doc
 * id on every content replacement (revisions re-attach automatically), so a
 * persisted docId goes stale after any upload.
 */
export async function fetchManifest(
  apiBase: string,
  apiKey: string,
  kbId: string,
): Promise<ManifestEntryWithDocId[]> {
  return invoke<ManifestEntryWithDocId[]>('picora_kb_manifest', { apiBase, apiKey, kbId });
}

/**
 * Batch upsert/delete docs in a KB. Returns the server's applied / conflicts /
 * skipped buckets (each item carries the server-side snapshot).
 */
export async function syncBatch(
  apiBase: string,
  apiKey: string,
  kbId: string,
  ops: SyncOp[],
): Promise<SyncBatchResult> {
  const res = await invoke<Partial<SyncBatchResult> | null>('picora_kb_sync_batch', { apiBase, apiKey, kbId, ops });
  return {
    applied: res?.applied ?? [],
    conflicts: res?.conflicts ?? [],
    skipped: res?.skipped ?? [],
  };
}

/** Fetch raw content of a single doc by relativePath. */
export async function fetchRaw(
  apiBase: string,
  apiKey: string,
  kbId: string,
  relativePath: string,
): Promise<string> {
  return invoke<string>('picora_kb_raw', { apiBase, apiKey, kbId, relativePath });
}

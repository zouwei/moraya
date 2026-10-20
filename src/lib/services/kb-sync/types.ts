// The generalized sync data contracts (manifest entries, diff result, line-
// merge shapes, conflict entry) now live in @moraya/core/sync (extracted in
// core v0.8.0 so PC / Web / Mobile share one contract). They are re-exported
// here so every existing `./types` import keeps working unchanged. The
// PC-specific orchestration types below (sync mode, KB bindings, sync reports,
// batch protocol) stay local — they describe the desktop runSync engine, not
// the shared merge core. `InitialAuthority` is intentionally re-exported from
// `./diff` (not here) to preserve the original module layout.
import type { ConflictEntry } from '@moraya/core/sync';

export type {
  ManifestEntry,
  LocalManifestEntry,
  LocalManifest,
  RemoteManifest,
  DiffAction,
  DiffResult,
  MergeChunk,
  MergeResult,
  ChunkPick,
  ConflictEntry,
  ConflictResolution,
} from '@moraya/core/sync';

// ── PC-specific orchestration types (desktop runSync engine) ─────────────────

/**
 * v1.22.0: the server manifest has always carried each entry's server-side
 * document id (`docId`) — the key into the doc-revisions API. Core's
 * ManifestEntry contract stays at 4 fields; PC extends it locally. Entries
 * flowing remote manifest → lastManifest carry it through persistence
 * (`~/.moraya/kb-sync/{kbId}.manifest.json`), giving relativePath → docId
 * for any KB that has synced at least once.
 */
export type ManifestEntryWithDocId = import('@moraya/core/sync').ManifestEntry & {
  docId?: string;
};

export type SyncMode = 'manual' | 'on-save' | 'interval' | 'on-startup-and-close';
export type SyncScope = 'markdown-only' | 'markdown-plus-rules' | 'all-including-hidden';
export type ConflictPolicy = 'prompt' | 'prefer-local' | 'prefer-remote';

export interface SyncStrategy {
  mode: SyncMode;
  intervalSecs: 60 | 300 | 900 | 1800;
  scope: SyncScope;
  excludePatterns: string[];
  conflictPolicy: ConflictPolicy;
  maxFileSizeBytes: number;
}

export const DEFAULT_SYNC_STRATEGY: SyncStrategy = {
  mode: 'on-save',
  intervalSecs: 300,
  scope: 'all-including-hidden',
  excludePatterns: ['node_modules/**', '.git/**', '.DS_Store', '*.tmp', '.env*', '*.key', '*.pem'],
  conflictPolicy: 'prompt',
  maxFileSizeBytes: 2 * 1024 * 1024,
};

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  deletedRemote: number;
  deletedLocal: number;
  skipped: number;
  conflicts: number;
}

export interface KbBinding {
  localKbId: string;
  picoraTargetId: string;
  picoraKbId: string;
  picoraKbName: string;
  strategy: SyncStrategy;
  lastSyncAt: string | null;
  lastSyncReport: SyncReport | null;
  lastSyncError: string | null;
}

// Picora API types

export interface PicoraKb {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  docCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export type SyncOpType = 'upsert' | 'delete';

export interface SyncOp {
  op: SyncOpType;
  relativePath: string;
  content?: string;
  sourceHash?: string;
  baseUpdatedAt?: string;
}

/**
 * One op the server applied (or skipped as a no-op). `updatedAt` / `sourceHash`
 * are the server's authoritative values — the last-synced manifest must record
 * these, not client-side guesses, or the next incremental upload is judged
 * against a base the server never had.
 */
export interface SyncAppliedItem {
  op: 'upsert' | 'delete' | 'move';
  relativePath: string;
  fromPath?: string;
  id: string | null;
  updatedAt: string | null;
  sourceHash: string | null;
}

export type SyncConflictReason =
  | 'REMOTE_NEWER'
  | 'REMOTE_DELETED'
  | 'BASE_MISSING'
  | 'LOCAL_HASH_MISMATCH'
  | 'MOVE_SOURCE_MISSING'
  | 'MOVE_TARGET_EXISTS';

/** An op the server refused, with its current snapshot of the document. */
export interface SyncConflictItem {
  op: 'upsert' | 'delete' | 'move';
  relativePath: string;
  reason: SyncConflictReason;
  remote: {
    sourceHash: string | null;
    sizeBytes: number | null;
    updatedAt: string | null;
    deletedAt: string | null;
  } | null;
}

/** `POST /v1/kbs/:id/sync` response (`data` object). */
export interface SyncBatchResult {
  applied: SyncAppliedItem[];
  conflicts: SyncConflictItem[];
  skipped: SyncAppliedItem[];
}

// Sync state per KB (for UI reactivity)

export type KbSyncStatus = 'unbound' | 'idle' | 'syncing' | 'conflict' | 'error';

export interface KbSyncState {
  localKbId: string;
  status: KbSyncStatus;
  conflictCount: number;
  pendingConflicts: ConflictEntry[];
  lastError: string | null;
}

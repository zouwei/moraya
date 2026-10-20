import { invoke } from '@tauri-apps/api/core';
import { writable, get } from 'svelte/store';
import { threeWayDiff } from './diff';
import { threeWayMergeLines } from './merge';
import { saveBaseContent, loadBaseContent, deleteBaseContent } from './base-cache';
import { buildLocalManifest, loadLastManifest, saveLastManifest, moveToTrash } from './manifest';
import {
  listKbs,
  createKb,
  fetchManifest,
  syncBatch,
  fetchRaw,
  picoraApiBase,
} from './picora-kb-client';
import type {
  KbBinding,
  SyncReport,
  ConflictEntry,
  RemoteManifest,
  ManifestEntry,
  KbSyncState,
  DiffResult,
  SyncAppliedItem,
  SyncConflictItem,
} from './types';
import type { ImageHostTarget } from '$lib/services/image-hosting/types';
import type { KnowledgeBase } from '$lib/stores/files-store';

export { listKbs, createKb, picoraApiBase };

/** SHA-256 hex of a UTF-8 string — matches the Rust local hash
 *  (`format!("{:x}", Sha256::digest(bytes))`) for UTF-8 files. */
async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Whether `hash` matches a snapshot in this document's local version history,
 * i.e. the remote content is a state this device itself already had. Best-
 * effort: false when version history is off or unreadable.
 */
async function isOwnPriorVersion(kbPath: string, relativePath: string, hash: string): Promise<boolean> {
  try {
    const { listVersions } = await import('$lib/services/version-history');
    const versions = await listVersions(`${kbPath}/${relativePath}`);
    return versions.some(v => v.sourceHash === hash);
  } catch {
    return false;
  }
}

/**
 * Dot-prefixed top-level namespaces other than `.moraya` are AI-memory tool
 * directories (`.claude/`, `.cursor/`, `.codex/`…). They are managed by the
 * separate memory binding-sync engine (push from `~/.claude` → cloud namespace)
 * and pulled only via explicit "restore" — never folder-synced into the KB's
 * local path. So KB folder sync ignores them: an unbound tool's hidden data is
 * neither downloaded into the folder nor uploaded from it. `.moraya` is the KB's
 * own rules/memory and stays part of folder sync.
 */
export function isMemoryNamespacePath(relativePath: string): boolean {
  const slash = relativePath.indexOf('/');
  const top = slash === -1 ? relativePath : relativePath.slice(0, slash);
  return top.startsWith('.') && top !== '.moraya';
}

function stripMemoryNamespaces<V>(m: Map<string, V>): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, v] of m) if (!isMemoryNamespacePath(k)) out.set(k, v);
  return out;
}

// ── Sync state store ─────────────────────────────────────────────────

function createKbSyncStore() {
  const { subscribe, update } = writable<Map<string, KbSyncState>>(new Map());

  return {
    subscribe,
    setState(localKbId: string, partial: Partial<KbSyncState>) {
      update(map => {
        const existing = map.get(localKbId) ?? {
          localKbId,
          status: 'unbound',
          conflictCount: 0,
          pendingConflicts: [],
          lastError: null,
        };
        const next = new Map(map);
        next.set(localKbId, { ...existing, ...partial });
        return next;
      });
    },
    getState(localKbId: string): KbSyncState {
      const map = get({ subscribe });
      return map.get(localKbId) ?? {
        localKbId,
        status: 'unbound',
        conflictCount: 0,
        pendingConflicts: [],
        lastError: null,
      };
    },
  };
}

export const kbSyncStore = createKbSyncStore();

// ── Interval scheduler ───────────────────────────────────────────────

const intervalMap = new Map<string, ReturnType<typeof setInterval>>();

export function registerKbInterval(
  binding: KbBinding,
  kb: KnowledgeBase,
  target: ImageHostTarget,
  onComplete?: (report: SyncReport) => void,
) {
  clearKbInterval(binding.localKbId);
  if (binding.strategy.mode !== 'interval') return;

  const id = setInterval(async () => {
    await runSync(binding, kb, target, false, onComplete);
  }, binding.strategy.intervalSecs * 1000);

  intervalMap.set(binding.localKbId, id);
}

export function clearKbInterval(localKbId: string) {
  const id = intervalMap.get(localKbId);
  if (id !== undefined) {
    clearInterval(id);
    intervalMap.delete(localKbId);
  }
}

export function clearAllIntervals() {
  for (const [id] of intervalMap) clearKbInterval(id);
}

// ── Core sync runner ─────────────────────────────────────────────────

export async function runSync(
  binding: KbBinding,
  kb: KnowledgeBase,
  target: ImageHostTarget,
  dryRun: boolean,
  onComplete?: (report: SyncReport) => void,
): Promise<Omit<SyncReport, 'conflicts'> & { conflicts: ConflictEntry[]; diff?: DiffResult }> {
  const { localKbId, picoraKbId, strategy } = binding;
  const apiBase = picoraApiBase(target.picoraApiUrl);
  const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
  const apiKey = await getPicoraApiKey(target);

  // Cloud-sync entitlement gate (hard, engine-level). An account with no active
  // paid plan must not touch Picora KB-sync endpoints — the server-side gate
  // would reject them and a wall of failing requests tanks perceived perf. Fall
  // back to local-only: do nothing on the network, surface a clear reason. This
  // one check covers every trigger (manual / on-save / interval / startup /
  // close / conflict re-sync) since they all run through runSync.
  const { getPicoraPlan, isKbSyncEntitled } = await import('$lib/services/picora/entitlement');
  if (!isKbSyncEntitled(await getPicoraPlan(target))) {
    if (dryRun) {
      kbSyncStore.setState(localKbId, { status: 'idle' });
    } else {
      const { t } = await import('$lib/i18n');
      kbSyncStore.setState(localKbId, { status: 'error', lastError: get(t)('kb_sync.gate.no_plan') });
    }
    return { uploaded: 0, downloaded: 0, deletedRemote: 0, deletedLocal: 0, skipped: 0, conflicts: [] };
  }

  kbSyncStore.setState(localKbId, { status: 'syncing', lastError: null });

  try {
    const [localManifestRaw, lastManifestRaw, remoteEntries] = await Promise.all([
      buildLocalManifest(kb.path, strategy.scope, strategy.excludePatterns),
      loadLastManifest(localKbId),
      fetchManifest(apiBase, apiKey, picoraKbId),
    ]);

    // Exclude AI-memory tool namespaces (`.claude/`…) from folder sync in BOTH
    // directions — they're handled by the memory binding engine, not folder sync.
    const localManifest = stripMemoryNamespaces(localManifestRaw);
    const lastManifest = stripMemoryNamespaces(lastManifestRaw);
    const remoteManifest: RemoteManifest = stripMemoryNamespaces(
      new Map(remoteEntries.map(e => [e.relativePath, e]))
    );

    // First sync (no base): this machine is the initial authority — divergent
    // both-exist files upload rather than conflict. See InitialAuthority.
    const diff = threeWayDiff(
      lastManifest,
      localManifest,
      remoteManifest,
      strategy.maxFileSizeBytes,
      'local',
    );

    if (dryRun) {
      kbSyncStore.setState(localKbId, { status: 'idle' });
      return {
        uploaded: diff.uploadPaths.length,
        downloaded: diff.downloadPaths.length,
        deletedRemote: diff.deleteRemotePaths.length,
        deletedLocal: diff.deleteLocalPaths.length,
        skipped: diff.skippedLarge.length,
        conflicts: diff.conflictPaths.length,
        diff,
      } as unknown as Omit<SyncReport, 'conflicts'> & { conflicts: ConflictEntry[]; diff: DiffResult };
    }

    // ── Execute non-conflict operations ──
    const report: SyncReport = {
      uploaded: 0,
      downloaded: 0,
      deletedRemote: 0,
      deletedLocal: 0,
      skipped: diff.skippedLarge.length,
      conflicts: diff.conflictPaths.length,
    };

    // Running manifest of the last-agreed state; updated as each op succeeds.
    // Every entry written here must carry the SERVER's updatedAt/sourceHash
    // (from the batch response or the remote manifest) — the next sync both
    // diffs against it and sends its updatedAt as the optimistic-concurrency
    // base, so a client-side guess turns plain incremental edits into conflicts.
    const newLastManifest: RemoteManifest = new Map(lastManifest);
    const PREVIEW_LIMIT = 2000;

    const recordApplied = (relativePath: string, item: SyncAppliedItem, content: string, hash: string) => {
      newLastManifest.set(relativePath, {
        relativePath,
        sourceHash: item.sourceHash ?? hash,
        sizeBytes: utf8Len(content),
        updatedAt: item.updatedAt ?? remoteManifest.get(relativePath)?.updatedAt ?? new Date().toISOString(),
      });
    };

    /** Upsert one file; returns the server's applied item, or null if refused. */
    const uploadOne = async (relativePath: string, content: string, baseUpdatedAt: string | undefined) => {
      const hash = await sha256Hex(content);
      const res = await syncBatch(apiBase, apiKey, picoraKbId, [
        { op: 'upsert', relativePath, content, sourceHash: hash, ...(baseUpdatedAt ? { baseUpdatedAt } : {}) },
      ]);
      const item = res.applied.find(a => a.relativePath === relativePath);
      if (!item) return null;
      await saveBaseContent(localKbId, relativePath, content);
      recordApplied(relativePath, item, content, hash);
      return item;
    };

    // ── Uploads + remote deletes (batch) ──
    // baseUpdatedAt = the remote version observed in THIS sync's manifest: the
    // diff only chose "upload"/"delete-remote" after checking that version, so
    // it is the precise concurrency base (and covers first syncs, where there
    // is no lastManifest entry yet).
    const uploadContents = new Map<string, { content: string; hash: string }>();
    const uploadOps = await Promise.all(
      diff.uploadPaths.map(async (relativePath) => {
        const content = await invoke<string>('read_file', {
          path: `${kb.path}/${relativePath}`,
        });
        // Hash what is actually sent — the file may have been saved again
        // since the manifest scan, and a stale hash is rejected server-side.
        const hash = await sha256Hex(content);
        uploadContents.set(relativePath, { content, hash });
        const baseUpdatedAt = remoteManifest.get(relativePath)?.updatedAt;
        return {
          op: 'upsert' as const,
          relativePath,
          content,
          sourceHash: hash,
          ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
        };
      })
    );

    const deleteRemoteOps = diff.deleteRemotePaths.map(relativePath => {
      const baseUpdatedAt = remoteManifest.get(relativePath)?.updatedAt;
      return {
        op: 'delete' as const,
        relativePath,
        ...(baseUpdatedAt ? { baseUpdatedAt } : {}),
      };
    });

    const allOps = [...uploadOps, ...deleteRemoteOps];
    let batchConflicts: SyncConflictItem[] = [];

    if (allOps.length > 0) {
      const batchResult = await syncBatch(apiBase, apiKey, picoraKbId, allOps);
      const applied = new Map(batchResult.applied.map(a => [a.relativePath, a]));
      const skipped = new Set(batchResult.skipped.map(a => a.relativePath));
      batchConflicts = batchResult.conflicts;

      for (const relativePath of diff.uploadPaths) {
        const item = applied.get(relativePath);
        const sent = uploadContents.get(relativePath);
        if (!item || !sent) continue;
        report.uploaded++;
        await saveBaseContent(localKbId, relativePath, sent.content);
        recordApplied(relativePath, item, sent.content, sent.hash);
      }
      for (const relativePath of diff.deleteRemotePaths) {
        // A skipped delete means the doc was already gone — equally settled.
        if (!applied.has(relativePath) && !skipped.has(relativePath)) continue;
        report.deletedRemote++;
        newLastManifest.delete(relativePath);
        await deleteBaseContent(localKbId, relativePath);
      }
    }

    // ── Downloads ──
    for (const relativePath of diff.downloadPaths) {
      const content = (await fetchRaw(apiBase, apiKey, picoraKbId, relativePath)) ?? '';
      await invoke('write_file', { path: `${kb.path}/${relativePath}`, content });
      await saveBaseContent(localKbId, relativePath, content);
      const entry = remoteManifest.get(relativePath);
      if (entry) newLastManifest.set(relativePath, entry);
      report.downloaded++;
    }

    // ── Local deletes (move to trash) ──
    for (const relativePath of diff.deleteLocalPaths) {
      await moveToTrash(kb.path, localKbId, relativePath);
      newLastManifest.delete(relativePath);
      await deleteBaseContent(localKbId, relativePath);
      report.deletedLocal++;
    }

    // ── Conflicts ──
    // Locally-detected conflicts and upserts the server refused go through ONE
    // pipeline: same content → aligned; remote is a version this device itself
    // had → fast-forward; clean 3-way merge; conflictPolicy; else prompt.
    // A refused delete is left alone — the next sync re-diffs it.
    type RemoteMeta = { sourceHash: string; sizeBytes: number; updatedAt: string } | null;
    const conflictQueue = new Map<string, RemoteMeta>();
    for (const relativePath of diff.conflictPaths) {
      conflictQueue.set(relativePath, remoteManifest.get(relativePath) ?? null);
    }
    for (const c of batchConflicts) {
      if (c.op !== 'upsert' || conflictQueue.has(c.relativePath)) continue;
      const r = c.remote;
      conflictQueue.set(
        c.relativePath,
        r && !r.deletedAt && r.sourceHash && r.updatedAt
          ? { sourceHash: r.sourceHash, sizeBytes: r.sizeBytes ?? 0, updatedAt: r.updatedAt }
          : null,
      );
    }

    const pendingConflicts: ConflictEntry[] = [];
    for (const [relativePath, remoteMeta] of conflictQueue) {
      const localMeta = localManifest.get(relativePath);
      // Absent locally = deleted here while the remote changed (diff conflict).
      const localExists = localMeta !== undefined;
      let localContent = '';
      let remoteContent = '';
      if (localExists) {
        try { localContent = (await invoke<string>('read_file', { path: `${kb.path}/${relativePath}` })) ?? ''; } catch { /* best-effort */ }
      }
      if (remoteMeta) {
        try { remoteContent = (await fetchRaw(apiBase, apiKey, picoraKbId, relativePath)) ?? ''; } catch { /* best-effort */ }
      }
      const localHash = await sha256Hex(localContent);
      const baseUpdatedAt = remoteMeta?.updatedAt;

      // 0) Already identical — just record the agreed state.
      if (localExists && remoteMeta && localHash === remoteMeta.sourceHash) {
        await saveBaseContent(localKbId, relativePath, localContent);
        newLastManifest.set(relativePath, { relativePath, ...remoteMeta });
        continue;
      }

      // 1) Remote holds a state this device already had (found in the local
      //    version history) → local simply moved on from it: fast-forward.
      //    Also self-heals last-synced manifests left stale by older builds.
      if (localExists && remoteMeta && await isOwnPriorVersion(kb.path, relativePath, remoteMeta.sourceHash)) {
        if (await uploadOne(relativePath, localContent, baseUpdatedAt)) {
          report.uploaded++;
          continue;
        }
      }

      const baseContent = await loadBaseContent(localKbId, relativePath);

      // 2) Clean 3-way auto-merge (non-overlapping edits) → write + upload, no prompt.
      if (localExists && remoteMeta && baseContent !== null) {
        const merged = threeWayMergeLines(localContent, baseContent, remoteContent);
        if (!merged.hasConflict && merged.mergedText !== null) {
          const text = merged.mergedText;
          if (await uploadOne(relativePath, text, baseUpdatedAt)) {
            await invoke('write_file', { path: `${kb.path}/${relativePath}`, content: text });
            report.uploaded++;
            continue;
          }
        }
      }

      // 3) Auto-resolve per conflictPolicy (skip prompting).
      if (strategy.conflictPolicy === 'prefer-local') {
        if (localExists) {
          if (await uploadOne(relativePath, localContent, baseUpdatedAt)) {
            report.uploaded++;
            continue;
          }
        } else {
          const res = await syncBatch(apiBase, apiKey, picoraKbId, [
            { op: 'delete', relativePath, ...(baseUpdatedAt ? { baseUpdatedAt } : {}) },
          ]);
          if (res.applied.length > 0 || res.skipped.length > 0) {
            newLastManifest.delete(relativePath);
            await deleteBaseContent(localKbId, relativePath);
            report.deletedRemote++;
            continue;
          }
        }
      }
      if (strategy.conflictPolicy === 'prefer-remote' && remoteMeta) {
        await invoke('write_file', { path: `${kb.path}/${relativePath}`, content: remoteContent });
        await saveBaseContent(localKbId, relativePath, remoteContent);
        newLastManifest.set(relativePath, { relativePath, ...remoteMeta });
        report.downloaded++;
        continue;
      }
      if (strategy.conflictPolicy === 'prefer-remote' && localExists) {
        // Remote deleted it → follow the remote (recoverable from trash).
        await moveToTrash(kb.path, localKbId, relativePath);
        newLastManifest.delete(relativePath);
        await deleteBaseContent(localKbId, relativePath);
        report.deletedLocal++;
        continue;
      }

      // 4) prompt → surface with full content + base for the line-level UI.
      pendingConflicts.push({
        relativePath,
        localUpdatedAt: localMeta ? new Date(localMeta.mtime).toISOString() : '',
        remoteUpdatedAt: remoteMeta?.updatedAt ?? '',
        localSizeBytes: localMeta?.sizeBytes ?? utf8Len(localContent),
        remoteSizeBytes: remoteMeta?.sizeBytes ?? 0,
        localPreview: localContent.slice(0, PREVIEW_LIMIT),
        remotePreview: remoteContent.slice(0, PREVIEW_LIMIT),
        localHash: localExists ? localHash : '',
        remoteHash: remoteMeta?.sourceHash ?? '',
        localContent,
        remoteContent,
        baseContent,
      });
    }

    report.conflicts = pendingConflicts.length;

    await saveLastManifest(localKbId, newLastManifest);

    kbSyncStore.setState(localKbId, {
      status: pendingConflicts.length > 0 ? 'conflict' : 'idle',
      conflictCount: pendingConflicts.length,
      pendingConflicts: pendingConflicts,
    });

    onComplete?.(report);
    return { ...report, conflicts: pendingConflicts };
  } catch (err) {
    const errMsg = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'Sync failed');
    kbSyncStore.setState(localKbId, { status: 'error', lastError: errMsg });
    throw err;
  }
}

/** Perform dry-run for initial binding preview. */
export async function dryRunSync(
  binding: KbBinding,
  kb: KnowledgeBase,
  target: ImageHostTarget,
) {
  return runSync(binding, kb, target, true);
}

/**
 * Apply a user-resolved merged content for a single conflicting file: write it
 * locally, upload to Picora, and record the merged content as the new base +
 * manifest entry so the next sync sees it aligned (no re-conflict). Used by the
 * line-level conflict resolution panel. `remoteUpdatedAt` is the remote version
 * the user resolved against (the conflict's `remoteUpdatedAt`); if the server
 * has moved past it, the upload is refused and this throws so the panel can
 * ask for a fresh sync instead of silently dropping the resolution.
 */
export async function applyResolvedContent(
  binding: KbBinding,
  kb: KnowledgeBase,
  target: ImageHostTarget,
  relativePath: string,
  mergedText: string,
  remoteUpdatedAt?: string,
): Promise<void> {
  const { localKbId, picoraKbId } = binding;
  const apiBase = picoraApiBase(target.picoraApiUrl);
  const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
  const apiKey = await getPicoraApiKey(target);

  const hash = await sha256Hex(mergedText);
  // Always persist the resolved merge to the local file (local-first).
  await invoke('write_file', { path: `${kb.path}/${relativePath}`, content: mergedText });

  // Cloud-sync entitlement gate: without an active paid plan, keep the local
  // write but skip the Picora upload + manifest advance. (Defensive — an
  // unentitled account can't reach a conflict since runSync is gated upstream.)
  const { getPicoraPlan, isKbSyncEntitled } = await import('$lib/services/picora/entitlement');
  if (!isKbSyncEntitled(await getPicoraPlan(target))) return;

  const res = await syncBatch(apiBase, apiKey, picoraKbId, [
    { op: 'upsert', relativePath, content: mergedText, sourceHash: hash, ...(remoteUpdatedAt ? { baseUpdatedAt: remoteUpdatedAt } : {}) },
  ]);
  const item = res.applied.find(a => a.relativePath === relativePath);
  if (!item) {
    const { t } = await import('$lib/i18n');
    throw new Error(get(t)('kb_sync.conflict.remote_changed'));
  }
  await saveBaseContent(localKbId, relativePath, mergedText);

  const manifest = await loadLastManifest(localKbId);
  manifest.set(relativePath, {
    relativePath,
    sourceHash: item.sourceHash ?? hash,
    sizeBytes: utf8Len(mergedText),
    updatedAt: item.updatedAt ?? new Date().toISOString(),
  });
  await saveLastManifest(localKbId, manifest);
}

/**
 * Manual "sync now" for a Picora-bound knowledge base, shared by the sidebar
 * KB-switcher button and the status-bar sync icon so both behave identically.
 */

import { get } from 'svelte/store';
import { t } from '$lib/i18n';
import { filesStore, type KnowledgeBase } from '$lib/stores/files-store';
import { settingsStore } from '$lib/stores/settings-store';
import { kbSyncStore, runSync } from './sync-service';

export type SyncNotify = (text: string, type?: 'success' | 'error') => void;

/** Run a manual sync of `kb` and record the outcome on the KB binding + sync store. */
export async function syncKbNow(kb: KnowledgeBase, onNotify?: SyncNotify): Promise<void> {
  if (!kb.picoraBinding) return;
  const target = settingsStore.getState().imageHostTargets
    .find(tg => tg.id === kb.picoraBinding!.picoraTargetId);
  if (!target) {
    // Picora account was deleted after binding — surface the error.
    const errMsg = get(t)('kb_sync.error.target_missing');
    filesStore.updateKbSyncReport(kb.id, {
      lastSyncAt: new Date().toISOString(),
      lastSyncReport: null,
      lastSyncError: errMsg,
    });
    kbSyncStore.setState(kb.id, { status: 'error', lastError: errMsg });
    return;
  }
  try {
    const report = await runSync(kb.picoraBinding, kb, target, false);
    const numConflicts = typeof report.conflicts === 'number'
      ? report.conflicts
      : (report.conflicts as unknown as { length: number }).length;
    filesStore.updateKbSyncReport(kb.id, {
      lastSyncAt: new Date().toISOString(),
      lastSyncReport: {
        uploaded: report.uploaded,
        downloaded: report.downloaded,
        deletedRemote: report.deletedRemote,
        deletedLocal: report.deletedLocal,
        skipped: report.skipped,
        conflicts: numConflicts,
      },
      lastSyncError: null,
    });
    if (report.deletedLocal > 0 && onNotify) {
      onNotify(
        get(t)('kb_sync.trash.toast_deleted', { count: String(report.deletedLocal) }),
        'success',
      );
    }
  } catch (e) {
    const errMsg = typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Sync failed');
    console.error('[KbSync] Sync failed for KB', kb.id, ':', errMsg);
    kbSyncStore.setState(kb.id, { status: 'error', lastError: errMsg });
    filesStore.updateKbSyncReport(kb.id, {
      lastSyncAt: new Date().toISOString(),
      lastSyncReport: null,
      lastSyncError: errMsg,
    });
  }
}

/**
 * Called after a Picora target's credential changes. Drops the cached plan and
 * clears the `error` state of every KB bound to that target, so the sync icons
 * re-enable immediately instead of staying stuck on the old key's failure.
 */
export async function onPicoraCredentialChanged(targetId: string): Promise<void> {
  const { invalidatePlanCache } = await import('$lib/services/picora/entitlement');
  invalidatePlanCache(targetId);
  for (const kb of filesStore.getState().knowledgeBases) {
    if (kb.picoraBinding?.picoraTargetId !== targetId) continue;
    if (kbSyncStore.getState(kb.id).status === 'error') {
      kbSyncStore.setState(kb.id, { status: 'unbound', lastError: null });
    }
  }
}

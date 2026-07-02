<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { filesStore, type KnowledgeBase } from '$lib/stores/files-store';
  import {
    listTrash,
    restoreFromTrash,
    purgeTrash,
    deleteTrashEntry,
    formatBytes,
    groupByKb,
    filterSince,
    type TrashEntry,
    type RestoreResult,
  } from '$lib/services/kb-sync/trash';

  let { onClose }: { onClose: () => void } = $props();

  type TimeFilter = '7d' | '30d' | 'all';

  let entries = $state<TrashEntry[]>([]);
  let loading = $state(true);
  let busyPath = $state<string | null>(null);
  let error = $state('');
  let kbFilter = $state<string>('__all__');
  let timeFilter = $state<TimeFilter>('7d');
  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let conflict = $state<{ entry: TrashEntry; existingSize: number } | null>(null);
  let purgeReportToast = $state<string | null>(null);

  const unsubFs = filesStore.subscribe(s => { knowledgeBases = s.knowledgeBases; });

  onMount(() => {
    void refresh();
    return () => unsubFs();
  });

  async function refresh() {
    loading = true;
    error = '';
    try {
      entries = await listTrash();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      loading = false;
    }
  }

  function kbRootOf(kbId: string): string | null {
    return knowledgeBases.find(k => k.id === kbId)?.path ?? null;
  }

  function kbNameOf(kbId: string): string {
    return knowledgeBases.find(k => k.id === kbId)?.name ?? $t('kbSync.trash.kbUnknown');
  }

  function formatDeletedAt(ms: number): string {
    if (ms === 0) return '—';
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return '—';
    }
  }

  let cutoffMs = $derived(
    timeFilter === 'all' ? 0
      : timeFilter === '7d' ? Date.now() - 7 * 86400_000
      : Date.now() - 30 * 86400_000
  );

  let filtered = $derived.by(() => {
    const timeFiltered = cutoffMs > 0 ? filterSince(entries, cutoffMs) : entries;
    return kbFilter === '__all__'
      ? timeFiltered
      : timeFiltered.filter(e => e.kbId === kbFilter);
  });

  let groupedByKb = $derived([...groupByKb(filtered).entries()]);

  let availableKbIds = $derived(
    [...new Set(entries.map(e => e.kbId))]
  );

  async function handleRestore(entry: TrashEntry, overwrite = false) {
    const kbRoot = kbRootOf(entry.kbId);
    if (!kbRoot) {
      error = $t('kbSync.trash.restoreFailed');
      return;
    }
    busyPath = entry.absoluteTrashPath;
    try {
      const result: RestoreResult = await restoreFromTrash({
        kbId: entry.kbId,
        deletedAt: entry.deletedAt,
        relativePath: entry.relativePath,
        kbRoot,
        overwrite,
      });
      if (result.kind === 'conflict-exists') {
        conflict = { entry, existingSize: result.existingSize };
        return;
      }
      // Success: drop the entry locally + refresh sidebar tree
      entries = entries.filter(e => e.absoluteTrashPath !== entry.absoluteTrashPath);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      busyPath = null;
    }
  }

  async function handleConfirmOverwrite() {
    if (!conflict) return;
    const entry = conflict.entry;
    conflict = null;
    await handleRestore(entry, true);
  }

  async function handleDeleteForever(entry: TrashEntry) {
    const msg = $t('kbSync.trash.deleteForeverConfirm', { path: entry.relativePath });
    if (!confirm(msg)) return;
    busyPath = entry.absoluteTrashPath;
    try {
      await deleteTrashEntry(entry.absoluteTrashPath);
      entries = entries.filter(e => e.absoluteTrashPath !== entry.absoluteTrashPath);
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    } finally {
      busyPath = null;
    }
  }

  async function handlePurgeAll() {
    const days = 7;
    if (!confirm($t('kbSync.trash.purgeAllConfirm', { days: String(days) }))) return;
    try {
      const report = await purgeTrash({ olderThanDays: days });
      purgeReportToast = $t('kbSync.trash.purgeResult', {
        files: String(report.purgedFiles),
        size: formatBytes(report.freedBytes),
      });
      setTimeout(() => { purgeReportToast = null; }, 4000);
      await refresh();
    } catch (e) {
      error = String(e instanceof Error ? e.message : e);
    }
  }
</script>

<div class="modal-overlay" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()} role="presentation">
  <div class="modal-panel" role="dialog" aria-labelledby="trash-title" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <header>
      <h2 id="trash-title">{$t('kbSync.trash.title')}</h2>
      <button class="close-btn" onclick={onClose} aria-label="Close" type="button">×</button>
    </header>

    <div class="filters">
      <label>
        <select bind:value={kbFilter}>
          <option value="__all__">{$t('kbSync.trash.filterKbAll')}</option>
          {#each availableKbIds as kbId (kbId)}
            <option value={kbId}>{kbNameOf(kbId)}</option>
          {/each}
        </select>
      </label>
      <label>
        <select bind:value={timeFilter}>
          <option value="7d">{$t('kbSync.trash.filterTime7d')}</option>
          <option value="30d">{$t('kbSync.trash.filterTime30d')}</option>
          <option value="all">{$t('kbSync.trash.filterTimeAll')}</option>
        </select>
      </label>
      <button class="purge-btn" onclick={handlePurgeAll} type="button">
        {$t('kbSync.trash.purgeAll')}
      </button>
    </div>

    <p class="auto-purge-hint">{$t('kbSync.trash.autoPurgeHint')}</p>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    {#if purgeReportToast}
      <p class="info-toast">{purgeReportToast}</p>
    {/if}

    <div class="body">
      {#if loading}
        <p class="muted">{$t('kbSync.trash.loading')}</p>
      {:else if filtered.length === 0}
        <p class="muted">{$t('kbSync.trash.emptyState')}</p>
      {:else}
        {#each groupedByKb as [kbId, group] (kbId)}
          <section class="kb-group">
            <h3>{kbNameOf(kbId)} <span class="count">({group.length})</span></h3>
            <ul>
              {#each group as entry (entry.absoluteTrashPath)}
                <li>
                  <div class="entry-meta">
                    <span class="path">📄 {entry.relativePath}</span>
                    <span class="sub">
                      {$t('kbSync.trash.entryDeletedAt', { date: formatDeletedAt(entry.deletedAtMs) })}
                      · {formatBytes(entry.sizeBytes)}
                    </span>
                  </div>
                  <div class="entry-actions">
                    <button
                      onclick={() => handleRestore(entry)}
                      disabled={busyPath === entry.absoluteTrashPath}
                      type="button"
                    >
                      {$t('kbSync.trash.restore')}
                    </button>
                    <button
                      class="danger"
                      onclick={() => handleDeleteForever(entry)}
                      disabled={busyPath === entry.absoluteTrashPath}
                      type="button"
                    >
                      {$t('kbSync.trash.deleteForever')}
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}
    </div>
  </div>
</div>

{#if conflict}
  <div class="conflict-overlay" role="presentation">
    <div class="conflict-panel" role="dialog">
      <h3>{$t('kbSync.trash.restoreConflictTitle')}</h3>
      <p>{$t('kbSync.trash.restoreConflictBody', { path: conflict.entry.relativePath })}</p>
      <p class="sub">{$t('kbSync.trash.entryDeletedAt', { date: formatDeletedAt(conflict.entry.deletedAtMs) })} · {formatBytes(conflict.entry.sizeBytes)}</p>
      <div class="conflict-actions">
        <button onclick={() => { conflict = null; }} type="button">{$t('kbSync.trash.cancel')}</button>
        <button class="primary" onclick={handleConfirmOverwrite} type="button">{$t('kbSync.trash.overwrite')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 1000;
    display: flex; align-items: center; justify-content: center;
  }
  .modal-panel {
    background: var(--bg-primary); color: var(--text-primary);
    width: min(720px, 90vw); max-height: 80vh; display: flex; flex-direction: column;
    border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    padding: 1rem 1.25rem;
  }
  header { display: flex; align-items: center; justify-content: space-between; }
  header h2 { margin: 0; font-size: var(--font-size-lg); }
  .close-btn {
    background: transparent; border: none; font-size: 1.6rem; line-height: 1;
    color: var(--text-secondary); cursor: pointer; padding: 0 0.4rem;
  }
  .close-btn:hover { color: var(--text-primary); }
  .filters {
    display: flex; gap: 0.5rem; align-items: center; margin: 0.5rem 0;
  }
  .filters select {
    padding: 4px 8px; font-size: var(--font-size-sm);
    background: var(--bg-secondary); color: var(--text-primary);
    border: 1px solid var(--border-color); border-radius: 4px;
  }
  .purge-btn {
    margin-left: auto;
    padding: 4px 12px; font-size: var(--font-size-sm);
    background: transparent; color: var(--text-secondary);
    border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;
  }
  .purge-btn:hover { color: var(--text-primary); border-color: var(--text-primary); }
  .auto-purge-hint { font-size: var(--font-size-xs); color: var(--text-secondary); margin: 0 0 0.5rem; }
  .body { overflow-y: auto; flex: 1; }
  .muted { color: var(--text-secondary); font-size: var(--font-size-sm); padding: 1rem 0; }
  .error { color: #dc3545; font-size: var(--font-size-sm); }
  .info-toast {
    background: var(--bg-secondary); padding: 0.5rem 0.75rem; border-radius: 4px;
    font-size: var(--font-size-sm); margin: 0.25rem 0;
  }
  .kb-group { margin-bottom: 1rem; }
  .kb-group h3 { font-size: var(--font-size-base); margin: 0.5rem 0 0.25rem; }
  .kb-group .count { color: var(--text-secondary); font-weight: normal; }
  ul { list-style: none; padding: 0; margin: 0; }
  li {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; border: 1px solid var(--border-color);
    border-radius: 4px; margin-bottom: 4px;
  }
  .entry-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .path { font-size: var(--font-size-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: var(--font-size-xs); color: var(--text-secondary); }
  .entry-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .entry-actions button {
    padding: 4px 8px; font-size: var(--font-size-xs);
    background: transparent; color: var(--text-primary);
    border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;
  }
  .entry-actions button:hover:not(:disabled) { background: var(--bg-secondary); }
  .entry-actions .danger { color: #dc3545; border-color: #dc3545; }
  .entry-actions .danger:hover:not(:disabled) { background: #dc3545; color: white; }
  .entry-actions button:disabled { opacity: 0.5; cursor: not-allowed; }

  .conflict-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1100;
    display: flex; align-items: center; justify-content: center;
  }
  .conflict-panel {
    background: var(--bg-primary); color: var(--text-primary);
    padding: 1.25rem; border-radius: 8px;
    width: min(440px, 90vw);
    box-shadow: 0 8px 24px rgba(0,0,0,0.2);
  }
  .conflict-panel h3 { margin: 0 0 0.5rem; font-size: var(--font-size-base); }
  .conflict-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }
  .conflict-actions button {
    padding: 4px 12px; font-size: var(--font-size-sm);
    background: transparent; color: var(--text-primary);
    border: 1px solid var(--border-color); border-radius: 4px; cursor: pointer;
  }
  .conflict-actions .primary { background: var(--accent-color, #0d6efd); color: white; border-color: transparent; }
</style>

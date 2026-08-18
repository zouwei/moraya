<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { ask } from '$lib/utils/native-dialog';
  import { t } from '$lib/i18n';
  import {
    listVersions,
    readVersion,
    restoreVersion,
    clearVersions,
    fetchRemoteRevisions,
    fetchRemoteRevisionContent,
    mergeRemoteRevisions,
    restoreRemoteVersion,
    sha256Hex,
    type VersionEntry,
    type MergedVersionRow,
    type RemoteRevisionsContext,
  } from '$lib/services/version-history';

  let {
    filePath,
    fileName,
    onClose,
    onRestored,
    onOpenVersion,
  }: {
    filePath: string;
    fileName: string;
    onClose: () => void;
    onRestored: (content: string) => void;
    /** Open a historical version in a read-only preview tab. */
    onOpenVersion: (content: string, label: string, previewKey: string) => void;
  } = $props();

  let rows = $state<MergedVersionRow[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let cloudLoading = $state(false);
  // sourceHash of the current on-disk document — the row matching it is the
  // "current" version (clicking it just closes the panel, no new tab).
  let currentHash = $state<string | null>(null);
  let remoteCtx: RemoteRevisionsContext | null = null;
  // Guard stale async overlays after rapid refreshes
  let refreshSerial = 0;

  async function refresh() {
    const serial = ++refreshSerial;
    loading = true;
    const local = await listVersions(filePath);
    if (serial !== refreshSerial) return;
    rows = local.map((e) => ({ ...e }));
    loading = false;

    // Hash the current on-disk content to flag which row is "current".
    invoke<string>('read_file', { path: filePath })
      .then((text) => sha256Hex(text))
      .then((h) => { if (serial === refreshSerial) currentHash = h; })
      .catch(() => { if (serial === refreshSerial) currentHash = null; });

    // Cloud overlay: best-effort, never blocks the local list. Any gate miss
    // or failure keeps the panel in local-only mode.
    cloudLoading = true;
    const ctx = await fetchRemoteRevisions(filePath);
    if (serial !== refreshSerial) return;
    remoteCtx = ctx;
    if (ctx) rows = mergeRemoteRevisions(local, ctx.revisions);
    cloudLoading = false;
  }

  function isCurrent(row: MergedVersionRow): boolean {
    return currentHash != null && row.sourceHash === currentHash;
  }

  function previewKeyFor(row: MergedVersionRow): string {
    return row.cloudOnly
      ? `${filePath}#cloud:${row.remote?.revId}`
      : `${filePath}#${row.file}`;
  }

  /** Row click → read-only open, unless the row is the current document. */
  async function handleOpenRow(row: MergedVersionRow) {
    if (busy) return;
    if (isCurrent(row)) {
      onClose();
      return;
    }
    busy = true;
    let content: string | null;
    if (row.cloudOnly) {
      content = remoteCtx
        ? await fetchRemoteRevisionContent(remoteCtx, row.remote!.revId)
        : null;
    } else {
      content = await readVersion(filePath, row as unknown as VersionEntry).catch(() => null);
    }
    busy = false;
    if (content == null) return;
    onOpenVersion(content, `${fileName} #${row.revNumber}`, previewKeyFor(row));
    onClose();
  }

  onMount(() => {
    refresh();
  });

  function formatTime(row: MergedVersionRow): string {
    if (row.createdAt) {
      const d = new Date(row.createdAt);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
    // meta was rebuilt without timestamps — fall back to the filename stem
    return row.file.replace(/(_r\d+)?\.md$/, '').replace('_', ' ');
  }

  function formatSize(bytes: number): string {
    if (bytes <= 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  /** "P" badge: the version's content is retrievable from Picora. */
  function isCloudSynced(row: MergedVersionRow): boolean {
    return row.remote != null;
  }

  function rowKey(row: MergedVersionRow): string {
    return row.cloudOnly ? `c:${row.remote!.revId}` : `l:${row.file}`;
  }

  async function handleRestore(row: MergedVersionRow) {
    if (busy) return;
    const confirmed = await ask(
      $t('version_history.restore_confirm', { time: formatTime(row) }),
      { title: $t('version_history.restore'), kind: 'warning' }
    );
    if (!confirmed) return;
    busy = true;
    let restored: string | null;
    if (row.cloudOnly) {
      restored = remoteCtx
        ? await restoreRemoteVersion(filePath, remoteCtx, row.remote!.revId)
        : null;
    } else {
      restored = await restoreVersion(filePath, row as unknown as VersionEntry);
    }
    busy = false;
    if (restored != null) {
      onRestored(restored);
      await refresh();
    }
  }

  async function handleClear() {
    if (busy || rows.length === 0) return;
    const confirmed = await ask($t('version_history.clear_confirm'), {
      title: $t('version_history.clear'),
      kind: 'warning',
    });
    if (!confirmed) return;
    busy = true;
    const ok = await clearVersions(filePath);
    busy = false;
    if (ok) await refresh();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="vh-scrim" onclick={onClose}>
  <div class="vh-sheet" onclick={(e) => e.stopPropagation()}>
    <div class="vh-header">
      <span class="vh-title">{$t('version_history.title')}</span>
      <span class="vh-file" title={filePath}>{fileName}</span>
      <div class="vh-header-actions">
        {#if cloudLoading}
          <span class="vh-cloud-loading">{$t('version_history.cloud_loading')}</span>
        {/if}
        {#if rows.some((r) => !r.cloudOnly)}
          <button class="vh-clear" onclick={handleClear} disabled={busy}>
            {$t('version_history.clear')}
          </button>
        {/if}
        <button class="vh-close" onclick={onClose} aria-label={$t('common.close')}>✕</button>
      </div>
    </div>

    <div class="vh-list">
      {#if loading}
        <div class="vh-empty">…</div>
      {:else if rows.length === 0}
        <div class="vh-empty">{$t('version_history.empty')}</div>
      {:else}
        {#each rows as row (rowKey(row))}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="vh-row"
            class:vh-row-cloud={row.cloudOnly}
            class:vh-row-current={isCurrent(row)}
            role="button"
            tabindex="0"
            title={isCurrent(row) ? undefined : $t('version_history.open_hint')}
            onclick={() => handleOpenRow(row)}
            onkeydown={(e) => { if (e.key === 'Enter') handleOpenRow(row); }}
          >
            <span class="vh-rev">#{row.revNumber}</span>
            <span class="vh-time">{formatTime(row)}</span>
            <span class="vh-origin" class:origin-manual={row.origin === 'manual' || row.origin === 'upload'} class:origin-restore={row.origin === 'restore'}>
              {$t(`version_history.origin_${row.origin}`)}
            </span>
            {#if isCurrent(row)}
              <span class="vh-current">{$t('version_history.current')}</span>
            {/if}
            {#if row.cloudOnly}
              <span class="vh-cloud-only">{$t('version_history.cloud_only')}</span>
            {/if}
            <span class="vh-size">{formatSize(row.sizeBytes)}</span>
            {#if isCloudSynced(row)}
              <!-- Picora brand mark (picora-mark-mono-blue.svg) — cloud-synced badge -->
              <span class="vh-cloud" title={$t('version_history.cloud_synced')}>
                <svg width="10" height="12" viewBox="8 6 16 20" fill="none" aria-hidden="true"><path d="M9.5 7.5v17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="14" r="6.5" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="14" r="2.4" fill="currentColor"/></svg>
              </span>
            {/if}
            <button class="vh-restore" onclick={(e) => { e.stopPropagation(); handleRestore(row); }} disabled={busy}>
              {$t('version_history.restore')}
            </button>
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .vh-scrim {
    position: fixed;
    inset: 0;
    z-index: 500;
  }

  .vh-sheet {
    position: absolute;
    bottom: calc(var(--statusbar-height) + 4px);
    left: 50%;
    transform: translateX(-50%);
    width: min(720px, calc(100vw - 2rem));
    max-height: 50vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.22);
    animation: vh-slide-up 0.16s ease-out;
  }

  @keyframes vh-slide-up {
    from { transform: translateX(-50%) translateY(12px); opacity: 0; }
    to { transform: translateX(-50%) translateY(0); opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .vh-sheet { animation: none; }
  }

  .vh-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--border-color);
  }

  .vh-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .vh-file {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vh-header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .vh-clear {
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-muted);
    border-radius: 4px;
    font-size: var(--font-size-xs);
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .vh-clear:hover:not(:disabled) { color: var(--color-error, #e53e3e); border-color: var(--color-error, #e53e3e); }

  .vh-close {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9rem;
    line-height: 1;
    padding: 0.15rem;
  }
  .vh-close:hover { color: var(--text-primary); }

  .vh-list {
    overflow-y: auto;
    padding: 0.25rem 0;
  }

  .vh-empty {
    padding: 1.5rem 0;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .vh-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.9rem;
    font-size: var(--font-size-xs);
    cursor: pointer;
  }
  .vh-row:hover { background: var(--bg-hover); }
  .vh-row-current { cursor: default; }

  .vh-current {
    color: var(--accent-color);
    border: 1px solid var(--accent-color);
    border-radius: 3px;
    padding: 0 0.35rem;
    white-space: nowrap;
    flex-shrink: 0;
    font-size: var(--font-size-xs);
  }

  .vh-rev {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    min-width: 2.2em;
    flex-shrink: 0;
  }

  .vh-time {
    color: var(--text-primary);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .vh-origin {
    color: var(--text-muted);
    border: 1px solid var(--border-color);
    border-radius: 3px;
    padding: 0 0.35rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .vh-origin.origin-manual { color: var(--accent-color); border-color: var(--accent-color); }
  .vh-origin.origin-restore { color: var(--color-warning, #d69e2e); border-color: var(--color-warning, #d69e2e); }

  .vh-size {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    margin-left: auto;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .vh-cloud {
    color: #2563eb;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .vh-cloud-loading {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    white-space: nowrap;
  }

  .vh-row-cloud {
    opacity: 0.85;
  }

  .vh-cloud-only {
    color: #2563eb;
    border: 1px solid #2563eb;
    border-radius: 3px;
    padding: 0 0.35rem;
    white-space: nowrap;
    flex-shrink: 0;
    font-size: var(--font-size-xs);
  }

  .vh-restore {
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-primary);
    border-radius: 4px;
    font-size: var(--font-size-xs);
    padding: 0.15rem 0.6rem;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .vh-restore:hover:not(:disabled) { border-color: var(--accent-color); color: var(--accent-color); }
  .vh-restore:disabled { opacity: 0.5; cursor: default; }
</style>

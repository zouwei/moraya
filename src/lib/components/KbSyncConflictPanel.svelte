<script lang="ts">
  import { t } from '$lib/i18n';
  import type { KnowledgeBase } from '$lib/stores/files-store';
  import { kbSyncStore, applyResolvedContent } from '$lib/services/kb-sync/sync-service';
  import { threeWayMergeLines, twoWayMergeLines, assembleMerged } from '$lib/services/kb-sync/merge';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { KbBinding, ConflictEntry, MergeResult, ChunkPick } from '$lib/services/kb-sync/types';

  let { kb, binding, conflicts, onClose }: {
    kb: KnowledgeBase;
    binding: KbBinding;
    conflicts: ConflictEntry[];
    onClose: () => void;
  } = $props();

  let currentIndex = $state(0);
  let applying = $state(false);
  let error = $state('');

  // Per-file, per-conflict-chunk pick: Map<relativePath, Map<chunkIdx, ChunkPick>>
  let picks = $state<Map<string, Map<number, ChunkPick>>>(new Map());

  let current = $derived(conflicts[currentIndex] as ConflictEntry | undefined);

  // Compute the line-level merge for the current file. 3-way when a base exists,
  // else a 2-way local-vs-remote diff.
  let mergeResult = $derived.by<MergeResult | null>(() => {
    if (!current) return null;
    if (current.baseContent !== null && current.baseContent !== undefined) {
      return threeWayMergeLines(current.localContent, current.baseContent, current.remoteContent);
    }
    return twoWayMergeLines(current.localContent, current.remoteContent);
  });

  // Indices (within chunks[]) of the conflict chunks, for numbering.
  let conflictChunkIndices = $derived.by(() => {
    const out: number[] = [];
    mergeResult?.chunks.forEach((c, i) => { if (c.type === 'conflict') out.push(i); });
    return out;
  });

  function pickFor(chunkIdx: number): ChunkPick | undefined {
    return current ? picks.get(current.relativePath)?.get(chunkIdx) : undefined;
  }

  function setPick(chunkIdx: number, pick: ChunkPick) {
    if (!current) return;
    const next = new Map(picks);
    const fileMap = new Map(next.get(current.relativePath) ?? []);
    fileMap.set(chunkIdx, pick);
    next.set(current.relativePath, fileMap);
    picks = next;
  }

  function setAll(pick: ChunkPick) {
    if (!current || !mergeResult) return;
    const next = new Map(picks);
    const fileMap = new Map(next.get(current.relativePath) ?? []);
    mergeResult.chunks.forEach((c, i) => { if (c.type === 'conflict') fileMap.set(i, pick); });
    next.set(current.relativePath, fileMap);
    picks = next;
  }

  let unresolvedCount = $derived.by(() => {
    if (!mergeResult) return 0;
    const fileMap = current ? picks.get(current.relativePath) : undefined;
    let n = 0;
    mergeResult.chunks.forEach((c, i) => { if (c.type === 'conflict' && !fileMap?.has(i)) n++; });
    return n;
  });

  // Live merged text using current picks (unresolved default to local).
  let mergedPreview = $derived.by(() => {
    if (!mergeResult || !current) return '';
    return assembleMerged(mergeResult, picks.get(current.relativePath) ?? new Map(), 'local');
  });

  async function applyCurrent() {
    if (!current || !mergeResult || unresolvedCount > 0) return;
    applying = true;
    error = '';
    try {
      const target = settingsStore.getState().imageHostTargets.find(tg => tg.id === binding.picoraTargetId);
      if (!target) throw new Error('Picora target not found');
      const merged = assembleMerged(mergeResult, picks.get(current.relativePath) ?? new Map(), 'local');
      await applyResolvedContent(binding, kb, target, current.relativePath, merged, current.remoteUpdatedAt || undefined);
      removeCurrentFromStore();
    } catch (e) {
      error = typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Failed to apply');
    } finally {
      applying = false;
    }
  }

  function removeCurrentFromStore() {
    if (!current) return;
    const path = current.relativePath;
    const remaining = conflicts.filter(c => c.relativePath !== path);
    kbSyncStore.setState(kb.id, {
      pendingConflicts: remaining,
      conflictCount: remaining.length,
      status: remaining.length === 0 ? 'idle' : 'conflict',
    });
    if (currentIndex >= remaining.length) currentIndex = Math.max(0, remaining.length - 1);
    if (remaining.length === 0) onClose();
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="conflict-overlay" onkeydown={(e) => e.key === 'Escape' && onClose()} onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="conflict-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="dialog-header">
      <span class="dialog-icon">⚠</span>
      <h3>{$t('kb_sync.conflict.title').replace('{name}', kb.name).replace('{n}', String(conflicts.length))}</h3>
      <button class="close-btn" onclick={onClose}>&times;</button>
    </div>

    {#if conflicts.length === 0 || !current}
      <div class="dialog-body">
        <p class="empty-hint">{$t('kb_sync.conflict.no_conflicts')}</p>
      </div>
    {:else}
      <div class="nav-bar">
        <button class="nav-btn" disabled={currentIndex === 0} onclick={() => { currentIndex--; }}>‹</button>
        <span class="nav-label" title={current.relativePath}>{current.relativePath} ({currentIndex + 1}/{conflicts.length})</span>
        <button class="nav-btn" disabled={currentIndex >= conflicts.length - 1} onclick={() => { currentIndex++; }}>›</button>
      </div>

      <div class="toolbar">
        <div class="meta">
          <span class="side-tag local">{$t('kb_sync.conflict.local')}</span>
          <span class="dim">{formatBytes(current.localSizeBytes)}</span>
          <span class="side-tag remote">{$t('kb_sync.conflict.remote')}</span>
          <span class="dim">{formatBytes(current.remoteSizeBytes)}</span>
          {#if unresolvedCount > 0}
            <span class="unresolved">{$t('kb_sync.conflict.unresolved').replace('{n}', String(unresolvedCount))}</span>
          {/if}
        </div>
        <div class="bulk">
          <button class="mini" onclick={() => setAll('local')}>{$t('kb_sync.conflict.take_local')}</button>
          <button class="mini" onclick={() => setAll('remote')}>{$t('kb_sync.conflict.take_remote')}</button>
        </div>
      </div>

      <div class="merge-view">
        {#if mergeResult}
          {#each mergeResult.chunks as chunk, i (i)}
            {#if chunk.type === 'stable'}
              {#each chunk.lines ?? [] as line}
                <div class="line context">{line || ' '}</div>
              {/each}
            {:else}
              {@const pick = pickFor(i)}
              <div class="conflict-block" class:resolved={pick !== undefined}>
                <div class="conflict-actions">
                  <button class="chip" class:on={pick === 'local'} onclick={() => setPick(i, 'local')}>{$t('kb_sync.conflict.take_local')}</button>
                  <button class="chip" class:on={pick === 'remote'} onclick={() => setPick(i, 'remote')}>{$t('kb_sync.conflict.take_remote')}</button>
                  <button class="chip" class:on={pick === 'both-local-first'} onclick={() => setPick(i, 'both-local-first')}>{$t('kb_sync.conflict.take_both')}</button>
                </div>
                <div class="side local" class:muted={pick === 'remote'}>
                  {#each chunk.local ?? [] as line}
                    <div class="line add">{line || ' '}</div>
                  {/each}
                  {#if (chunk.local ?? []).length === 0}<div class="line empty">∅</div>{/if}
                </div>
                <div class="side remote" class:muted={pick === 'local'}>
                  {#each chunk.remote ?? [] as line}
                    <div class="line del">{line || ' '}</div>
                  {/each}
                  {#if (chunk.remote ?? []).length === 0}<div class="line empty">∅</div>{/if}
                </div>
              </div>
            {/if}
          {/each}
        {/if}
      </div>

      <details class="preview-wrap">
        <summary>{$t('kb_sync.conflict.merge_preview')}</summary>
        <pre class="merged-preview">{mergedPreview}</pre>
      </details>

      {#if error}
        <p class="error-text">{error}</p>
      {/if}
    {/if}

    <div class="dialog-footer">
      <button class="btn btn-ghost" onclick={onClose}>{$t('common.close')}</button>
      {#if current}
        <button
          class="btn btn-ghost"
          disabled={currentIndex >= conflicts.length - 1}
          onclick={() => { currentIndex++; }}
        >
          {$t('kb_sync.conflict.skip')}
        </button>
        <button
          class="btn btn-primary"
          disabled={unresolvedCount > 0 || applying}
          onclick={applyCurrent}
        >
          {$t('kb_sync.conflict.apply_upload')}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .conflict-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 250;
  }

  .conflict-dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    width: 760px;
    max-width: 92vw;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 12px 40px rgba(0,0,0,0.25);
  }

  .dialog-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }

  .dialog-icon { font-size: 1rem; color: var(--warning-color, #e8a838); }

  .dialog-header h3 {
    margin: 0;
    flex: 1;
    font-size: var(--font-size-base);
    font-weight: 600;
  }

  .close-btn {
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0 0.25rem;
    line-height: 1;
  }

  .nav-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border-light);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .nav-btn {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 1rem;
    color: var(--text-secondary);
    padding: 0 0.25rem;
  }
  .nav-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .nav-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4rem 1rem;
    border-bottom: 1px solid var(--border-light);
    font-size: var(--font-size-xs);
  }
  .meta { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
  .side-tag { padding: 0.05rem 0.35rem; border-radius: 3px; font-weight: 600; }
  .side-tag.local { background: color-mix(in srgb, var(--accent-color) 16%, transparent); color: var(--accent-color); }
  .side-tag.remote { background: color-mix(in srgb, #38a169 16%, transparent); color: var(--color-success, #38a169); }
  .dim { color: var(--text-muted); }
  .unresolved { color: var(--warning-color, #e8a838); font-weight: 600; }
  .bulk { display: flex; gap: 0.35rem; }
  .mini {
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    padding: 0.1rem 0.5rem;
    font-size: var(--font-size-xs);
    cursor: pointer;
  }
  .mini:hover { background: var(--bg-hover); }

  .merge-view {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
    font-family: monospace;
    font-size: var(--font-size-xs);
    min-height: 220px;
    background: var(--bg-primary);
  }

  .line {
    padding: 0 1rem;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }
  .line.context { color: var(--text-secondary); }
  .line.add { background: color-mix(in srgb, var(--accent-color) 12%, transparent); color: var(--text-primary); }
  .line.del { background: color-mix(in srgb, #38a169 12%, transparent); color: var(--text-primary); }
  .line.empty { color: var(--text-muted); font-style: italic; }

  .conflict-block {
    border-left: 3px solid var(--warning-color, #e8a838);
    margin: 0.35rem 0;
    background: color-mix(in srgb, var(--warning-color, #e8a838) 6%, transparent);
  }
  .conflict-block.resolved { border-left-color: var(--color-success, #38a169); }
  .conflict-actions { display: flex; gap: 0.35rem; padding: 0.3rem 1rem; }
  .chip {
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-secondary);
    border-radius: 4px;
    padding: 0.1rem 0.5rem;
    font-size: var(--font-size-xs);
    cursor: pointer;
  }
  .chip:hover { background: var(--bg-hover); }
  .chip.on { background: var(--accent-color); color: #fff; border-color: var(--accent-color); }
  .side.muted { opacity: 0.4; }

  .preview-wrap {
    border-top: 1px solid var(--border-light);
    padding: 0.4rem 1rem;
    font-size: var(--font-size-xs);
  }
  .preview-wrap summary { cursor: pointer; color: var(--text-secondary); }
  .merged-preview {
    margin: 0.4rem 0 0;
    max-height: 160px;
    overflow: auto;
    padding: 0.5rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    font-family: monospace;
    font-size: var(--font-size-xs);
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-secondary);
  }

  .error-text {
    padding: 0 1rem;
    font-size: var(--font-size-sm);
    color: var(--color-error, #e53e3e);
  }
  .empty-hint {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-light);
  }
  .btn {
    padding: 0.35rem 0.9rem;
    border-radius: 5px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost { background: transparent; border-color: var(--border-color); color: var(--text-secondary); }
  .btn-primary { background: var(--accent-color); color: white; }
  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
</style>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { filesStore, type KnowledgeBase } from '$lib/stores/files-store';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { KbBinding, SyncStrategy } from '$lib/services/kb-sync/types';
  import { kbSyncStore, runSync } from '$lib/services/kb-sync/sync-service';
  import { picoraApiBase } from '$lib/services/kb-sync/picora-kb-client';
  import type { KbSyncState } from '$lib/services/kb-sync/types';
  import KbPicoraBindDialog from './KbPicoraBindDialog.svelte';
  import KbSyncConflictPanel from './KbSyncConflictPanel.svelte';
  import KbSyncTrashPanel from './KbSyncTrashPanel.svelte';
  import { ask } from '@tauri-apps/plugin-dialog';

  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let kbSyncEnabled = $state(true);
  let syncStates = $state<Map<string, KbSyncState>>(new Map());
  let bindingKb = $state<KnowledgeBase | null>(null);
  let conflictKbId = $state<string | null>(null);
  let expandedKbId = $state<string | null>(null);
  let showTrash = $state(false);

  const unsub1 = filesStore.subscribe(state => { knowledgeBases = state.knowledgeBases; });
  const unsub2 = settingsStore.subscribe(state => { kbSyncEnabled = state.kbSyncEnabled ?? true; });
  const unsub3 = kbSyncStore.subscribe(map => { syncStates = map; });
  onDestroy(() => { unsub1(); unsub2(); unsub3(); });

  function getSyncState(kbId: string): KbSyncState {
    return syncStates.get(kbId) ?? {
      localKbId: kbId,
      status: 'unbound',
      conflictCount: 0,
      pendingConflicts: [],
      lastError: null,
    };
  }

  function getPicoraTarget(binding: KbBinding) {
    return settingsStore.getState().imageHostTargets.find(t => t.id === binding.picoraTargetId);
  }

  async function syncNow(kb: KnowledgeBase) {
    const binding = kb.picoraBinding;
    if (!binding) return;
    const target = getPicoraTarget(binding);
    if (!target) return;
    try {
      const report = await runSync(binding, kb, target, false, (r) => {
        filesStore.updateKbSyncReport(kb.id, {
          lastSyncAt: new Date().toISOString(),
          lastSyncReport: r,
          lastSyncError: null,
        });
      });
      if ((report.conflicts as unknown as { length: number }).length === 0 && typeof report.conflicts === 'number' && report.conflicts === 0) {
        filesStore.updateKbSyncReport(kb.id, {
          lastSyncAt: new Date().toISOString(),
          lastSyncReport: {
            uploaded: report.uploaded,
            downloaded: report.downloaded,
            deletedRemote: report.deletedRemote,
            deletedLocal: report.deletedLocal,
            skipped: report.skipped,
            conflicts: report.conflicts,
          },
          lastSyncError: null,
        });
      }
    } catch (e) {
      filesStore.updateKbSyncReport(kb.id, {
        lastSyncAt: new Date().toISOString(),
        lastSyncReport: null,
        lastSyncError: typeof e === 'string' ? e : 'Sync failed',
      });
    }
  }

  async function unbind(kb: KnowledgeBase) {
    const confirmed = await ask(
      $t('kbSync.settings.unbindConfirm').replace('{name}', kb.name),
      { title: $t('kbSync.settings.unbindTitle'), kind: 'warning' }
    );
    if (confirmed) {
      filesStore.clearKbBinding(kb.id);
    }
  }

  function saveStrategy(kb: KnowledgeBase, strategy: SyncStrategy) {
    filesStore.updateKbStrategy(kb.id, strategy);
    expandedKbId = null;
  }

  function formatDate(iso: string | null): string {
    if (!iso) return $t('kbSync.settings.never');
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  function statusIcon(kb: KnowledgeBase): string {
    const state = getSyncState(kb.id);
    if (!kb.picoraBinding) return '';
    switch (state.status) {
      case 'syncing': return '⟳';
      case 'conflict': return `⚠ ${state.conflictCount}`;
      case 'error': return '✗';
      default: return '✓';
    }
  }

  function statusClass(kb: KnowledgeBase): string {
    const state = getSyncState(kb.id);
    if (!kb.picoraBinding) return '';
    return state.status;
  }
</script>

<div class="kb-sync-settings gx-tab">
  <section class="gx-section">
    <h3 class="gx-section-title">{$t('kbSync.settings.globalSwitch')}</h3>
    <div class="gx-card">
      <div class="gx-row gx-row-check">
        <label class="gx-check">
          <input
            type="checkbox"
            checked={kbSyncEnabled}
            onchange={(e) => settingsStore.update({ kbSyncEnabled: (e.target as HTMLInputElement).checked })}
          />
          <span>{$t('kbSync.settings.globalSwitch')}</span>
        </label>
        <p class="gx-hint gx-hint-indent">{$t('kbSync.settings.globalSwitchHint')}</p>
      </div>
      <div class="gx-row gx-row-check">
        <button class="gx-btn gx-btn-sm trash-link" onclick={() => { showTrash = true; }} type="button">
          🗑 {$t('kbSync.trash.title')}
        </button>
      </div>
    </div>
  </section>

  <section class="gx-section">
    <h3 class="gx-section-title">{$t('settings.tabs.kbSync')}</h3>
    <div class="kb-list">
    {#each knowledgeBases as kb}
      <div class="kb-item">
        <div class="kb-item-header">
          <div class="kb-info">
            <span class="kb-name">{kb.name}</span>
            {#if kb.picoraBinding}
              <span class="kb-sync-status {statusClass(kb)}">
                ☁ {kb.picoraBinding.picoraKbName} {statusIcon(kb)}
              </span>
              <span class="kb-last-sync">
                {$t('kbSync.settings.lastSync')}: {formatDate(kb.picoraBinding.lastSyncAt)}
                {#if kb.picoraBinding.lastSyncReport}
                  · ↑{kb.picoraBinding.lastSyncReport.uploaded} ↓{kb.picoraBinding.lastSyncReport.downloaded}
                {/if}
                {#if kb.picoraBinding.lastSyncError}
                  <span class="sync-error" title={kb.picoraBinding.lastSyncError}>
                    ({kb.picoraBinding.lastSyncError.slice(0, 120)}{kb.picoraBinding.lastSyncError.length > 120 ? '…' : ''})
                  </span>
                {/if}
              </span>
            {:else}
              <span class="kb-unbound">{$t('kbSync.settings.unbound')}</span>
            {/if}
          </div>
          <div class="kb-actions">
            {#if kb.picoraBinding}
              {#if getSyncState(kb.id).conflictCount > 0}
                <button class="action-btn warn" onclick={() => { conflictKbId = kb.id; }}>
                  {$t('kbSync.settings.viewConflicts')} ({getSyncState(kb.id).conflictCount})
                </button>
              {/if}
              <button
                class="action-btn"
                onclick={() => syncNow(kb)}
                disabled={getSyncState(kb.id).status === 'syncing' || !kbSyncEnabled}
              >
                {getSyncState(kb.id).status === 'syncing' ? $t('kbSync.settings.syncing') : $t('kbSync.settings.syncNow')}
              </button>
              <button class="action-btn" onclick={() => { expandedKbId = expandedKbId === kb.id ? null : kb.id; }}>
                {$t('kbSync.settings.editStrategy')} {expandedKbId === kb.id ? '▲' : '▼'}
              </button>
              <button class="action-btn danger" onclick={() => unbind(kb)}>{$t('kbSync.settings.unbind')}</button>
            {:else}
              <button class="action-btn primary" onclick={() => { bindingKb = kb; }}>
                + {$t('kbSync.settings.bind')}
              </button>
            {/if}
          </div>
        </div>

        {#if kb.picoraBinding && expandedKbId === kb.id}
          {@const binding = kb.picoraBinding}
          <div class="strategy-editor">
            <div class="strategy-row">
              <label class="strategy-label" for="sync-strategy-mode">{$t('kbSync.strategy.mode')}</label>
              <select
                id="sync-strategy-mode"
                class="select-input"
                value={binding.strategy.mode}
                onchange={(e) => filesStore.updateKbStrategy(kb.id, { ...binding.strategy, mode: (e.target as HTMLSelectElement).value as SyncStrategy['mode'] })}
              >
                <option value="manual">{$t('kbSync.strategy.modeManual')}</option>
                <option value="on-save">{$t('kbSync.strategy.modeOnSave')}</option>
                <option value="interval">{$t('kbSync.strategy.modeInterval')}</option>
                <option value="on-startup-and-close">{$t('kbSync.strategy.modeStartup')}</option>
              </select>
              {#if binding.strategy.mode === 'interval'}
                <select
                  class="select-input"
                  value={binding.strategy.intervalSecs}
                  onchange={(e) => filesStore.updateKbStrategy(kb.id, { ...binding.strategy, intervalSecs: Number((e.target as HTMLSelectElement).value) as SyncStrategy['intervalSecs'] })}
                >
                  <option value={60}>{$t('kbSync.strategy.interval60')}</option>
                  <option value={300}>{$t('kbSync.strategy.interval300')}</option>
                  <option value={900}>{$t('kbSync.strategy.interval900')}</option>
                  <option value={1800}>{$t('kbSync.strategy.interval1800')}</option>
                </select>
              {/if}
            </div>
            <div class="strategy-row">
              <label class="strategy-label" for="sync-strategy-scope">{$t('kbSync.strategy.scope')}</label>
              <select
                id="sync-strategy-scope"
                class="select-input"
                value={binding.strategy.scope}
                onchange={(e) => filesStore.updateKbStrategy(kb.id, { ...binding.strategy, scope: (e.target as HTMLSelectElement).value as SyncStrategy['scope'] })}
              >
                <option value="markdown-only">{$t('kbSync.strategy.scopeMdOnly')}</option>
                <option value="markdown-plus-rules">{$t('kbSync.strategy.scopeMdRules')}</option>
                <option value="all-including-hidden">{$t('kbSync.strategy.scopeAll')}</option>
              </select>
            </div>
            <div class="strategy-row">
              <label class="strategy-label" for="sync-strategy-conflict">{$t('kbSync.strategy.conflict')}</label>
              <select
                id="sync-strategy-conflict"
                class="select-input"
                value={binding.strategy.conflictPolicy}
                onchange={(e) => filesStore.updateKbStrategy(kb.id, { ...binding.strategy, conflictPolicy: (e.target as HTMLSelectElement).value as SyncStrategy['conflictPolicy'] })}
              >
                <option value="prompt">{$t('kbSync.strategy.conflictPrompt')}</option>
                <option value="prefer-local">{$t('kbSync.strategy.conflictLocal')}</option>
                <option value="prefer-remote">{$t('kbSync.strategy.conflictRemote')}</option>
              </select>
            </div>
          </div>
        {/if}
      </div>
    {/each}
    {#if knowledgeBases.length === 0}
      <p class="empty-hint">{$t('kbSync.settings.noKbs')}</p>
    {/if}
    </div>
  </section>
</div>

{#if bindingKb}
  <KbPicoraBindDialog
    kb={bindingKb}
    onClose={() => { bindingKb = null; }}
    onBound={(binding) => {
      bindingKb = null;
    }}
  />
{/if}

{#if showTrash}
  <KbSyncTrashPanel onClose={() => { showTrash = false; }} />
{/if}

{#if conflictKbId}
  {@const conflictKb = knowledgeBases.find(k => k.id === conflictKbId)}
  {#if conflictKb && conflictKb.picoraBinding}
    <KbSyncConflictPanel
      kb={conflictKb}
      binding={conflictKb.picoraBinding}
      conflicts={getSyncState(conflictKbId).pendingConflicts}
      onClose={() => { conflictKbId = null; }}
    />
  {/if}
{/if}

<style>
  /* Layout — outer .gx-tab + .gx-section provided by settings.css.
     This file only defines visuals unique to KB sync (knowledge-base
     item rows, strategy editor). */
  .trash-link {
    align-self: flex-start;
  }
  .kb-list {
    display: flex;
    flex-direction: column;
  }
  .kb-item {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
  }
  .kb-item + .kb-item {
    margin-top: 0.4rem;
  }
  .kb-item-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.65rem 0.9rem;
  }

  .kb-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .kb-name {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .kb-sync-status {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .kb-sync-status.idle { color: var(--color-success, #38a169); }
  .kb-sync-status.conflict { color: var(--warning-color, #e8a838); }
  .kb-sync-status.error { color: var(--color-error, #e53e3e); }
  .kb-sync-status.syncing { color: var(--accent-color); }

  .kb-last-sync {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .sync-error {
    color: var(--color-error, #e53e3e);
  }

  .kb-unbound {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .kb-actions {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .action-btn {
    padding: 3px 10px;
    border: 1px solid var(--border-color);
    border-radius: 5px;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    font-family: inherit;
    cursor: pointer;
    transition: background 0.1s ease, color 0.1s ease, border-color 0.1s ease;
    white-space: nowrap;
  }

  .action-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--text-muted);
  }
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-btn.primary {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: white;
  }
  .action-btn.primary:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
    color: white;
  }
  .action-btn.warn { border-color: var(--warning-color, #e8a838); color: var(--warning-color, #e8a838); }
  .action-btn.danger { border-color: #e57373; color: #c62828; }
  .action-btn.danger:hover:not(:disabled) {
    background: color-mix(in srgb, #dc3545 10%, transparent);
    color: #c62828;
    border-color: #e57373;
  }

  .strategy-editor {
    padding: 0.65rem 0.9rem 0.85rem;
    border-top: 1px solid var(--border-light);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .strategy-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .strategy-label {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    width: 88px;
    flex-shrink: 0;
  }

  .select-input {
    padding: 4px 8px;
    border: 1px solid var(--border-color);
    border-radius: 5px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: inherit;
  }

  .empty-hint {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    text-align: center;
    padding: 1.25rem 1rem;
  }
</style>

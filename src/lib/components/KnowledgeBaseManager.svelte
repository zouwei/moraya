<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { filesStore, type KnowledgeBase } from '../stores/files-store';
  import { settingsStore } from '$lib/stores/settings-store';
  import { open, ask } from '$lib/utils/native-dialog';
  import { t } from '$lib/i18n';
  import { checkGitInstalled, deleteGitToken } from '$lib/services/git';
  import GitBindDialog from './GitBindDialog.svelte';
  import KbPicoraBindDialog from './KbPicoraBindDialog.svelte';
  import KbMemoryAssetPanel from './KbMemoryAssetPanel.svelte';
  import { kbSyncStore } from '$lib/services/kb-sync/sync-service';
  import type { KbSyncState } from '$lib/services/kb-sync/types';

  let { onClose }: { onClose: () => void } = $props();

  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let editingId = $state<string | null>(null);
  let editingName = $state('');
  let editInputEl = $state<HTMLInputElement | null>(null);
  let gitAvailable = $state<boolean | null>(null);
  let bindingKb = $state<KnowledgeBase | null>(null);
  let picoraBindingKb = $state<KnowledgeBase | null>(null);
  let syncStates = $state<Map<string, KbSyncState>>(new Map());
  // Which KB's inline "AI memory asset" panel is expanded (Picora-bound KBs).
  let memoryExpandedId = $state<string | null>(null);
  // Which KB's "…" overflow menu (rename / delete) is open.
  let openMenuId = $state<string | null>(null);

  const unsubSync = kbSyncStore.subscribe(map => { syncStates = map; });
  onDestroy(() => { unsubSync(); });

  function handleWindowClick(e: MouseEvent) {
    if (!(e.target as HTMLElement).closest('.kb-more')) openMenuId = null;
  }
  onMount(() => { window.addEventListener('click', handleWindowClick); });
  onDestroy(() => { window.removeEventListener('click', handleWindowClick); });

  // Top-level store subscription — do NOT wrap in $effect().
  // Svelte 5 $effect tracks reads in subscribe callbacks, causing infinite loops.
  const unsubFiles = filesStore.subscribe(state => {
    knowledgeBases = state.knowledgeBases;
  });
  onDestroy(() => { unsubFiles(); });

  async function addKnowledgeBase() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: $t('knowledge_base.add'),
    });

    if (selected && typeof selected === 'string') {
      // Check if already exists
      if (filesStore.findKnowledgeBaseByPath(selected)) return;

      const name = selected.split('/').pop() || selected;
      const kb: KnowledgeBase = {
        id: crypto.randomUUID(),
        name,
        path: selected,
        lastAccessedAt: Date.now(),
      };
      filesStore.addKnowledgeBase(kb);

      // If a Picora account is already configured, immediately open the sync
      // bind dialog for the new KB so the user can wire it to the cloud in one flow.
      const hasPicoraAccount = settingsStore.getState().imageHostTargets
        .some(t => t.provider === 'picora');
      if (hasPicoraAccount) {
        picoraBindingKb = kb;
      }
    }
  }

  async function removeKnowledgeBase(kb: KnowledgeBase) {
    const confirmed = await ask(
      $t('knowledge_base.delete_confirm').replace('{name}', kb.name),
      { title: $t('knowledge_base.remove'), kind: 'warning' }
    );
    if (confirmed) {
      filesStore.removeKnowledgeBase(kb.id);
    }
  }

  function startRename(kb: KnowledgeBase) {
    editingId = kb.id;
    editingName = kb.name;
    setTimeout(() => editInputEl?.focus(), 50);
  }

  function confirmRename() {
    if (editingId && editingName.trim()) {
      filesStore.renameKnowledgeBase(editingId, editingName.trim());
    }
    editingId = null;
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      confirmRename();
    } else if (e.key === 'Escape') {
      editingId = null;
    }
  }

  function formatDate(ts: number): string {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString();
  }

  // Check git availability on mount
  $effect(() => {
    checkGitInstalled().then(ok => { gitAvailable = ok; }).catch(() => { gitAvailable = false; });
  });

  async function unbindGit(kb: KnowledgeBase) {
    if (!kb.git) return;
    const confirmed = await ask(
      $t('git.unbind_confirm').replace('{name}', kb.name),
      { title: $t('git.unbind_title'), kind: 'warning' }
    );
    if (confirmed) {
      await deleteGitToken(kb.git.configId).catch(() => {});
      filesStore.updateKnowledgeBase(kb.id, { git: undefined });
    }
  }

  function shortenUrl(url: string): string {
    return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
  }


  function picoraButtonClass(kb: KnowledgeBase): string {
    if (!kb.picoraBinding) return '';
    const state = syncStates.get(kb.id);
    if (!state) return 'picora-ok';
    if (state.status === 'conflict') return 'picora-warn';
    if (state.status === 'error') return 'picora-err';
    if (state.status === 'syncing') return 'picora-sync';
    return 'picora-ok';
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="kb-overlay" onkeydown={(e) => e.key === 'Escape' && onClose()} onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="kb-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="kb-dialog-header">
      <h3>{$t('knowledge_base.title')}</h3>
      <button class="kb-dialog-close" onclick={onClose}>&times;</button>
    </div>

    <div class="kb-dialog-body">
      {#if knowledgeBases.length === 0}
        <div class="kb-empty">
          <p>{$t('knowledge_base.empty')}</p>
          <p class="kb-empty-hint">{$t('knowledge_base.empty_hint')}</p>
        </div>
      {:else}
        <div class="kb-list">
          {#each knowledgeBases as kb}
            {@const gitBound = !!kb.git}
            {@const picoraBound = !!kb.picoraBinding}
            {@const picoraBlocked = !picoraBound && gitBound}
            {@const gitBlocked = !gitBound && picoraBound}
            <div class="kb-row-wrap">
            <div class="kb-list-item">
              <div class="kb-list-info">
                {#if editingId === kb.id}
                  <input
                    bind:this={editInputEl}
                    class="kb-rename-input"
                    bind:value={editingName}
                    onkeydown={handleRenameKeydown}
                    onblur={confirmRename}
                  />
                {:else}
                  <span class="kb-list-name" role="button" tabindex="0"
                    onclick={async () => {
                      const result = await filesStore.setActiveKnowledgeBase(kb.id);
                      if (result.success) { onClose(); }
                    }}
                    onkeydown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}
                  >{kb.name}</span>
                {/if}
                <span class="kb-list-path" title={kb.path}>{kb.path}</span>
                {#if kb.git}
                  <span class="kb-git-info" title={kb.git.remoteUrl}>
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
                    {shortenUrl(kb.git.remoteUrl)}
                  </span>
                {/if}
              </div>
              <div class="kb-list-actions">
                <button
                  class="kb-action-btn kb-picora-btn {picoraButtonClass(kb)}"
                  onclick={() => { if (!picoraBlocked) picoraBindingKb = kb; }}
                  disabled={picoraBlocked}
                  title={picoraBlocked ? $t('kb_sync.card.unbind_git_first') : (picoraBound ? $t('kb_sync.card.settings') : $t('kb_sync.card.bind'))}
                >
                  <span class="picora-icon"><svg width="13" height="13" viewBox="8 6 16 20" fill="none" style="vertical-align:-1px;display:inline-block" aria-hidden="true"><path d="M9.5 7.5v17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="14" r="6.5" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="14" r="2.4" fill="currentColor"/></svg></span>{#if kb.picoraBinding}{@const _s = syncStates.get(kb.id)}{#if _s?.status === 'conflict'} ⚠{_s.conflictCount}{:else if _s?.status === 'error'} ✗{:else if _s?.status === 'syncing'}{:else} {kb.picoraBinding.picoraKbName.slice(0, 12)}{/if}{/if}
                </button>
                {#if kb.git}
                  <button class="kb-action-btn" onclick={() => unbindGit(kb)} title={$t('git.unbind')}>
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M4.28 3.22a.75.75 0 00-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 101.06 1.06L8 9.06l3.72 3.72a.75.75 0 101.06-1.06L9.06 8l3.72-3.72a.75.75 0 00-1.06-1.06L8 6.94 4.28 3.22z"/></svg>
                  </button>
                {:else if gitAvailable}
                  <button class="kb-action-btn" onclick={() => { if (!gitBlocked) bindingKb = kb; }} disabled={gitBlocked} title={gitBlocked ? $t('git.unbind_picora_first') : $t('git.bind')}>
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25V5.372a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/></svg>
                  </button>
                {/if}
                {#if picoraBound}
                  <button
                    class="kb-action-btn"
                    class:active={memoryExpandedId === kb.id}
                    onclick={() => memoryExpandedId = memoryExpandedId === kb.id ? null : kb.id}
                    title={$t('kb_sync.settings.memory_asset')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>
                  </button>
                {/if}
                <div class="kb-more">
                  <button class="kb-action-btn" onclick={(e) => { e.stopPropagation(); openMenuId = openMenuId === kb.id ? null : kb.id; }} title={$t('knowledge_base.more')}>
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>
                  </button>
                  {#if openMenuId === kb.id}
                    <div class="kb-more-menu">
                      <button class="kb-more-item" onclick={() => { openMenuId = null; startRename(kb); }}>{$t('knowledge_base.rename')}</button>
                      <button class="kb-more-item danger" onclick={() => { openMenuId = null; removeKnowledgeBase(kb); }}>{$t('knowledge_base.remove')}</button>
                    </div>
                  {/if}
                </div>
              </div>
            </div>
            {#if memoryExpandedId === kb.id}
              <KbMemoryAssetPanel {kb} />
            {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="kb-dialog-footer">
      <button class="kb-add-btn" onclick={addKnowledgeBase}>
        + {$t('knowledge_base.add')}
      </button>
    </div>
  </div>
</div>

{#if bindingKb}
  <GitBindDialog kb={bindingKb} onClose={() => { bindingKb = null; }} />
{/if}

{#if picoraBindingKb}
  <KbPicoraBindDialog
    kb={picoraBindingKb}
    onClose={() => { picoraBindingKb = null; }}
    onBound={() => { picoraBindingKb = null; }}
  />
{/if}

<style>
  .kb-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .kb-dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    width: 460px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }

  .kb-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }

  .kb-dialog-header h3 {
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
  }

  .kb-dialog-close {
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0 0.25rem;
    line-height: 1;
  }

  .kb-dialog-close:hover {
    color: var(--text-primary);
  }

  .kb-dialog-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
  }

  .kb-empty {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .kb-empty-hint {
    margin-top: 0.5rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .kb-list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 1rem;
    gap: 0.5rem;
  }

  .kb-list-item:hover {
    background: var(--bg-hover);
  }

  .kb-list-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1;
  }

  .kb-list-name {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .kb-list-name:hover {
    color: var(--accent-color, #0969da);
  }

  .kb-list-path {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kb-rename-input {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--accent-color);
    border-radius: 3px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-weight: 600;
    outline: none;
    width: 100%;
  }

  .kb-list-actions {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .kb-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 3px;
  }

  .kb-action-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .kb-action-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .kb-action-btn.active {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .kb-action-danger:hover {
    color: var(--color-danger, #ef4444);
  }

  .kb-row-wrap {
    display: flex;
    flex-direction: column;
  }

  .kb-more {
    position: relative;
    display: inline-flex;
  }

  .kb-more-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 2px;
    min-width: 120px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    z-index: 20;
    padding: 0.25rem;
    display: flex;
    flex-direction: column;
  }

  .kb-more-item {
    text-align: left;
    padding: 0.4rem 0.6rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    border-radius: 4px;
    cursor: pointer;
  }

  .kb-more-item:hover {
    background: var(--bg-hover);
  }

  .kb-more-item.danger {
    color: var(--color-danger, #ef4444);
  }

  .kb-dialog-footer {
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .kb-add-btn {
    width: 100%;
    padding: 0.4rem;
    border: 1px dashed var(--border-color);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 5px;
    cursor: pointer;
    font-size: var(--font-size-sm);
  }

  .kb-add-btn:hover {
    border-color: var(--accent-color);
    color: var(--accent-color);
    background: var(--bg-hover);
  }

  .kb-git-info {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kb-git-info svg {
    flex-shrink: 0;
  }

  .kb-picora-btn {
    font-size: var(--font-size-xs);
    padding: 0 0.4rem;
    border-radius: 3px;
    border: 1px solid var(--border-color) !important;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* Override the fixed 1.5rem width inherited from .kb-action-btn so the bound-state
       label (kbName suffix) is not truncated. Unbound state shows lens icon only. */
    width: auto;
    min-width: 1.5rem;
    max-width: 140px;
  }

  .kb-picora-btn.picora-ok { color: var(--color-success, #38a169); border-color: var(--color-success, #38a169) !important; }
  .kb-picora-btn.picora-warn { color: var(--warning-color, #e8a838); border-color: var(--warning-color, #e8a838) !important; }
  .kb-picora-btn.picora-err { color: var(--color-error, #e53e3e); border-color: var(--color-error, #e53e3e) !important; }
  .kb-picora-btn.picora-sync { color: var(--accent-color); border-color: var(--accent-color) !important; }

  .picora-icon {
    display: inline-block;
    transform-origin: center;
  }
  /* Syncing → breathing-light on the Picora glyph (matches the sidebar &
     status bar sync indicators): opacity + subtle scale pulse with a soft
     accent halo, replacing the old rotation-looking ⟳ glyph. */
  .kb-picora-btn.picora-sync .picora-icon {
    animation: kb-sync-breathe 1.6s ease-in-out infinite;
  }
  @keyframes kb-sync-breathe {
    0%, 100% {
      opacity: 0.45;
      transform: scale(0.9);
      filter: drop-shadow(0 0 0 transparent);
    }
    50% {
      opacity: 1;
      transform: scale(1.1);
      filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent-color) 55%, transparent));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .kb-picora-btn.picora-sync .picora-icon { animation: none; opacity: 0.75; }
  }
</style>

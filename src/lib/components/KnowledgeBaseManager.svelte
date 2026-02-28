<script lang="ts">
  import { onDestroy } from 'svelte';
  import { filesStore, type KnowledgeBase } from '../stores/files-store';
  import { open, ask } from '@tauri-apps/plugin-dialog';
  import { t } from '$lib/i18n';

  let { onClose }: { onClose: () => void } = $props();

  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let editingId = $state<string | null>(null);
  let editingName = $state('');
  let editInputEl = $state<HTMLInputElement | null>(null);

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
      title: $t('knowledgeBase.add'),
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
    }
  }

  async function removeKnowledgeBase(kb: KnowledgeBase) {
    const confirmed = await ask(
      $t('knowledgeBase.deleteConfirm').replace('{name}', kb.name),
      { title: $t('knowledgeBase.remove'), kind: 'warning' }
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
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="kb-overlay" onkeydown={(e) => e.key === 'Escape' && onClose()} onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="kb-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="kb-dialog-header">
      <h3>{$t('knowledgeBase.title')}</h3>
      <button class="kb-dialog-close" onclick={onClose}>&times;</button>
    </div>

    <div class="kb-dialog-body">
      {#if knowledgeBases.length === 0}
        <div class="kb-empty">
          <p>{$t('knowledgeBase.empty')}</p>
          <p class="kb-empty-hint">{$t('knowledgeBase.emptyHint')}</p>
        </div>
      {:else}
        <div class="kb-list">
          {#each knowledgeBases as kb}
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
              </div>
              <div class="kb-list-actions">
                <button class="kb-action-btn" onclick={() => startRename(kb)} title={$t('knowledgeBase.rename')}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zM11.189 3.5L3 11.689v.001l-.59 2.058 2.058-.59L12.657 4.97 11.19 3.5z"/></svg>
                </button>
                <button class="kb-action-btn kb-action-danger" onclick={() => removeKnowledgeBase(kb)} title={$t('knowledgeBase.remove')}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 0V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675a.75.75 0 10-1.492.15l.66 6.6A1.75 1.75 0 005.405 15h5.19a1.75 1.75 0 001.741-1.575l.66-6.6a.75.75 0 00-1.492-.15l-.66 6.6a.25.25 0 01-.249.225h-5.19a.25.25 0 01-.249-.225l-.66-6.6z"/></svg>
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="kb-dialog-footer">
      <button class="kb-add-btn" onclick={addKnowledgeBase}>
        + {$t('knowledgeBase.add')}
      </button>
    </div>
  </div>
</div>

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

  .kb-action-danger:hover {
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
</style>

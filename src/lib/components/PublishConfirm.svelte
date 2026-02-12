<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { PublishTarget } from '$lib/services/publish/types';

  let {
    onClose,
    onConfirm,
  }: {
    onClose: () => void;
    onConfirm: (targetIds: string[]) => void;
  } = $props();

  const tr = $t;

  let targets = $state<PublishTarget[]>([]);
  let selectedIds = $state<Set<string>>(new Set());

  settingsStore.subscribe(state => {
    targets = state.publishTargets || [];
  });

  function toggleTarget(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    selectedIds = next;
  }

  function handleConfirm() {
    if (selectedIds.size === 0) return;
    onConfirm(Array.from(selectedIds));
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onclick={onClose}>
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    <div class="dialog-header">
      <h3>{tr('workflow.selectTargets')}</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>

    <div class="dialog-body">
      {#if targets.length === 0}
        <div class="empty-state">
          <p>{tr('publish.settingsEmpty')}</p>
          <p class="hint">{tr('publish.settingsHint')}</p>
        </div>
      {:else}
        <div class="target-list">
          {#each targets as target (target.id)}
            <label class="target-item">
              <input
                type="checkbox"
                checked={selectedIds.has(target.id)}
                onchange={() => toggleTarget(target.id)}
              />
              <span class="target-icon">
                {target.type === 'github' ? '🔵' : '🟣'}
              </span>
              <div class="target-info">
                <span class="target-name">{target.name || '(unnamed)'}</span>
                <span class="target-type">
                  {target.type === 'github' ? tr('publish.github') : tr('publish.customApi')}
                </span>
              </div>
            </label>
          {/each}
        </div>
      {/if}
    </div>

    <div class="dialog-footer">
      <button class="btn btn-secondary" onclick={onClose}>{tr('common.cancel')}</button>
      <button
        class="btn btn-primary"
        onclick={handleConfirm}
        disabled={selectedIds.size === 0}
      >
        {tr('workflow.confirmPublish')}
      </button>
    </div>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    width: 380px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
    overflow: hidden;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }

  .dialog-header h3 {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
  }

  .close-btn {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1.1rem;
  }

  .dialog-body {
    padding: 0.75rem 1rem;
    max-height: 300px;
    overflow-y: auto;
  }

  .empty-state {
    text-align: center;
    padding: 1.5rem;
    color: var(--text-muted);
  }

  .empty-state p {
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .empty-state .hint {
    font-size: var(--font-size-xs);
    margin-top: 0.5rem;
  }

  .target-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .target-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color var(--transition-fast);
  }

  .target-item:hover {
    border-color: var(--accent-color);
  }

  .target-item input[type="checkbox"] {
    accent-color: var(--accent-color);
  }

  .target-icon {
    font-size: 0.85rem;
  }

  .target-info {
    display: flex;
    flex-direction: column;
  }

  .target-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
  }

  .target-type {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .btn {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-sm);
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .btn-secondary {
    background: var(--bg-primary);
    color: var(--text-secondary);
  }

  .btn-primary {
    background: var(--accent-color);
    color: white;
    border-color: var(--accent-color);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

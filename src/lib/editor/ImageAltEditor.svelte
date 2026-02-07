<script lang="ts">
  import { t } from '$lib/i18n';

  let {
    position,
    initialValue,
    onSave,
    onCancel,
  }: {
    position: { top: number; left: number };
    initialValue: string;
    onSave: (value: string) => void;
    onCancel: () => void;
  } = $props();

  const tr = $t;
  // eslint-disable-next-line svelte/state-referenced-locally -- intentional initial capture
  let value = $state(initialValue);
  let inputEl: HTMLInputElement | undefined = $state();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSave(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  $effect(() => {
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="alt-editor-backdrop" onclick={onCancel}>
  <div
    class="alt-editor"
    style="top: {position.top}px; left: {position.left}px"
    onclick={(e) => e.stopPropagation()}
  >
    <label class="alt-label">{tr('imageMenu.editAlt')}</label>
    <input
      bind:this={inputEl}
      bind:value
      type="text"
      placeholder={tr('imageMenu.editAlt')}
      onkeydown={handleKeydown}
    />
    <div class="alt-actions">
      <button class="btn-cancel" onclick={onCancel}>{tr('common.cancel')}</button>
      <button class="btn-save" onclick={() => onSave(value)}>{tr('common.save')}</button>
    </div>
  </div>
</div>

<style>
  .alt-editor-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
  }

  .alt-editor {
    position: fixed;
    min-width: 260px;
    padding: 0.75rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 61;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .alt-label {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    font-weight: 500;
  }

  input {
    width: 100%;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    outline: none;
    box-sizing: border-box;
  }

  input:focus {
    border-color: var(--accent-color);
  }

  .alt-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .btn-cancel,
  .btn-save {
    padding: 0.25rem 0.75rem;
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .btn-cancel {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .btn-save {
    background: var(--accent-color);
    color: white;
  }

  .btn-cancel:hover {
    background: var(--border-color);
  }

  .btn-save:hover {
    opacity: 0.9;
  }
</style>

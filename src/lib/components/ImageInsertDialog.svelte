<script lang="ts">
  import { t } from '$lib/i18n';
  import { openImageFile } from '$lib/services/file-service';

  let {
    onInsert,
    onClose,
  }: {
    onInsert: (data: { src: string; alt: string }) => void;
    onClose: () => void;
  } = $props();

  type TabMode = 'url' | 'file';
  let activeTab = $state<TabMode>('url');
  let imageUrl = $state('');
  let filePath = $state('');
  let altText = $state('');

  const tr = $t;

  let currentSrc = $derived(activeTab === 'url' ? imageUrl.trim() : filePath);
  let canInsert = $derived(currentSrc.length > 0);

  async function handleSelectFile() {
    const selected = await openImageFile();
    if (selected) {
      filePath = selected;
    }
  }

  function handleInsert() {
    if (!canInsert) return;
    onInsert({ src: currentSrc, alt: altText.trim() });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      onClose();
    } else if (event.key === 'Enter' && canInsert) {
      event.preventDefault();
      handleInsert();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onclick={onClose} onkeydown={handleKeydown}>
  <div class="dialog-panel" onclick={(e) => e.stopPropagation()}>
    <h3 class="dialog-title">{tr('imageDialog.title')}</h3>

    <div class="tab-bar">
      <button
        class="tab-btn"
        class:active={activeTab === 'url'}
        onclick={() => activeTab = 'url'}
      >
        {tr('imageDialog.urlTab')}
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === 'file'}
        onclick={() => activeTab = 'file'}
      >
        {tr('imageDialog.fileTab')}
      </button>
    </div>

    <div class="dialog-body">
      {#if activeTab === 'url'}
        <div class="field">
          <input
            type="text"
            class="text-input"
            placeholder={tr('imageDialog.urlPlaceholder')}
            bind:value={imageUrl}
          />
        </div>
      {:else}
        <div class="field file-field">
          <button class="file-btn" onclick={handleSelectFile}>
            {tr('imageDialog.selectFile')}
          </button>
          <span class="file-path" title={filePath}>
            {filePath || tr('imageDialog.noFileSelected')}
          </span>
        </div>
      {/if}

      <div class="field">
        <input
          type="text"
          class="text-input"
          placeholder={tr('imageDialog.altPlaceholder')}
          bind:value={altText}
        />
      </div>
    </div>

    <div class="dialog-actions">
      <button class="btn btn-secondary" onclick={onClose}>
        {tr('imageDialog.cancel')}
      </button>
      <button class="btn btn-primary" disabled={!canInsert} onclick={handleInsert}>
        {tr('imageDialog.insert')}
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

  .dialog-panel {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    width: 480px;
    padding: 1.5rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  }

  .dialog-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    margin: 0 0 1rem;
    color: var(--text-primary);
  }

  .tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border-light);
    margin-bottom: 1rem;
  }

  .tab-btn {
    flex: 1;
    padding: 0.5rem 1rem;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color var(--transition-fast), border-color var(--transition-fast);
  }

  .tab-btn:hover {
    color: var(--text-primary);
  }

  .tab-btn.active {
    color: var(--accent-color);
    border-bottom-color: var(--accent-color);
  }

  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }

  .field {
    display: flex;
    flex-direction: column;
  }

  .text-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    outline: none;
    transition: border-color var(--transition-fast);
    box-sizing: border-box;
  }

  .text-input:focus {
    border-color: var(--accent-color);
  }

  .text-input::placeholder {
    color: var(--text-muted);
  }

  .file-field {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }

  .file-btn {
    flex-shrink: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .file-btn:hover {
    background: var(--bg-hover);
  }

  .file-path {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .btn {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 6px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    transition: background var(--transition-fast), opacity var(--transition-fast);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .btn-primary {
    background: var(--accent-color);
    color: #fff;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }
</style>

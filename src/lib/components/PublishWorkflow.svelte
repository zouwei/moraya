<script lang="ts">
  import { t } from '$lib/i18n';

  let {
    onClose,
    onSEO,
    onImageGen,
    onPublish,
    seoCompleted = false,
    imageGenCompleted = false,
  }: {
    onClose: () => void;
    onSEO: () => void;
    onImageGen: () => void;
    onPublish: () => void;
    seoCompleted?: boolean;
    imageGenCompleted?: boolean;
  } = $props();

  const tr = $t;
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="workflow-backdrop" onclick={onClose}>
  <div class="workflow-panel" onclick={(e) => e.stopPropagation()}>
    <div class="panel-header">
      <h3>{tr('workflow.title')}</h3>
      <button class="close-btn" onclick={onClose} aria-label="Close">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path fill="currentColor" d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z"/>
        </svg>
      </button>
    </div>

    <div class="step-list">
      <!-- SEO step -->
      <button class="step-item" class:done={seoCompleted} onclick={onSEO}>
        <span class="step-icon">✦</span>
        <div class="step-info">
          <span class="step-title">{tr('workflow.seoStep')}</span>
          <span class="step-desc">{tr('seo.stepDescription')}</span>
        </div>
        {#if seoCompleted}<span class="step-done">✅</span>{/if}
      </button>

      <!-- Image Gen step -->
      <button class="step-item" class:done={imageGenCompleted} onclick={onImageGen}>
        <span class="step-icon">🎨</span>
        <div class="step-info">
          <span class="step-title">{tr('workflow.imageGenStep')}</span>
          <span class="step-desc">{tr('imageGen.stepDescription')}</span>
        </div>
        {#if imageGenCompleted}<span class="step-done">✅</span>{/if}
      </button>

      <!-- Publish step -->
      <button class="step-item" onclick={onPublish}>
        <span class="step-icon">📤</span>
        <div class="step-info">
          <span class="step-title">{tr('workflow.publishStep')}</span>
          <span class="step-desc">{tr('workflow.publishDesc')}</span>
        </div>
      </button>
    </div>
  </div>
</div>

<style>
  .workflow-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
  }

  .workflow-panel {
    position: fixed;
    bottom: 28px; /* above StatusBar */
    right: 1rem;
    width: 300px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12);
    z-index: 101;
    animation: slideUp 0.15s ease-out;
  }

  /* iPadOS: flush with StatusBar top border (40px height + 1px border-top) */
  :global(.platform-ipados) .workflow-panel {
    bottom: 41px;
  }

  @keyframes slideUp {
    from { transform: translateY(10px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--border-light);
  }

  .panel-header h3 {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 3px;
  }

  .close-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .step-list {
    padding: 0.5rem;
  }

  .step-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.6rem 0.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 6px;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .step-item:hover {
    background: var(--bg-hover);
  }

  .step-icon {
    font-size: 0.9rem;
    flex-shrink: 0;
    width: 1.2rem;
    text-align: center;
  }

  .step-item.done .step-title {
    color: var(--text-muted);
  }

  .step-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1;
  }

  .step-title {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
  }

  .step-desc {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .step-done {
    font-size: 0.85rem;
    flex-shrink: 0;
  }

</style>

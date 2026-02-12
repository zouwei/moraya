<script lang="ts">
  import { t } from '$lib/i18n';

  let {
    position,
    currentWidth,
    onResize,
    onClose,
  }: {
    position: { top: number; left: number };
    currentWidth: string;
    onResize: (width: string) => void;
    onClose: () => void;
  } = $props();

  const tr = $t;

  const sizeOptions = [
    { label: '25%', value: '25%' },
    { label: '50%', value: '50%' },
    { label: '75%', value: '75%' },
    { label: '100%', value: '100%' },
    { label: tr('imageMenu.originalSize'), value: '' },
  ];

  function handleResize(value: string) {
    onResize(value);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="toolbar-backdrop" onclick={onClose}>
  <div
    class="image-toolbar"
    style="top: {position.top}px; left: {position.left}px"
    onclick={(e) => e.stopPropagation()}
  >
    {#each sizeOptions as opt}
      <button
        class="size-btn"
        class:active={currentWidth === opt.value}
        onclick={() => handleResize(opt.value)}
        title={opt.value || tr('imageMenu.originalSize')}
      >
        {opt.label}
      </button>
    {/each}
  </div>
</div>

<style>
  .toolbar-backdrop {
    position: fixed;
    inset: 0;
    z-index: 55;
  }

  .image-toolbar {
    position: fixed;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    z-index: 56;
    transform: translateX(-50%);
  }

  .size-btn {
    padding: 3px 8px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    border-radius: 4px;
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
    white-space: nowrap;
  }

  .size-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .size-btn.active {
    background: var(--accent-color);
    color: white;
  }
</style>

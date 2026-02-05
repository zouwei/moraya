<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { editorStore } from '../stores/editor-store';
  import { t } from '$lib/i18n';

  let {
    title = 'Moraya',
  }: {
    title?: string;
  } = $props();

  let isMaximized = $state(false);

  const appWindow = getCurrentWindow();

  async function checkMaximized() {
    isMaximized = await appWindow.isMaximized();
  }

  function handleMinimize() {
    appWindow.minimize();
  }

  function handleMaximize() {
    appWindow.toggleMaximize();
    checkMaximized();
  }

  function handleClose() {
    appWindow.close();
  }

  // Derive display title
  let isDirty = $derived(false);
  editorStore.subscribe(state => {
    isDirty = state.isDirty;
  });

  let displayTitle = $derived(isDirty ? `${title} - ${$t('titlebar.unsaved')}` : title);

  // Sync native window title so macOS Window menu and Dock show the document name
  $effect(() => {
    appWindow.setTitle(displayTitle);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="titlebar no-select" data-tauri-drag-region>
  <div class="titlebar-left">
    <span class="app-name">Moraya</span>
  </div>

  <div class="titlebar-center" data-tauri-drag-region>
    <span class="title-text">{displayTitle}</span>
  </div>

  <div class="titlebar-right">
    <button class="titlebar-btn" onclick={handleMinimize} title={$t('titlebar.minimize')}>
      <svg width="10" height="1" viewBox="0 0 10 1">
        <rect fill="currentColor" width="10" height="1"/>
      </svg>
    </button>
    <button class="titlebar-btn" onclick={handleMaximize} title={$t('titlebar.maximize')}>
      {#if isMaximized}
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path fill="currentColor" d="M2 0h6v2H2zM0 2h8v8H0zM1 3h6v6H1z" fill-rule="evenodd"/>
        </svg>
      {:else}
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect stroke="currentColor" fill="none" x="0.5" y="0.5" width="9" height="9" rx="0.5"/>
        </svg>
      {/if}
    </button>
    <button class="titlebar-btn close" onclick={handleClose} title={$t('titlebar.close')}>
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path fill="currentColor" d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z"/>
      </svg>
    </button>
  </div>
</div>

<style>
  .titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--titlebar-height);
    background: var(--bg-titlebar);
    border-bottom: 1px solid var(--border-light);
    padding: 0 0.5rem;
    -webkit-app-region: drag;
  }

  .titlebar-left {
    flex: 0 0 auto;
    padding-left: 0.5rem;
    /* macOS: leave space for traffic lights */
  }

  .app-name {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .titlebar-center {
    flex: 1;
    text-align: center;
    -webkit-app-region: drag;
  }

  .title-text {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  .titlebar-right {
    display: flex;
    gap: 0;
    -webkit-app-region: no-drag;
  }

  .titlebar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: var(--titlebar-height);
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .titlebar-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .titlebar-btn.close:hover {
    background: #e81123;
    color: white;
  }

  /* macOS: hide custom buttons, use native traffic lights */
  :global(.platform-macos) .titlebar-right {
    display: none;
  }

  :global(.platform-macos) .titlebar-left {
    padding-left: 5rem; /* space for traffic lights */
  }
</style>

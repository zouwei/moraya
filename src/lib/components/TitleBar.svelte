<script lang="ts">
  import { onDestroy } from 'svelte';
  import { editorStore } from '../stores/editor-store';
  import type { TabItem } from '../stores/tabs-store';
  import { t } from '$lib/i18n';
  import { isTauri, isMacOS } from '$lib/utils/platform';
  import { getCurrentWindow, type Window as TauriWindow } from '@tauri-apps/api/window';

  let {
    title = 'Moraya',
    tabs = [] as TabItem[],
    activeTabId = '',
    onSwitchTab = (_id: string) => {},
    onCloseTab = (_tab: TabItem) => {},
    onNewFile = () => {},
    onOpenFile = () => {},
  }: {
    title?: string;
    tabs?: TabItem[];
    activeTabId?: string;
    onSwitchTab?: (id: string) => void;
    onCloseTab?: (tab: TabItem) => void;
    onNewFile?: () => void;
    onOpenFile?: () => void;
  } = $props();

  let isMaximized = $state(false);

  // Tauri window API (null in plain browser for iPad testing)
  const appWindow: TauriWindow | null = isTauri ? getCurrentWindow() : null;

  async function checkMaximized() {
    if (appWindow) isMaximized = await appWindow.isMaximized();
  }

  function handleMinimize() {
    appWindow?.minimize();
  }

  function handleMaximize() {
    appWindow?.toggleMaximize();
    checkMaximized();
  }

  function handleClose() {
    appWindow?.close();
  }

  // macOS Overlay: data-tauri-drag-region doesn't propagate to children,
  // so clicking on <span class="title-text"> won't trigger dragging.
  // Use explicit startDragging() on mousedown for reliable window dragging.
  function handleDragStart(event: MouseEvent) {
    if (event.button !== 0) return; // Only left mouse button
    if ((event.target as HTMLElement).closest('button')) return;
    if ((event.target as HTMLElement).closest('.tab-item')) return;
    // Skip drag on double-click (detail >= 2): macOS startDragging() handles
    // double-click-to-maximize natively, and our ondblclick handler also calls
    // toggleMaximize — triggering both would double-toggle (maximize then restore).
    if (event.detail >= 2) return;
    appWindow?.startDragging();
  }

  function handleDblClick(event: MouseEvent) {
    if ((event.target as HTMLElement).closest('button')) return;
    if ((event.target as HTMLElement).closest('.tab-item')) return;
    // On macOS, startDragging() already handles double-click-to-maximize natively.
    // Only call toggleMaximize on non-macOS platforms.
    if (!isMacOS) {
      handleMaximize();
    }
  }

  // Track dirty state from store — top-level subscribe, do NOT wrap in $effect().
  let isDirty = $state(false);
  const unsubEditor = editorStore.subscribe(state => {
    isDirty = state.isDirty;
  });
  onDestroy(() => { unsubEditor(); });

  let displayTitle = $derived(isDirty ? `${title} - ${$t('titlebar.unsaved')}` : title);

  // Whether to show inline tabs (macOS only, when tabs exist)
  let showInlineTabs = $derived(isMacOS && tabs.length > 0);

  // Right-click context menu state
  let showContextMenu = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);

  function handleContextMenu(event: MouseEvent) {
    if (!isMacOS) return;
    if ((event.target as HTMLElement).closest('.tab-item')) return;
    event.preventDefault();
    contextMenuX = event.clientX;
    contextMenuY = event.clientY;
    showContextMenu = true;

    // Close on next click anywhere
    function closeMenu() {
      showContextMenu = false;
      document.removeEventListener('click', closeMenu, true);
      document.removeEventListener('contextmenu', closeMenu, true);
    }
    requestAnimationFrame(() => {
      document.addEventListener('click', closeMenu, true);
      document.addEventListener('contextmenu', closeMenu, true);
    });
  }

  // Sync native window title.
  // On macOS with Overlay titlebar, native title text renders in the OS title bar area
  // alongside our custom .title-text, causing duplicates. Set native title to '' so the
  // OS renders no text; the custom .title-text (with proper sidebar/AI-panel CSS offsets)
  // handles the visible filename. On other platforms, sync normally.
  $effect(() => {
    if (isMacOS) {
      appWindow?.setTitle('');
    } else {
      appWindow?.setTitle(displayTitle);
    }
  });

  function handleTabClose(event: MouseEvent, tab: TabItem) {
    event.stopPropagation();
    onCloseTab(tab);
  }

  // Scroll overflow detection for macOS inline tabs
  let macScrollEl: HTMLDivElement | undefined = $state();
  let canScrollLeft = $state(false);
  let canScrollRight = $state(false);

  function updateScrollState() {
    if (!macScrollEl) return;
    canScrollLeft = macScrollEl.scrollLeft > 1;
    canScrollRight = macScrollEl.scrollLeft < macScrollEl.scrollWidth - macScrollEl.clientWidth - 1;
  }

  function scrollTabs(dir: 'left' | 'right') {
    if (!macScrollEl) return;
    macScrollEl.scrollBy({ left: dir === 'left' ? -200 : 200, behavior: 'smooth' });
  }

  $effect(() => {
    void tabs.length;
    requestAnimationFrame(updateScrollState);
  });

  // Auto-scroll active tab into view when activeTabId changes
  $effect(() => {
    void activeTabId;
    requestAnimationFrame(() => {
      if (!macScrollEl) return;
      const activeEl = macScrollEl.querySelector('.tab-item.active') as HTMLElement | null;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        requestAnimationFrame(updateScrollState);
      }
    });
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="titlebar no-select" data-tauri-drag-region
  onmousedown={handleDragStart} ondblclick={handleDblClick}
  oncontextmenu={handleContextMenu}>
  <div class="titlebar-left">
    <span class="app-name" data-tauri-drag-region>Moraya</span>
  </div>

  <div class="titlebar-center" data-tauri-drag-region>
    {#if showInlineTabs}
      <!-- macOS: tabs embedded in 28px overlay -->
      {#if canScrollLeft}
        <button class="scroll-arrow scroll-left" onclick={() => scrollTabs('left')}>
          <svg width="6" height="8" viewBox="0 0 6 8"><path fill="currentColor" d="M5 0L0 4l5 4z"/></svg>
        </button>
      {/if}
      <div class="mac-tabs-scroll" bind:this={macScrollEl} onscroll={updateScrollState}>
        {#each tabs as tab (tab.id)}
          <!-- svelte-ignore a11y_consider_explicit_label -->
          <button class="tab-item" class:active={tab.id === activeTabId}
            onclick={() => onSwitchTab(tab.id)}>
            <span class="tab-name">
              {#if tab.isDirty}<span class="dirty-dot"></span>{/if}
              {tab.fileName}
            </span>
            <span class="tab-close" role="button" tabindex="-1"
              onclick={(e) => handleTabClose(e, tab)}>×</span>
          </button>
        {/each}
      </div>
      {#if canScrollRight}
        <button class="scroll-arrow scroll-right" onclick={() => scrollTabs('right')}>
          <svg width="6" height="8" viewBox="0 0 6 8"><path fill="currentColor" d="M0 0l6 4-6 4z"/></svg>
        </button>
      {/if}
    {:else}
      <span class="title-text" data-tauri-drag-region>{displayTitle}</span>
    {/if}
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

{#if showContextMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="titlebar-context-menu" style="left: {contextMenuX}px; top: {contextMenuY}px">
    <button class="context-menu-item" onclick={() => { showContextMenu = false; onNewFile(); }}>
      {$t('titlebar.newFile')}
    </button>
    <button class="context-menu-item" onclick={() => { showContextMenu = false; onOpenFile(); }}>
      {$t('titlebar.openFile')}
    </button>
  </div>
{/if}

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
    display: flex;
    align-items: center;
    overflow: hidden;
  }

  .title-text {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    flex: 1;
    text-align: center;
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

  /* ── macOS inline tabs ── */
  .scroll-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    -webkit-app-region: no-drag;
    z-index: 1;
    transition: color var(--transition-fast);
  }
  .scroll-arrow:hover {
    color: var(--text-primary);
  }

  .mac-tabs-scroll {
    display: flex;
    align-items: center;
    overflow-x: auto;
    overflow-y: hidden;
    min-width: 0; /* allow shrink for overflow */
    max-width: 100%;
    -webkit-app-region: no-drag;
    scrollbar-width: none;
  }
  .mac-tabs-scroll::-webkit-scrollbar {
    display: none;
  }

  .tab-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    height: 28px;
    padding: 0 0.5rem;
    max-width: 150px;
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    -webkit-app-region: no-drag;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .tab-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .tab-item.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent-color);
  }

  .tab-name {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dirty-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent-color);
    flex-shrink: 0;
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    font-size: 12px;
    line-height: 1;
    color: var(--text-muted);
    flex-shrink: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s, background var(--transition-fast);
  }
  .tab-item.active .tab-close {
    opacity: 1;
    pointer-events: auto;
  }
  .tab-item:hover .tab-close {
    opacity: 1;
    pointer-events: auto;
  }
  .tab-close:hover {
    background: var(--bg-active);
    color: var(--text-primary);
  }

  /* macOS: transparent overlay drag region for Overlay title bar style.
     The native title bar is transparent in Overlay mode; this element provides
     the drag region so the window can be moved by dragging and maximised by
     double-clicking. Traffic lights are native OS controls rendered on top. */
  :global(.platform-macos) .titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 28px;
    background: transparent;
    border-bottom: none;
    z-index: 50;
    padding: 0;
  }

  :global(.platform-macos) .titlebar-left,
  :global(.platform-macos) .titlebar-right {
    display: none;
  }

  :global(.platform-macos) .titlebar-center {
    padding-left: max(78px, var(--sidebar-visible-width, 0px)); /* traffic lights or sidebar (whichever is wider) */
    padding-right: var(--ai-panel-width, 0px); /* AI panel offset */
  }

  :global(.platform-macos) .title-text {
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Windows/Linux: hide custom titlebar, use native decorations */
  :global(.platform-windows) .titlebar,
  :global(.platform-linux) .titlebar {
    display: none;
  }

  /* iPadOS: no window controls, no drag region, safe area inset */
  :global(.platform-ipados) .titlebar {
    -webkit-app-region: no-drag;
    padding-top: env(safe-area-inset-top);
  }

  :global(.platform-ipados) .titlebar-right {
    display: none;
  }

  :global(.platform-ipados) .titlebar-left {
    padding-left: 0.5rem;
  }

  /* RTL overrides */
  :global([dir="rtl"]) .titlebar-left {
    padding-left: 0;
    padding-right: 0.5rem;
  }

  :global([dir="rtl"].platform-macos) .titlebar-center {
    padding-left: var(--ai-panel-width, 0px);
    padding-right: max(78px, var(--sidebar-visible-width, 0px));
  }

  /* ── Context menu ── */
  .titlebar-context-menu {
    position: fixed;
    z-index: 100;
    background: var(--bg-primary);
    border: 1px solid var(--border-light);
    border-radius: 6px;
    padding: 4px 0;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    min-width: 160px;
  }

  .context-menu-item {
    display: block;
    width: 100%;
    padding: 6px 16px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .context-menu-item:hover {
    background: var(--accent-color);
    color: white;
  }
</style>

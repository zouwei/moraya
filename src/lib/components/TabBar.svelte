<script lang="ts">
  import { onDestroy } from 'svelte';
  import { tabsStore, type TabItem } from '$lib/stores/tabs-store';
  import { t } from '$lib/i18n';

  let {
    onNewTab,
    onCloseTab,
  }: {
    onNewTab?: () => void;
    onCloseTab?: (tab: TabItem) => void;
  } = $props();

  let tabs = $state<TabItem[]>([]);
  let activeTabId = $state('');

  // Top-level store subscription — do NOT wrap in $effect().
  const unsub = tabsStore.subscribe(state => {
    tabs = state.tabs;
    activeTabId = state.activeTabId;
  });
  onDestroy(() => { unsub(); });

  function handleSwitchTab(tabId: string) {
    tabsStore.switchTab(tabId);
  }

  function handleCloseTab(e: MouseEvent, tab: TabItem) {
    e.stopPropagation();
    if (onCloseTab) {
      onCloseTab(tab);
    } else {
      tabsStore.closeTab(tab.id);
    }
  }

  function handleNewTab() {
    if (onNewTab) {
      onNewTab();
    } else {
      tabsStore.addTab();
    }
  }

  // Scroll overflow detection
  let scrollEl: HTMLDivElement | undefined = $state();
  let canScrollLeft = $state(false);
  let canScrollRight = $state(false);

  function updateScrollState() {
    if (!scrollEl) return;
    canScrollLeft = scrollEl.scrollLeft > 1;
    canScrollRight = scrollEl.scrollLeft < scrollEl.scrollWidth - scrollEl.clientWidth - 1;
  }

  function scrollTabs(dir: 'left' | 'right') {
    if (!scrollEl) return;
    const amount = 200;
    scrollEl.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  }

  // Re-check overflow when tabs change
  $effect(() => {
    // Track tabs array to re-check on add/remove
    void tabs.length;
    requestAnimationFrame(updateScrollState);
  });

  // Auto-scroll active tab into view when activeTabId changes
  $effect(() => {
    void activeTabId;
    requestAnimationFrame(() => {
      if (!scrollEl) return;
      const activeEl = scrollEl.querySelector('.tab-item.active') as HTMLElement | null;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        requestAnimationFrame(updateScrollState);
      }
    });
  });
</script>

<div class="tabbar no-select">
  {#if canScrollLeft}
    <button class="scroll-arrow scroll-left" onclick={() => scrollTabs('left')}>
      <svg width="8" height="10" viewBox="0 0 8 10"><path fill="currentColor" d="M7 0L0 5l7 5z"/></svg>
    </button>
  {/if}

  <div class="tabs-scroll" bind:this={scrollEl} onscroll={updateScrollState}>
    {#each tabs as tab (tab.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="tab-item"
        class:active={tab.id === activeTabId}
        onclick={() => handleSwitchTab(tab.id)}
      >
        <span class="tab-name">
          {#if tab.isDirty}<span class="dirty-dot"></span>{/if}
          {tab.fileName}
        </span>
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span
          class="tab-close"
          onclick={(e) => handleCloseTab(e, tab)}
        >
          <svg width="8" height="8" viewBox="0 0 8 8">
            <path fill="currentColor" d="M1 0L0 1l3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3z"/>
          </svg>
        </span>
      </div>
    {/each}
  </div>

  {#if canScrollRight}
    <button class="scroll-arrow scroll-right" onclick={() => scrollTabs('right')}>
      <svg width="8" height="10" viewBox="0 0 8 10"><path fill="currentColor" d="M0 0l7 5-7 5z"/></svg>
    </button>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tab-new" onclick={handleNewTab} title={$t('common.new')}>
    <svg width="12" height="12" viewBox="0 0 12 12">
      <path fill="currentColor" d="M6 0v12M0 6h12" stroke="currentColor" stroke-width="1.5"/>
    </svg>
  </div>
</div>

<style>
  .tabbar {
    display: flex;
    align-items: center;
    height: 36px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-light);
    overflow: hidden;
  }

  .tabs-scroll {
    display: flex;
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .tabs-scroll::-webkit-scrollbar {
    display: none;
  }

  .scroll-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 36px;
    border: none;
    background: var(--bg-secondary);
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    z-index: 1;
    transition: color var(--transition-fast), background var(--transition-fast);
  }
  .scroll-arrow:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .tab-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.75rem;
    height: 36px;
    min-width: 0;
    max-width: 180px;
    cursor: pointer;
    border-right: 1px solid var(--border-light);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    transition: background var(--transition-fast), color var(--transition-fast);
    flex-shrink: 0;
  }

  .tab-item:active {
    background: var(--bg-hover);
  }

  .tab-item.active {
    background: var(--bg-primary);
    color: var(--text-primary);
    border-bottom: 2px solid var(--accent-color);
  }

  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .dirty-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-color);
    flex-shrink: 0;
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 3px;
    color: var(--text-muted);
    flex-shrink: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s, background var(--transition-fast), color var(--transition-fast);
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

  .tab-new {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .tab-new:active {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
</style>

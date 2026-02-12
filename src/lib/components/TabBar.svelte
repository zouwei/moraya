<script lang="ts">
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

  tabsStore.subscribe(state => {
    tabs = state.tabs;
    activeTabId = state.activeTabId;
  });

  function handleSwitchTab(tabId: string) {
    tabsStore.switchTab(tabId);
  }

  function handleCloseTab(e: MouseEvent, tab: TabItem) {
    e.stopPropagation();
    if (tab.isDirty && onCloseTab) {
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
</script>

<div class="tabbar no-select">
  <div class="tabs-scroll">
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
        {#if tabs.length > 1}
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
        {/if}
      </div>
    {/each}
  </div>
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
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .tab-close:active {
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

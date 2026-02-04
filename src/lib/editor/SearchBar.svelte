<script lang="ts">
  import { onMount } from 'svelte';
  import { t as tStore } from '$lib/i18n';

  let {
    showReplace = false,
    matchCount = 0,
    currentMatch = 0,
    onSearch,
    onFindNext,
    onFindPrev,
    onReplace,
    onReplaceAll,
    onToggleReplace,
    onClose,
  }: {
    showReplace?: boolean;
    matchCount?: number;
    currentMatch?: number;
    onSearch: (text: string, caseSensitive: boolean) => void;
    onFindNext: () => void;
    onFindPrev: () => void;
    onReplace: (replaceText: string) => void;
    onReplaceAll: (searchText: string, replaceText: string, caseSensitive: boolean) => void;
    onToggleReplace: () => void;
    onClose: () => void;
  } = $props();

  let searchText = $state('');
  let replaceText = $state('');
  let caseSensitive = $state(false);
  let searchInputEl: HTMLInputElement | undefined = $state();

  const tr = $derived($tStore);

  function handleSearchInput() {
    onSearch(searchText, caseSensitive);
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        onFindPrev();
      } else {
        onFindNext();
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  function handleReplaceKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      onReplace(replaceText);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  function toggleCaseSensitive() {
    caseSensitive = !caseSensitive;
    handleSearchInput();
  }

  onMount(() => {
    searchInputEl?.focus();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="search-bar" onclick={(e) => e.stopPropagation()}>
  <button
    class="toggle-replace-btn"
    onclick={onToggleReplace}
    title={showReplace ? 'Hide Replace' : 'Show Replace'}
  >
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      {#if showReplace}
        <path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      {:else}
        <path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      {/if}
    </svg>
  </button>

  <div class="search-fields">
    <div class="search-row">
      <input
        bind:this={searchInputEl}
        class="search-input"
        type="text"
        placeholder={tr('search.findPlaceholder')}
        bind:value={searchText}
        oninput={handleSearchInput}
        onkeydown={handleSearchKeydown}
      />
      <span class="match-info">
        {#if searchText}
          {#if matchCount > 0}
            {currentMatch} / {matchCount}
          {:else}
            {tr('search.noResults')}
          {/if}
        {/if}
      </span>
      <button class="search-btn" onclick={onFindPrev} title="Previous (Shift+Enter)">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 9l4-4 4 4" />
        </svg>
      </button>
      <button class="search-btn" onclick={onFindNext} title="Next (Enter)">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 5l4 4 4-4" />
        </svg>
      </button>
      <button
        class="search-btn"
        class:active={caseSensitive}
        onclick={toggleCaseSensitive}
        title={tr('search.caseSensitive')}
      >
        Aa
      </button>
      <button class="search-btn close-btn" onclick={onClose} title="Close (Esc)">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3l8 8M11 3l-8 8" />
        </svg>
      </button>
    </div>

    {#if showReplace}
      <div class="replace-row">
        <input
          class="search-input"
          type="text"
          placeholder={tr('search.replacePlaceholder')}
          bind:value={replaceText}
          onkeydown={handleReplaceKeydown}
        />
        <button class="search-btn text-btn" onclick={() => onReplace(replaceText)}>
          {tr('search.replace')}
        </button>
        <button class="search-btn text-btn" onclick={() => onReplaceAll(searchText, replaceText, caseSensitive)}>
          {tr('search.replaceAll')}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .search-bar {
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-color);
    z-index: 50;
    flex-shrink: 0;
  }

  .toggle-replace-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    padding: 0.3rem;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 0.15rem;
  }

  .toggle-replace-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .search-fields {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-width: 500px;
  }

  .search-row,
  .replace-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .search-input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--border-light);
    border-radius: 4px;
    padding: 0.3rem 0.5rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    outline: none;
  }

  .search-input:focus {
    border-color: var(--accent-color);
  }

  .match-info {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    white-space: nowrap;
    min-width: 3.5rem;
    text-align: center;
  }

  .search-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-secondary);
    padding: 0.3rem;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--font-size-xs);
  }

  .search-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .search-btn.active {
    background: var(--accent-color);
    color: white;
  }

  .text-btn {
    padding: 0.3rem 0.5rem;
    white-space: nowrap;
  }

  .close-btn {
    margin-left: 0.25rem;
  }
</style>

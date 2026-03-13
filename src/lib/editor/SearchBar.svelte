<script lang="ts">
  import { onMount } from 'svelte';
  import { t as tStore } from '$lib/i18n';

  let {
    showReplace = false,
    onSearch,
    onFindNext,
    onFindPrev,
    onReplace,
    onReplaceAll,
    onToggleReplace,
    onClose,
  }: {
    showReplace?: boolean;
    onSearch: (text: string, caseSensitive: boolean, useRegex: boolean) => void;
    onFindNext: () => void;
    onFindPrev: () => void;
    onReplace: (replaceText: string) => void;
    onReplaceAll: (searchText: string, replaceText: string, caseSensitive: boolean, useRegex: boolean) => void;
    onToggleReplace: () => void;
    onClose: () => void;
  } = $props();

  let searchText = $state('');
  let replaceText = $state('');
  let caseSensitive = $state(false);
  let useRegex = $state(false);
  let searchInputEl: HTMLTextAreaElement | undefined = $state();
  let replaceInputEl: HTMLTextAreaElement | undefined = $state();

  const tr = $derived($tStore);

  /** Compute display rows: 1 line = 1 row, max 6 rows */
  function calcRows(text: string): number {
    const lines = text.split('\n').length;
    return Math.min(Math.max(lines, 1), 6);
  }

  let searchRows = $derived(calcRows(searchText));
  let replaceRows = $derived(calcRows(replaceText));

  function handleSearchInput() {
    onSearch(searchText, caseSensitive, useRegex);
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    // Alt+Enter or Ctrl+Enter → insert newline
    if (event.key === 'Enter' && (event.altKey || event.ctrlKey || event.metaKey)) {
      // Let the textarea handle the newline naturally via Alt+Enter
      // For Ctrl/Cmd+Enter, manually insert newline since textarea doesn't do it by default
      if (!event.altKey) {
        event.preventDefault();
        insertNewlineAt(searchInputEl);
        handleSearchInput();
      }
      return;
    }
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
    if (event.isComposing) return;
    // Alt+Enter or Ctrl+Enter → insert newline
    if (event.key === 'Enter' && (event.altKey || event.ctrlKey || event.metaKey)) {
      if (!event.altKey) {
        event.preventDefault();
        insertNewlineAt(replaceInputEl);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onReplace(replaceText);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  /** Insert a newline at the cursor position of a textarea */
  function insertNewlineAt(el: HTMLTextAreaElement | undefined) {
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const val = el.value;
    const newVal = val.substring(0, start) + '\n' + val.substring(end);
    // Update the bound $state variable
    if (el === searchInputEl) {
      searchText = newVal;
    } else {
      replaceText = newVal;
    }
    // Restore cursor after Svelte re-renders
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 1;
    });
  }

  function toggleCaseSensitive() {
    caseSensitive = !caseSensitive;
    handleSearchInput();
  }

  function toggleRegex() {
    useRegex = !useRegex;
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
      <textarea
        bind:this={searchInputEl}
        class="search-input"
        placeholder={tr('search.findPlaceholder')}
        bind:value={searchText}
        oninput={handleSearchInput}
        onkeydown={handleSearchKeydown}
        rows={searchRows}
      ></textarea>
      <div class="action-buttons">
        <button
          class="search-btn"
          class:active={useRegex}
          onclick={toggleRegex}
          title={tr('search.regex')}
        >
          .*
        </button>
        <button
          class="search-btn"
          class:active={caseSensitive}
          onclick={toggleCaseSensitive}
          title={tr('search.caseSensitive')}
        >
          Aa
        </button>
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
        <button class="search-btn close-btn" onclick={onClose} title="Close (Esc)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>
    </div>

    {#if showReplace}
      <div class="replace-row">
        <textarea
          bind:this={replaceInputEl}
          class="search-input"
          placeholder={tr('search.replacePlaceholder')}
          bind:value={replaceText}
          onkeydown={handleReplaceKeydown}
          rows={replaceRows}
        ></textarea>
        <div class="replace-actions">
          <button class="search-btn text-btn" onclick={() => onReplace(replaceText)}>
            {tr('search.replace')}
          </button>
          <button class="search-btn text-btn" onclick={() => onReplaceAll(searchText, replaceText, caseSensitive, useRegex)}>
            {tr('search.replaceAll')}
          </button>
        </div>
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
  }

  .search-row,
  .replace-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
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
    font-family: inherit;
    outline: none;
    resize: none;
    line-height: 1.4;
    overflow-y: auto;
    max-height: 8rem;
  }

  .search-input:focus {
    border-color: var(--accent-color);
  }

  .replace-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    padding-top: 0.15rem;
  }

  .action-buttons {
    display: flex;
    align-items: center;
    gap: 0.15rem;
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

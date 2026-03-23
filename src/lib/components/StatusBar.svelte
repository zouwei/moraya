<script lang="ts">
  import { editorStore, type EditorMode } from '../stores/editor-store';
  import { updateStore } from '$lib/services/update-service';
  import { t } from '$lib/i18n';
  import { isMacOS, isIPadOS } from '$lib/utils/platform';

  let {
    onShowUpdateDialog,
    onToggleAI,
    onModeChange,
    currentMode = 'visual' as EditorMode,
    aiPanelOpen = false,
    aiConfigured = false,
    aiLoading = false,
    aiError = false,
    searchActive = false,
    searchMatchCount = 0,
    searchCurrentMatch = 0,
    searchRegexError = '',
    hideModeSwitcher = false,
    indexingPhase = '',
    indexingCurrent = 0,
    indexingTotal = 0,
  }: {
    onShowUpdateDialog?: () => void;
    onToggleAI?: () => void;
    onModeChange?: (mode: EditorMode) => void;
    currentMode?: EditorMode;
    aiPanelOpen?: boolean;
    aiConfigured?: boolean;
    aiLoading?: boolean;
    aiError?: boolean;
    searchActive?: boolean;
    searchMatchCount?: number;
    searchCurrentMatch?: number;
    searchRegexError?: string;
    hideModeSwitcher?: boolean;
    indexingPhase?: string;
    indexingCurrent?: number;
    indexingTotal?: number;
  } = $props();

  const aiShortcutHint = isMacOS || isIPadOS ? '⇧⌘I' : 'Ctrl+Shift+I';

  function getAITooltip(): string {
    const label = $t('statusbar.aiTooltip');
    return `${label} (${aiShortcutHint})`;
  }

  let wordCount = $state(0);
  let charCount = $state(0);
  let updateAvailable = $state(false);

  // Top-level store subscriptions — do NOT wrap in $effect().
  // Svelte 5 $effect tracks reads in subscribe callbacks, causing infinite loops.
  editorStore.subscribe(state => {
    wordCount = state.wordCount;
    charCount = state.charCount;
  });
  updateStore.subscribe(state => {
    updateAvailable = state.checkStatus === 'available';
  });

  const modes: EditorMode[] = ['visual', 'source', 'split'];

  function getModeLabel(mode: EditorMode): string {
    const labelMap: Record<EditorMode, string> = {
      visual: 'statusbar.visualMode',
      source: 'statusbar.sourceMode',
      split: 'statusbar.splitMode',
    };
    return labelMap[mode];
  }
</script>

<div class="statusbar no-select">
  <div class="statusbar-left">
    <span class="status-item">{$t('statusbar.words')}: {wordCount}</span>
    <span class="status-item">{$t('statusbar.characters')}: {charCount}</span>
    {#if searchActive}
      <span class="status-item search-status" class:search-error={!!searchRegexError}>
        {#if searchRegexError}
          {$t('search.regexError')}
        {:else if searchMatchCount > 0}
          {$t('search.matchStatus', { current: String(searchCurrentMatch), total: String(searchMatchCount) })}
        {:else}
          {$t('search.noResults')}
        {/if}
      </span>
    {/if}
    {#if indexingPhase === 'error'}
      <span class="status-item indexing-error">Embedding error</span>
    {:else if indexingPhase === 'done'}
      <span class="status-item indexing-done">✓ {$t('kb.indexComplete')}</span>
    {:else if indexingPhase}
      <span class="status-item indexing-status">
        <span class="indexing-spinner"></span>
        {#if indexingPhase === 'scanning'}
          {$t('kb.progress.scanning')}
        {:else if indexingPhase === 'chunking' && indexingTotal > 0}
          {$t('kb.progress.chunking').replace('{current}', String(indexingCurrent)).replace('{total}', String(indexingTotal))}
        {:else if indexingPhase === 'embedding' && indexingTotal > 0}
          {$t('kb.progress.embedding').replace('{current}', String(indexingCurrent)).replace('{total}', String(indexingTotal))}
        {:else if indexingPhase === 'indexing'}
          {$t('kb.progress.indexing')}
        {:else}
          {$t('kb.indexing')}
        {/if}
        {#if indexingTotal > 0}
          <span class="indexing-bar">
            <span class="indexing-fill" style="width: {Math.round((indexingCurrent / indexingTotal) * 100)}%"></span>
          </span>
        {/if}
      </span>
    {/if}
  </div>
  <div class="statusbar-right">
    {#if !hideModeSwitcher}
      <div class="mode-switcher">
        {#each modes as mode}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="mode-btn"
            class:active={currentMode === mode}
            onclick={() => {
              if (onModeChange) {
                onModeChange(mode);
              } else {
                editorStore.setEditorMode(mode);
              }
            }}
          >
            {$t(getModeLabel(mode))}
          </span>
        {/each}
      </div>
    {/if}
    {#if updateAvailable && onShowUpdateDialog}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="update-indicator" onclick={onShowUpdateDialog} title={$t('update.newVersionAvailable')}>
        &#x2B06;&#xFE0F;
      </span>
    {/if}
    {#if onToggleAI}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="ai-sparkle"
        class:active={aiPanelOpen}
        class:unconfigured={!aiConfigured}
        class:loading={aiLoading}
        class:error={aiError && !aiLoading}
        onclick={onToggleAI}
        title={getAITooltip()}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0L9.5 5.5L16 8L9.5 9.5L8 16L6.5 9.5L0 8L6.5 5.5Z"/>
        </svg>
      </span>
    {/if}
    <span class="status-item">{$t('statusbar.format')}</span>
  </div>
</div>

<style>
  .statusbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--statusbar-height);
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-light);
    padding: 0 1rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .statusbar-left,
  .statusbar-right {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .status-item {
    white-space: nowrap;
  }

  .search-status {
    color: var(--accent-color);
  }

  .search-status.search-error {
    color: var(--color-error, #e53e3e);
  }

  .indexing-status {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--accent-color);
  }

  .indexing-error {
    color: var(--color-error, #e53e3e);
  }

  .indexing-done {
    color: var(--color-success, #38a169);
  }

  .indexing-spinner {
    width: 8px;
    height: 8px;
    border: 1.5px solid var(--accent-color);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .indexing-bar {
    width: 60px;
    height: 4px;
    background: var(--border-light);
    border-radius: 2px;
    overflow: hidden;
  }

  .indexing-fill {
    display: block;
    height: 100%;
    background: var(--accent-color);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .mode-switcher {
    display: flex;
    gap: 0;
    border: 1px solid var(--border-light);
    border-radius: 3px;
    overflow: hidden;
  }

  .mode-btn {
    padding: 0.1rem 0.4rem;
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
    border-right: 1px solid var(--border-light);
  }

  .mode-btn:last-child {
    border-right: none;
  }

  .mode-btn:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .mode-btn.active {
    background: var(--accent-color);
    color: white;
  }

  .update-indicator {
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    padding: 0.1rem 0.2rem;
    border-radius: 3px;
    transition: background var(--transition-fast);
    animation: pulse 2s ease-in-out infinite;
  }

  .update-indicator:hover {
    background: var(--bg-hover);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* AI Sparkle indicator */
  .ai-sparkle {
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    color: var(--text-muted);
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .ai-sparkle:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .ai-sparkle.unconfigured {
    opacity: 0.5;
  }

  .ai-sparkle.unconfigured svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
  }

  .ai-sparkle.active {
    color: var(--accent-color);
  }

  .ai-sparkle.loading {
    color: var(--accent-color);
    animation: pulse 2s ease-in-out infinite;
  }

  .ai-sparkle.error {
    color: var(--warning-color, #e8a838);
  }

  /* iPadOS: taller statusbar to match TouchToolbar visual weight */
  :global(.platform-ipados) .statusbar {
    height: 40px;
    padding-bottom: env(safe-area-inset-bottom);
    font-size: var(--font-size-sm);
  }

  :global(.platform-ipados) .mode-switcher {
    height: 28px;
    border-radius: 5px;
  }

  :global(.platform-ipados) .mode-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.6rem;
    height: 100%;
  }

  :global(.platform-ipados) .ai-sparkle svg {
    width: 16px;
    height: 16px;
  }

  /* RTL overrides */
  :global([dir="rtl"]) .mode-btn {
    border-right: none;
    border-left: 1px solid var(--border-light);
  }

  :global([dir="rtl"]) .mode-btn:last-child {
    border-left: none;
  }
</style>

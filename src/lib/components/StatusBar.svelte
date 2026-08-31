<script lang="ts">
  import { editorStore, type EditorMode } from '../stores/editor-store';
  import { CREATION_VIEWS, allowsEditorMode, type CreationView } from '$lib/editor/creation-view';
  import { settingsStore } from '../stores/settings-store';
  import { updateStore } from '$lib/services/update-service';
  import { t } from '$lib/i18n';
  import { isMacOS, isIPadOS } from '$lib/utils/platform';
  import GitSyncStatus from './GitSyncStatus.svelte';
  import { filesStore } from '$lib/stores/files-store';
  import { kbSyncStore } from '$lib/services/kb-sync/sync-service';
  import type { KbSyncState } from '$lib/services/kb-sync/types';
  import { exportProgressStore } from '$lib/stores/export-progress-store';
  import { editorLoadingStore, type LoadingPhase } from '$lib/stores/editor-loading-store';

  let {
    onShowUpdateDialog,
    onToggleAI,
    onModeChange,
    onGitSync,
    onShowConflicts,
    onToggleVersionHistory,
    versionHistoryAvailable = false,
    currentMode = 'visual' as EditorMode,
    creationView = 'standard' as CreationView,
    onCreationViewChange,
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
    docFlavor = 'markdown' as 'markdown' | 'typst',
  }: {
    onShowUpdateDialog?: () => void;
    onToggleAI?: () => void;
    onModeChange?: (mode: EditorMode) => void;
    onGitSync?: () => void;
    onShowConflicts?: () => void;
    onToggleVersionHistory?: () => void;
    versionHistoryAvailable?: boolean;
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
    /** Active creation view — see $lib/editor/creation-view. */
    creationView?: CreationView;
    onCreationViewChange?: (view: CreationView) => void;
    indexingPhase?: string;
    indexingCurrent?: number;
    indexingTotal?: number;
    /** Markup language of the active document, shown in the right-hand corner.
     *  Driven by the active tab's flavor so it tracks tab switches. */
    docFlavor?: 'markdown' | 'typst';
  } = $props();

  const aiShortcutHint = isMacOS || isIPadOS ? '⇧⌘I' : 'Ctrl+Shift+I';

  function getAITooltip(): string {
    const label = $t('statusbar.ai_tooltip');
    return `${label} (${aiShortcutHint})`;
  }

  let wordCount = $state(0);
  let charCount = $state(0);
  let updateAvailable = $state(false);
  let activeKbSyncState = $state<KbSyncState | null>(null);
  let showSyncPopover = $state(false);
  let showSidebar = $state(false);
  let showOutline = $state(false);

  // Top-level store subscriptions — do NOT wrap in $effect().
  // Svelte 5 $effect tracks reads in subscribe callbacks, causing infinite loops.
  editorStore.subscribe(state => {
    wordCount = state.wordCount;
    charCount = state.charCount;
  });
  settingsStore.subscribe(state => {
    showSidebar = state.showSidebar;
    showOutline = state.showOutline;
  });
  updateStore.subscribe(state => {
    updateAvailable = state.checkStatus === 'available';
  });
  filesStore.subscribe(state => {
    const activeId = state.activeKnowledgeBaseId;
    const activeKb = activeId ? state.knowledgeBases.find(k => k.id === activeId) : null;
    if (activeKb?.picoraBinding && activeId) {
      // Snapshot current kbSyncStore so the icon shows immediately when a bound KB is selected.
      activeKbSyncState = kbSyncStore.getState(activeId);
    } else {
      activeKbSyncState = null;
    }
  });
  kbSyncStore.subscribe(map => {
    const filesState = filesStore.getState();
    const activeId = filesState.activeKnowledgeBaseId;
    const activeKb = activeId ? filesState.knowledgeBases.find(k => k.id === activeId) : null;
    if (activeKb?.picoraBinding) {
      activeKbSyncState = map.get(activeId!) ?? {
        localKbId: activeId!,
        status: 'idle',
        conflictCount: 0,
        pendingConflicts: [],
        lastError: null,
      };
    } else {
      activeKbSyncState = null;
    }
  });

  let exportProgress: {
    phase: string;
    current?: number;
    total?: number;
    fallback: boolean;
    message?: string;
  } = $state({ phase: 'idle', fallback: false });
  exportProgressStore.subscribe((s) => {
    exportProgress = { ...s };
  });

  let editorLoading: { phase: LoadingPhase; sizeKB?: number } = $state({ phase: 'idle' });
  editorLoadingStore.subscribe((s) => {
    editorLoading = { ...s };
  });

  const modes: EditorMode[] = ['visual', 'source', 'split'];

  const viewLabels: Record<CreationView, string> = {
    standard: 'statusbar.view_standard',
    reading: 'statusbar.view_reading',
    writing: 'statusbar.view_writing',
  };

  function getModeLabel(mode: EditorMode): string {
    const labelMap: Record<EditorMode, string> = {
      visual: 'statusbar.visual_mode',
      source: 'statusbar.source_mode',
      split: 'statusbar.split_mode',
    };
    return labelMap[mode];
  }

  function toggleSidebar() {
    settingsStore.toggleSidebar();
  }

  function toggleOutline() {
    settingsStore.update({ showOutline: !showOutline });
  }
</script>

<div class="statusbar no-select">
  <div class="statusbar-left">
    <button
      class="status-icon"
      class:active={showSidebar}
      onclick={toggleSidebar}
      title={$t('menu.toggle_sidebar')}
      aria-label={$t('menu.toggle_sidebar')}
      aria-pressed={showSidebar}
      type="button"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>
    </button>
    <button
      class="status-icon"
      class:active={showOutline}
      onclick={toggleOutline}
      title={$t('menu.toggle_outline')}
      aria-label={$t('menu.toggle_outline')}
      aria-pressed={showOutline}
      type="button"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"/>
        <line x1="8" y1="12" x2="21" y2="12"/>
        <line x1="8" y1="18" x2="21" y2="18"/>
        <line x1="3" y1="6" x2="3.01" y2="6"/>
        <line x1="3" y1="12" x2="3.01" y2="12"/>
        <line x1="3" y1="18" x2="3.01" y2="18"/>
      </svg>
    </button>
    <span class="status-item">{$t('statusbar.words')}: {wordCount}</span>
    <span class="status-item">{$t('statusbar.characters')}: {charCount}</span>
    {#if searchActive}
      <span class="status-item search-status" class:search-error={!!searchRegexError}>
        {#if searchRegexError}
          {$t('search.regex_error')}
        {:else if searchMatchCount > 0}
          {$t('search.match_status', { current: String(searchCurrentMatch), total: String(searchMatchCount) })}
        {:else}
          {$t('search.no_results')}
        {/if}
      </span>
    {/if}
    {#if indexingPhase === 'error'}
      <span class="status-item indexing-error">Embedding error</span>
    {:else if indexingPhase === 'done'}
      <span class="status-item indexing-done">✓ {$t('kb.index_complete')}</span>
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
    {#if editorLoading.phase !== 'idle'}
      <span class="status-item export-progress">
        <span class="indexing-spinner"></span>
        {#if editorLoading.phase === 'parsing'}
          {$t('editor.loading.parsing')}
        {:else}
          {$t('editor.loading.rendering')}
        {/if}
        {#if editorLoading.sizeKB}
          <span class="export-fallback-tag">({editorLoading.sizeKB}KB)</span>
        {/if}
        <span class="indexing-bar">
          <span class="indexing-fill export-indeterminate"></span>
        </span>
      </span>
    {/if}
    {#if exportProgress.phase !== 'idle'}
      <span
        class="status-item export-progress"
        class:export-error={exportProgress.phase === 'error'}
        class:export-done={exportProgress.phase === 'done'}
        class:export-fallback={exportProgress.fallback}
      >
        {#if exportProgress.phase === 'error'}
          ⚠ {exportProgress.message
            ? exportProgress.message.slice(0, 60)
            : $t('export.error.generic')}
        {:else if exportProgress.phase === 'done'}
          ✓ {$t('export.progress.done')}
          {#if exportProgress.fallback}
            <span class="export-fallback-tag">({$t('export.fallback.notice')})</span>
          {/if}
        {:else}
          <span class="indexing-spinner"></span>
          {#if exportProgress.phase === 'preparing'}
            {$t('export.progress.preparing')}
          {:else if exportProgress.phase === 'rendering'}
            {$t('export.progress.rendering')}
          {:else if exportProgress.phase === 'paginating' && exportProgress.total}
            {$t('export.progress.paginating')
              .replace('{current}', String(exportProgress.current ?? 0))
              .replace('{total}', String(exportProgress.total))}
          {:else if exportProgress.phase === 'writing'}
            {$t('export.progress.writing')}
          {:else}
            {$t('export.progress.preparing')}
          {/if}
          {#if exportProgress.fallback}
            <span class="export-fallback-tag">({$t('export.fallback.notice')})</span>
          {/if}
          {#if exportProgress.phase === 'paginating' && exportProgress.total}
            <span class="indexing-bar">
              <span
                class="indexing-fill"
                style="width: {Math.round(((exportProgress.current ?? 0) / exportProgress.total) * 100)}%"
              ></span>
            </span>
          {:else if exportProgress.phase !== 'idle' && exportProgress.phase !== 'done' && exportProgress.phase !== 'error'}
            <span class="indexing-bar">
              <span class="indexing-fill export-indeterminate"></span>
            </span>
          {/if}
        {/if}
      </span>
    {/if}
    {#if onGitSync}
      <GitSyncStatus onSync={onGitSync} />
    {/if}
    {#if activeKbSyncState !== null}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="kb-sync-icon"
        class:sync-idle={activeKbSyncState.status === 'idle'}
        class:sync-syncing={activeKbSyncState.status === 'syncing'}
        class:sync-conflict={activeKbSyncState.status === 'conflict'}
        class:sync-error={activeKbSyncState.status === 'error'}
        onclick={() => {
          if (activeKbSyncState?.status === 'conflict' && onShowConflicts) {
            onShowConflicts();
          } else {
            showSyncPopover = !showSyncPopover;
          }
        }}
        title={activeKbSyncState.status === 'error' && activeKbSyncState.lastError
          ? activeKbSyncState.lastError
          : $t('kb_sync.statusbar.tooltip')}
      >
        <svg width="12" height="12" viewBox="8 6 16 20" fill="none" style="vertical-align:-1px;display:inline-block" aria-hidden="true"><path d="M9.5 7.5v17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="14" r="6.5" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="14" r="2.4" fill="currentColor"/></svg>{#if activeKbSyncState.status === 'conflict'} ⚠{activeKbSyncState.conflictCount}{:else if activeKbSyncState.status === 'error'} ✗{#if activeKbSyncState.lastError} {activeKbSyncState.lastError.length > 35 ? activeKbSyncState.lastError.slice(0, 35) + '…' : activeKbSyncState.lastError}{/if}{:else if activeKbSyncState.status === 'idle'} ✓{/if}
      </span>
      {#if showSyncPopover && activeKbSyncState.status === 'error' && activeKbSyncState.lastError}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="kb-sync-popover" onclick={() => { showSyncPopover = false; }}>
          <div class="kb-sync-popover-inner" onclick={(e) => e.stopPropagation()}>
            <span class="kb-sync-popover-label">{$t('kb_sync.statusbar.error_label')}</span>
            <span class="kb-sync-popover-msg">{activeKbSyncState.lastError}</span>
            <button class="kb-sync-popover-close" onclick={() => { showSyncPopover = false; }}>&times;</button>
          </div>
        </div>
      {/if}
    {/if}
    {#if onToggleVersionHistory}
      <button
        class="status-icon vh-btn"
        onclick={onToggleVersionHistory}
        disabled={!versionHistoryAvailable}
        title={versionHistoryAvailable
          ? $t('version_history.statusbar_tooltip')
          : $t('version_history.statusbar_disabled')}
        aria-label={$t('version_history.statusbar_tooltip')}
        type="button"
      >
        <!-- history: clock with counter-clockwise arrow -->
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9" />
          <path d="M2.5 8.5V6h2.5" transform="translate(0 3)" />
          <path d="M8 5.2V8l2 1.4" />
        </svg>
      </button>
    {/if}
  </div>
  <div class="statusbar-right">
    {#if !hideModeSwitcher}
      <!-- Creation view. Sits LEFT of the surface switcher and is never
           hidden, including inside the views themselves: reading removes the
           caret, so the way back out has to stay on screen rather than
           depending on the user recalling Escape or finding the menu. -->
      <div class="mode-switcher view-switcher">
        {#each CREATION_VIEWS as view}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="mode-btn"
            class:active={creationView === view}
            title={$t(viewLabels[view])}
            onclick={() => onCreationViewChange?.(view)}
          >
            {$t(viewLabels[view])}
          </span>
        {/each}
      </div>
      <div class="mode-switcher">
        {#each modes as mode}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="mode-btn"
            class:active={currentMode === mode}
            class:disabled={!allowsEditorMode(creationView, mode)}
            title={allowsEditorMode(creationView, mode) ? '' : $t('statusbar.mode_locked_by_reading')}
            onclick={() => {
              // Left visible but inert in reading view, so the reason a
              // surface cannot be picked is on screen instead of inferred
              // from a button that vanished.
              if (!allowsEditorMode(creationView, mode)) return;
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
      <span class="update-indicator" onclick={onShowUpdateDialog} title={$t('update.new_version_available')}>
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
    <!-- Markup language of the active document. 'Typst' is a product name (not
         translatable); markdown keeps the existing localized key. -->
    <span class="status-item">{docFlavor === 'typst' ? 'Typst' : $t('statusbar.format')}</span>
  </div>
</div>

<style>
  /* Two switchers sit side by side; a hairline keeps them from reading as one
     six-button group, since they are different axes. */
  .view-switcher {
    margin-right: 6px;
    padding-right: 6px;
    border-right: 1px solid var(--border-color);
  }

  .mode-btn.disabled {
    opacity: 0.4;
    cursor: default;
  }

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

  .status-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    margin: 0 -2px;
    border: none;
    background: none;
    border-radius: 3px;
    cursor: pointer;
    color: var(--text-muted);
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .status-icon:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .status-icon.active {
    color: var(--accent-color);
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

  .export-progress {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--accent-color);
  }
  .export-progress.export-error {
    color: var(--color-error, #e53e3e);
  }
  .export-progress.export-done {
    color: var(--color-success, #38a169);
    transition: opacity 0.2s ease;
  }
  .export-progress.export-fallback {
    color: var(--color-warning, #d69e2e);
  }
  .export-fallback-tag {
    font-size: 0.85em;
    opacity: 0.8;
  }
  .export-indeterminate {
    width: 40% !important;
    transition: none;
    animation: export-slide 1.4s ease-in-out infinite;
  }
  @keyframes export-slide {
    0%   { margin-left: -40%; }
    100% { margin-left: 100%; }
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

  .kb-sync-icon {
    cursor: pointer;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-size: var(--font-size-xs);
    transition: background var(--transition-fast);
    white-space: nowrap;
  }

  .kb-sync-icon:hover { background: var(--bg-hover); }
  .kb-sync-icon.sync-idle { color: var(--color-success, #38a169); }
  .kb-sync-icon.sync-syncing {
    color: var(--accent-color);
    display: inline-block;
    transform-origin: center;
    animation: kb-sync-breathe 1.6s ease-in-out infinite;
  }

  .kb-sync-icon.sync-conflict { color: var(--warning-color, #e8a838); }
  .kb-sync-icon.sync-error { color: var(--color-error, #e53e3e); }

  /* Breathing-light effect shown while syncing — matches the sidebar sync
     button. Opacity + subtle scale pulse with a soft accent halo. */
  @keyframes kb-sync-breathe {
    0%, 100% {
      opacity: 0.45;
      transform: scale(0.9);
      filter: drop-shadow(0 0 0 transparent);
    }
    50% {
      opacity: 1;
      transform: scale(1.1);
      filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent-color) 55%, transparent));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .kb-sync-icon.sync-syncing { animation: none; opacity: 0.75; }
  }

  .vh-btn:disabled {
    opacity: 0.35;
    cursor: default;
    pointer-events: auto; /* keep the disabled-state tooltip */
  }

  .kb-sync-popover {
    position: fixed;
    inset: 0;
    z-index: 500;
  }

  .kb-sync-popover-inner {
    position: absolute;
    bottom: calc(var(--statusbar-height) + 4px);
    left: 1rem;
    max-width: 360px;
    background: var(--bg-primary);
    border: 1px solid var(--color-error, #e53e3e);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    box-shadow: 0 4px 16px rgba(0,0,0,0.18);
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: var(--font-size-xs);
  }

  .kb-sync-popover-label {
    color: var(--color-error, #e53e3e);
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .kb-sync-popover-msg {
    color: var(--text-primary);
    word-break: break-all;
    flex: 1;
  }

  .kb-sync-popover-close {
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.1rem;
  }
  .kb-sync-popover-close:hover { color: var(--text-primary); }
</style>

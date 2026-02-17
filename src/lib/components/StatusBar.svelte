<script lang="ts">
  import { editorStore, type EditorMode } from '../stores/editor-store';
  import { updateStore } from '$lib/services/update-service';
  import { t } from '$lib/i18n';
  import { isMacOS, isIPadOS } from '$lib/utils/platform';

  let {
    onPublishWorkflow,
    onShowUpdateDialog,
    onToggleAI,
    onModeChange,
    aiPanelOpen = false,
    aiConfigured = false,
    aiLoading = false,
    aiError = false,
  }: {
    onPublishWorkflow?: () => void;
    onShowUpdateDialog?: () => void;
    onToggleAI?: () => void;
    onModeChange?: (mode: EditorMode) => void;
    aiPanelOpen?: boolean;
    aiConfigured?: boolean;
    aiLoading?: boolean;
    aiError?: boolean;
  } = $props();

  const aiShortcutHint = isMacOS || isIPadOS ? '⌘J' : 'Ctrl+J';

  function getAITooltip(): string {
    const label = $t('statusbar.aiTooltip');
    return `${label} (${aiShortcutHint})`;
  }

  let wordCount = $state(0);
  let charCount = $state(0);
  let editorMode = $state<EditorMode>('visual');
  let updateAvailable = $state(false);

  editorStore.subscribe(state => {
    wordCount = state.wordCount;
    charCount = state.charCount;
    editorMode = state.editorMode;
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
  </div>
  <div class="statusbar-right">
    <div class="mode-switcher">
      {#each modes as mode}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span
          class="mode-btn"
          class:active={editorMode === mode}
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
    {#if onPublishWorkflow}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="publish-btn" onclick={onPublishWorkflow}>
        {$t('statusbar.publishWorkflow')}
      </span>
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

  .publish-btn {
    padding: 0.1rem 0.4rem;
    cursor: pointer;
    border: 1px solid var(--border-light);
    border-radius: 3px;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .publish-btn:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
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

  :global(.platform-ipados) .publish-btn {
    display: flex;
    align-items: center;
    padding: 0 0.6rem;
    height: 28px;
    border-radius: 5px;
  }

  :global(.platform-ipados) .ai-sparkle svg {
    width: 16px;
    height: 16px;
  }
</style>

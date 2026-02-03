<script lang="ts">
  import { editorStore, type EditorMode } from '../stores/editor-store';
  import { t } from '$lib/i18n';

  let wordCount = $state(0);
  let charCount = $state(0);
  let editorMode = $state<EditorMode>('visual');

  editorStore.subscribe(state => {
    wordCount = state.wordCount;
    charCount = state.charCount;
    editorMode = state.editorMode;
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
          onclick={() => editorStore.setEditorMode(mode)}
        >
          {$t(getModeLabel(mode))}
        </span>
      {/each}
    </div>
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
</style>

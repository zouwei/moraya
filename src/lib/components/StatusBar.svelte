<script lang="ts">
  import { editorStore } from '../stores/editor-store';

  let wordCount = $state(0);
  let charCount = $state(0);

  editorStore.subscribe(state => {
    wordCount = state.wordCount;
    charCount = state.charCount;
  });
</script>

<div class="statusbar no-select">
  <div class="statusbar-left">
    <span class="status-item">Words: {wordCount}</span>
    <span class="status-item">Characters: {charCount}</span>
  </div>
  <div class="statusbar-right">
    <span class="status-item">Markdown</span>
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
  }

  .status-item {
    white-space: nowrap;
  }
</style>

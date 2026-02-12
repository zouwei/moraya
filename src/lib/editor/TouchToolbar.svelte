<script lang="ts">
  import { t } from '$lib/i18n';

  let {
    onCommand,
  }: {
    onCommand: (cmd: string, payload?: unknown) => void;
  } = $props();

  const tr = $t;

  interface ToolbarButton {
    id: string;
    label: string;
    icon?: string;
    group: 'format' | 'paragraph' | 'insert' | 'action';
  }

  const buttons: ToolbarButton[] = [
    // Actions
    { id: 'undo', label: '↩', group: 'action' },
    { id: 'redo', label: '↪', group: 'action' },
    // Text format
    { id: 'bold', label: 'B', group: 'format' },
    { id: 'italic', label: 'I', group: 'format' },
    { id: 'strikethrough', label: 'S', group: 'format' },
    { id: 'code', label: '`', group: 'format' },
    { id: 'link', label: '🔗', group: 'format' },
    // Paragraph
    { id: 'h1', label: 'H1', group: 'paragraph' },
    { id: 'h2', label: 'H2', group: 'paragraph' },
    { id: 'h3', label: 'H3', group: 'paragraph' },
    { id: 'quote', label: '❝', group: 'paragraph' },
    { id: 'bullet_list', label: '•', group: 'paragraph' },
    { id: 'ordered_list', label: '1.', group: 'paragraph' },
    // Insert
    { id: 'code_block', label: '{ }', group: 'insert' },
    { id: 'math_block', label: '∑', group: 'insert' },
    { id: 'table', label: '▦', group: 'insert' },
    { id: 'image', label: '🖼', group: 'insert' },
    { id: 'hr', label: '—', group: 'insert' },
  ];
</script>

<div class="touch-toolbar no-select">
  <div class="toolbar-scroll">
    {#each buttons as btn (btn.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="tb-btn"
        class:tb-bold={btn.id === 'bold'}
        class:tb-italic={btn.id === 'italic'}
        class:tb-strike={btn.id === 'strikethrough'}
        onclick={() => onCommand(btn.id)}
        title={btn.label}
      >
        {btn.label}
      </span>
      {#if btn.id === 'redo' || btn.id === 'link' || btn.id === 'ordered_list'}
        <span class="tb-sep"></span>
      {/if}
    {/each}
  </div>
</div>

<style>
  .touch-toolbar {
    display: flex;
    align-items: center;
    height: 40px;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border-color);
    padding: 0 0.25rem;
    z-index: 50;
    flex-shrink: 0;
  }

  .toolbar-scroll {
    display: flex;
    gap: 2px;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    align-items: center;
    height: 100%;
  }

  .toolbar-scroll::-webkit-scrollbar {
    display: none;
  }

  .tb-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
    height: 36px;
    padding: 0 0.5rem;
    border-radius: 6px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--transition-fast);
  }

  .tb-btn:active {
    background: var(--bg-active);
  }

  .tb-bold {
    font-weight: 700;
  }

  .tb-italic {
    font-style: italic;
  }

  .tb-strike {
    text-decoration: line-through;
  }

  .tb-sep {
    width: 1px;
    height: 20px;
    background: var(--border-color);
    margin: 0 2px;
    flex-shrink: 0;
  }
</style>

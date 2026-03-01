<script lang="ts">
  import { t } from '$lib/i18n';

  export interface OutlineHeading {
    id: string;
    level: number;
    text: string;
  }

  let {
    headings = [],
    activeId = null,
    onSelect,
  }: {
    headings?: OutlineHeading[];
    activeId?: string | null;
    onSelect?: (heading: OutlineHeading) => void;
  } = $props();
</script>

<nav class="outline-panel">
  {#if headings.length === 0}
    <span class="outline-empty">{$t('outline.empty')}</span>
  {:else}
    {#each headings as h}
      <button
        class="outline-item"
        class:active={h.id === activeId}
        style="padding-left: {(h.level - 1) * 12}px"
        onclick={() => onSelect?.(h)}
        title={h.text}
      >
        {h.text}
      </button>
    {/each}
  {/if}
</nav>

<style>
  .outline-panel {
    width: 200px;
    flex-shrink: 0;
    position: sticky;
    top: 0;
    align-self: flex-start;
    max-height: calc(100vh - var(--titlebar-height) - var(--statusbar-height) - 4rem);
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 8px;
    scrollbar-width: none;
  }

  .outline-panel::-webkit-scrollbar {
    display: none;
  }

  .outline-empty {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .outline-item {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-left: 2px solid transparent;
    padding: 2px 4px;
    font-size: var(--font-size-xs);
    line-height: 1.6;
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 0.15s;
  }

  .outline-item:hover {
    color: var(--text-primary);
  }

  .outline-item.active {
    color: var(--text-primary);
    border-left-color: var(--accent-color);
  }
</style>

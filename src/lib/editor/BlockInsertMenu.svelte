<script lang="ts">
  /**
   * The "+" button's dropdown: pick a markdown construct and have the editor
   * write it for you.
   *
   * Rows come from block-insert-items.ts; this file is only presentation and
   * keyboard handling. It follows EditorContextMenu's shape — fixed position,
   * backdrop that closes on click, auto-flip when it would run off-screen —
   * so it feels like the menus already in the app rather than a new species
   * of popup.
   */
  import { t } from '$lib/i18n';
  import { INSERT_GROUPS, INSERT_ITEMS, type InsertActionId } from './block-insert-items';

  let {
    position,
    onSelect,
    onClose,
  }: {
    position: { top: number; left: number };
    onSelect: (id: InsertActionId) => void;
    onClose: () => void;
  } = $props();

  let menuEl: HTMLDivElement | undefined = $state();
  let adjustedTop = $state(position.top);
  let adjustedLeft = $state(position.left);
  /** Keyboard cursor. -1 until an arrow key is pressed, so opening the menu
   *  does not pre-highlight a row the user never asked for. */
  let activeIndex = $state(-1);

  $effect(() => {
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    // Flip above the button when there is not enough room below, and pull
    // back from the right edge — the menu opens from the far-left gutter, so
    // running off the bottom is the common case on a block low in the page.
    adjustedTop =
      position.top + rect.height > window.innerHeight
        ? Math.max(4, position.top - rect.height - 26)
        : position.top;
    adjustedLeft =
      position.left + rect.width > window.innerWidth
        ? Math.max(4, window.innerWidth - rect.width - 4)
        : Math.max(4, position.left);
  });

  $effect(() => {
    menuEl?.focus();
  });

  function choose(id: InsertActionId) {
    onSelect(id);
    onClose();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const n = INSERT_ITEMS.length;
      activeIndex = activeIndex < 0 ? (step === 1 ? 0 : n - 1) : (activeIndex + step + n) % n;
      return;
    }
    if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      const item = INSERT_ITEMS[activeIndex];
      if (item) choose(item.id);
    }
  }

  /** Index of a row within the flattened list, for the keyboard cursor. */
  function indexOf(id: InsertActionId): number {
    return INSERT_ITEMS.findIndex((i) => i.id === id);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu-backdrop" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    bind:this={menuEl}
    class="insert-menu"
    role="menu"
    tabindex="-1"
    aria-label={$t('editor.insert_menu_tooltip')}
    style="top: {adjustedTop}px; left: {adjustedLeft}px"
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeydown}
  >
    {#each INSERT_GROUPS as group, gi}
      {#if gi > 0}<div class="menu-divider"></div>{/if}
      {#each group as item}
        <button
          class="menu-item"
          class:active={activeIndex === indexOf(item.id)}
          role="menuitem"
          data-action={item.id}
          onclick={() => choose(item.id)}
          onmouseenter={() => { activeIndex = indexOf(item.id); }}
        >
          <span class="icon" class:glyph={!!item.glyph} data-style={item.glyphStyle ?? ''}>
            {#if item.svg}
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">{@html item.svg}</svg>
            {:else}
              {item.glyph}
            {/if}
          </span>
          <span class="label">{$t(item.labelKey)}</span>
          <span class="hint">{item.hint}</span>
        </button>
      {/each}
    {/each}
  </div>
</div>

<style>
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
  }

  .insert-menu {
    position: fixed;
    min-width: 230px;
    /* Tall enough for all 18 rows on a normal window, scrollable on a short
       one rather than overflowing off-screen. */
    max-height: min(70vh, 520px);
    overflow-y: auto;
    padding: 0.25rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 61;
    outline: none;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.35rem 0.5rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border-radius: 4px;
    text-align: left;
  }

  .menu-item:hover,
  .menu-item.active {
    background: var(--bg-hover);
  }

  .icon {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--text-secondary);
    background: var(--bg-secondary, transparent);
  }

  .icon.glyph {
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
  }

  .icon[data-style='bold'] { font-weight: 800; font-size: 13px; }
  .icon[data-style='italic'] { font-style: italic; font-size: 13px; font-family: Georgia, serif; }
  .icon[data-style='strike'] { text-decoration: line-through; font-size: 13px; }
  .icon[data-style='mono'] { font-family: var(--font-mono, ui-monospace, Menlo, monospace); font-size: 10px; }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The markdown the row writes. Greyed and monospaced so it reads as a
     lesson rather than as part of the label. */
  .hint {
    flex: none;
    margin-left: 0.75rem;
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .menu-divider {
    height: 1px;
    background: var(--border-light);
    margin: 0.25rem 0.5rem;
  }
</style>

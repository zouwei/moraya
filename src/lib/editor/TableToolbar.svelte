<script lang="ts">
  import { t } from '$lib/i18n';

  let {
    position,
    onAddRowBefore,
    onAddRowAfter,
    onAddColBefore,
    onAddColAfter,
    onDeleteRow,
    onDeleteCol,
    onAlignLeft,
    onAlignCenter,
    onAlignRight,
  }: {
    position: { top: number; left: number };
    onAddRowBefore: () => void;
    onAddRowAfter: () => void;
    onAddColBefore: () => void;
    onAddColAfter: () => void;
    onDeleteRow: () => void;
    onDeleteCol: () => void;
    onAlignLeft: () => void;
    onAlignCenter: () => void;
    onAlignRight: () => void;
  } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="table-toolbar"
  style="top: {position.top}px; left: {position.left}px"
  onclick={(e) => e.stopPropagation()}
>
  <div class="toolbar-group">
    <button class="toolbar-btn" onclick={onAddRowBefore} title={$t('table.insertRowAbove')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="12" y1="3" x2="12" y2="12"/>
        <line x1="9" y1="7" x2="15" y2="7"/>
      </svg>
    </button>
    <button class="toolbar-btn" onclick={onAddRowAfter} title={$t('table.insertRowBelow')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="12" y1="12" x2="12" y2="21"/>
        <line x1="9" y1="17" x2="15" y2="17"/>
      </svg>
    </button>
    <button class="toolbar-btn danger" onclick={onDeleteRow} title={$t('table.deleteRow')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="3" y1="12" x2="21" y2="12"/>
        <line x1="9" y1="8" x2="15" y2="8"/>
      </svg>
    </button>
  </div>

  <div class="toolbar-divider"></div>

  <div class="toolbar-group">
    <button class="toolbar-btn" onclick={onAddColBefore} title={$t('table.insertColLeft')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="12" y1="3" x2="12" y2="21"/>
        <line x1="3" y1="12" x2="12" y2="12"/>
        <line x1="7" y1="9" x2="7" y2="15"/>
      </svg>
    </button>
    <button class="toolbar-btn" onclick={onAddColAfter} title={$t('table.insertColRight')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="12" y1="3" x2="12" y2="21"/>
        <line x1="12" y1="12" x2="21" y2="12"/>
        <line x1="17" y1="9" x2="17" y2="15"/>
      </svg>
    </button>
    <button class="toolbar-btn danger" onclick={onDeleteCol} title={$t('table.deleteCol')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <line x1="12" y1="3" x2="12" y2="21"/>
        <line x1="8" y1="9" x2="8" y2="15"/>
      </svg>
    </button>
  </div>

  <div class="toolbar-divider"></div>

  <div class="toolbar-group">
    <button class="toolbar-btn" onclick={onAlignLeft} title={$t('table.alignLeft')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>
      </svg>
    </button>
    <button class="toolbar-btn" onclick={onAlignCenter} title={$t('table.alignCenter')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
      </svg>
    </button>
    <button class="toolbar-btn" onclick={onAlignRight} title={$t('table.alignRight')}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>
      </svg>
    </button>
  </div>
</div>

<style>
  .table-toolbar {
    position: fixed;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    z-index: 50;
    transform: translateY(-100%) translateY(-8px);
  }

  .toolbar-group {
    display: flex;
    gap: 0.125rem;
  }

  .toolbar-divider {
    width: 1px;
    height: 1.25rem;
    background: var(--border-light);
    margin: 0 0.125rem;
  }

  .toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: 4px;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .toolbar-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .toolbar-btn.danger:hover {
    background: rgba(232, 17, 35, 0.1);
    color: #e81123;
  }
</style>

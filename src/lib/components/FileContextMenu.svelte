<script lang="ts">
  import { t } from '$lib/i18n';

  type TargetType = 'file' | 'folder' | 'blank';

  let {
    position,
    targetType,
    targetPath,
    targetName,
    onNewFile,
    onSearch,
    onRefresh,
    onRename,
    onDuplicate,
    onDelete,
    onCopyPath,
    onRevealInFinder,
    onClose,
  }: {
    position: { top: number; left: number };
    targetType: TargetType;
    targetPath: string;
    targetName: string;
    onNewFile: () => void;
    onSearch: () => void;
    onRefresh: () => void;
    onRename: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onCopyPath: () => void;
    onRevealInFinder: () => void;
    onClose: () => void;
  } = $props();

  const tr = $t;

  function handleAction(action: () => void) {
    action();
    onClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu-backdrop" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
  <div
    class="context-menu"
    style="top: {position.top}px; left: {position.left}px"
    onclick={(e) => e.stopPropagation()}
  >
    <button class="menu-item" onclick={() => handleAction(onNewFile)}>
      {tr('sidebar.contextMenu.newFile')}
    </button>

    <button class="menu-item" onclick={() => handleAction(onSearch)}>
      {tr('sidebar.contextMenu.searchFiles')}
    </button>

    <button class="menu-item" onclick={() => handleAction(onRefresh)}>
      {tr('sidebar.contextMenu.refresh')}
    </button>

    {#if targetType !== 'blank'}
      <div class="menu-divider"></div>

      <button class="menu-item" onclick={() => handleAction(onRename)}>
        {tr('sidebar.contextMenu.rename')}
      </button>

      {#if targetType === 'file'}
        <button class="menu-item" onclick={() => handleAction(onDuplicate)}>
          {tr('sidebar.contextMenu.duplicate')}
        </button>
      {/if}

      <button class="menu-item danger" onclick={() => handleAction(onDelete)}>
        {tr('sidebar.contextMenu.delete')}
      </button>

      <div class="menu-divider"></div>

      <button class="menu-item" onclick={() => handleAction(onCopyPath)}>
        {tr('sidebar.contextMenu.copyPath')}
      </button>

      <button class="menu-item" onclick={() => handleAction(onRevealInFinder)}>
        {tr('sidebar.contextMenu.revealInFinder')}
      </button>
    {/if}
  </div>
</div>

<style>
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
  }

  .context-menu {
    position: fixed;
    min-width: 180px;
    padding: 0.25rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 61;
  }

  .menu-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 0.4rem 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border-radius: 4px;
    text-align: left;
  }

  .menu-item:hover {
    background: var(--bg-hover);
  }

  .menu-item.danger:hover {
    background: rgba(232, 17, 35, 0.1);
    color: #e81123;
  }

  .menu-divider {
    height: 1px;
    background: var(--border-light);
    margin: 0.25rem 0.5rem;
  }
</style>

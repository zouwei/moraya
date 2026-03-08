<script lang="ts">
  import { t } from '$lib/i18n';
  import { isMacOS, isWindows } from '$lib/utils/platform';

  type TargetType = 'file' | 'folder' | 'blank';

  let {
    position,
    targetType,
    targetPath,
    targetName,
    onNewFile,
    onNewFolder,
    onSearch,
    onRefresh,
    onRename,
    onDuplicate,
    onDelete,
    onCopyPath,
    onRevealInFinder,
    historyVersions,
    onRestoreVersion,
    onClose,
  }: {
    position: { top: number; left: number };
    targetType: TargetType;
    targetPath: string;
    targetName: string;
    onNewFile: () => void;
    onNewFolder: () => void;
    onSearch: () => void;
    onRefresh: () => void;
    onRename: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onCopyPath: () => void;
    onRevealInFinder: () => void;
    /** Pre-loaded history versions for MORAYA.md; undefined = not applicable */
    historyVersions?: Array<{ path: string; timestamp: string }>;
    onRestoreVersion?: (versionPath: string) => void;
    onClose: () => void;
  } = $props();

  const revealLabel = isMacOS
    ? $t('sidebar.contextMenu.revealInFinder')
    : isWindows
      ? $t('sidebar.contextMenu.revealInExplorer')
      : $t('sidebar.contextMenu.revealInFinder'); // Linux fallback

  const tr = $t;

  function handleAction(action: () => void) {
    action();
    onClose();
  }

  // Submenu hover management with a small hide-delay so the cursor
  // can travel from the menu item to the submenu without it flickering away.
  let showHistorySubmenu = $state(false);
  let hideSubmenuTimer: ReturnType<typeof setTimeout> | undefined;

  function onSubmenuEnter() {
    clearTimeout(hideSubmenuTimer);
    showHistorySubmenu = true;
  }

  function onSubmenuLeave() {
    clearTimeout(hideSubmenuTimer);
    hideSubmenuTimer = setTimeout(() => {
      showHistorySubmenu = false;
    }, 200);
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

    <button class="menu-item" onclick={() => handleAction(onNewFolder)}>
      {tr('sidebar.contextMenu.newFolder')}
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
        {revealLabel}
      </button>

      {#if targetType === 'file' && targetName === 'MORAYA.md' && historyVersions !== undefined}
        <div class="menu-divider"></div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
          class="submenu-container"
          onmouseenter={onSubmenuEnter}
          onmouseleave={onSubmenuLeave}
        >
          <div class="menu-item submenu-trigger" role="menuitem" tabindex="-1">
            <span>{tr('sidebar.contextMenu.historyVersions')}</span>
            <span class="submenu-arrow">▶</span>
          </div>
          {#if showHistorySubmenu}
            <div class="submenu" onclick={(e) => e.stopPropagation()}>
              {#if historyVersions.length === 0}
                <div class="submenu-empty">{tr('sidebar.history.empty')}</div>
              {:else}
                {#each historyVersions as v}
                  <button
                    class="menu-item"
                    onclick={() => { onRestoreVersion?.(v.path); onClose(); }}
                  >
                    {v.timestamp}
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {/if}
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

  /* ---- History submenu ---- */

  .submenu-container {
    position: relative;
  }

  .submenu-trigger {
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: default;
    user-select: none;
  }

  /* Keep hover highlight even when the submenu is open */
  .submenu-container:hover > .submenu-trigger {
    background: var(--bg-hover);
  }

  .submenu-arrow {
    font-size: 0.5rem;
    opacity: 0.55;
    margin-left: 0.5rem;
    flex-shrink: 0;
  }

  .submenu {
    position: absolute;
    left: calc(100% + 0.25rem);
    top: -0.25rem;           /* align with the context-menu's top padding */
    min-width: 210px;
    max-height: 240px;
    overflow-y: auto;
    padding: 0.25rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 1;              /* above siblings within context-menu stacking context */
  }

  .submenu .menu-item {
    white-space: nowrap;
    font-family: var(--font-mono, monospace);
  }

  .submenu-empty {
    padding: 0.4rem 0.75rem;
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    white-space: nowrap;
  }
</style>

<script lang="ts">
  import { t } from '$lib/i18n';

  let {
    position,
    imageSrc,
    isUploadable,
    isRemoteUrl,
    onResize,
    onUpload,
    onEditAlt,
    onCopyImage,
    onCopyUrl,
    onOpenInBrowser,
    onSaveAs,
    onDelete,
    onClose,
  }: {
    position: { top: number; left: number };
    imageSrc: string;
    isUploadable: boolean;
    isRemoteUrl: boolean;
    onResize: (width: string) => void;
    onUpload: () => void;
    onEditAlt: () => void;
    onCopyImage: () => void;
    onCopyUrl: () => void;
    onOpenInBrowser: () => void;
    onSaveAs: () => void;
    onDelete: () => void;
    onClose: () => void;
  } = $props();

  const tr = $t;

  let showResizeSubmenu = $state(false);

  const resizeOptions = [
    { label: '25%', value: '25%' },
    { label: '50%', value: '50%' },
    { label: '75%', value: '75%' },
    { label: '100%', value: '100%' },
    { label: tr('imageMenu.originalSize'), value: '' },
  ];

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
    <div
      class="menu-item has-submenu"
      onmouseenter={() => showResizeSubmenu = true}
      onmouseleave={() => showResizeSubmenu = false}
    >
      <span>{tr('imageMenu.resize')}</span>
      <span class="arrow">›</span>
      {#if showResizeSubmenu}
        <div class="submenu">
          {#each resizeOptions as opt}
            <button class="menu-item" onclick={() => handleAction(() => onResize(opt.value))}>
              {opt.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="menu-divider"></div>

    <button class="menu-item" onclick={() => handleAction(onCopyImage)}>
      {tr('imageMenu.copyImage')}
    </button>

    <button class="menu-item" onclick={() => handleAction(onCopyUrl)}>
      {tr('imageMenu.copyUrl')}
    </button>

    <div class="menu-divider"></div>

    {#if isUploadable}
      <button class="menu-item" onclick={() => handleAction(onUpload)}>
        {tr('imageMenu.upload')}
      </button>
    {/if}

    <button class="menu-item" onclick={() => handleAction(onEditAlt)}>
      {tr('imageMenu.editAlt')}
    </button>

    <div class="menu-divider"></div>

    {#if isRemoteUrl}
      <button class="menu-item" onclick={() => handleAction(onOpenInBrowser)}>
        {tr('imageMenu.openInBrowser')}
      </button>
    {/if}

    <button class="menu-item" onclick={() => handleAction(onSaveAs)}>
      {tr('imageMenu.saveAs')}
    </button>

    <div class="menu-divider"></div>

    <button class="menu-item danger" onclick={() => handleAction(onDelete)}>
      {tr('imageMenu.delete')}
    </button>
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
    justify-content: space-between;
    width: 100%;
    padding: 0.4rem 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border-radius: 4px;
    text-align: left;
    position: relative;
  }

  .menu-item:hover {
    background: var(--bg-hover);
  }

  .menu-item.danger:hover {
    background: rgba(232, 17, 35, 0.1);
    color: #e81123;
  }

  .menu-item.has-submenu {
    cursor: default;
  }

  .arrow {
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .submenu {
    position: absolute;
    left: 100%;
    top: -0.25rem;
    min-width: 120px;
    padding: 0.25rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }

  .menu-divider {
    height: 1px;
    background: var(--border-light);
    margin: 0.25rem 0.5rem;
  }
</style>

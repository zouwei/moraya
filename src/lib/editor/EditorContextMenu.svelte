<script lang="ts">
  import { t } from '$lib/i18n';
  import { isMacOS } from '$lib/utils/platform';

  let {
    position,
    hasImages = false,
    hasSelection = false,
    inSpecialBlock = false,
    showCloudInsert = true,
    onCut,
    onCopy,
    onPaste,
    onBold,
    onItalic,
    onUnderline,
    onStrikethrough,
    onCode,
    onBulletList,
    onOrderedList,
    onUploadAllImages,
    onSEO,
    onImageGen,
    onPublish,
    onAddReview,
    onInsertCloudImage,
    onInsertCloudAudio,
    onInsertCloudVideo,
    onClose,
  }: {
    position: { top: number; left: number };
    hasImages?: boolean;
    hasSelection?: boolean;
    inSpecialBlock?: boolean;
    showCloudInsert?: boolean;
    onCut: () => void;
    onCopy: () => void;
    onPaste: () => void;
    onBold?: () => void;
    onItalic?: () => void;
    onUnderline?: () => void;
    onStrikethrough?: () => void;
    onCode?: () => void;
    onBulletList?: () => void;
    onOrderedList?: () => void;
    onUploadAllImages?: () => void;
    onSEO: () => void;
    onImageGen: () => void;
    onPublish: () => void;
    onAddReview?: () => void;
    onInsertCloudImage?: () => void;
    onInsertCloudAudio?: () => void;
    onInsertCloudVideo?: () => void;
    onClose: () => void;
  } = $props();

  const modKey = isMacOS ? '⌘' : 'Ctrl+';
  const shiftKey = isMacOS ? '⇧' : 'Shift+';

  let menuEl: HTMLDivElement | undefined = $state();
  // svelte-ignore state_referenced_locally
  let adjustedTop = $state(position.top);
  // svelte-ignore state_referenced_locally
  let adjustedLeft = $state(position.left);

  let showMoreSubmenu = $state(false);
  let showCloudSubmenu = $state(false);

  let hasCloudInsert = $derived(!!(onInsertCloudImage || onInsertCloudAudio || onInsertCloudVideo));

  $effect(() => {
    if (!menuEl) return;
    const rect = menuEl.getBoundingClientRect();
    const viewH = window.innerHeight;
    const viewW = window.innerWidth;
    adjustedTop = (position.top + rect.height > viewH)
      ? Math.max(4, position.top - rect.height)
      : position.top;
    adjustedLeft = (position.left + rect.width > viewW)
      ? Math.max(4, viewW - rect.width - 4)
      : position.left;
  });

  function handleAction(action: () => void) {
    action();
    onClose();
  }

  function trimDots(s: string): string {
    return s.replace(/…$/, '');
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu-backdrop" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}>
  <div
    bind:this={menuEl}
    class="context-menu"
    style="top: {adjustedTop}px; left: {adjustedLeft}px"
    onclick={(e) => e.stopPropagation()}
  >
    <button class="menu-item" onclick={() => handleAction(onCut)}>
      <span>{$t('contextMenu.cut')}</span>
      <span class="shortcut">{modKey}X</span>
    </button>

    <button class="menu-item" onclick={() => handleAction(onCopy)}>
      <span>{$t('contextMenu.copy')}</span>
      <span class="shortcut">{modKey}C</span>
    </button>

    <button class="menu-item" onclick={() => handleAction(onPaste)}>
      <span>{$t('contextMenu.paste')}</span>
      <span class="shortcut">{modKey}V</span>
    </button>

    {#if hasSelection && (onBold || onItalic || onUnderline || onStrikethrough || onCode)}
      <div class="menu-divider"></div>
      <div class="format-group">
        {#if onBold}
          <button class="menu-item format-btn" onclick={() => handleAction(onBold)} title="{$t('contextMenu.bold')} ({modKey}B)">
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z"/>
              </svg>
            </span>
          </button>
        {/if}
        {#if onItalic}
          <button class="menu-item format-btn" onclick={() => handleAction(onItalic)} title="{$t('contextMenu.italic')} ({modKey}I)">
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z"/>
              </svg>
            </span>
          </button>
        {/if}
        {#if onUnderline}
          <button class="menu-item format-btn" onclick={() => handleAction(onUnderline)} title="{$t('contextMenu.underline')} ({modKey}U)">
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 17c3.31 0 6-2.69 6-6V3h-2.5v8c0 1.93-1.57 3.5-3.5 3.5S8.5 12.93 8.5 11V3H6v8c0 3.31 2.69 6 6 6zm-7 2v2h14v-2H5z"/>
              </svg>
            </span>
          </button>
        {/if}
        {#if onStrikethrough}
          <button class="menu-item format-btn" onclick={() => handleAction(onStrikethrough)} title="{$t('contextMenu.strikethrough')} ({modKey}{shiftKey}D)">
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 4H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
                <line x1="4" y1="12" x2="20" y2="12"/>
              </svg>
            </span>
          </button>
        {/if}
        {#if onCode}
          <button class="menu-item format-btn" onclick={() => handleAction(onCode)} title={`${$t('contextMenu.code')} (${modKey + '`'})`}>
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
              </svg>
            </span>
          </button>
        {/if}
        {#if onBulletList || onOrderedList}
          <div
            class="submenu-wrapper"
            onmouseenter={() => showMoreSubmenu = true}
            onmouseleave={() => showMoreSubmenu = false}
          >
            <button
              class="menu-item format-btn"
              class:submenu-open={showMoreSubmenu}
              title={$t('contextMenu.moreFormatting')}
            >
              <span class="menu-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="1.5"/>
                  <circle cx="12" cy="12" r="1.5"/>
                  <circle cx="12" cy="19" r="1.5"/>
                </svg>
              </span>
            </button>
            {#if showMoreSubmenu}
              <div class="submenu submenu-more">
                {#if onBulletList}
                  <button class="menu-item" onclick={() => handleAction(onBulletList)}>
                    <span class="menu-icon">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="8" y1="6" x2="21" y2="6"/>
                        <line x1="8" y1="12" x2="21" y2="12"/>
                        <line x1="8" y1="18" x2="21" y2="18"/>
                        <circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/>
                        <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/>
                        <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/>
                      </svg>
                    </span>
                    <span class="menu-label">{$t('contextMenu.unorderedList')}</span>
                  </button>
                {/if}
                {#if onOrderedList}
                  <button class="menu-item" onclick={() => handleAction(onOrderedList)}>
                    <span class="menu-icon">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="10" y1="6" x2="21" y2="6"/>
                        <line x1="10" y1="12" x2="21" y2="12"/>
                        <line x1="10" y1="18" x2="21" y2="18"/>
                        <text x="3" y="8" font-size="9" fill="currentColor" stroke="none" font-weight="bold">1</text>
                        <text x="3" y="14" font-size="9" fill="currentColor" stroke="none" font-weight="bold">2</text>
                        <text x="3" y="20" font-size="9" fill="currentColor" stroke="none" font-weight="bold">3</text>
                      </svg>
                    </span>
                    <span class="menu-label">{$t('contextMenu.orderedList')}</span>
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    {#if onAddReview}
      <div class="menu-divider"></div>
      <button
        class="menu-item"
        disabled={!hasSelection}
        onclick={() => { if (onAddReview) handleAction(onAddReview); }}
      >
        <span>{$t('review.addReview')}</span>
        <span class="shortcut">{modKey}{shiftKey}R</span>
      </button>
    {/if}

    {#if showCloudInsert && !inSpecialBlock && hasCloudInsert}
      <div class="menu-divider"></div>
      <div
        class="menu-item has-submenu"
        onmouseenter={() => showCloudSubmenu = true}
        onmouseleave={() => showCloudSubmenu = false}
      >
        <span>{$t('contextMenu.insertCloud')}</span>
        <span class="arrow">›</span>
        {#if showCloudSubmenu}
          <div class="submenu submenu-cloud" onmouseenter={() => showCloudSubmenu = true} onmouseleave={() => showCloudSubmenu = false}>
            {#if onInsertCloudImage}
              <button class="menu-item" onclick={() => handleAction(onInsertCloudImage)}>
                {trimDots($t('contextMenu.insertCloudImage'))}
              </button>
            {/if}
            {#if onInsertCloudAudio}
              <button class="menu-item" onclick={() => handleAction(onInsertCloudAudio)}>
                {trimDots($t('contextMenu.insertCloudAudio'))}
              </button>
            {/if}
            {#if onInsertCloudVideo}
              <button class="menu-item" onclick={() => handleAction(onInsertCloudVideo)}>
                {trimDots($t('contextMenu.insertCloudVideo'))}
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <div class="menu-divider"></div>

    <button class="menu-item" disabled={!hasImages} onclick={() => { if (onUploadAllImages) handleAction(onUploadAllImages); }}>
      {$t('contextMenu.uploadAllImages')}
    </button>

    <div class="menu-divider"></div>

    <button class="menu-item" onclick={() => handleAction(onSEO)}>
      {$t('menu.seoOptimization')}
    </button>

    <button class="menu-item" onclick={() => handleAction(onImageGen)}>
      {$t('menu.aiImageGeneration')}
    </button>

    <button class="menu-item" onclick={() => handleAction(onPublish)}>
      {$t('menu.publish')}
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
    min-width: 200px;
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

  .menu-item:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .menu-item:disabled {
    color: var(--text-muted);
    cursor: default;
    opacity: 0.5;
  }

  .menu-item.has-submenu {
    cursor: default;
  }

  .shortcut {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-left: 1.5rem;
    flex-shrink: 0;
  }

  .arrow {
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-left: 0.5rem;
  }

  .menu-divider {
    height: 1px;
    background: var(--border-light);
    margin: 0.25rem 0.5rem;
  }

  .menu-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 18px;
    color: var(--text-secondary);
  }

  .menu-label {
    flex: 1;
  }

  .format-group {
    display: flex;
    gap: 0.125rem;
    padding: 0.25rem;
  }

  .format-btn {
    justify-content: center;
    width: 34px;
    height: 32px;
    padding: 0;
    border-radius: 4px;
  }

  .format-btn:hover {
    background: var(--bg-hover);
  }

  .submenu-wrapper {
    position: relative;
  }

  .submenu-wrapper .format-btn.submenu-open {
    background: var(--bg-hover);
  }

  .submenu {
    position: absolute;
    left: 100%;
    top: -0.25rem;
    min-width: 140px;
    padding: 0.25rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    z-index: 62;
  }

  .submenu-more {
    left: auto;
    right: 0;
    top: 100%;
    min-width: 160px;
  }

  .submenu-cloud {
    min-width: 180px;
  }

  .submenu .menu-item {
    gap: 0.5rem;
  }
</style>

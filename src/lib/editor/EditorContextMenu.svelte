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

  // Auto-flip: measure menu after render and flip if it would overflow viewport
  let menuEl: HTMLDivElement | undefined = $state();
  let adjustedTop = $state(position.top);
  let adjustedLeft = $state(position.left);

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
      <span class="menu-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </span>
      <span class="menu-label">{$t('contextMenu.paste')}</span>
      <span class="shortcut">{modKey}V</span>
    </button>

    {#if hasSelection && (onBold || onItalic || onUnderline || onStrikethrough || onCode)}
      <div class="menu-divider"></div>
      <div class="format-group">
        {#if onBold}
          <button class="menu-item format-btn" onclick={() => handleAction(onBold)} title={$t('contextMenu.bold')}>
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z"/>
              </svg>
            </span>
          </button>
        {/if}
        {#if onItalic}
          <button class="menu-item format-btn" onclick={() => handleAction(onItalic)} title={$t('contextMenu.italic')}>
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z"/>
              </svg>
            </span>
          </button>
        {/if}
        {#if onUnderline}
          <button class="menu-item format-btn" onclick={() => handleAction(onUnderline)} title={$t('contextMenu.underline')}>
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 17c3.31 0 6-2.69 6-6V3h-2.5v8c0 1.93-1.57 3.5-3.5 3.5S8.5 12.93 8.5 11V3H6v8c0 3.31 2.69 6 6 6zm-7 2v2h14v-2H5z"/>
              </svg>
            </span>
          </button>
        {/if}
        {#if onStrikethrough}
          <button class="menu-item format-btn" onclick={() => handleAction(onStrikethrough)} title={$t('contextMenu.strikethrough')}>
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6.85 7.08C6.85 4.37 9.45 3 12.24 3c1.64 0 3 .49 3.9 1.28.77.65 1.46 1.73 1.46 3.24h-3.81c0-.93-.37-1.55-.95-1.88-.55-.3-1.22-.42-1.93-.31-.81.13-1.56.49-1.93 1-.35.49-.33 1.01-.33 1.14 0 1.04.39 1.73 1.2 2.26l.12.08H3v2h18v-2h-4.65c-.35-.22-.66-.47-.95-.73.64-.55 1.14-1.28 1.14-2.25 0-1.04-.35-1.94-.99-2.62C14.85 4.18 13.67 3.5 12.24 3.5c-1.38 0-2.51.49-3.29 1.33-.76.82-1.1 1.89-1.1 3.05h2.81c0-.26.05-.54.19-.8zM4.5 5.05l-1.41 1.41L7.34 10.7a5.24 5.24 0 0 0-.19 2.22c0 2.06.94 3.75 2.43 4.81 1.45 1.02 3.27 1.27 4.73 1.27 1.33 0 2.63-.42 3.68-1.14l3.56 3.56 1.41-1.41L4.5 5.05z"/>
              </svg>
            </span>
          </button>
        {/if}
        {#if onCode}
          <button class="menu-item format-btn" onclick={() => handleAction(onCode)} title={$t('contextMenu.code')}>
            <span class="menu-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
              </svg>
            </span>
          </button>
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
        <span class="shortcut">⌘⇧R</span>
      </button>
    {/if}

    {#if showCloudInsert && !inSpecialBlock && (onInsertCloudImage || onInsertCloudAudio || onInsertCloudVideo)}
      <div class="menu-divider"></div>
      {#if onInsertCloudImage}
        <button class="menu-item" onclick={() => { if (onInsertCloudImage) handleAction(onInsertCloudImage); }}>
          ☁ {$t('contextMenu.insertCloudImage')}
        </button>
      {/if}
      {#if onInsertCloudAudio}
        <button class="menu-item" onclick={() => { if (onInsertCloudAudio) handleAction(onInsertCloudAudio); }}>
          ☁ {$t('contextMenu.insertCloudAudio')}
        </button>
      {/if}
      {#if onInsertCloudVideo}
        <button class="menu-item" onclick={() => { if (onInsertCloudVideo) handleAction(onInsertCloudVideo); }}>
          ☁ {$t('contextMenu.insertCloudVideo')}
        </button>
      {/if}
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
  }

  .menu-item:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .menu-item:disabled {
    color: var(--text-muted);
    cursor: default;
    opacity: 0.5;
  }

  .shortcut {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-left: 1.5rem;
    flex-shrink: 0;
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
</style>

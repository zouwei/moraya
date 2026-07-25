<script lang="ts">
  import { onDestroy } from 'svelte';
  import { editorStore } from '../stores/editor-store';
  import type { TabItem } from '../stores/tabs-store';
  import { t } from '$lib/i18n';
  import { isTauri, isMacOS } from '$lib/utils/platform';
  import { getCurrentWindow, LogicalPosition, type Window as TauriWindow } from '@tauri-apps/api/window';
  import { invoke } from '@tauri-apps/api/core';
  import { emitTo } from '@tauri-apps/api/event';

  let {
    title = 'Moraya',
    tabs = [] as TabItem[],
    activeTabId = '',
    externalDropIndex = -1,
    onSwitchTab = (_id: string) => {},
    onCloseTab = (_tab: TabItem) => {},
    onNewFile = () => {},
    onOpenFile = () => {},
    onReorderTabs = (_from: number, _to: number) => {},
    onDetachStart = (_tabIndex: number, _screenX: number, _screenY: number, _offsetX: number, _offsetY: number): Promise<string | undefined> => Promise.resolve(undefined),
    onDetachEnd = (_tabIndex: number, _detachedLabel: string | null, _reattachTarget: string | null): Promise<void> => Promise.resolve(),
    onAttachTab = (_tabIndex: number, _targetLabel: string): Promise<void> => Promise.resolve(),
  }: {
    title?: string;
    tabs?: TabItem[];
    activeTabId?: string;
    externalDropIndex?: number;
    onSwitchTab?: (id: string) => void;
    onCloseTab?: (tab: TabItem) => void;
    onNewFile?: () => void;
    onOpenFile?: () => void;
    onReorderTabs?: (fromIndex: number, toIndex: number) => void;
    onDetachStart?: (tabIndex: number, screenX: number, screenY: number, offsetX: number, offsetY: number) => Promise<string | undefined>;
    onDetachEnd?: (tabIndex: number, detachedLabel: string | null, reattachTarget: string | null) => Promise<void>;
    onAttachTab?: (tabIndex: number, targetLabel: string) => Promise<void>;
  } = $props();

  let isMaximized = $state(false);

  // Tauri window API (null in plain browser for iPad testing)
  const appWindow: TauriWindow | null = isTauri ? getCurrentWindow() : null;

  async function checkMaximized() {
    if (appWindow) isMaximized = await appWindow.isMaximized();
  }

  function handleMinimize() {
    appWindow?.minimize();
  }

  function handleMaximize() {
    appWindow?.toggleMaximize();
    checkMaximized();
  }

  function handleClose() {
    appWindow?.close();
  }

  // macOS Overlay: data-tauri-drag-region doesn't propagate to children,
  // so clicking on <span class="title-text"> won't trigger dragging.
  // Use explicit startDragging() on mousedown for reliable window dragging.
  function handleDragStart(event: MouseEvent) {
    if (event.button !== 0) return; // Only left mouse button
    if ((event.target as HTMLElement).closest('button')) return;
    if ((event.target as HTMLElement).closest('.tab-item')) return;
    // Skip drag on double-click (detail >= 2): macOS startDragging() handles
    // double-click-to-maximize natively, and our ondblclick handler also calls
    // toggleMaximize — triggering both would double-toggle (maximize then restore).
    if (event.detail >= 2) return;
    appWindow?.startDragging();
  }

  function handleDblClick(event: MouseEvent) {
    if ((event.target as HTMLElement).closest('button')) return;
    if ((event.target as HTMLElement).closest('.tab-item')) return;
    // On macOS, startDragging() already handles double-click-to-maximize natively.
    // Only call toggleMaximize on non-macOS platforms.
    if (!isMacOS) {
      handleMaximize();
    }
  }

  // Track dirty state from store — top-level subscribe, do NOT wrap in $effect().
  let isDirty = $state(false);
  const unsubEditor = editorStore.subscribe(state => {
    isDirty = state.isDirty;
  });
  onDestroy(() => { unsubEditor(); });

  let displayTitle = $derived(isDirty ? `${title} - ${$t('titlebar.unsaved')}` : title);

  // Whether to show inline tabs (macOS only, when tabs exist)
  let showInlineTabs = $derived(isMacOS && tabs.length > 0);

  // Tab drag reorder state (mouse-based, not HTML5 DnD — more reliable in Tauri WebKit)
  let dragTabIndex = $state<number | null>(null);
  let dropTargetIndex = $state<number | null>(null);
  let isDetaching = $state(false);
  let dragStartX = 0;
  let isDragging = false;

  // Cross-window drag state
  let crossWindowTarget: string | null = null;
  let cachedBounds: [string, number, number, number, number, number][] = [];
  let lastScreenX = 0;
  let lastScreenY = 0;

  // Live window following state
  let detachTriggered = false;
  let detachedWindowLabel: string | null = null;
  let detachPromise: Promise<string | undefined> | null = null;
  let detachedWindowHidden = false;
  let dragOffsetX = 200;
  let dragOffsetY = 14;
  let dragTabWidth = 100;
  let moveRafId = 0;
  let singleTabHidden = false;

  function handleTabPointerDown(event: PointerEvent, index: number) {
    if (event.button !== 0) return;
    // Don't start drag on close button
    if ((event.target as HTMLElement).closest('.tab-close')) return;
    dragStartX = event.clientX;
    isDragging = false;
    isDetaching = false;
    crossWindowTarget = null;
    detachTriggered = false;
    detachedWindowLabel = null;
    detachPromise = null;
    detachedWindowHidden = false;
    singleTabHidden = false;
    const pointerId = event.pointerId;
    const el = event.currentTarget as HTMLElement;
    el.setPointerCapture(pointerId);
    const myLabel = appWindow?.label ?? '';

    // Record tab width for detach offset calculation
    const tabRect = el.getBoundingClientRect();
    dragTabWidth = tabRect.width;

    // Pre-fetch window bounds immediately on pointer down (before any movement).
    // This gives the IPC ~200ms more time to complete vs fetching on first 5px move.
    if (isTauri) {
      invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
        .then(bounds => { cachedBounds = bounds; })
        .catch(() => {});
    }

    function onMove(e: PointerEvent) {
      if (!isDragging && Math.abs(e.clientX - dragStartX) > 5) {
        isDragging = true;
        dragTabIndex = index;
        document.body.style.cursor = 'grabbing';
        // Cache all window bounds + calculate drag offset for single-tab window move
        if (isTauri) {
          invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
            .then(bounds => { cachedBounds = bounds; })
            .catch(() => { cachedBounds = []; });
          appWindow?.outerPosition().then(pos => {
            // GUARD: don't overwrite detach offset if detach already triggered
            if (detachTriggered) return;
            const scale = window.devicePixelRatio || 1;
            dragOffsetX = e.screenX - pos.x / scale;
            dragOffsetY = e.screenY - pos.y / scale;
          }).catch(() => {});
        }
      }
      if (!isDragging) return;

      lastScreenX = e.screenX;
      lastScreenY = e.screenY;

      // Once detached (multi-tab), stay in window-follow mode regardless of cursor position
      if (detachTriggered) {
        handleDetachedMove(e, myLabel);
        return;
      }

      // Detach detection: check if pointer left the tab bar area
      const tabBarRect = macScrollEl?.getBoundingClientRect();
      if (tabBarRect) {
        const detachMargin = 40;
        const leftTabBar = e.clientY < tabBarRect.top - detachMargin ||
                           e.clientY > tabBarRect.bottom + detachMargin ||
                           e.clientX < tabBarRect.left - detachMargin ||
                           e.clientX > tabBarRect.right + detachMargin;

        if (leftTabBar) {
          // Check if pointer is over another window's tab bar (attach)
          if (cachedBounds.length > 0) {
            const DETECT_H = isMacOS ? 84 : 108;
            let overTarget: string | null = null;

            for (const [label, wx, wy, ww, , clientYOff] of cachedBounds) {
              if (label === myLabel) continue;
              // Tab bar starts at wy + clientYOff (below native title bar on Windows/Linux)
              const tabTop = wy + clientYOff;
              if (e.screenX >= wx && e.screenX <= wx + ww &&
                  e.screenY >= tabTop && e.screenY <= tabTop + DETECT_H) {
                overTarget = label;
                break;
              }
            }

            if (overTarget) {
              crossWindowTarget = overTarget;
              isDetaching = false;
              dropTargetIndex = null;
              emitTo(overTarget, 'tab-drag-hover', { screenX: e.screenX }).catch(() => {});
              // Single-tab: make window invisible when hovering over target tab bar (Chrome-style).
              // Uses NSWindow.setAlphaValue(0) on macOS — moving off-screen doesn't work
              // because macOS constrains the active/key window to stay partially on-screen.
              if (tabs.length <= 1 && appWindow && !singleTabHidden) {
                singleTabHidden = true;
                invoke('set_window_alpha', { label: appWindow.label, alpha: 0 }).catch(() => {});
              }
              return;
            }
          }

          crossWindowTarget = null;

          if (tabs.length > 1) {
            // Multi-tab: trigger detach immediately — create new window
            detachTriggered = true;
            isDetaching = true;
            dropTargetIndex = null;
            // New window inherits sidebar state from settings. Read the actual
            // padding-left of .titlebar-center which is max(78px, sidebarWidth).
            // This gives the exact X where tabs start in the new window.
            const centerEl = document.querySelector('.titlebar-center');
            const tabBarStart = centerEl
              ? parseFloat(getComputedStyle(centerEl).paddingLeft) || (isMacOS ? 78 : 0)
              : (isMacOS ? 78 : 0);
            dragOffsetX = tabBarStart + dragTabWidth / 2;
            dragOffsetY = isMacOS ? 14 : 50;
            // Re-fetch bounds if not available yet (async race at drag start)
            if (cachedBounds.length === 0 && isTauri) {
              invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
                .then(bounds => { cachedBounds = bounds; }).catch(() => {});
            }
            detachPromise = onDetachStart(index, e.screenX, e.screenY, dragOffsetX, dragOffsetY);
            detachPromise.then(label => {
              detachedWindowLabel = label ?? null;
              // Refresh bounds now that we know the detached window label.
              // This ensures subsequent detection can correctly skip the new window.
              if (isTauri) {
                invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
                  .then(bounds => { cachedBounds = bounds; }).catch(() => {});
              }
            });
          } else {
            // Single-tab: move current window with cursor (also restores from invisible)
            if (singleTabHidden && appWindow) {
              singleTabHidden = false;
              invoke('set_window_alpha', { label: appWindow.label, alpha: 1 }).catch(() => {});
            }
            if (appWindow) {
              appWindow.setPosition(new LogicalPosition(
                e.screenX - dragOffsetX,
                e.screenY - dragOffsetY,
              )).catch(() => {});
            }
          }
          return;
        }
      }

      crossWindowTarget = null;
      isDetaching = false;
      // Safety: restore single-tab window if cursor returned inside source tab bar
      if (singleTabHidden && appWindow) {
        singleTabHidden = false;
        invoke('set_window_alpha', { label: appWindow.label, alpha: 1 }).catch(() => {});
      }

      // Normal intra-window reorder
      const tabEls = macScrollEl?.querySelectorAll('.tab-item');
      if (!tabEls) return;
      let target: number | null = null;
      for (let i = 0; i < tabEls.length; i++) {
        const rect = tabEls[i].getBoundingClientRect();
        if (e.clientX >= rect.left && e.clientX < rect.right) {
          target = i;
          break;
        }
      }
      dropTargetIndex = target;
    }

    /** Handle pointer moves after a multi-tab detach: move the new window, detect re-attach targets */
    let boundsFetching = false;
    function handleDetachedMove(e: PointerEvent, _myLabel: string) {
      // Wait for the detached window label before attempting target detection.
      // Without the label we can't filter the detached window from cachedBounds,
      // risking a false match where we try to merge the tab into its own window.
      if (!detachedWindowLabel) return;

      // Re-fetch bounds if still empty (async race from drag start).
      // Guard with boundsFetching to prevent rapid-fire IPC on every pointermove.
      if (cachedBounds.length === 0 && isTauri && !boundsFetching) {
        boundsFetching = true;
        invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
          .then(bounds => { cachedBounds = bounds; boundsFetching = false; })
          .catch(() => { boundsFetching = false; });
      }

      const DETECT_H = isMacOS ? 84 : 108;
      const EXIT_MARGIN = 120; // hysteresis: must move this far from target to unhide

      let overTarget: string | null = null;
      let nearAnyTarget = false;

      if (cachedBounds.length > 0) {
        for (const [label, wx, wy, ww, , clientYOff] of cachedBounds) {
          if (label === detachedWindowLabel) continue;
          const tabTop = wy + clientYOff;

          // "Entry" zone: full window width × DETECT_H from tab top
          if (!overTarget &&
              e.screenX >= wx && e.screenX <= wx + ww &&
              e.screenY >= tabTop && e.screenY <= tabTop + DETECT_H) {
            overTarget = label;
            nearAnyTarget = true;
          }
          // "Near" zone: expanded by EXIT_MARGIN on all sides (for hysteresis)
          if (!nearAnyTarget &&
              e.screenX >= wx - EXIT_MARGIN && e.screenX <= wx + ww + EXIT_MARGIN &&
              e.screenY >= tabTop - EXIT_MARGIN && e.screenY <= tabTop + DETECT_H + EXIT_MARGIN) {
            nearAnyTarget = true;
          }
        }
      }

      // Hysteresis: if hidden and cursor is still near a target (but not directly over),
      // keep the window hidden and maintain the previous target for merging.
      if (!overTarget && detachedWindowHidden && nearAnyTarget && crossWindowTarget) {
        emitTo(crossWindowTarget, 'tab-drag-hover', { screenX: e.screenX }).catch(() => {});
        return;
      }

      // Update cross-window target state and emit hover events
      if (overTarget !== crossWindowTarget) {
        if (crossWindowTarget) emitTo(crossWindowTarget, 'tab-drag-end', {}).catch(() => {});
        crossWindowTarget = overTarget;
      }

      if (overTarget) {
        emitTo(overTarget, 'tab-drag-hover', { screenX: e.screenX }).catch(() => {});
        // "Hide" the detached window by moving it off-screen.
        // Using move_window instead of set_window_visible eliminates IPC race
        // conditions between separate hide/show/move commands — all visibility
        // changes now go through a single command type.
        if (detachedWindowLabel && !detachedWindowHidden) {
          detachedWindowHidden = true;
          if (moveRafId) { cancelAnimationFrame(moveRafId); moveRafId = 0; }
          invoke('set_window_alpha', { label: detachedWindowLabel, alpha: 0 }).catch(() => {});
        }
      } else {
        // Cursor is far from all targets — bring the window back to cursor position
        if (detachedWindowLabel && detachedWindowHidden) {
          detachedWindowHidden = false;
          // Restore opacity + move immediately so the window reappears without lag
          invoke('set_window_alpha', { label: detachedWindowLabel, alpha: 1 }).catch(() => {});
          invoke('move_window', {
            label: detachedWindowLabel,
            x: e.screenX - dragOffsetX,
            y: e.screenY - dragOffsetY,
          }).catch(() => {});
        }
      }

      // Move the detached window to follow cursor (RAF-throttled; skip when off-screen)
      if (detachedWindowLabel && !detachedWindowHidden) {
        const moveX = e.screenX - dragOffsetX;
        const moveY = e.screenY - dragOffsetY;
        const moveLabel = detachedWindowLabel;
        if (moveRafId) cancelAnimationFrame(moveRafId);
        moveRafId = requestAnimationFrame(() => {
          moveRafId = 0;
          invoke('move_window', { label: moveLabel, x: moveX, y: moveY }).catch(() => {});
        });
      }
    }

    async function onUp() {
      el.releasePointerCapture(pointerId);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);

      // Snapshot all state into locals before any async work.
      // A new drag could start while we're awaiting, resetting component-level vars.
      const savedCrossTarget = crossWindowTarget;
      const savedDragTabIndex = dragTabIndex;
      const savedIsDragging = isDragging;
      const savedDetachTriggered = detachTriggered;
      const savedDetachedWindowLabel = detachedWindowLabel;
      const savedDetachPromise = detachPromise;
      const savedDetachedWindowHidden = detachedWindowHidden;
      const savedCachedBounds = cachedBounds;
      const savedDropTargetIndex = dropTargetIndex;
      const savedSingleTabHidden = singleTabHidden;

      // Reset drag state immediately so a new drag can start cleanly
      document.body.style.cursor = '';
      if (moveRafId) { cancelAnimationFrame(moveRafId); moveRafId = 0; }
      dragTabIndex = null;
      dropTargetIndex = null;
      isDetaching = false;
      isDragging = false;
      crossWindowTarget = null;
      cachedBounds = [];
      detachTriggered = false;
      detachedWindowLabel = null;
      detachPromise = null;
      detachedWindowHidden = false;
      singleTabHidden = false;

      // Restore single-tab window opacity if it was hidden
      if (savedSingleTabHidden && appWindow) {
        invoke('set_window_alpha', { label: appWindow.label, alpha: 1 }).catch(() => {});
      }

      if (savedIsDragging && savedDragTabIndex !== null) {
        if (savedDetachTriggered) {
          // Ensure we have the detached window label (IPC might still be in flight)
          const finalLabel = savedDetachedWindowLabel ??
            (savedDetachPromise ? (await savedDetachPromise.catch(() => undefined)) ?? null : null);
          // If detached window is invisible but no target: restore it at cursor position
          if (savedDetachedWindowHidden && finalLabel && !savedCrossTarget) {
            invoke('set_window_alpha', { label: finalLabel, alpha: 1 }).catch(() => {});
          }
          // Multi-tab detach finalize: remove source tab; if over target, re-attach instead.
          // Await to ensure tab store operations complete before the next drag can start.
          await onDetachEnd(savedDragTabIndex, finalLabel, savedCrossTarget);
        } else if (savedCrossTarget) {
          // Single-tab or pre-detach attach
          await onAttachTab(savedDragTabIndex, savedCrossTarget);
        } else if (savedDropTargetIndex !== null && savedDragTabIndex !== savedDropTargetIndex) {
          onReorderTabs(savedDragTabIndex, savedDropTargetIndex);
        }
      }

      // Broadcast drag end to all OTHER windows (skip the attach/reattach target — handled by callbacks)
      if (savedIsDragging && savedCachedBounds.length > 0) {
        for (const [label] of savedCachedBounds) {
          if (label !== myLabel && label !== savedCrossTarget) {
            emitTo(label, 'tab-drag-end', {}).catch(() => {});
          }
        }
      }
    }

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  }

  // Right-click context menu state
  let showContextMenu = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);

  function handleContextMenu(event: MouseEvent) {
    if (!isMacOS) return;
    if ((event.target as HTMLElement).closest('.tab-item')) return;
    event.preventDefault();
    contextMenuX = event.clientX;
    contextMenuY = event.clientY;
    showContextMenu = true;

    // Close on next click anywhere
    function closeMenu() {
      showContextMenu = false;
      document.removeEventListener('click', closeMenu, true);
      document.removeEventListener('contextmenu', closeMenu, true);
    }
    requestAnimationFrame(() => {
      document.addEventListener('click', closeMenu, true);
      document.addEventListener('contextmenu', closeMenu, true);
    });
  }

  // Sync native window title.
  // On macOS with Overlay titlebar, native title text renders in the OS title bar area
  // alongside our custom .title-text, causing duplicates. Set native title to '' so the
  // OS renders no text; the custom .title-text (with proper sidebar/AI-panel CSS offsets)
  // handles the visible filename. On other platforms, sync normally.
  $effect(() => {
    if (isMacOS) {
      appWindow?.setTitle('');
    } else {
      appWindow?.setTitle(displayTitle);
    }
  });

  function handleTabClose(event: MouseEvent, tab: TabItem) {
    event.stopPropagation();
    onCloseTab(tab);
  }

  // Scroll overflow detection for macOS inline tabs
  let macScrollEl: HTMLDivElement | undefined = $state();
  let canScrollLeft = $state(false);
  let canScrollRight = $state(false);

  function updateScrollState() {
    if (!macScrollEl) return;
    canScrollLeft = macScrollEl.scrollLeft > 1;
    canScrollRight = macScrollEl.scrollLeft < macScrollEl.scrollWidth - macScrollEl.clientWidth - 1;
  }

  function scrollTabs(dir: 'left' | 'right') {
    if (!macScrollEl) return;
    macScrollEl.scrollBy({ left: dir === 'left' ? -200 : 200, behavior: 'smooth' });
  }

  $effect(() => {
    void tabs.length;
    requestAnimationFrame(updateScrollState);
  });

  // Auto-scroll active tab into view when activeTabId changes
  $effect(() => {
    void activeTabId;
    requestAnimationFrame(() => {
      if (!macScrollEl) return;
      const activeEl = macScrollEl.querySelector('.tab-item.active') as HTMLElement | null;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        requestAnimationFrame(updateScrollState);
      }
    });
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="titlebar no-select" data-tauri-drag-region
  onmousedown={handleDragStart} ondblclick={handleDblClick}
  oncontextmenu={handleContextMenu}>
  <div class="titlebar-left">
    <span class="app-name" data-tauri-drag-region>Moraya</span>
  </div>

  <div class="titlebar-center" data-tauri-drag-region>
    {#if showInlineTabs}
      <!-- macOS: tabs embedded in 28px overlay -->
      {#if canScrollLeft}
        <button class="scroll-arrow scroll-left" onclick={() => scrollTabs('left')}>
          <svg width="6" height="8" viewBox="0 0 6 8"><path fill="currentColor" d="M5 0L0 4l5 4z"/></svg>
        </button>
      {/if}
      <div class="mac-tabs-scroll" bind:this={macScrollEl} onscroll={updateScrollState}>
        {#each tabs as tab, index (tab.id)}
          {#if externalDropIndex === index}
            <div class="external-drop-indicator"></div>
          {/if}
          <!-- svelte-ignore a11y_consider_explicit_label -->
          <button class="tab-item" class:active={tab.id === activeTabId}
            class:typst={tab.flavor === 'typst'}
            class:drag-over={dropTargetIndex === index && dragTabIndex !== index}
            class:dragging={dragTabIndex === index}
            class:detaching={isDetaching && dragTabIndex === index}
            onclick={() => { if (!isDragging) onSwitchTab(tab.id); }}
            onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); handleTabClose(e, tab); } }}
            onpointerdown={(e) => handleTabPointerDown(e, index)}>
            <span class="tab-name">
              {#if tab.isDirty}<span class="dirty-dot"></span>{/if}
              {#if tab.readOnly}<svg class="readonly-lock" width="9" height="10" viewBox="0 0 10 12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="1.5" y="5" width="7" height="6" rx="1"/><path d="M3 5V3.5a2 2 0 0 1 4 0V5"/></svg>{/if}
              {tab.fileName}
            </span>
            <span class="tab-close" role="button" tabindex="-1"
              onclick={(e) => handleTabClose(e, tab)}>×</span>
          </button>
        {/each}
        {#if externalDropIndex >= tabs.length}
          <div class="external-drop-indicator"></div>
        {/if}
      </div>
      {#if canScrollRight}
        <button class="scroll-arrow scroll-right" onclick={() => scrollTabs('right')}>
          <svg width="6" height="8" viewBox="0 0 6 8"><path fill="currentColor" d="M0 0l6 4-6 4z"/></svg>
        </button>
      {/if}
    {:else}
      <span class="title-text" data-tauri-drag-region>{displayTitle}</span>
    {/if}
  </div>

  <div class="titlebar-right">
    <button class="titlebar-btn" onclick={handleMinimize} title={$t('titlebar.minimize')}>
      <svg width="10" height="1" viewBox="0 0 10 1">
        <rect fill="currentColor" width="10" height="1"/>
      </svg>
    </button>
    <button class="titlebar-btn" onclick={handleMaximize} title={$t('titlebar.maximize')}>
      {#if isMaximized}
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path fill="currentColor" d="M2 0h6v2H2zM0 2h8v8H0zM1 3h6v6H1z" fill-rule="evenodd"/>
        </svg>
      {:else}
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect stroke="currentColor" fill="none" x="0.5" y="0.5" width="9" height="9" rx="0.5"/>
        </svg>
      {/if}
    </button>
    <button class="titlebar-btn close" onclick={handleClose} title={$t('titlebar.close')}>
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path fill="currentColor" d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z"/>
      </svg>
    </button>
  </div>
</div>

{#if showContextMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="titlebar-context-menu" style="left: {contextMenuX}px; top: {contextMenuY}px">
    <button class="context-menu-item" onclick={() => { showContextMenu = false; onNewFile(); }}>
      {$t('titlebar.new_file')}
    </button>
    <button class="context-menu-item" onclick={() => { showContextMenu = false; onOpenFile(); }}>
      {$t('titlebar.open_file')}
    </button>
  </div>
{/if}

<style>
  .titlebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--titlebar-height);
    background: var(--bg-titlebar);
    border-bottom: 1px solid var(--border-light);
    padding: 0 0.5rem;
    -webkit-app-region: drag;
  }

  .titlebar-left {
    flex: 0 0 auto;
    padding-left: 0.5rem;
  }

  .app-name {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .titlebar-center {
    flex: 1;
    text-align: center;
    -webkit-app-region: drag;
    display: flex;
    align-items: center;
    overflow: hidden;
  }

  .title-text {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    flex: 1;
    text-align: center;
  }

  .titlebar-right {
    display: flex;
    gap: 0;
    -webkit-app-region: no-drag;
  }

  .titlebar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: var(--titlebar-height);
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .titlebar-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .titlebar-btn.close:hover {
    background: #e81123;
    color: white;
  }

  /* ── macOS inline tabs ── */
  .scroll-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 28px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    -webkit-app-region: no-drag;
    z-index: 1;
    transition: color var(--transition-fast);
  }
  .scroll-arrow:hover {
    color: var(--text-primary);
  }

  .mac-tabs-scroll {
    display: flex;
    align-items: center;
    overflow-x: auto;
    overflow-y: hidden;
    min-width: 0; /* allow shrink for overflow */
    max-width: 100%;
    -webkit-app-region: no-drag;
    scrollbar-width: none;
  }
  .mac-tabs-scroll::-webkit-scrollbar {
    display: none;
  }

  .tab-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    height: 28px;
    padding: 0 0.5rem;
    max-width: 150px;
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 11px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    -webkit-app-region: no-drag;
    transition: background var(--transition-fast), color var(--transition-fast);
  }
  .tab-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .tab-item.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent-color);
  }
  /* Typst tabs: distinct teal underline (vs. markdown's blue), matching
     TabBar.svelte's non-macOS tab strip so the flavor color is consistent
     across both tab-rendering paths. */
  .tab-item.typst.active {
    border-bottom-color: var(--typst-accent-color);
  }
  .tab-item.typst .dirty-dot {
    background: var(--typst-accent-color);
  }
  .tab-item.dragging {
    opacity: 0.4;
  }
  .tab-item.detaching {
    opacity: 0.6;
    transform: scale(1.05);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    background: var(--accent-color);
    color: white;
    border-radius: 4px;
    z-index: 10;
    transition: none;
  }
  .tab-item.drag-over {
    border-left: 2px solid var(--accent-color);
  }

  .external-drop-indicator {
    width: 2px;
    height: 20px;
    background: var(--accent-color);
    flex-shrink: 0;
    border-radius: 1px;
  }

  .tab-name {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dirty-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent-color);
    flex-shrink: 0;
  }

  .readonly-lock {
    flex-shrink: 0;
    color: var(--text-muted);
    vertical-align: -1px;
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    font-size: 12px;
    line-height: 1;
    color: var(--text-muted);
    flex-shrink: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s, background var(--transition-fast);
  }
  .tab-item.active .tab-close {
    opacity: 1;
    pointer-events: auto;
  }
  .tab-item:hover .tab-close {
    opacity: 1;
    pointer-events: auto;
  }
  .tab-close:hover {
    background: var(--bg-active);
    color: var(--text-primary);
  }

  /* macOS: transparent overlay drag region for Overlay title bar style.
     The native title bar is transparent in Overlay mode; this element provides
     the drag region so the window can be moved by dragging and maximised by
     double-clicking. Traffic lights are native OS controls rendered on top. */
  :global(.platform-macos) .titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 28px;
    background: transparent;
    border-bottom: none;
    z-index: 50;
    padding: 0;
  }

  :global(.platform-macos) .titlebar-left,
  :global(.platform-macos) .titlebar-right {
    display: none;
  }

  :global(.platform-macos) .titlebar-center {
    padding-left: max(78px, var(--sidebar-visible-width, 0px)); /* traffic lights or sidebar (whichever is wider) */
    padding-right: var(--ai-panel-width, 0px); /* AI panel offset */
  }

  :global(.platform-macos) .title-text {
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Windows/Linux: hide custom titlebar, use native decorations */
  :global(.platform-windows) .titlebar,
  :global(.platform-linux) .titlebar {
    display: none;
  }

  /* iPadOS: no window controls, no drag region, safe area inset */
  :global(.platform-ipados) .titlebar {
    -webkit-app-region: no-drag;
    padding-top: env(safe-area-inset-top);
  }

  :global(.platform-ipados) .titlebar-right {
    display: none;
  }

  :global(.platform-ipados) .titlebar-left {
    padding-left: 0.5rem;
  }

  /* RTL overrides */
  :global([dir="rtl"]) .titlebar-left {
    padding-left: 0;
    padding-right: 0.5rem;
  }

  :global([dir="rtl"].platform-macos) .titlebar-center {
    padding-left: var(--ai-panel-width, 0px);
    padding-right: max(78px, var(--sidebar-visible-width, 0px));
  }

  /* ── Context menu ── */
  .titlebar-context-menu {
    position: fixed;
    z-index: 100;
    background: var(--bg-primary);
    border: 1px solid var(--border-light);
    border-radius: 6px;
    padding: 4px 0;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    min-width: 160px;
  }

  .context-menu-item {
    display: block;
    width: 100%;
    padding: 6px 16px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .context-menu-item:hover {
    background: var(--accent-color);
    color: white;
  }
</style>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { tabsStore, type TabItem } from '$lib/stores/tabs-store';
  import { t } from '$lib/i18n';
  import { isTauri, isMacOS } from '$lib/utils/platform';
  import { getCurrentWindow, LogicalPosition } from '@tauri-apps/api/window';
  import { invoke } from '@tauri-apps/api/core';
  import { emitTo } from '@tauri-apps/api/event';

  let {
    onNewTab,
    onCloseTab,
    externalDropIndex = -1,
    onDetachStart = (_tabIndex: number, _screenX: number, _screenY: number, _offsetX: number, _offsetY: number): Promise<string | undefined> => Promise.resolve(undefined),
    onDetachEnd = (_tabIndex: number, _detachedLabel: string | null, _reattachTarget: string | null): Promise<void> => Promise.resolve(),
    onAttachTab = (_tabIndex: number, _targetLabel: string): Promise<void> => Promise.resolve(),
  }: {
    onNewTab?: () => void;
    onCloseTab?: (tab: TabItem) => void;
    externalDropIndex?: number;
    onDetachStart?: (tabIndex: number, screenX: number, screenY: number, offsetX: number, offsetY: number) => Promise<string | undefined>;
    onDetachEnd?: (tabIndex: number, detachedLabel: string | null, reattachTarget: string | null) => Promise<void>;
    onAttachTab?: (tabIndex: number, targetLabel: string) => Promise<void>;
  } = $props();

  let tabs = $state<TabItem[]>([]);
  let activeTabId = $state('');

  // Top-level store subscription — do NOT wrap in $effect().
  const unsub = tabsStore.subscribe(state => {
    tabs = state.tabs;
    activeTabId = state.activeTabId;
  });
  onDestroy(() => { unsub(); });

  function handleSwitchTab(tabId: string) {
    tabsStore.switchTab(tabId);
  }

  function handleCloseTab(e: MouseEvent, tab: TabItem) {
    e.stopPropagation();
    if (onCloseTab) {
      onCloseTab(tab);
    } else {
      tabsStore.closeTab(tab.id);
    }
  }

  function handleNewTab() {
    if (onNewTab) {
      onNewTab();
    } else {
      tabsStore.addTab();
    }
  }

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
  let boundsFetching = false;
  let boundsLastFetchTime = 0;
  let singleTabHidden = false;

  const appWindow = isTauri ? getCurrentWindow() : null;

  function handleTabPointerDown(event: PointerEvent, index: number) {
    if (event.button !== 0) return;
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
      boundsLastFetchTime = Date.now();
      invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
        .then(bounds => { cachedBounds = bounds; boundsLastFetchTime = Date.now(); })
        .catch(() => {});
    }

    function onMove(e: PointerEvent) {
      if (!isDragging && Math.abs(e.clientX - dragStartX) > 5) {
        isDragging = true;
        dragTabIndex = index;
        document.body.style.cursor = 'grabbing';
        // Cache all window bounds + calculate drag offset for single-tab window move
        if (isTauri) {
          boundsLastFetchTime = Date.now();
          invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
            .then(bounds => { cachedBounds = bounds; boundsLastFetchTime = Date.now(); })
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

      // Refresh bounds periodically during drag for accurate target detection
      const moveNow = Date.now();
      if (isTauri && cachedBounds.length > 0 && moveNow - boundsLastFetchTime > 500) {
        boundsLastFetchTime = moveNow;
        invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
          .then(bounds => { cachedBounds = bounds; boundsLastFetchTime = Date.now(); })
          .catch(() => {});
      }

      // Detach detection: check if pointer left the tab bar area
      const tabBarRect = scrollEl?.getBoundingClientRect();
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
            // On Windows/Linux the TabBar is a separate component below native title bar.
            // Tab items start at the left edge of .tabs-scroll (no sidebar offset).
            // Read actual position from the scroll container for accuracy.
            const tabScrollEl = scrollEl ?? document.querySelector('.tabs-scroll');
            const tabBarStart = tabScrollEl
              ? tabScrollEl.getBoundingClientRect().left
              : 0;
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
                boundsLastFetchTime = Date.now();
                invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
                  .then(bounds => { cachedBounds = bounds; boundsLastFetchTime = Date.now(); }).catch(() => {});
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
      const tabEls = scrollEl?.querySelectorAll('.tab-item');
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
    function handleDetachedMove(e: PointerEvent, _myLabel: string) {
      // Wait for the detached window label before attempting target detection.
      // Without the label we can't filter the detached window from cachedBounds,
      // risking a false match where we try to merge the tab into its own window.
      if (!detachedWindowLabel) return;

      // Re-fetch bounds periodically (every 500ms) to stay accurate after window layout
      // changes from repeated detach/attach cycles. Also handles the initial empty-bounds case.
      const now = Date.now();
      if (isTauri && !boundsFetching && (cachedBounds.length === 0 || now - boundsLastFetchTime > 500)) {
        boundsFetching = true;
        boundsLastFetchTime = now;
        invoke<[string, number, number, number, number, number][]>('get_all_window_bounds')
          .then(bounds => { cachedBounds = bounds; boundsFetching = false; boundsLastFetchTime = Date.now(); })
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
      boundsFetching = false;
      boundsLastFetchTime = 0;

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
          tabsStore.reorderTabs(savedDragTabIndex, savedDropTargetIndex);
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

  // Scroll overflow detection
  let scrollEl: HTMLDivElement | undefined = $state();
  let canScrollLeft = $state(false);
  let canScrollRight = $state(false);

  function updateScrollState() {
    if (!scrollEl) return;
    canScrollLeft = scrollEl.scrollLeft > 1;
    canScrollRight = scrollEl.scrollLeft < scrollEl.scrollWidth - scrollEl.clientWidth - 1;
  }

  function scrollTabs(dir: 'left' | 'right') {
    if (!scrollEl) return;
    const amount = 200;
    scrollEl.scrollBy({ left: dir === 'left' ? -amount : amount, behavior: 'smooth' });
  }

  // Re-check overflow when tabs change
  $effect(() => {
    // Track tabs array to re-check on add/remove
    void tabs.length;
    requestAnimationFrame(updateScrollState);
  });

  // Auto-scroll active tab into view when activeTabId changes
  $effect(() => {
    void activeTabId;
    requestAnimationFrame(() => {
      if (!scrollEl) return;
      const activeEl = scrollEl.querySelector('.tab-item.active') as HTMLElement | null;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        requestAnimationFrame(updateScrollState);
      }
    });
  });
</script>

<div class="tabbar no-select">
  {#if canScrollLeft}
    <button class="scroll-arrow scroll-left" onclick={() => scrollTabs('left')}>
      <svg width="8" height="10" viewBox="0 0 8 10"><path fill="currentColor" d="M7 0L0 5l7 5z"/></svg>
    </button>
  {/if}

  <div class="tabs-scroll" bind:this={scrollEl} onscroll={updateScrollState}>
    {#each tabs as tab, index (tab.id)}
      {#if externalDropIndex === index}
        <div class="external-drop-indicator"></div>
      {/if}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="tab-item"
        class:active={tab.id === activeTabId}
        class:typst={tab.flavor === 'typst'}
        class:drag-over={dropTargetIndex === index && dragTabIndex !== index}
        class:dragging={dragTabIndex === index}
        class:detaching={isDetaching && dragTabIndex === index}
        onclick={() => { if (!isDragging) handleSwitchTab(tab.id); }}
        onauxclick={(e) => { if (e.button === 1) { e.preventDefault(); handleCloseTab(e, tab); } }}
        onpointerdown={(e) => handleTabPointerDown(e, index)}
      >
        <span class="tab-name">
          {#if tab.isDirty}<span class="dirty-dot"></span>{/if}
          {#if tab.readOnly}<svg class="readonly-lock" width="9" height="10" viewBox="0 0 10 12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="1.5" y="5" width="7" height="6" rx="1"/><path d="M3 5V3.5a2 2 0 0 1 4 0V5"/></svg>{/if}
          {tab.fileName}
        </span>
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span
          class="tab-close"
          onclick={(e) => handleCloseTab(e, tab)}
        >
          <svg width="8" height="8" viewBox="0 0 8 8">
            <path fill="currentColor" d="M1 0L0 1l3 3-3 3 1 1 3-3 3 3 1-1-3-3 3-3-1-1-3 3z"/>
          </svg>
        </span>
      </div>
    {/each}
    {#if externalDropIndex >= tabs.length}
      <div class="external-drop-indicator"></div>
    {/if}
  </div>

  {#if canScrollRight}
    <button class="scroll-arrow scroll-right" onclick={() => scrollTabs('right')}>
      <svg width="8" height="10" viewBox="0 0 8 10"><path fill="currentColor" d="M0 0l7 5-7 5z"/></svg>
    </button>
  {/if}

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tab-new" onclick={handleNewTab} title={$t('common.new')}>
    <svg width="12" height="12" viewBox="0 0 12 12">
      <path fill="currentColor" d="M6 0v12M0 6h12" stroke="currentColor" stroke-width="1.5"/>
    </svg>
  </div>
</div>

<style>
  .tabbar {
    display: flex;
    align-items: center;
    height: 36px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-light);
    overflow: hidden;
  }

  .tabs-scroll {
    display: flex;
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .tabs-scroll::-webkit-scrollbar {
    display: none;
  }

  .scroll-arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 36px;
    border: none;
    background: var(--bg-secondary);
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    z-index: 1;
    transition: color var(--transition-fast), background var(--transition-fast);
  }
  .scroll-arrow:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .tab-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0 0.75rem;
    height: 36px;
    min-width: 0;
    max-width: 180px;
    cursor: pointer;
    border-right: 1px solid var(--border-light);
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    transition: background var(--transition-fast), color var(--transition-fast);
    flex-shrink: 0;
  }

  .tab-item:active {
    background: var(--bg-hover);
  }

  .tab-item.active {
    background: var(--bg-primary);
    color: var(--text-primary);
    border-bottom: 2px solid var(--accent-color);
  }

  /* Typst tabs get a distinct teal underline (vs. markdown's blue accent) so
     the two mutually-exclusive document flavors read as visually different
     languages at a glance, not just different file extensions. Matches the
     "Typst" badge color used inside TypstEditor's own toolbar. */
  .tab-item.typst.active {
    border-bottom-color: var(--typst-accent-color, #239dad);
  }
  .tab-item.typst .dirty-dot {
    background: var(--typst-accent-color, #239dad);
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

  .tab-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .dirty-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
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
    width: 20px;
    height: 20px;
    border-radius: 3px;
    color: var(--text-muted);
    flex-shrink: 0;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s, background var(--transition-fast), color var(--transition-fast);
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

  .external-drop-indicator {
    width: 2px;
    height: 28px;
    background: var(--accent-color);
    flex-shrink: 0;
    border-radius: 1px;
  }

  .tab-new {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .tab-new:active {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
</style>

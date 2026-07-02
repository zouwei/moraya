<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import { filesStore } from '$lib/stores/files-store';
  import type { ImageHostTarget } from '$lib/services/image-hosting/types';
  import type { UnifiedMediaItem, MediaType, PickerTab, KbScope } from '$lib/services/cloud-resource/types';
  import {
    listMedia,
    mediaCache,
    makeCacheKey,
    picoraApiBaseFromUploadUrl,
    getRecentItems,
    getFavoriteIds,
    addRecentItem,
    toggleFavorite,
    updateVisibility,
  } from '$lib/services/cloud-resource';

  let {
    type,
    multiSelect = false,
    targetPos,
    mode = 'insert',
    embedded = false,
    onInsert,
    onClose,
  }: {
    type: MediaType;
    multiSelect?: boolean;
    targetPos?: number;
    /** v0.37.0: 'insert' shows the insert-at-cursor footer; 'browse' is read-only (settings panel embed). */
    mode?: 'insert' | 'browse';
    /** v0.37.0: Render inline (no overlay backdrop, no fixed size) for use inside settings panel. */
    embedded?: boolean;
    onInsert?: (items: UnifiedMediaItem[], insertAsHtml: boolean, targetPos?: number) => void;
    onClose: () => void;
  } = $props();

  // ── Target / account selection ───────────────────────────────────────

  let settings = $state(settingsStore.getState());
  const unsubSettings = settingsStore.subscribe(s => { settings = s; });
  onDestroy(() => { unsubSettings(); });

  let picoraTargets = $derived(settings.imageHostTargets.filter(t => t.provider === 'picora'));

  // Derive best default target. v0.37.0: prefer the dedicated Picora-account
  // default (used for KB sync + cloud browse) over the image-upload default —
  // the two roles are semantically distinct (see v0.37.0 §2.3).
  function getDefaultTargetId(): string {
    const picoraDefault = picoraTargets.find(t => t.id === settings.defaultPicoraAccountId);
    if (picoraDefault) return picoraDefault.id;
    const uploadDefault = picoraTargets.find(t => t.id === settings.defaultImageHostId);
    if (uploadDefault) return uploadDefault.id;
    return picoraTargets[0]?.id ?? '';
  }

  // KB binding context
  let boundPicoraTargetId = $state<string | null>(null);
  let boundKbId = $state<string | null>(null);

  filesStore.subscribe(fs => {
    const activeKb = fs.activeKnowledgeBaseId
      ? fs.knowledgeBases.find(k => k.id === fs.activeKnowledgeBaseId)
      : null;
    if (activeKb?.picoraBinding) {
      boundPicoraTargetId = activeKb.picoraBinding.picoraTargetId;
      boundKbId = activeKb.picoraBinding.picoraKbId;
    } else {
      boundPicoraTargetId = null;
      boundKbId = null;
    }
  });

  // svelte-ignore state_referenced_locally
  let selectedTargetId = $state(
    boundPicoraTargetId
      ? (picoraTargets.find(t => t.id === boundPicoraTargetId)?.id ?? getDefaultTargetId())
      : getDefaultTargetId()
  );

  let selectedTarget = $derived<ImageHostTarget | undefined>(
    picoraTargets.find(t => t.id === selectedTargetId)
  );

  // ── Scope / KB filter ────────────────────────────────────────────────

  // Default to 'all' so the picker always shows account-wide content on first
  // open. The user can switch to 'this-kb' (or 'no-kb') via the scope dropdown
  // when KB is bound. Picker uses an in-memory + disk LRU cache (mediaCache),
  // so subsequent opens render cached items instantly while a background
  // refresh updates them.
  let kbScope = $state<KbScope>('all');
  let hasKbBinding = $derived(!!boundKbId && selectedTargetId === boundPicoraTargetId);

  // ── Search / pagination ──────────────────────────────────────────────

  let q = $state('');
  let debouncedQ = $state('');
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    clearTimeout(debounceTimer);
    const val = q;
    debounceTimer = setTimeout(() => { debouncedQ = val; }, 300);
    return () => clearTimeout(debounceTimer);
  });

  let activeTab = $state<PickerTab>('all');
  let viewMode = $state<'grid' | 'list'>('grid');

  // ── Items & pagination state ─────────────────────────────────────────

  let allItems = $state<UnifiedMediaItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let lastFetchAt = $state<number | null>(null);
  let fetchKey = $state(0); // trigger refetch

  // ── Selected items ───────────────────────────────────────────────────

  let selectedIds = $state(new Set<string>());

  function toggleSelect(item: UnifiedMediaItem) {
    if (!canSelect(item)) return;
    const next = new Set(selectedIds);
    if (multiSelect) {
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
    } else {
      next.clear();
      if (!selectedIds.has(item.id)) next.add(item.id);
    }
    selectedIds = next;
  }

  function canSelect(item: UnifiedMediaItem): boolean {
    if (type === 'video' && item.status !== 'ready' && item.status !== undefined) return false;
    return true;
  }

  let selectedItems = $derived(allItems.filter(i => selectedIds.has(i.id)));
  let insertAsHtml = $state(false);

  // ── Favorites ────────────────────────────────────────────────────────

  let favoriteIds = $state(new Set<string>());
  $effect(() => {
    favoriteIds = getFavoriteIds(selectedTargetId);
  });

  function handleToggleFav(id: string, ev: MouseEvent) {
    ev.stopPropagation();
    const isFav = toggleFavorite(selectedTargetId, id);
    favoriteIds = getFavoriteIds(selectedTargetId);
    // update UI state
    _ = isFav;
  }
  let _: unknown; // used to consume side-effect values

  // ── Recent items ─────────────────────────────────────────────────────

  let recentItems = $derived(getRecentItems(selectedTargetId));

  // ── Displayed items per tab ──────────────────────────────────────────

  let displayedItems = $derived(
    activeTab === 'recent' ? recentItems :
    activeTab === 'favorites' ? allItems.filter(i => favoriteIds.has(i.id)) :
    allItems
  );

  // ── Data fetching ────────────────────────────────────────────────────

  async function fetchPage(cursor?: string) {
    if (!selectedTarget) return;
    const apiBase = picoraApiBaseFromUploadUrl(selectedTarget.picoraApiUrl);
    const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
    const apiKey = await getPicoraApiKey(selectedTarget);
    const cacheKey = makeCacheKey(selectedTargetId, type, debouncedQ, kbScope, cursor ?? '', undefined);

    const cached = mediaCache.get(cacheKey);
    if (cached && !cursor) {
      allItems = cached.items;
      nextCursor = cached.nextCursor;
      lastFetchAt = cached.fetchedAt;
      // Background refresh
      doFetch(apiBase, apiKey, cursor, cacheKey, true);
      return;
    }
    await doFetch(apiBase, apiKey, cursor, cacheKey, false);
  }

  async function doFetch(
    apiBase: string,
    apiKey: string,
    cursor: string | undefined,
    cacheKey: string,
    background: boolean,
  ) {
    if (!background) { loading = true; loadError = null; }
    try {
      const res = await listMedia({
        apiBase,
        apiKey,
        type,
        cursor,
        limit: 20,
        q: debouncedQ || undefined,
        kbScope,
        boundKbId: boundKbId ?? undefined,
        statusFilter: undefined,
      }, selectedTargetId);

      if (cursor) {
        allItems = [...allItems, ...res.items];
      } else {
        allItems = res.items;
      }
      nextCursor = res.nextCursor ?? null;
      lastFetchAt = Date.now();
      mediaCache.set(cacheKey, { items: allItems, nextCursor, fetchedAt: lastFetchAt });
    } catch (err) {
      if (!background) {
        loadError = typeof err === 'string' ? err : (err instanceof Error ? err.message : 'Load failed');
      }
    } finally {
      if (!background) loading = false;
    }
  }

  function refresh() {
    allItems = [];
    nextCursor = null;
    selectedIds = new Set();
    fetchPage();
  }

  // Re-fetch when target, type, q, or kbScope changes
  $effect(() => {
    // Access reactive deps
    const _tid = selectedTargetId;
    const _q = debouncedQ;
    const _scope = kbScope;
    const _fk = fetchKey;
    _ = _fk; // use it
    refresh();
  });

  // ── Infinite scroll via IntersectionObserver ──────────────────────

  let sentinelEl: HTMLDivElement | undefined = $state();

  onMount(() => {
    if (!sentinelEl) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && nextCursor && !loading) {
        fetchPage(nextCursor);
      }
    }, { threshold: 0.1 });
    obs.observe(sentinelEl);
    return () => obs.disconnect();
  });

  // ── Privacy confirmation ──────────────────────────────────────────────

  let showPrivacyConfirm = $state(false);
  let privateItems = $state<UnifiedMediaItem[]>([]);

  function handleInsertClick() {
    if (selectedItems.length === 0) return;
    const privates = selectedItems.filter(i => !i.isPublic);
    if (privates.length > 0 && !getSuppressPrivacyWarn()) {
      privateItems = privates;
      showPrivacyConfirm = true;
    } else {
      doInsert(selectedItems, false);
    }
  }

  function getSuppressPrivacyWarn(): boolean {
    try {
      const raw = localStorage.getItem(`picoraPrivacyWarnSuppressed:${selectedTargetId}`);
      return raw === 'true';
    } catch { return false; }
  }

  function setSuppressPrivacyWarn(v: boolean) {
    try { localStorage.setItem(`picoraPrivacyWarnSuppressed:${selectedTargetId}`, String(v)); } catch { /* ignore */ }
  }

  let suppressPrivacyNext = $state(false);

  async function confirmInsertPrivate() {
    if (suppressPrivacyNext) setSuppressPrivacyWarn(true);
    showPrivacyConfirm = false;
    doInsert(selectedItems, false);
  }

  async function makePublicThenInsert() {
    if (!selectedTarget) return;
    const apiBase = picoraApiBaseFromUploadUrl(selectedTarget.picoraApiUrl);
    const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
    const apiKey = await getPicoraApiKey(selectedTarget);
    for (const item of privateItems) {
      try {
        await updateVisibility(apiBase, apiKey, item.type, item.id, true);
        item.isPublic = true;
      } catch { /* ignore, insert anyway */ }
    }
    showPrivacyConfirm = false;
    doInsert(selectedItems, false);
  }

  function doInsert(items: UnifiedMediaItem[], asHtml: boolean) {
    items.forEach(item => addRecentItem(selectedTargetId, item));
    if (mode === 'browse' || !onInsert) {
      onClose();
      return;
    }
    onInsert(items, asHtml || insertAsHtml, targetPos);
    onClose();
  }

  // ── Keyboard navigation ───────────────────────────────────────────────

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleInsertClick();
    }
    if (e.key === '/' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      searchInputEl?.focus();
    }
  }

  let searchInputEl: HTMLInputElement | undefined = $state();

  // ── Helpers ───────────────────────────────────────────────────────────

  function formatBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDuration(s: number): string {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      return `${d.getMonth() + 1}-${d.getDate()}`;
    } catch { return iso.slice(0, 10); }
  }

  // ── Copy helpers ──────────────────────────────────────────────────────

  function copyUrl(item: UnifiedMediaItem, e: MouseEvent) {
    e.stopPropagation();
    const url = item.playbackUrl ?? item.url ?? '';
    navigator.clipboard.writeText(url).catch(() => {});
  }

  function copyMarkdown(item: UnifiedMediaItem, e: MouseEvent) {
    e.stopPropagation();
    const url = item.playbackUrl ?? item.url ?? '';
    const alt = item.title ?? item.filename;
    const md = item.type === 'image' ? `![${alt}](${url})` : url;
    navigator.clipboard.writeText(md).catch(() => {});
  }

  // ── Slot content types (passed from type-specific pickers) ────────────

  // Used in template with {#snippet} pattern — type-specific pickers override the card slot
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="cloud-picker-overlay" class:embedded role="dialog" aria-modal={embedded ? undefined : 'true'}>
  <div class="cloud-picker" class:embedded>
    <!-- Header -->
    <div class="picker-header">
      <span class="picker-title">
        {type === 'image' ? $t('cloudPicker.titleImage') :
         type === 'audio' ? $t('cloudPicker.titleAudio') :
         $t('cloudPicker.titleVideo')}
      </span>
      {#if !embedded}
        <button class="picker-close" onclick={onClose} aria-label={$t('common.close')}>✕</button>
      {/if}
    </div>

    <!-- Controls -->
    <div class="picker-controls">
      <!-- Target selector -->
      {#if picoraTargets.length === 0}
        <span class="no-targets">{$t('cloudPicker.noTargets')}</span>
      {:else}
        <select class="target-select" bind:value={selectedTargetId}>
          {#each picoraTargets as tgt}
            <option value={tgt.id}>{tgt.name || tgt.picoraApiUrl}</option>
          {/each}
        </select>
      {/if}

      <!-- KB scope (only shown when hasKbBinding) -->
      {#if hasKbBinding}
        <select class="scope-select" bind:value={kbScope}>
          <option value="this-kb">{$t('cloudPicker.scopeThisKb')}</option>
          <option value="all">{$t('cloudPicker.scopeAll')}</option>
          <option value="no-kb">{$t('cloudPicker.scopeNoKb')}</option>
        </select>
      {/if}

      <button class="refresh-btn" onclick={() => { fetchKey++; }} title={$t('common.refresh')}>↺</button>
    </div>

    <!-- Tabs + Search + View toggle -->
    <div class="picker-toolbar">
      <div class="picker-tabs">
        {#each (['recent', 'all', 'favorites'] as const) as tab}
          <button
            class="tab-btn"
            class:active={activeTab === tab}
            onclick={() => { activeTab = tab; }}
          >
            {tab === 'recent' ? $t('cloudPicker.tabRecent') :
             tab === 'all' ? $t('cloudPicker.tabAll') :
             $t('cloudPicker.tabFavorites')}
          </button>
        {/each}
      </div>
      <div class="toolbar-right">
        <input
          bind:this={searchInputEl}
          class="search-input"
          type="search"
          placeholder={$t('cloudPicker.searchPlaceholder')}
          bind:value={q}
        />
        <button
          class="view-btn"
          class:active={viewMode === 'grid'}
          onclick={() => { viewMode = 'grid'; }}
          title={$t('cloudPicker.gridView')}
        >⊞</button>
        <button
          class="view-btn"
          class:active={viewMode === 'list'}
          onclick={() => { viewMode = 'list'; }}
          title={$t('cloudPicker.listView')}
        >☰</button>
      </div>
    </div>

    <!-- Body -->
    <div class="picker-body">
      {#if loading && allItems.length === 0}
        <!-- Skeleton -->
        <div class="skeleton-grid">
          {#each Array(10) as _}
            <div class="skeleton-card"></div>
          {/each}
        </div>
      {:else if loadError && allItems.length === 0}
        <!-- Error state -->
        <div class="picker-empty">
          <div class="empty-icon">⚠</div>
          <div class="empty-text">{$t('cloudPicker.errorTitle')}</div>
          <div class="empty-sub">{loadError}</div>
          {#if lastFetchAt}
            <div class="stale-hint">{$t('cloudPicker.lastCache')}: {formatDate(new Date(lastFetchAt).toISOString())}</div>
          {/if}
          <button class="retry-btn" onclick={() => { fetchKey++; }}>{$t('common.retry')}</button>
        </div>
      {:else if displayedItems.length === 0 && !loading}
        <!-- Empty state -->
        <div class="picker-empty">
          <div class="empty-icon">☁</div>
          <div class="empty-text">{$t('cloudPicker.emptyTitle')}</div>
          {#if hasKbBinding && kbScope === 'this-kb'}
            <!-- Most common cause: legacy uploads aren't tagged with the
                 newly-bound KB. Offer a one-click escape to scope='all'. -->
            <div class="empty-sub">{$t('cloudPicker.emptyKbScopedSub')}</div>
            <button class="retry-btn" onclick={() => { kbScope = 'all'; }}>
              {$t('cloudPicker.switchScopeAll')}
            </button>
          {:else}
            <div class="empty-sub">{$t('cloudPicker.emptySub')}</div>
          {/if}
        </div>
      {:else}
        <div class="items-container" class:grid={viewMode === 'grid'} class:list-view={viewMode === 'list'}>
          {#each displayedItems as item (item.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="media-card"
              class:selected={selectedIds.has(item.id)}
              class:disabled={!canSelect(item)}
              draggable="true"
              ondragstart={(e) => {
                if (e.dataTransfer) {
                  e.dataTransfer.setData('application/x-cloud-media-id', item.id);
                  e.dataTransfer.setData('application/x-cloud-media-type', item.type);
                  e.dataTransfer.setData('application/x-cloud-media-url', item.playbackUrl ?? item.url ?? '');
                }
              }}
              onclick={() => toggleSelect(item)}
            >
              <!-- Checkbox (visible on hover for multi-select) -->
              {#if multiSelect}
                <div class="card-check" class:checked={selectedIds.has(item.id)}>
                  {selectedIds.has(item.id) ? '☑' : '☐'}
                </div>
              {:else}
                <div class="card-radio">
                  {selectedIds.has(item.id) ? '◉' : '○'}
                </div>
              {/if}

              <!-- Thumbnail / icon. Only render <img> for image-type items or
                   when there's an explicit thumbnail for video. Audio never has
                   a meaningful image thumbnail — always show the 🎵 icon. -->
              <div class="card-thumb">
                {#if item.type === 'image' && (item.thumbnailUrl || item.url)}
                  <img src={item.thumbnailUrl ?? item.url} alt={item.title ?? item.filename} loading="lazy" />
                {:else if item.type === 'video' && item.thumbnailUrl}
                  <img src={item.thumbnailUrl} alt={item.title ?? item.filename} loading="lazy" />
                {:else if item.type === 'audio'}
                  <span class="media-icon">🎵</span>
                {:else if item.type === 'video'}
                  <span class="media-icon">🎬</span>
                {:else}
                  <span class="media-icon">📄</span>
                {/if}
                {#if item.type === 'video' && item.durationSeconds !== undefined}
                  <span class="duration-badge">{formatDuration(item.durationSeconds)}</span>
                {/if}
                {#if item.type === 'video' && item.status === 'processing'}
                  <span class="status-badge processing">⏳ {$t('cloudPicker.processing')}</span>
                {/if}
              </div>

              <!-- Privacy + favorite + options row -->
              <div class="card-meta-row">
                <button class="fav-btn" onclick={(e) => handleToggleFav(item.id, e)} title={$t('cloudPicker.favorite')}>
                  {favoriteIds.has(item.id) ? '★' : '☆'}
                </button>
                <span class="visibility-icon" title={item.isPublic ? $t('cloudPicker.public') : $t('cloudPicker.private')}>
                  {item.isPublic ? '🌐' : '🔒'}
                </span>
                <button class="options-btn" onclick={(e) => { e.stopPropagation(); copyUrl(item, e); }} title={$t('cloudPicker.copyUrl')}>
                  ⋯
                </button>
              </div>

              <!-- Title & size -->
              <div class="card-name" title={item.filename}>{item.title ?? item.filename}</div>
              <div class="card-info">
                {formatBytes(item.sizeBytes)}
                {#if item.durationSeconds !== undefined}
                  · {formatDuration(item.durationSeconds)}
                {/if}
                · {formatDate(item.createdAt)}
              </div>
            </div>
          {/each}
        </div>
        <!-- Infinite scroll sentinel -->
        <div bind:this={sentinelEl} class="sentinel"></div>
        {#if loading && allItems.length > 0}
          <div class="loading-more">{$t('cloudPicker.loadingMore')}</div>
        {/if}
      {/if}
    </div>

    <!-- Footer -->
    {#if picoraTargets.length > 0 && mode === 'insert'}
      <div class="picker-footer">
        <div class="footer-left">
          {#if selectedIds.size > 0}
            <span class="selected-count">{$t('cloudPicker.selectedCount', { n: String(selectedIds.size) })}</span>
          {/if}
          {#if type === 'image'}
            <label class="html-toggle">
              <input type="checkbox" bind:checked={insertAsHtml} />
              {$t('cloudPicker.insertAsHtml')}
            </label>
          {/if}
        </div>
        <div class="footer-right">
          <button class="btn-cancel" onclick={onClose}>{$t('common.cancel')}</button>
          <button
            class="btn-insert"
            disabled={selectedIds.size === 0}
            onclick={handleInsertClick}
          >
            {$t('cloudPicker.insertBtn')}
          </button>
        </div>
      </div>
    {:else if picoraTargets.length > 0 && mode === 'browse'}
      <div class="picker-footer">
        <div class="footer-left">
          {#if selectedItems.length === 1}
            <span class="selected-count">{selectedItems[0].title ?? selectedItems[0].filename}</span>
          {:else if selectedIds.size > 0}
            <span class="selected-count">{$t('cloudPicker.selectedCount', { n: String(selectedIds.size) })}</span>
          {/if}
        </div>
        <div class="footer-right">
          <button
            class="btn-cancel"
            disabled={selectedItems.length !== 1}
            onclick={() => { if (selectedItems.length === 1) navigator.clipboard.writeText(selectedItems[0].playbackUrl ?? selectedItems[0].url ?? '').catch(() => {}); }}
          >{$t('cloudPicker.copyUrl')}</button>
          <button
            class="btn-cancel"
            disabled={selectedItems.length !== 1}
            onclick={() => { if (selectedItems.length === 1) { const it = selectedItems[0]; const url = it.playbackUrl ?? it.url ?? ''; const md = it.type === 'image' ? `![${it.title ?? it.filename}](${url})` : url; navigator.clipboard.writeText(md).catch(() => {}); } }}
          >{$t('cloudPicker.copyMarkdown')}</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<!-- Privacy confirmation dialog -->
{#if showPrivacyConfirm}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="privacy-overlay" role="dialog" aria-modal="true">
    <div class="privacy-dialog">
      <div class="privacy-title">🔒 {$t('cloudPicker.privacyTitle')}</div>
      <div class="privacy-body">
        <p>{$t('cloudPicker.privacyDesc', { n: String(privateItems.length) })}</p>
        <ul>
          {#each privateItems as item}
            <li>🔒 {item.title ?? item.filename}</li>
          {/each}
        </ul>
        <p class="privacy-warn">{$t('cloudPicker.privacyWarn')}</p>
      </div>
      <label class="suppress-check">
        <input type="checkbox" bind:checked={suppressPrivacyNext} />
        {$t('cloudPicker.suppressPrivacy')}
      </label>
      <div class="privacy-actions">
        <button class="btn-make-public" onclick={makePublicThenInsert}>{$t('cloudPicker.makePublicInsert')}</button>
        <button class="btn-insert-anyway" onclick={confirmInsertPrivate}>{$t('cloudPicker.insertAnyway')}</button>
        <button class="btn-cancel" onclick={() => { showPrivacyConfirm = false; }}>{$t('common.cancel')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .cloud-picker-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .cloud-picker-overlay.embedded {
    position: static;
    background: transparent;
    z-index: auto;
    display: block;
  }

  .cloud-picker {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25);
    width: min(760px, 92vw);
    height: min(600px, 88vh);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .cloud-picker.embedded {
    width: 100%;
    height: 480px;
    box-shadow: none;
    border-radius: 6px;
  }

  .picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-light);
    font-weight: 600;
    font-size: var(--font-size-base);
  }

  .picker-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
  }
  .picker-close:hover { background: var(--bg-hover); }

  .picker-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border-light);
    flex-wrap: wrap;
  }

  .target-select, .scope-select {
    font-size: var(--font-size-sm);
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .refresh-btn {
    background: none;
    border: 1px solid var(--border-light);
    border-radius: 4px;
    cursor: pointer;
    padding: 0.2rem 0.5rem;
    font-size: 0.9rem;
    color: var(--text-muted);
  }
  .refresh-btn:hover { background: var(--bg-hover); }

  .picker-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 1rem;
    border-bottom: 1px solid var(--border-light);
    gap: 0.75rem;
  }

  .picker-tabs {
    display: flex;
    gap: 0;
  }

  .tab-btn {
    background: none;
    border: 1px solid var(--border-light);
    cursor: pointer;
    padding: 0.2rem 0.7rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }
  .tab-btn:first-child { border-radius: 4px 0 0 4px; }
  .tab-btn:last-child { border-radius: 0 4px 4px 0; border-left: none; }
  .tab-btn:not(:first-child):not(:last-child) { border-left: none; }
  .tab-btn.active { background: var(--accent-color); color: #fff; border-color: var(--accent-color); }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .search-input {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-size: var(--font-size-sm);
    background: var(--bg-secondary);
    color: var(--text-primary);
    width: 180px;
  }

  .view-btn {
    background: none;
    border: 1px solid var(--border-light);
    border-radius: 4px;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    color: var(--text-muted);
  }
  .view-btn.active { background: var(--accent-color); color: #fff; border-color: var(--accent-color); }

  .picker-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem 1rem;
  }

  /* Grid layout */
  .items-container.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 0.75rem;
  }

  /* List layout */
  .items-container.list-view {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .media-card {
    border: 1px solid var(--border-light);
    border-radius: 6px;
    padding: 0.4rem;
    cursor: pointer;
    position: relative;
    transition: border-color var(--transition-fast), background var(--transition-fast);
    user-select: none;
  }

  .media-card:hover { border-color: var(--accent-color); background: var(--bg-hover); }
  .media-card.selected { border-color: var(--accent-color); background: color-mix(in srgb, var(--accent-color) 10%, transparent); }
  .media-card.disabled { opacity: 0.5; cursor: not-allowed; }

  .list-view .media-card {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.6rem;
  }

  .card-check, .card-radio {
    position: absolute;
    top: 4px;
    left: 4px;
    font-size: 0.85rem;
    color: var(--accent-color);
    z-index: 1;
  }

  .list-view .card-check,
  .list-view .card-radio {
    position: static;
    flex-shrink: 0;
  }

  .card-thumb {
    aspect-ratio: 1;
    background: var(--bg-secondary);
    border-radius: 4px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    margin-bottom: 0.35rem;
  }

  .list-view .card-thumb {
    width: 52px;
    height: 52px;
    flex-shrink: 0;
    margin-bottom: 0;
    aspect-ratio: auto;
  }

  .card-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .media-icon { font-size: 1.6rem; }

  .duration-badge {
    position: absolute;
    bottom: 3px;
    right: 3px;
    background: rgba(0,0,0,0.65);
    color: #fff;
    font-size: 0.65rem;
    padding: 1px 4px;
    border-radius: 3px;
  }

  .status-badge {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    background: rgba(0,0,0,0.55);
    color: #fff;
    text-align: center;
  }

  .card-meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.15rem;
  }

  .list-view .card-meta-row { margin-left: auto; margin-bottom: 0; }

  .fav-btn, .options-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 1px 4px;
    font-size: 0.8rem;
    color: var(--text-muted);
    border-radius: 3px;
  }
  .fav-btn:hover, .options-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

  .visibility-icon { font-size: 0.75rem; }

  .card-name {
    font-size: 0.7rem;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  .card-info {
    font-size: 0.65rem;
    color: var(--text-muted);
    margin-top: 1px;
    white-space: nowrap;
  }

  .list-view .card-name, .list-view .card-info {
    flex: 1;
    min-width: 0;
  }

  .sentinel { height: 1px; }

  .loading-more {
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    padding: 0.5rem;
  }

  /* Skeleton */
  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 0.75rem;
  }

  .skeleton-card {
    height: 140px;
    background: linear-gradient(90deg, var(--bg-secondary) 25%, var(--bg-hover) 50%, var(--bg-secondary) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: 6px;
  }

  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* Empty / Error */
  .picker-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    height: 100%;
    color: var(--text-muted);
    padding: 2rem;
    text-align: center;
  }

  .empty-icon { font-size: 2.5rem; }
  .empty-text { font-size: var(--font-size-base); color: var(--text-secondary); }
  .empty-sub, .stale-hint { font-size: var(--font-size-sm); }
  .retry-btn {
    padding: 0.35rem 1rem;
    background: var(--accent-color);
    color: #fff;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    margin-top: 0.5rem;
  }

  /* Footer */
  .picker-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
    border-top: 1px solid var(--border-light);
    gap: 0.75rem;
  }

  .footer-left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
  }

  .footer-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .selected-count { font-size: var(--font-size-sm); color: var(--text-muted); }

  .html-toggle {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .btn-cancel {
    padding: 0.3rem 0.8rem;
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 5px;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
  .btn-cancel:hover { background: var(--bg-hover); }

  .btn-insert {
    padding: 0.3rem 1rem;
    background: var(--accent-color);
    color: #fff;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: var(--font-size-sm);
  }
  .btn-insert:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-insert:not(:disabled):hover { opacity: 0.9; }

  .no-targets {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }

  /* Privacy dialog */
  .privacy-overlay {
    position: fixed;
    inset: 0;
    z-index: 300;
    background: rgba(0,0,0,0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .privacy-dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1.5rem;
    width: min(480px, 90vw);
    box-shadow: 0 4px 24px rgba(0,0,0,0.3);
  }

  .privacy-title { font-weight: 600; font-size: var(--font-size-base); margin-bottom: 1rem; }
  .privacy-body { font-size: var(--font-size-sm); color: var(--text-secondary); margin-bottom: 0.75rem; }
  .privacy-body ul { margin: 0.5rem 0 0.5rem 1.25rem; }
  .privacy-warn { color: var(--warning-color, #e8a838); margin-top: 0.5rem; }

  .suppress-check {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    cursor: pointer;
    margin-bottom: 1rem;
  }

  .privacy-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }

  .btn-make-public {
    padding: 0.3rem 0.9rem;
    background: var(--accent-color);
    color: #fff;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    font-size: var(--font-size-sm);
  }

  .btn-insert-anyway {
    padding: 0.3rem 0.9rem;
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 5px;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
</style>

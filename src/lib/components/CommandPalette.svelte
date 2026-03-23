<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { t } from '$lib/i18n';
  import { filesStore } from '$lib/stores/files-store';
  import { allShortcuts, type KeyBinding } from '$lib/editor/plugins/keybindings';
  import { isMacOS } from '$lib/utils/platform';

  let {
    initialMode = 'files' as 'files' | 'commands',
    onFileSelect,
    onCommand,
    onClose,
  }: {
    initialMode?: 'files' | 'commands';
    onFileSelect: (path: string, scrollOffset?: number, keyword?: string) => void;
    onCommand: (action: string) => void;
    onClose: () => void;
  } = $props();

  let inputEl: HTMLInputElement | undefined = $state();
  let query = $state(initialMode === 'commands' ? '>' : '');
  let selectedIndex = $state(0);
  let resultListEl: HTMLDivElement | undefined = $state();

  // Determine mode from prefix
  let mode = $derived.by(() => {
    if (query.startsWith('>')) return 'commands' as const;
    if (query.startsWith('#')) return 'semantic' as const;
    if (query.startsWith('?')) return 'keyword' as const;
    return 'files' as const;
  });

  // Strip prefix for actual search query
  let searchQuery = $derived.by(() => {
    if (query.startsWith('>') || query.startsWith('#') || query.startsWith('?')) {
      return query.slice(1).trim();
    }
    return query.trim();
  });

  // --------------- File search ---------------
  interface FileItem {
    type: 'file';
    name: string;
    path: string;
    dir: string;
  }

  let flatFiles: FileItem[] = $state([]);

  // Load file tree on mount
  const unsubFiles = filesStore.subscribe((s) => {
    const items: FileItem[] = [];
    function flatten(entries: Array<{ name: string; path: string; is_dir: boolean; children?: any[] }>, parentDir: string) {
      for (const entry of entries) {
        if (entry.is_dir && entry.children) {
          flatten(entry.children, entry.name);
        } else if (!entry.is_dir) {
          items.push({
            type: 'file',
            name: entry.name,
            path: entry.path,
            dir: parentDir,
          });
        }
      }
    }
    if (s.fileTree) flatten(s.fileTree, '');
    flatFiles = items;
  });

  // Fuzzy file matching
  let fileResults = $derived.by(() => {
    if (mode !== 'files' || !searchQuery) return flatFiles.slice(0, 30);
    const q = searchQuery.toLowerCase();
    return flatFiles
      .filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      .slice(0, 50);
  });

  // --------------- Command search ---------------
  interface CommandItem {
    type: 'command';
    action: string;
    description: string;
    shortcut: string;
  }

  let commands: CommandItem[] = $derived.by(() => {
    const items: CommandItem[] = allShortcuts
      .filter((kb) => kb.action !== 'quick-open' && kb.action !== 'command-palette')
      .map((kb) => ({
        type: 'command' as const,
        action: kb.action,
        description: kb.description,
        shortcut: formatShortcut(kb),
      }));

    // Add non-shortcut commands
    items.push(
      { type: 'command', action: 'settings', description: 'Settings', shortcut: formatShortcut({ key: ',', mod: true, action: 'settings', description: '' }) },
      { type: 'command', action: 'index-kb', description: 'Index Knowledge Base', shortcut: '' },
    );

    if (!searchQuery) return items;
    const q = searchQuery.toLowerCase();
    return items.filter((c) =>
      c.description.toLowerCase().includes(q) || c.action.toLowerCase().includes(q),
    );
  });

  let commandResults = $derived(commands.slice(0, 20));

  // --------------- Semantic search (debounced) ---------------
  let semanticResults: Array<{ type: 'search'; filePath: string; heading?: string; preview: string; score: number; offset: number }> = $state([]);
  let semanticLoading = $state(false);
  let semanticTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    // Trigger content search for: default mode (files), semantic (#), keyword (?)
    // In default mode, content search supplements file name matches
    if ((mode === 'files' || mode === 'semantic' || mode === 'keyword') && searchQuery.length >= 2) {
      clearTimeout(semanticTimer);
      semanticTimer = setTimeout(() => doContentSearch(), 300);
    } else {
      semanticResults = [];
    }
  });

  async function doContentSearch() {
    const fsState = filesStore.getState();
    const kb = fsState.knowledgeBases.find((k) => k.id === fsState.activeKnowledgeBaseId);
    if (!kb) return;

    semanticLoading = true;
    try {
      const { getEmbeddingConfig, searchKnowledgeBase } = await import('$lib/services/kb');
      const config = getEmbeddingConfig();
      if (!config) {
        // No embedding config — use BM25-only via invoke directly
        const { invoke } = await import('@tauri-apps/api/core');
        const results = await invoke<Array<{
          file_path: string; heading: string | null; preview: string;
          score: number; offset: number; source: string;
        }>>('kb_search', {
          kbPath: kb.path, query: searchQuery,
          configId: '', keyPrefix: null, provider: 'openai',
          model: '', dimensions: 0, baseUrl: null,
          topK: 10, mode: 'bm25',
        });
        semanticResults = results.map((r) => ({
          type: 'search' as const,
          filePath: r.file_path, heading: r.heading ?? undefined,
          preview: r.preview, score: r.score, offset: r.offset,
        }));
        return;
      }

      const searchMode = mode === 'keyword' ? 'bm25' : (mode === 'semantic' ? 'hybrid' : 'bm25');
      const results = await searchKnowledgeBase(kb.path, searchQuery, config, 10, searchMode);
      semanticResults = results.map((r) => ({
        type: 'search' as const,
        filePath: r.filePath,
        heading: r.heading,
        preview: r.preview,
        score: r.score,
        offset: r.offset,
      }));
    } catch {
      semanticResults = [];
    } finally {
      semanticLoading = false;
    }
  }

  // --------------- Combined results ---------------
  type ResultItem =
    | FileItem
    | CommandItem
    | { type: 'search'; filePath: string; heading?: string; preview: string; score: number; offset: number };

  let results: ResultItem[] = $derived.by(() => {
    if (mode === 'commands') return commandResults;
    if (mode === 'semantic' || mode === 'keyword') return semanticResults;
    // Default mode: file name matches + content search results
    if (searchQuery.length >= 2 && semanticResults.length > 0) {
      // Merge: files first (max 10), then content results
      const files = fileResults.slice(0, 10);
      // Deduplicate: remove content results whose file already appears in file results
      const filePathSet = new Set(files.map((f) => f.path));
      const contentHits = semanticResults.filter(
        (r) => !filePathSet.has(r.filePath),
      );
      return [...files, ...contentHits];
    }
    return fileResults;
  });

  // Reset selection when results change
  $effect(() => {
    results; // track
    selectedIndex = 0;
  });

  /** Highlight search keywords in text (supports CJK single-char matching) */
  function highlightKeywords(text: string, q: string): string {
    if (!q) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const terms = new Set<string>();
    const qt = q.trim();
    if (qt.length >= 2) terms.add(qt);
    for (const w of qt.split(/\s+/)) { if (w.length >= 2) terms.add(w); }
    for (const ch of qt) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(ch)) terms.add(ch);
    }
    if (terms.size === 0) return escaped;
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    const pattern = sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    try {
      return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
    } catch { return escaped; }
  }

  function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --------------- Keyboard navigation ---------------
  function handleKeydown(e: KeyboardEvent) {
    if (e.isComposing) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, results.length - 1);
      scrollToSelected();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      scrollToSelected();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const item = results[selectedIndex];
      if (!item) return;
      if (item.type === 'file') {
        onFileSelect(item.path);
        onClose();
      } else if (item.type === 'command') {
        onCommand(item.action);
        onClose();
      } else if (item.type === 'search') {
        onFileSelect(item.filePath, item.offset, searchQuery);
        onClose();
      }
      return;
    }
  }

  function scrollToSelected() {
    tick().then(() => {
      const el = resultListEl?.querySelector(`[data-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function formatShortcut(kb: KeyBinding): string {
    const parts: string[] = [];
    if (kb.mod) parts.push(isMacOS ? '⌘' : 'Ctrl');
    if (kb.shift) parts.push(isMacOS ? '⇧' : 'Shift');
    if (kb.alt) parts.push(isMacOS ? '⌥' : 'Alt');
    parts.push(kb.key.length === 1 ? kb.key.toUpperCase() : kb.key);
    return parts.join(isMacOS ? '' : '+');
  }

  function getFileName(path: string): string {
    return path.split('/').pop() || path;
  }

  // Handle clicks outside
  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement)?.classList?.contains('palette-backdrop')) {
      onClose();
    }
  }

  onMount(() => {
    inputEl?.focus();
    return () => {
      unsubFiles();
      clearTimeout(semanticTimer);
    };
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="palette-backdrop" onclick={handleBackdropClick}>
  <div class="palette-container">
    <div class="palette-input-row">
      <input
        bind:this={inputEl}
        class="palette-input"
        type="text"
        bind:value={query}
        placeholder={$t('commandPalette.placeholder')}
        onkeydown={handleKeydown}
      />
    </div>

    <div class="palette-results" bind:this={resultListEl}>
      {#if results.length === 0}
        <div class="palette-empty">
          {#if semanticLoading}
            {$t('kb.indexing')}
          {:else}
            {$t('commandPalette.noResults')}
          {/if}
        </div>
      {:else}
        {#each results as item, i}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_tabindex -->
          <div
            class="palette-item"
            class:selected={i === selectedIndex}
            data-index={i}
            tabindex="-1"
            onclick={() => {
              selectedIndex = i;
              if (item.type === 'file') { onFileSelect(item.path); onClose(); }
              else if (item.type === 'command') { onCommand(item.action); onClose(); }
              else if (item.type === 'search') { onFileSelect(item.filePath, item.offset); onClose(); }
            }}
            onmouseenter={() => selectedIndex = i}
          >
            {#if item.type === 'file'}
              <span class="item-icon">📄</span>
              <span class="item-label">{item.name}</span>
              {#if item.dir}
                <span class="item-meta">{item.dir}/</span>
              {/if}
            {:else if item.type === 'command'}
              <span class="item-icon">⚡</span>
              <span class="item-label">{item.description}</span>
              {#if item.shortcut}
                <span class="item-shortcut">{item.shortcut}</span>
              {/if}
            {:else if item.type === 'search'}
              <span class="item-icon">🔍</span>
              <div class="item-search-content">
                <div class="search-file">{getFileName(item.filePath)}{item.heading ? ` > ${item.heading}` : ''}</div>
                <div class="search-preview">{@html highlightKeywords(item.preview.slice(0, 120), searchQuery)}</div>
              </div>
              <span class="item-score">{item.score.toFixed(2)}</span>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <div class="palette-footer">
      <span class="hint">{$t('commandPalette.files')}</span>
      <span class="hint"><kbd>{'>'}</kbd> {$t('commandPalette.commands')}</span>
      <span class="hint"><kbd>#</kbd> {$t('commandPalette.semanticSearch')}</span>
    </div>
  </div>
</div>

<style>
  .palette-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.3);
    z-index: 9999;
    display: flex;
    justify-content: center;
    padding-top: 15vh;
  }

  .palette-container {
    width: 560px;
    max-height: 420px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    height: fit-content;
  }

  .palette-input-row {
    padding: 12px;
    border-bottom: 1px solid var(--border-color);
  }

  .palette-input {
    width: 100%;
    padding: 8px 10px;
    border: none;
    outline: none;
    font-size: var(--font-size-base);
    background: transparent;
    color: var(--text-primary);
    box-sizing: border-box;
  }

  .palette-results {
    flex: 1;
    overflow-y: auto;
    max-height: 320px;
  }

  .palette-empty {
    padding: 20px;
    text-align: center;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }

  .palette-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: var(--font-size-sm);
  }

  .palette-item:hover,
  .palette-item.selected {
    background: var(--bg-hover);
  }

  .item-icon {
    flex-shrink: 0;
    width: 18px;
    text-align: center;
    font-size: 12px;
  }

  .item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }

  .item-meta {
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    flex-shrink: 0;
  }

  .item-shortcut {
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    flex-shrink: 0;
    font-family: system-ui, monospace;
  }

  .item-search-content {
    flex: 1;
    overflow: hidden;
    min-width: 0;
  }

  .search-file {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-preview {
    font-size: var(--font-size-xs);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 1px;
  }

  .search-preview :global(mark) {
    background: rgba(255, 200, 0, 0.35);
    color: inherit;
    padding: 0 1px;
    border-radius: 2px;
  }

  .item-score {
    font-size: 10px;
    color: var(--text-secondary);
    flex-shrink: 0;
    font-family: monospace;
  }

  .palette-footer {
    padding: 6px 12px;
    border-top: 1px solid var(--border-color);
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .hint kbd {
    background: var(--bg-secondary);
    padding: 0 4px;
    border-radius: 2px;
    font-family: monospace;
    font-size: 11px;
  }
</style>

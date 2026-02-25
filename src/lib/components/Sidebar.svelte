<script lang="ts">
  import { onDestroy } from 'svelte';
  import { filesStore, type FileEntry, type FilePreview, type KnowledgeBase } from '../stores/files-store';
  import { settingsStore } from '../stores/settings-store';
  import { invoke } from '@tauri-apps/api/core';
  import { open, ask, message } from '@tauri-apps/plugin-dialog';
  import { revealItemInDir } from '@tauri-apps/plugin-opener';
  import { t } from '$lib/i18n';
  import { startWatching, stopWatching, refreshFileTree } from '$lib/services/file-watcher';
  import FileContextMenu from './FileContextMenu.svelte';

  let {
    onFileSelect,
    onOpenKBManager,
  }: {
    onFileSelect: (path: string) => void;
    onOpenKBManager?: () => void;
  } = $props();

  let fileTree = $state<FileEntry[]>([]);
  let folderPath = $state<string | null>(null);
  let expandedDirs = $state<Set<string>>(new Set());
  let viewMode = $state<'tree' | 'list'>('tree');
  let filePreviews = $state<FilePreview[]>([]);
  let searchQuery = $state('');
  let showSearch = $state(false);
  let searchInputEl = $state<HTMLInputElement | null>(null);

  // Context menu state
  let contextMenu = $state<{
    show: boolean;
    position: { top: number; left: number };
    targetType: 'file' | 'folder' | 'blank';
    targetPath: string;
    targetName: string;
  }>({
    show: false,
    position: { top: 0, left: 0 },
    targetType: 'blank',
    targetPath: '',
    targetName: '',
  });

  // Inline input dialog state (replaces window.prompt which doesn't work in WKWebView)
  let inputDialog = $state<{
    mode: 'new-file' | 'rename';
    value: string;
    targetPath: string; // new-file: parent dir; rename: original file path
  } | null>(null);
  let inputDialogEl = $state<HTMLInputElement | null>(null);

  // Knowledge base state
  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let activeKBId = $state<string | null>(null);
  let showKBDropdown = $state(false);
  let showSaveAsKBHint = $state(false);

  filesStore.subscribe(state => {
    fileTree = state.fileTree;
    folderPath = state.openFolderPath;
    viewMode = state.sidebarViewMode;
    filePreviews = state.filePreviews;
    knowledgeBases = state.knowledgeBases;
    activeKBId = state.activeKnowledgeBaseId;
  });

  $effect(() => {
    // Close dropdown when clicking outside
    if (showKBDropdown) {
      const close = () => { showKBDropdown = false; };
      setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
    }
  });

  function toggleKBDropdown(e: MouseEvent) {
    e.stopPropagation();
    showKBDropdown = !showKBDropdown;
  }

  async function switchKB(id: string) {
    showKBDropdown = false;
    const result = await filesStore.setActiveKnowledgeBase(id);
    if (!result.success) {
      await message(result.error || 'Failed to open knowledge base', { title: 'Error', kind: 'error' });
    }
  }

  function getActiveKBName(): string {
    if (!activeKBId) return folderPath ? getFileName(folderPath) : $t('sidebar.title');
    const kb = knowledgeBases.find(k => k.id === activeKBId);
    return kb?.name ?? $t('sidebar.title');
  }

  function saveCurrentAsKB() {
    if (!folderPath) return;
    const name = getFileName(folderPath);
    const kb: KnowledgeBase = {
      id: crypto.randomUUID(),
      name,
      path: folderPath,
      lastAccessedAt: Date.now(),
    };
    filesStore.addKnowledgeBase(kb);
    // Auto-select the new KB
    filesStore.setActiveKnowledgeBase(kb.id);
    showSaveAsKBHint = false;
  }

  async function openFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: $t('sidebar.openFolder'),
    });

    if (selected && typeof selected === 'string') {
      const tree = await invoke<FileEntry[]>('read_dir_recursive', {
        path: selected,
        depth: 3,
      });
      filesStore.setOpenFolder(selected, tree);
      // Expand root level
      expandedDirs = new Set([selected]);
      // Remember the opened folder
      const settings = settingsStore.getState();
      if (settings.rememberLastFolder) {
        settingsStore.update({ lastOpenedFolder: selected });
      }
      // Start watching for changes
      startWatching(selected);
      // Load file previews for list mode
      loadFilePreviews(tree);

      // If user has KBs and this folder isn't one, show hint
      const existingKB = filesStore.findKnowledgeBaseByPath(selected);
      if (existingKB) {
        // Auto-select existing KB
        filesStore.setActiveKnowledgeBase(existingKB.id);
        showSaveAsKBHint = false;
      } else if (knowledgeBases.length > 0) {
        showSaveAsKBHint = true;
      }
    }
  }

  // Start watcher for restored folder
  $effect(() => {
    if (folderPath) {
      startWatching(folderPath);
    }
  });

  // Load previews when tree changes
  $effect(() => {
    if (fileTree.length > 0) {
      loadFilePreviews(fileTree);
    }
  });

  onDestroy(() => {
    stopWatching();
  });

  function collectFilePaths(entries: FileEntry[]): string[] {
    const paths: string[] = [];
    for (const entry of entries) {
      if (!entry.is_dir) {
        paths.push(entry.path);
      }
      if (entry.children) {
        paths.push(...collectFilePaths(entry.children));
      }
    }
    return paths;
  }

  async function loadFilePreviews(tree: FileEntry[]) {
    const paths = collectFilePaths(tree);
    if (paths.length === 0) {
      filesStore.setFilePreviews([]);
      return;
    }
    try {
      const previews = await invoke<FilePreview[]>('read_file_previews', {
        paths,
        maxChars: 100,
      });
      // Sort by filename descending (date-prefixed names sort correctly)
      previews.sort((a, b) => b.name.localeCompare(a.name));
      filesStore.setFilePreviews(previews);
    } catch {
      // Ignore preview loading errors
    }
  }

  function toggleDir(path: string) {
    const newSet = new Set(expandedDirs);
    if (newSet.has(path)) {
      newSet.delete(path);
    } else {
      newSet.add(path);
    }
    expandedDirs = newSet;
  }

  function handleFileClick(entry: FileEntry) {
    if (entry.is_dir) {
      toggleDir(entry.path);
    } else {
      onFileSelect(entry.path);
    }
  }

  function getFileName(path: string): string {
    return path.split('/').pop() || path;
  }

  function getDisplayName(name: string): string {
    return name.replace(/\.md$/, '').replace(/\.markdown$/, '');
  }

  let viewModeToggling = false;
  function toggleViewMode() {
    if (viewModeToggling) return;
    viewModeToggling = true;
    const newMode = viewMode === 'tree' ? 'list' : 'tree';
    filesStore.setSidebarViewMode(newMode);
    // Throttle: allow next toggle only after current frame renders
    requestAnimationFrame(() => { viewModeToggling = false; });
  }

  function toggleSearch() {
    showSearch = !showSearch;
    if (showSearch) {
      // Focus search input after DOM update
      setTimeout(() => searchInputEl?.focus(), 50);
    } else {
      searchQuery = '';
    }
  }

  function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      showSearch = false;
      searchQuery = '';
    }
  }

  // Filter tree entries by search query
  function filterTree(entries: FileEntry[], query: string): FileEntry[] {
    if (!query) return entries;
    const lower = query.toLowerCase();
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.is_dir) {
        const filteredChildren = entry.children ? filterTree(entry.children, query) : [];
        if (filteredChildren.length > 0) {
          result.push({ ...entry, children: filteredChildren });
        }
      } else {
        if (entry.name.toLowerCase().includes(lower)) {
          result.push(entry);
        }
      }
    }
    return result;
  }

  // Filter previews by search query
  function filterPreviews(previews: FilePreview[], query: string): FilePreview[] {
    if (!query) return previews;
    const lower = query.toLowerCase();
    return previews.filter(p => p.name.toLowerCase().includes(lower));
  }

  // Derived filtered data
  let filteredTree = $derived(filterTree(fileTree, searchQuery));
  let filteredPreviews = $derived(filterPreviews(filePreviews, searchQuery));

  // Context menu handlers
  function handleContextMenu(event: MouseEvent, type: 'file' | 'folder' | 'blank', path: string, name: string) {
    event.preventDefault();
    event.stopPropagation();
    contextMenu = {
      show: true,
      position: { top: event.clientY, left: event.clientX },
      targetType: type,
      targetPath: path,
      targetName: name,
    };
  }

  function closeContextMenu() {
    contextMenu = { ...contextMenu, show: false };
  }

  function handleNewFile() {
    const dirPath = contextMenu.targetType === 'folder'
      ? contextMenu.targetPath
      : contextMenu.targetType === 'file'
        ? contextMenu.targetPath.substring(0, contextMenu.targetPath.lastIndexOf('/'))
        : folderPath;

    if (!dirPath) return;

    inputDialog = { mode: 'new-file', value: '', targetPath: dirPath };
    setTimeout(() => inputDialogEl?.focus(), 50);
  }

  function handleSearchAction() {
    toggleSearch();
  }

  async function handleRefresh() {
    if (folderPath) {
      await refreshFileTree(folderPath);
    }
  }

  function handleRename() {
    inputDialog = {
      mode: 'rename',
      value: contextMenu.targetName,
      targetPath: contextMenu.targetPath,
    };
    setTimeout(() => {
      inputDialogEl?.focus();
      inputDialogEl?.select();
    }, 50);
  }

  async function submitInputDialog() {
    if (!inputDialog) return;
    const value = inputDialog.value.trim();
    if (!value) {
      inputDialog = null;
      return;
    }

    if (inputDialog.mode === 'new-file') {
      try {
        const newPath = await invoke<string>('create_markdown_file', {
          dirPath: inputDialog.targetPath,
          fileName: value,
        });
        if (folderPath) await refreshFileTree(folderPath);
        onFileSelect(newPath);
      } catch (e) {
        console.warn('Failed to create file:', e);
      }
    } else {
      const oldPath = inputDialog.targetPath;
      const oldName = getFileName(oldPath);
      if (value !== oldName) {
        const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/'));
        const newPath = `${parentDir}/${value}`;
        try {
          await invoke('rename_file', { oldPath, newPath });
          if (folderPath) await refreshFileTree(folderPath);
        } catch (e) {
          console.warn('Failed to rename:', e);
        }
      }
    }

    inputDialog = null;
  }

  function handleInputDialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitInputDialog();
    } else if (event.key === 'Escape') {
      inputDialog = null;
    }
  }

  async function handleDuplicate() {
    const originalPath = contextMenu.targetPath;
    const originalName = contextMenu.targetName;
    const ext = originalName.includes('.') ? originalName.substring(originalName.lastIndexOf('.')) : '';
    const baseName = ext ? originalName.substring(0, originalName.lastIndexOf('.')) : originalName;
    const copyName = `${baseName} copy${ext}`;
    const parentDir = originalPath.substring(0, originalPath.lastIndexOf('/'));
    const copyPath = `${parentDir}/${copyName}`;

    try {
      const content = await invoke<string>('read_file', { path: originalPath });
      await invoke('write_file', { path: copyPath, content });
      if (folderPath) await refreshFileTree(folderPath);
    } catch (e) {
      console.warn('Failed to duplicate:', e);
    }
  }

  async function handleDelete() {
    const name = contextMenu.targetName;
    const confirmed = await ask(
      $t('sidebar.deleteConfirm').replace('{name}', name),
      { title: $t('sidebar.contextMenu.delete'), kind: 'warning' }
    );
    if (!confirmed) return;

    try {
      await invoke('delete_file', { path: contextMenu.targetPath });
      if (folderPath) await refreshFileTree(folderPath);
    } catch (e) {
      console.warn('Failed to delete:', e);
    }
  }

  async function handleCopyPath() {
    try {
      await navigator.clipboard.writeText(contextMenu.targetPath);
    } catch {
      // Clipboard may not be available
    }
  }

  async function handleRevealInFinder() {
    try {
      await revealItemInDir(contextMenu.targetPath);
    } catch {
      // May fail on some platforms
    }
  }
</script>

<div
  class="sidebar no-select"
  oncontextmenu={(e) => handleContextMenu(e, 'blank', folderPath || '', '')}
>
  <div class="sidebar-header">
    <button class="kb-switcher" onclick={toggleKBDropdown} title={$t('knowledgeBase.switchTo')}>
      <span class="kb-switcher-name">{getActiveKBName()}</span>
      <svg class="kb-chevron" class:open={showKBDropdown} width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
        <path d="M4.427 6.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 6H4.604a.25.25 0 00-.177.427z"/>
      </svg>
    </button>
    {#if showKBDropdown}
      <div class="kb-dropdown">
        {#each [...knowledgeBases].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt) as kb}
          <button
            class="kb-dropdown-item"
            class:active={kb.id === activeKBId}
            onclick={() => switchKB(kb.id)}
          >
            {#if kb.id === activeKBId}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
            {:else}
              <span class="kb-check-spacer"></span>
            {/if}
            <span class="kb-dropdown-name">{kb.name}</span>
          </button>
        {/each}
        <div class="kb-dropdown-divider"></div>
        <button class="kb-dropdown-item kb-manage" onclick={() => { showKBDropdown = false; onOpenKBManager?.(); }}>
          {$t('knowledgeBase.manage')}
        </button>
      </div>
    {/if}
    <div class="sidebar-actions">
      {#if folderPath}
        <button
          class="sidebar-btn"
          onclick={toggleSearch}
          title={$t('sidebar.search')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85zm-5.242.156a5 5 0 110-10 5 5 0 010 10z"/>
          </svg>
        </button>
        <button
          class="sidebar-btn"
          onclick={toggleViewMode}
          title={viewMode === 'tree' ? $t('sidebar.listView') : $t('sidebar.treeView')}
        >
          {#if viewMode === 'tree'}
            <!-- List icon -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 4h12v1H2zm0 3.5h12v1H2zm0 3.5h12v1H2z"/>
            </svg>
          {:else}
            <!-- Tree icon -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 1h4v4H1zm6 0h8v1.5H7zm0 2.5h6v1H7zM1 7h4v4H1zm6 0h8v1.5H7zm0 2.5h6v1H7z"/>
            </svg>
          {/if}
        </button>
      {/if}
      <button class="sidebar-btn" onclick={() => onOpenKBManager?.()} title={$t('sidebar.kbSettings')}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0a1 1 0 011 1v1.07a5.97 5.97 0 011.828.75l.757-.756a1 1 0 011.414 1.414l-.756.757c.357.567.62 1.187.75 1.828H14a1 1 0 110 2h-1.07a5.97 5.97 0 01-.75 1.828l.756.757a1 1 0 01-1.414 1.414l-.757-.756a5.97 5.97 0 01-1.828.75V14a1 1 0 11-2 0v-1.07a5.97 5.97 0 01-1.828-.75l-.757.756a1 1 0 01-1.414-1.414l.756-.757a5.97 5.97 0 01-.75-1.828H2a1 1 0 110-2h1.07a5.97 5.97 0 01.75-1.828l-.756-.757A1 1 0 014.478 2.93l.757.756A5.97 5.97 0 017 2.936V1a1 1 0 011-1zm0 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z"/>
        </svg>
      </button>
    </div>
  </div>

  {#if showSearch}
    <div class="search-bar">
      <input
        bind:this={searchInputEl}
        type="text"
        class="search-input"
        placeholder={$t('sidebar.search')}
        bind:value={searchQuery}
        onkeydown={handleSearchKeydown}
      />
    </div>
  {/if}

  {#if inputDialog}
    <div class="input-dialog">
      <span class="input-dialog-label">
        {inputDialog.mode === 'new-file' ? $t('sidebar.newFilePrompt') : $t('sidebar.renamePrompt')}
      </span>
      <input
        bind:this={inputDialogEl}
        type="text"
        class="input-dialog-input"
        bind:value={inputDialog.value}
        onkeydown={handleInputDialogKeydown}
        onblur={() => { inputDialog = null; }}
      />
    </div>
  {/if}

  {#if showSaveAsKBHint && folderPath}
    <div class="kb-save-hint">
      <span>{$t('knowledgeBase.saveHint')}</span>
      <div class="kb-save-hint-actions">
        <button class="kb-save-hint-btn" onclick={saveCurrentAsKB}>{$t('knowledgeBase.saveAsKB')}</button>
        <button class="kb-save-hint-close" onclick={() => showSaveAsKBHint = false}>&times;</button>
      </div>
    </div>
  {/if}

  <div class="sidebar-content">
    {#if fileTree.length === 0 && knowledgeBases.length === 0}
      <!-- No knowledge bases created yet -->
      <div class="sidebar-empty">
        <p>{$t('sidebar.createKB')}</p>
        <button class="open-btn" onclick={() => onOpenKBManager?.()}>{$t('knowledgeBase.add')}</button>
      </div>
    {:else if fileTree.length === 0}
      <!-- KB bound but directory is empty -->
      <div class="sidebar-empty">
        <p>{$t('sidebar.emptyDir')}</p>
      </div>
    {:else if viewMode === 'list'}
      <!-- List View -->
      <div class="list-view">
        {#each filteredPreviews as preview}
          <button
            class="list-item"
            onclick={() => onFileSelect(preview.path)}
            oncontextmenu={(e) => handleContextMenu(e, 'file', preview.path, preview.name)}
          >
            <span class="list-item-title">{getDisplayName(preview.name)}</span>
            {#if preview.preview}
              <span class="list-item-preview">{preview.preview}</span>
            {/if}
          </button>
        {/each}
      </div>
    {:else}
      <!-- Tree View -->
      {#each filteredTree as entry}
        {@render fileTreeItem(entry, 0)}
      {/each}
    {/if}
  </div>
</div>

{#snippet fileTreeItem(entry: FileEntry, depth: number)}
  <button
    class="tree-item"
    class:is-dir={entry.is_dir}
    style="padding-left: {0.75 + depth * 1}rem"
    onclick={() => handleFileClick(entry)}
    oncontextmenu={(e) => handleContextMenu(e, entry.is_dir ? 'folder' : 'file', entry.path, entry.name)}
  >
    {#if entry.is_dir}
      <span class="tree-icon" class:expanded={expandedDirs.has(entry.path)}>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
          <path d="M2 1l4 3-4 3z"/>
        </svg>
      </span>
    {:else}
      <span class="tree-icon file-icon">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5">
          <path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/>
        </svg>
      </span>
    {/if}
    <span class="tree-name">{entry.name}</span>
  </button>

  {#if entry.is_dir && entry.children && expandedDirs.has(entry.path)}
    {#each entry.children as child}
      {@render fileTreeItem(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

{#if contextMenu.show}
  <FileContextMenu
    position={contextMenu.position}
    targetType={contextMenu.targetType}
    targetPath={contextMenu.targetPath}
    targetName={contextMenu.targetName}
    onNewFile={handleNewFile}
    onSearch={handleSearchAction}
    onRefresh={handleRefresh}
    onRename={handleRename}
    onDuplicate={handleDuplicate}
    onDelete={handleDelete}
    onCopyPath={handleCopyPath}
    onRevealInFinder={handleRevealInFinder}
    onClose={closeContextMenu}
  />
{/if}

<style>
  .sidebar {
    width: var(--sidebar-width);
    height: 100%;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border-light);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border-light);
    min-height: 2rem;
    position: relative;
  }

  .sidebar-actions {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    flex-shrink: 0;
  }

  .sidebar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: 3px;
  }

  .sidebar-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .search-bar {
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--border-light);
  }

  .search-input {
    width: 100%;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    outline: none;
  }

  .search-input:focus {
    border-color: var(--accent-color);
  }

  .input-dialog {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--border-light);
    background: var(--bg-secondary);
  }

  .input-dialog-label {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }

  .input-dialog-input {
    width: 100%;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--accent-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    outline: none;
  }

  .sidebar-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0.25rem 0;
  }

  .sidebar-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 0.75rem;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .open-btn {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-xs);
  }

  .open-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  /* Tree View */
  .tree-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.2rem 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tree-item:hover {
    background: var(--bg-hover);
  }

  .tree-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 0.75rem;
    flex-shrink: 0;
    color: var(--text-muted);
    transition: transform var(--transition-fast);
  }

  .tree-icon.expanded {
    transform: rotate(90deg);
  }

  .tree-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* List View */
  .list-view {
    display: flex;
    flex-direction: column;
  }

  .list-item {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    width: 100%;
    min-width: 0;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    border-bottom: 1px solid var(--border-light);
    box-sizing: border-box;
  }

  .list-item:hover {
    background: var(--bg-hover);
  }

  .list-item-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .list-item-preview {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  /* iPadOS: larger touch targets and active feedback */
  :global(.platform-ipados) .tree-item {
    padding: 0.5rem 0.75rem;
    min-height: 44px;
  }

  :global(.platform-ipados) .tree-item:active {
    background: var(--bg-hover);
  }

  :global(.platform-ipados) .list-item {
    padding: 0.65rem 0.75rem;
    min-height: 44px;
  }

  :global(.platform-ipados) .list-item:active {
    background: var(--bg-hover);
  }

  /* Knowledge Base Switcher */
  .kb-switcher {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .kb-switcher:hover {
    background: var(--bg-hover);
  }

  .kb-switcher-name {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kb-chevron {
    flex-shrink: 0;
    color: var(--text-muted);
    transition: transform var(--transition-fast);
  }

  .kb-chevron.open {
    transform: rotate(180deg);
  }

  .kb-dropdown {
    position: absolute;
    top: 100%;
    left: 0.5rem;
    right: 0.5rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 10;
    padding: 0.25rem 0;
    max-height: 280px;
    overflow-y: auto;
  }

  .kb-dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.4rem 0.5rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    text-align: left;
  }

  .kb-dropdown-item:hover {
    background: var(--bg-hover);
  }

  .kb-dropdown-item.active {
    font-weight: 600;
  }

  .kb-dropdown-item.kb-manage {
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
  }

  .kb-check-spacer {
    display: inline-block;
    width: 12px;
  }

  .kb-dropdown-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kb-dropdown-divider {
    height: 1px;
    background: var(--border-light);
    margin: 0.25rem 0;
  }

  .kb-save-hint {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-light);
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }

  .kb-save-hint-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .kb-save-hint-btn {
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--accent-color);
    background: transparent;
    color: var(--accent-color);
    border-radius: 3px;
    cursor: pointer;
    font-size: var(--font-size-xs);
    white-space: nowrap;
  }

  .kb-save-hint-btn:hover {
    background: var(--accent-color);
    color: white;
  }

  .kb-save-hint-close {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 0.15rem;
  }
</style>

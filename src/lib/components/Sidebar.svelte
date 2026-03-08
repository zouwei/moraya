<script lang="ts">
  import { onDestroy } from 'svelte';
  import { filesStore, type FileEntry, type FilePreview, type KnowledgeBase } from '../stores/files-store';
  import { settingsStore } from '../stores/settings-store';
  import { invoke } from '@tauri-apps/api/core';
  import { open, ask, message } from '@tauri-apps/plugin-dialog';
  import { revealItemInDir } from '@tauri-apps/plugin-opener';
  import { t } from '$lib/i18n';
  import { startWatching, stopWatching, refreshFileTree } from '$lib/services/file-watcher';
  import { load as loadStore } from '@tauri-apps/plugin-store';
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

  // Drag-and-drop state (pointer-event based, bypasses HTML5 DnD for WKWebView reliability)
  let _dragPath: string | null = null;   // plain var — always synchronously readable in handlers
  let draggedFilePath = $state<string | null>(null); // reactive: shows drag cursor
  let dropTargetPath = $state<string | null>(null);  // reactive: shows drop-target highlight
  let _dragGhost: HTMLElement | null = null;

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
    mode: 'new-file' | 'new-folder' | 'rename';
    value: string;
    targetPath: string; // new-file/new-folder: parent dir; rename: original file/dir path
  } | null>(null);
  let inputDialogEl = $state<HTMLInputElement | null>(null);

  // Knowledge base state
  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let activeKBId = $state<string | null>(null);
  let showKBDropdown = $state(false);
  let showSaveAsKBHint = $state(false);

  // Top-level store subscription — do NOT wrap in $effect().
  // Svelte 5 $effect tracks reads in subscribe callbacks, causing infinite loops.
  //
  // CRITICAL: Svelte 5's safe_equals() ALWAYS returns false for object/array
  // assignments (by design: `typeof value === 'object'` triggers unconditional
  // update). This means writing an array $state var with the SAME reference
  // STILL marks the signal dirty and re-triggers any $effect that reads it.
  //
  // The $effect on fileTree calls loadFilePreviews → setFilePreviews →
  // store update → subscribe → fileTree = state.fileTree (same ref, but safe_equals
  // returns false) → $effect re-runs → INFINITE LOOP pegging CPU at 100%+.
  //
  // Fix: guard array/object writes with reference equality so we only update
  // the signal when the underlying data genuinely changed.
  let _prevFileTree: FileEntry[] | null = null;
  let _prevFilePreviews: FilePreview[] | null = null;
  let _prevKnowledgeBases: KnowledgeBase[] | null = null;

  const unsubFiles = filesStore.subscribe(state => {
    if (state.fileTree !== _prevFileTree) {
      _prevFileTree = state.fileTree;
      fileTree = state.fileTree;
    }
    folderPath = state.openFolderPath;
    viewMode = state.sidebarViewMode;
    if (state.filePreviews !== _prevFilePreviews) {
      _prevFilePreviews = state.filePreviews;
      filePreviews = state.filePreviews;
    }
    if (state.knowledgeBases !== _prevKnowledgeBases) {
      _prevKnowledgeBases = state.knowledgeBases;
      knowledgeBases = state.knowledgeBases;
    }
    activeKBId = state.activeKnowledgeBaseId;
  });
  onDestroy(() => { unsubFiles(); });

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

  // Persist expanded dirs per KB folder
  const SIDEBAR_PREFS_STORE = 'files-prefs.json';
  let _skipExpandedDirsSave = false;
  let _expandedDirsSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Restore expanded dirs when folderPath changes
  $effect(() => {
    const fp = folderPath;
    if (!fp) return;
    // Cancel any pending save to avoid overwriting restored state
    if (_expandedDirsSaveTimer !== null) {
      clearTimeout(_expandedDirsSaveTimer);
      _expandedDirsSaveTimer = null;
    }
    _skipExpandedDirsSave = true;
    (async () => {
      try {
        const store = await loadStore(SIDEBAR_PREFS_STORE);
        const saved = await store.get<string[]>(`expandedDirs:${fp}`);
        if (Array.isArray(saved) && saved.length > 0) {
          expandedDirs = new Set(saved);
        }
      } catch { /* ignore */ }
      _skipExpandedDirsSave = false;
    })();
  });

  // Persist expanded dirs on change (debounced 800ms, skip during restore)
  $effect(() => {
    const dirs = expandedDirs;
    const fp = folderPath;
    if (!fp || _skipExpandedDirsSave) return;
    if (_expandedDirsSaveTimer !== null) clearTimeout(_expandedDirsSaveTimer);
    _expandedDirsSaveTimer = setTimeout(async () => {
      _expandedDirsSaveTimer = null;
      try {
        const store = await loadStore(SIDEBAR_PREFS_STORE);
        await store.set(`expandedDirs:${fp}`, [...dirs]);
        await store.save();
      } catch { /* ignore */ }
    }, 800);
  });

  // Load previews when tree changes
  $effect(() => {
    if (fileTree.length > 0) {
      loadFilePreviews(fileTree);
    }
  });

  onDestroy(() => {
    stopWatching();
    if (_expandedDirsSaveTimer !== null) clearTimeout(_expandedDirsSaveTimer);
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

  // Reserved directory names that should not appear in the sidebar
  function isReservedDir(entry: FileEntry): boolean {
    return entry.is_dir && entry.name === 'images';
  }

  // Filter reserved dirs from tree entries (recursively)
  function filterReserved(entries: FileEntry[]): FileEntry[] {
    return entries
      .filter(e => !isReservedDir(e))
      .map(e => e.is_dir && e.children
        ? { ...e, children: filterReserved(e.children) }
        : e
      );
  }

  /**
   * Pin MORAYA.md to the first position among root-level entries.
   * Only affects the top level — subdirectory order is unchanged.
   */
  function pinMorayaMd(entries: FileEntry[]): FileEntry[] {
    const idx = entries.findIndex(e => !e.is_dir && e.name === 'MORAYA.md');
    if (idx <= 0) return entries; // not found or already first
    const result = [...entries];
    result.splice(idx, 1);
    result.unshift(entries[idx]);
    return result;
  }

  // Derived filtered data (search + reserved dir filter + MORAYA.md pinned to top)
  let filteredTree = $derived(pinMorayaMd(filterTree(filterReserved(fileTree), searchQuery)));
  // List view: filter previews whose path is inside images/ directory
  let filteredPreviews = $derived(
    filterPreviews(
      filePreviews.filter(p => {
        // Exclude files inside the reserved images/ directory
        const rel = folderPath ? p.path.slice(folderPath.length + 1) : p.path;
        return !rel.startsWith('images/') && rel !== 'images';
      }),
      searchQuery
    )
  );

  // Preview lookup map for list view (path → preview)
  let previewMap = $derived(new Map(filePreviews.map(p => [p.path, p])));

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
    // Pre-load history versions so the submenu is ready on first hover
    if (type === 'file' && name === 'MORAYA.md') {
      contextMenuHistoryVersions = [];
      loadHistoryVersions(path);
    } else {
      contextMenuHistoryVersions = [];
    }
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

  function handleNewFolder() {
    const dirPath = contextMenu.targetType === 'folder'
      ? contextMenu.targetPath
      : contextMenu.targetType === 'file'
        ? contextMenu.targetPath.substring(0, contextMenu.targetPath.lastIndexOf('/'))
        : folderPath;

    if (!dirPath) return;

    inputDialog = { mode: 'new-folder', value: '', targetPath: dirPath };
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
    const name = contextMenu.targetName;
    // Strip .md extension so the user never sees/edits it; re-appended on submit
    const displayName = name.endsWith('.md') ? name.slice(0, -3) : name;
    inputDialog = {
      mode: 'rename',
      value: displayName,
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
    } else if (inputDialog.mode === 'new-folder') {
      // Reject reserved directory name "images"
      if (value.toLowerCase() === 'images') {
        await message($t('sidebar.reservedDirName'), { title: $t('sidebar.reservedDirTitle'), kind: 'warning' });
        inputDialog = null;
        return;
      }
      const newPath = `${inputDialog.targetPath}/${value}`;
      try {
        await invoke('create_dir', { path: newPath });
        if (folderPath) await refreshFileTree(folderPath);
        // Auto-expand the parent directory
        expandedDirs = new Set([...expandedDirs, inputDialog.targetPath]);
      } catch (e) {
        console.warn('Failed to create folder:', e);
      }
    } else {
      const oldPath = inputDialog.targetPath;
      // Re-append .md if the original file was .md (user edited without seeing the extension)
      const finalValue = oldPath.endsWith('.md') ? `${value}.md` : value;
      // Reject renaming a directory to the reserved name "images"
      const isDir = !oldPath.endsWith('.md') && !oldPath.endsWith('.markdown');
      if (isDir && finalValue.toLowerCase() === 'images') {
        await message($t('sidebar.reservedDirName'), { title: $t('sidebar.reservedDirTitle'), kind: 'warning' });
        inputDialog = null;
        return;
      }
      const oldName = getFileName(oldPath);
      if (finalValue !== oldName) {
        const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/'));
        const newPath = `${parentDir}/${finalValue}`;
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

  // ---- Drag-and-drop to move files (pointer/mouse events — more reliable in WKWebView) ----

  /** Create a floating ghost label that follows the cursor during drag. */
  function createDragGhost(name: string, x: number, y: number) {
    _dragGhost = document.createElement('div');
    _dragGhost.className = 'drag-ghost';
    _dragGhost.textContent = getDisplayName(name);
    _dragGhost.style.cssText = `left:${x + 14}px;top:${y - 10}px`;
    document.body.appendChild(_dragGhost);
  }

  function moveDragGhost(x: number, y: number) {
    if (_dragGhost) {
      _dragGhost.style.left = `${x + 14}px`;
      _dragGhost.style.top = `${y - 10}px`;
    }
  }

  function removeDragGhost() {
    _dragGhost?.remove();
    _dragGhost = null;
  }

  /**
   * Return the target folder path for a drop at (x, y), or null if none.
   * Priority:
   *   1. Cursor over a folder button → that folder
   *   2. Cursor over a file button   → that file's parent directory
   *   3. Cursor anywhere in sidebar  → KB root (folderPath)
   * Returns null when the target equals the dragged file's current parent (no-op).
   */
  function findFolderAtPoint(x: number, y: number): string | null {
    if (!_dragPath) return null;
    const dragParentDir = _dragPath.substring(0, _dragPath.lastIndexOf('/'));

    // Hide ghost temporarily so it doesn't block elementFromPoint
    if (_dragGhost) _dragGhost.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (_dragGhost) _dragGhost.style.display = '';
    if (!el) return null;

    // 1. Cursor over a folder button
    const folderBtn = el.closest('[data-folder-path]') as HTMLElement | null;
    if (folderBtn?.dataset.folderPath) {
      const target = folderBtn.dataset.folderPath;
      if (isReservedDir({ name: target.split('/').pop()!, path: target, is_dir: true })) return null;
      return dragParentDir === target ? null : target;
    }

    // 2. Cursor over a file row → use its parent directory
    const fileBtn = el.closest('[data-file-path]') as HTMLElement | null;
    if (fileBtn?.dataset.filePath) {
      const fp = fileBtn.dataset.filePath;
      const parentDir = fp.substring(0, fp.lastIndexOf('/'));
      return dragParentDir === parentDir ? null : parentDir;
    }

    // 3. Cursor anywhere in the sidebar content → KB root
    if (el.closest('.sidebar-content') && folderPath) {
      return dragParentDir === folderPath ? null : folderPath;
    }

    return null;
  }

  /** Start a mouse-based drag when mousedown fires on a file item. */
  function startFileDrag(event: MouseEvent, entry: FileEntry) {
    if (event.button !== 0 || entry.is_dir) return; // left-click on files only
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;

    function onMove(e: MouseEvent) {
      if (!started) {
        // Require >5px movement before recognising as drag (allows normal clicks)
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
        started = true;
        _dragPath = entry.path;
        draggedFilePath = entry.path;
        createDragGhost(entry.name, e.clientX, e.clientY);
      }
      moveDragGhost(e.clientX, e.clientY);
      dropTargetPath = findFolderAtPoint(e.clientX, e.clientY);
    }

    async function onUp(e: MouseEvent) {
      cleanup();
      if (!started) return; // was just a click — don't interfere

      const target = dropTargetPath;
      const filePath = _dragPath;
      dropTargetPath = null;
      _dragPath = null;
      draggedFilePath = null;
      removeDragGhost();

      if (target && filePath) {
        const fileName = filePath.split('/').pop()!;
        const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (parentDir !== target) {
          try {
            await invoke('rename_file', { oldPath: filePath, newPath: `${target}/${fileName}` });
            if (folderPath) await refreshFileTree(folderPath);
            expandedDirs = new Set([...expandedDirs, target]);
          } catch (err) {
            console.warn('Failed to move file:', err);
          }
        }
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        cleanup();
        _dragPath = null;
        draggedFilePath = null;
        dropTargetPath = null;
        removeDragGhost();
      }
    }

    function cleanup() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKeyDown);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', onKeyDown);
  }

  // ---- History versions (inline submenu in context menu) ----
  interface HistoryVersion {
    name: string;
    path: string;
    timestamp: string;
  }
  /** Versions pre-loaded when MORAYA.md is right-clicked; passed directly to FileContextMenu. */
  let contextMenuHistoryVersions = $state<HistoryVersion[]>([]);

  function formatHistoryTimestamp(filename: string): string {
    // Convert "2026-03-02_14-30-45.md" → "2026-03-02 14:30:45"
    const base = filename.replace(/\.md$/, '');
    return base.replace('_', ' ').replace(/-(\d{2})-(\d{2})$/, ':$1:$2');
  }

  async function loadHistoryVersions(filePath: string) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    const historyDir = `${dir}/.moraya/history`;
    try {
      const entries = await invoke<FileEntry[]>('read_dir_recursive', { path: historyDir, depth: 1 });
      contextMenuHistoryVersions = entries
        .filter((e) => !e.is_dir && e.name?.endsWith('.md'))
        .sort((a, b) => b.name.localeCompare(a.name))
        .map((e) => ({
          name: e.name,
          path: e.path,
          timestamp: formatHistoryTimestamp(e.name),
        }));
    } catch {
      contextMenuHistoryVersions = [];
    }
  }

  async function restoreHistoryVersion(versionPath: string) {
    // Capture the MORAYA.md path synchronously before any await
    const morayaPath = contextMenu.targetPath;
    const confirmed = await ask(
      $t('sidebar.history.restoreConfirm'),
      { title: $t('sidebar.history.restore'), kind: 'warning' }
    );
    if (!confirmed) return;

    try {
      const content = await invoke<string>('read_file', { path: versionPath });
      await invoke('write_file', { path: morayaPath, content });
    } catch (e) {
      console.warn('Failed to restore history version:', e);
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
        {inputDialog.mode === 'new-file' ? $t('sidebar.newFilePrompt') : inputDialog.mode === 'new-folder' ? $t('sidebar.newFolderPrompt') : $t('sidebar.renamePrompt')}
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

  <div class="sidebar-content" class:drop-root={dropTargetPath === folderPath && !!folderPath}>
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
      <!-- List View: hierarchical tree with folders and file previews -->
      <div class="list-view">
        {#each filteredTree as entry}
          {@render listItem(entry, 0)}
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
    class:drop-target={entry.is_dir && dropTargetPath === entry.path}
    style="padding-inline-start: {0.75 + depth * 1}rem"
    data-folder-path={entry.is_dir ? entry.path : undefined}
    data-file-path={!entry.is_dir ? entry.path : undefined}
    onclick={() => handleFileClick(entry)}
    oncontextmenu={(e) => handleContextMenu(e, entry.is_dir ? 'folder' : 'file', entry.path, entry.name)}
    onmousedown={!entry.is_dir ? (e) => startFileDrag(e, entry) : undefined}
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
    <span class="tree-name" class:moraya-rule={!entry.is_dir && entry.name === 'MORAYA.md'}>
      {entry.is_dir ? entry.name : getDisplayName(entry.name)}
    </span>
  </button>

  {#if entry.is_dir && entry.children && expandedDirs.has(entry.path)}
    {#each entry.children.filter(c => !isReservedDir(c)) as child}
      {@render fileTreeItem(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

{#snippet listItem(entry: FileEntry, depth: number)}
  {#if entry.is_dir}
    <!-- Directory row: folder name + chevron; also a drop target via data-folder-path -->
    <button
      class="list-dir-item"
      class:drop-target={dropTargetPath === entry.path}
      style="padding-inline-start: {0.75 + depth}rem"
      data-folder-path={entry.path}
      onclick={() => toggleDir(entry.path)}
      oncontextmenu={(e) => handleContextMenu(e, 'folder', entry.path, entry.name)}
    >
      <span class="tree-icon" class:expanded={expandedDirs.has(entry.path)}>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
          <path d="M2 1l4 3-4 3z"/>
        </svg>
      </span>
      <span class="list-dir-name">{entry.name}</span>
    </button>
    {#if expandedDirs.has(entry.path) && entry.children}
      {#each entry.children.filter(c => !isReservedDir(c)) as child}
        {@render listItem(child, depth + 1)}
      {/each}
    {/if}
  {:else}
    <!-- File row: name + preview excerpt; mouse-based drag to move between folders -->
    {@const preview = previewMap.get(entry.path)}
    <button
      class="list-item"
      style="padding-inline-start: {0.75 + depth + 1}rem"
      data-file-path={entry.path}
      onclick={() => onFileSelect(entry.path)}
      oncontextmenu={(e) => handleContextMenu(e, 'file', entry.path, entry.name)}
      onmousedown={(e) => startFileDrag(e, entry)}
    >
      <span class="list-item-title" class:moraya-rule={entry.name === 'MORAYA.md'}>{getDisplayName(entry.name)}</span>
      {#if preview?.preview}
        <span class="list-item-preview" class:moraya-rule-preview={entry.name === 'MORAYA.md'}>{preview.preview}</span>
      {/if}
    </button>
  {/if}
{/snippet}

{#if contextMenu.show}
  <FileContextMenu
    position={contextMenu.position}
    targetType={contextMenu.targetType}
    targetPath={contextMenu.targetPath}
    targetName={contextMenu.targetName}
    onNewFile={handleNewFile}
    onNewFolder={handleNewFolder}
    onSearch={handleSearchAction}
    onRefresh={handleRefresh}
    onRename={handleRename}
    onDuplicate={handleDuplicate}
    onDelete={handleDelete}
    onCopyPath={handleCopyPath}
    onRevealInFinder={handleRevealInFinder}
    historyVersions={contextMenu.targetName === 'MORAYA.md' ? contextMenuHistoryVersions : undefined}
    onRestoreVersion={restoreHistoryVersion}
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

  /* MORAYA.md rule file — always pinned at top, highlighted with accent color (same as AI send button).
     Use compound selectors to win over .tree-name / .list-item-title color declarations. */
  .tree-name.moraya-rule,
  .list-item-title.moraya-rule {
    color: var(--accent-color);
  }

  /* Preview text: accent color faded toward gray */
  .list-item-preview.moraya-rule-preview {
    color: color-mix(in srgb, var(--accent-color) 45%, var(--text-muted));
  }

  /* Drop target highlight — folder buttons */
  .tree-item.drop-target,
  .list-dir-item.drop-target {
    background: color-mix(in srgb, var(--accent-color) 15%, transparent);
    outline: 1.5px solid var(--accent-color);
    outline-offset: -1px;
    border-radius: 4px;
  }

  /* Root-level drop zone: subtle top border indicates "drop at KB root" */
  .sidebar-content.drop-root {
    outline: 1.5px solid var(--accent-color);
    outline-offset: -1px;
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

  /* Directory row in list view — same height/padding as list-item for easy drop targeting */
  .list-dir-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    min-width: 0;
    /* Match list-item height: single line with same vertical padding */
    padding: 0.5rem 0.75rem;
    border: none;
    border-bottom: 1px solid var(--border-light);
    background: transparent;
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
    white-space: nowrap;
    overflow: hidden;
  }

  .list-dir-item:hover {
    background: var(--bg-hover);
  }

  .list-dir-name {
    font-size: var(--font-size-xs);
    font-weight: 500;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
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
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .list-item-preview {
    font-size: 11px;
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

  /* RTL overrides */
  :global([dir="rtl"]) .sidebar {
    border-right: none;
    border-left: 1px solid var(--border-light);
  }

  :global([dir="rtl"]) .tree-item {
    text-align: right;
  }

  :global([dir="rtl"]) .tree-icon.expanded {
    transform: rotate(-90deg);
  }

  :global([dir="rtl"]) .list-item {
    text-align: right;
  }

  :global([dir="rtl"]) .kb-dropdown-item {
    text-align: right;
  }

  /* Drag ghost — appended to document.body, outside scoped styles → use :global */
  :global(.drag-ghost) {
    position: fixed;
    pointer-events: none;
    z-index: 9999;
    padding: 0.2rem 0.6rem;
    background: var(--bg-primary, #fff);
    border: 1.5px solid var(--accent-color, #4a9eff);
    border-radius: 4px;
    font-size: var(--font-size-sm, 0.8rem);
    color: var(--text-primary, #333);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
    white-space: nowrap;
    opacity: 0.92;
    user-select: none;
  }

</style>

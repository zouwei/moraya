<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { filesStore, type FileEntry, type FilePreview, type KnowledgeBase } from '../stores/files-store';
  import { settingsStore } from '../stores/settings-store';
  import { invoke } from '@tauri-apps/api/core';
  import { open, ask, message } from '$lib/utils/native-dialog';
  import { revealItemInDir } from '@tauri-apps/plugin-opener';
  import { t } from '$lib/i18n';
  import { documentExtension } from '@moraya/core/typst';
  import { startWatching, stopWatching, refreshFileTree } from '$lib/services/file-watcher';
  import { load as loadStore } from '@tauri-apps/plugin-store';
  import FileContextMenu from './FileContextMenu.svelte';
  import KbMemoryAssetDialog from './KbMemoryAssetDialog.svelte';
  import LockIndicator from './LockIndicator.svelte';
  import type { Lock } from '$lib/services/review/types';
  import { kbSyncStore, runSync } from '$lib/services/kb-sync/sync-service';
  import type { KbSyncState } from '$lib/services/kb-sync/types';
  import { renameVersionsDir } from '$lib/services/version-history';

  let {
    onFileSelect,
    onOpenKBManager,
    onRename,
    onOpenSettings,
    currentFileLock = null,
    selfName = '',
    onForceUnlock,
    onViewReadonly,
    onNotify,
  }: {
    onFileSelect: (path: string, scrollOffset?: number, keyword?: string) => void;
    onOpenKBManager?: () => void;
    onRename?: (oldPath: string, newPath: string) => void;
    onOpenSettings?: (tab: string) => void;
    /** Lock state for the currently open file, or null. */
    currentFileLock?: Lock | null;
    /** Current user's git name (for distinguishing own vs. other's lock). */
    selfName?: string;
    onForceUnlock?: () => void;
    onViewReadonly?: () => void;
    /** Toast notification — passed in from +page.svelte's showToast. */
    onNotify?: (text: string, type?: 'success' | 'error') => void;
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
    mode: 'new-folder' | 'new-file' | 'rename';
    value: string;
    targetPath: string; // new-file/new-folder: parent dir; rename: original file/dir path
  } | null>(null);
  let inputDialogEl = $state<HTMLInputElement | null>(null);

  // Knowledge base state
  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let activeKBId = $state<string | null>(null);
  let showKBDropdown = $state(false);
  let showSaveAsKBHint = $state(false);
  // KB whose memory-directory assets dialog is open (Picora-bound KBs only).
  let memoryPanelKb = $state<KnowledgeBase | null>(null);

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
  // Per-KB sync state map (drives dropdown badge + sync-button spinner state).
  let syncStates = $state<Map<string, KbSyncState>>(new Map());
  const unsubSync = kbSyncStore.subscribe(map => { syncStates = map; });
  onDestroy(() => { unsubFiles(); unsubSync(); });

  /** True when the active KB has Picora binding — used to render the sync button. */
  let activeKbBound = $derived(
    knowledgeBases.find(k => k.id === activeKBId)?.picoraBinding != null
  );

  /** Sync status for a KB (idle | syncing | conflict | error | unbound). */
  function kbSyncStatus(kbId: string): string {
    return syncStates.get(kbId)?.status ?? 'idle';
  }

  /** Trigger a manual sync of the currently-active KB. */
  async function triggerSyncActiveKb() {
    const kb = knowledgeBases.find(k => k.id === activeKBId);
    if (!kb?.picoraBinding) return;
    const settings = settingsStore.getState();
    const target = settings.imageHostTargets.find(t => t.id === kb.picoraBinding!.picoraTargetId);
    if (!target) {
      // Picora account was deleted after binding — surface the error.
      const errMsg = $t('kb_sync.error.target_missing');
      filesStore.updateKbSyncReport(kb.id, {
        lastSyncAt: new Date().toISOString(),
        lastSyncReport: null,
        lastSyncError: errMsg,
      });
      kbSyncStore.setState(kb.id, { status: 'error', lastError: errMsg });
      return;
    }
    try {
      const report = await runSync(kb.picoraBinding, kb, target, false);
      const numConflicts = typeof report.conflicts === 'number'
        ? report.conflicts
        : (report.conflicts as unknown as { length: number }).length;
      filesStore.updateKbSyncReport(kb.id, {
        lastSyncAt: new Date().toISOString(),
        lastSyncReport: {
          uploaded: report.uploaded,
          downloaded: report.downloaded,
          deletedRemote: report.deletedRemote,
          deletedLocal: report.deletedLocal,
          skipped: report.skipped,
          conflicts: numConflicts,
        },
        lastSyncError: null,
      });
      if (report.deletedLocal > 0 && onNotify) {
        onNotify(
          get(t)('kb_sync.trash.toast_deleted', { count: String(report.deletedLocal) }),
          'success',
        );
      }
    } catch (e) {
      const errMsg = typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Sync failed');
      console.error('[KbSync] Sync failed for KB', kb.id, ':', errMsg);
      kbSyncStore.setState(kb.id, { status: 'error', lastError: errMsg });
      filesStore.updateKbSyncReport(kb.id, {
        lastSyncAt: new Date().toISOString(),
        lastSyncReport: null,
        lastSyncError: errMsg,
      });
    }
  }

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
      title: $t('sidebar.open_folder'),
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
    // In tree mode, show full file name with extension
    if (viewMode === 'tree') return name;
    // List mode hides the document extension for either flavor (.md / .typ)
    const ext = documentExtension(name);
    return ext ? name.slice(0, -ext.length) : name;
  }

  /** Get file extension (lowercase, without dot) */
  function getFileExt(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  }

  let viewModeToggling = false;
  function toggleViewMode() {
    if (viewModeToggling) return;
    viewModeToggling = true;
    const newMode = viewMode === 'tree' ? 'list' : 'tree';
    filesStore.setSidebarViewMode(newMode);
    // Refresh file tree: tree mode shows all files, list mode shows only .md
    if (folderPath) refreshFileTree(folderPath);
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
      contentSearchResults = [];
    }
  }

  // --------------- Content search (BM25) ---------------
  interface ContentSearchResult {
    filePath: string;
    heading?: string;
    preview: string;
    score: number;
    offset: number;
  }
  let contentSearchResults: ContentSearchResult[] = $state([]);
  let contentSearchTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (searchQuery.length >= 2) {
      clearTimeout(contentSearchTimer);
      contentSearchTimer = setTimeout(() => doContentSearch(), 300);
    } else {
      contentSearchResults = [];
    }
  });

  /** Highlight search keywords in text by wrapping in <mark> tags */
  function highlightKeywords(text: string, query: string): string {
    if (!query) return escapeHtml(text);
    const escaped = escapeHtml(text);
    // Collect terms: full query + whitespace-split words + individual CJK chars
    const terms = new Set<string>();
    const q = query.trim();
    if (q.length >= 2) terms.add(q);
    for (const w of q.split(/\s+/)) {
      if (w.length >= 2) terms.add(w);
    }
    for (const ch of q) {
      if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(ch)) terms.add(ch);
    }
    if (terms.size === 0) return escaped;
    // Sort by length descending so longer matches take priority
    const sorted = [...terms].sort((a, b) => b.length - a.length);
    const pattern = sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    try {
      return escaped.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
    } catch {
      return escaped;
    }
  }

  function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function doContentSearch() {
    const fsState = filesStore.getState();
    const kb = fsState.knowledgeBases.find((k) => k.id === fsState.activeKnowledgeBaseId);
    if (!kb) return;
    try {
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
      contentSearchResults = results.map((r) => ({
        filePath: r.file_path,
        heading: r.heading ?? undefined,
        preview: r.preview,
        score: r.score,
        offset: r.offset,
      }));
    } catch {
      contentSearchResults = [];
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
  // In tree mode, show reserved directories (with visual differentiation); in list mode, hide them.
  let filteredTree = $derived(pinMorayaMd(filterTree(viewMode === 'tree' ? fileTree : filterReserved(fileTree), searchQuery)));
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

  /**
   * Open an inline "New File" input at the target folder — nothing is
   * created on disk until the user submits a non-empty name (Enter);
   * Escape/blur cancels with zero side effects. Mirrors `handleNewFolder()`.
   * Does NOT auto-open the created file in the editor — the user clicks the
   * new sidebar entry to open it, same as any other file.
   */
  function handleNewFile() {
    const dirPath = contextMenu.targetType === 'folder'
      ? contextMenu.targetPath
      : contextMenu.targetType === 'file'
        ? contextMenu.targetPath.substring(0, contextMenu.targetPath.lastIndexOf('/'))
        : folderPath;

    if (!dirPath) return;

    // Auto-expand the target directory so the inline input is visible
    if (dirPath !== folderPath && !expandedDirs.has(dirPath)) {
      expandedDirs = new Set([...expandedDirs, dirPath]);
    }
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

    // Auto-expand the target directory so the inline input is visible
    if (dirPath !== folderPath && !expandedDirs.has(dirPath)) {
      expandedDirs = new Set([...expandedDirs, dirPath]);
    }
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

  async function handleIndexAll() {
    if (!folderPath) return;
    try {
      const { getEmbeddingConfig, indexKnowledgeBase } = await import('$lib/services/kb');
      const config = getEmbeddingConfig();
      if (!config) {
        // Notify user: need to configure embedding provider
        if (onOpenSettings) onOpenSettings('knowledge-base');
        return;
      }
      console.log('[KB] Starting index all:', folderPath, JSON.stringify(config));
      const status = await indexKnowledgeBase(folderPath, config);
      console.log('[KB] Index complete:', JSON.stringify(status));
    } catch (e: any) {
      console.error('[KB] Index all FAILED:', typeof e === 'string' ? e : e?.message || JSON.stringify(e));
    }
  }

  async function handleIndexFile() {
    if (!folderPath || !contextMenu.targetPath) return;
    try {
      const { getEmbeddingConfig, indexSingleFile } = await import('$lib/services/kb');
      const config = getEmbeddingConfig();
      if (!config) {
        if (onOpenSettings) onOpenSettings('knowledge-base');
        return;
      }
      console.log('[KB] Indexing file:', contextMenu.targetPath);
      await indexSingleFile(folderPath, contextMenu.targetPath, config);
      console.log('[KB] File indexed');
    } catch (e) {
      console.error('[KB] Index file failed:', e);
    }
  }

  function handleRename() {
    const name = contextMenu.targetName;
    // In tree mode, show full name including extension; in list mode, hide the
    // document extension (either flavor) — it is re-appended on submit.
    const ext = documentExtension(name);
    const displayName = viewMode === 'tree' ? name : (ext ? name.slice(0, -ext.length) : name);
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

  /** Close the inline input without applying an edit — nothing was created/renamed. */
  function cancelInputDialog() {
    inputDialog = null;
  }

  async function submitInputDialog() {
    if (!inputDialog) return;
    const value = inputDialog.value.trim();
    if (!value) {
      cancelInputDialog();
      return;
    }

    if (inputDialog.mode === 'new-folder') {
      // Reject reserved directory name "images"
      if (value.toLowerCase() === 'images') {
        await message($t('sidebar.reserved_dir_name'), { title: $t('sidebar.reserved_dir_title'), kind: 'warning' });
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
    } else if (inputDialog.mode === 'new-file') {
      // create_markdown_file errors (rather than silently overwriting) on a
      // name collision — left as a console warning + the input just closes,
      // matching new-folder's existing error handling above.
      try {
        await invoke<string>('create_markdown_file', { dirPath: inputDialog.targetPath, fileName: value });
        if (folderPath) await refreshFileTree(folderPath);
      } catch (e) {
        console.warn('Failed to create file:', e);
      }
      // Do NOT auto-open — the user clicks the new sidebar entry to open it,
      // same as any other file.
    } else {
      // mode === 'rename'
      const oldPath = inputDialog.targetPath;
      // In list mode, re-append the original document extension (.md or .typ)
      // since the user edited the name without seeing it. In tree mode the full
      // name including extension was shown — use as-is.
      const oldExt = documentExtension(oldPath);
      const finalValue = viewMode === 'tree' ? value : (oldExt ? `${value}${oldExt}` : value);
      // Reject renaming a directory to the reserved name "images"
      const isDir = !oldExt;
      if (isDir && finalValue.toLowerCase() === 'images') {
        await message($t('sidebar.reserved_dir_name'), { title: $t('sidebar.reserved_dir_title'), kind: 'warning' });
        inputDialog = null;
        return;
      }
      const oldName = getFileName(oldPath);
      if (finalValue !== oldName) {
        const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/'));
        const newPath = `${parentDir}/${finalValue}`;
        try {
          await invoke('rename_file', { oldPath, newPath });
          // v1.21.0: keep local version history attached (best-effort; works
          // for files and directories alike since .versions mirrors the tree)
          renameVersionsDir(oldPath, newPath);
          if (folderPath) await refreshFileTree(folderPath);
          onRename?.(oldPath, newPath);
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
      cancelInputDialog();
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
      $t('sidebar.delete_confirm').replace('{name}', name),
      { title: $t('sidebar.context_menu.delete'), kind: 'warning' }
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
            // v1.21.0: move the file's local version history along (best-effort)
            renameVersionsDir(filePath, `${target}/${fileName}`);
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
      $t('sidebar.history.restore_confirm'),
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
    <button class="kb-switcher" onclick={toggleKBDropdown} title={$t('knowledge_base.switch_to')}>
      <span class="kb-switcher-name">{getActiveKBName()}</span>
      <svg class="kb-chevron" class:open={showKBDropdown} width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
        <path d="M4.427 6.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 6H4.604a.25.25 0 00-.177.427z"/>
      </svg>
    </button>
    {#if activeKbBound}
      {@const status = kbSyncStatus(activeKBId ?? '')}
      <button
        class="kb-sync-btn"
        class:syncing={status === 'syncing'}
        class:error={status === 'error'}
        class:conflict={status === 'conflict'}
        onclick={triggerSyncActiveKb}
        disabled={status === 'syncing'}
        title={$t('kb_sync.sync_now')}
      >
        <!-- Wrap icon in inner span so the breathing animation only affects the
             glyph, not the button border. -->
        <span class="kb-sync-btn-icon" class:breathing={status === 'syncing'}>
          <svg width="13" height="13" viewBox="8 6 16 20" fill="none" aria-hidden="true"><path d="M9.5 7.5v17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="14" r="6.5" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="14" r="2.4" fill="currentColor"/></svg>
        </span>
      </button>
    {/if}
    {#if showKBDropdown}
      <div class="kb-dropdown">
        {#each knowledgeBases as kb (kb.id)}
          {@const status = kbSyncStatus(kb.id)}
          <div class="kb-dropdown-row" class:active={kb.id === activeKBId}>
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
              {#if kb.picoraBinding}
                <span
                  class="kb-sync-badge"
                  class:syncing={status === 'syncing'}
                  class:error={status === 'error'}
                  class:conflict={status === 'conflict'}
                  title={$t('kb_sync.statusbar.tooltip')}
                ><svg width="10" height="10" viewBox="8 6 16 20" fill="none" style="vertical-align:-1px;display:inline-block" aria-hidden="true"><path d="M9.5 7.5v17" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="14" r="6.5" stroke="currentColor" stroke-width="3"/><circle cx="16" cy="14" r="2.4" fill="currentColor"/></svg>{status === 'error' ? ' ✗' : status === 'conflict' ? ' ⚠' : ''}</span>
              {/if}
            </button>
            {#if kb.picoraBinding}
              <button
                class="kb-mem-btn"
                title={$t('kb_sync.settings.memory_asset')}
                aria-label={$t('kb_sync.settings.memory_asset')}
                onclick={(e) => { e.stopPropagation(); showKBDropdown = false; memoryPanelKb = kb; }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>
              </button>
            {/if}
          </div>
        {/each}
        <div class="kb-dropdown-divider"></div>
        <button class="kb-dropdown-item kb-manage" onclick={() => { showKBDropdown = false; onOpenKBManager?.(); }}>
          {$t('knowledge_base.manage')}
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
          title={viewMode === 'tree' ? $t('sidebar.list_view') : $t('sidebar.tree_view')}
        >
          {#if viewMode === 'tree'}
            <!-- List/card view icon -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 1h4v4H1zm6 0h8v1.5H7zm0 2.5h6v1H7zM1 7h4v4H1zm6 0h8v1.5H7zm0 2.5h6v1H7z"/>
            </svg>
          {:else}
            <!-- Tree hierarchy icon -->
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 1h3v3H2V1zm0 5h3v3H2V6zm5 0h3v3H7V6zm0 5h3v3H7v-3zM3.5 4v2H3v1h.5V4zM3 7h4v.5H7V9h.5v2H7V9H3V7zm5 2v2h-.5V9H8z"/>
            </svg>
          {/if}
        </button>
      {/if}
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

  {#if showSearch && contentSearchResults.length > 0}
    <div class="content-search-results">
      <div class="content-search-label">{$t('command_palette.semantic_search')}</div>
      {#each contentSearchResults as result}
        <button class="content-search-item" onclick={() => onFileSelect(result.filePath, result.offset, searchQuery)}>
          <div class="csr-file">{result.filePath.split('/').pop()}</div>
          <div class="csr-preview">{#if result.heading}<span class="csr-heading">{result.heading}:</span> {/if}{@html highlightKeywords(result.preview, searchQuery)}</div>
        </button>
      {/each}
    </div>
  {/if}

  {#if showSaveAsKBHint && folderPath}
    <div class="kb-save-hint">
      <span>{$t('knowledge_base.save_hint')}</span>
      <div class="kb-save-hint-actions">
        <button class="kb-save-hint-btn" onclick={saveCurrentAsKB}>{$t('knowledge_base.save_as_kb')}</button>
        <button class="kb-save-hint-close" onclick={() => showSaveAsKBHint = false}>&times;</button>
      </div>
    </div>
  {/if}

  <LockIndicator
    lock={currentFileLock}
    {selfName}
    onForceUnlock={onForceUnlock}
    onViewReadonly={onViewReadonly}
  />

  <div class="sidebar-content" class:drop-root={dropTargetPath === folderPath && !!folderPath}>
    {#if knowledgeBases.length === 0}
      <!-- No knowledge bases created yet — prompt user to add one -->
      <div class="sidebar-empty">
        <p>{$t('sidebar.create_kb')}</p>
        <button class="open-btn" onclick={() => onOpenKBManager?.()}>{$t('knowledge_base.add')}</button>
      </div>
    {:else if fileTree.length === 0}
      <!-- KB bound but directory is empty. While the inline "new file/folder"
           input is open, render ONLY the input (at the top). Otherwise the
           flex-grown empty-state message fills the panel height and pushes the
           input down to the very bottom (the reported bug). -->
      {#if inputDialog && inputDialog.mode !== 'rename' && inputDialog.targetPath === folderPath}
        <div class="inline-rename" style="padding-inline-start: {viewMode === 'list' ? '1.75rem' : '0.75rem'}">
          <span class="tree-icon file-icon">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/></svg>
          </span>
          <input
            bind:this={inputDialogEl}
            type="text"
            class="inline-rename-input"
            placeholder={inputDialog.mode === 'new-folder' ? $t('sidebar.new_folder_prompt') : $t('sidebar.untitled_file_name')}
            bind:value={inputDialog.value}
            onkeydown={handleInputDialogKeydown}
            onblur={cancelInputDialog}
          />
        </div>
      {:else}
        <div class="sidebar-empty">
          <p>{$t('sidebar.empty_dir')}</p>
        </div>
      {/if}
    {:else if viewMode === 'list'}
      <!-- List View: hierarchical tree with folders and file previews -->
      <div class="list-view">
        {#each filteredTree as entry}
          {@render listItem(entry, 0)}
        {/each}
        {#if inputDialog && inputDialog.mode !== 'rename' && inputDialog.targetPath === folderPath}
          <div class="inline-rename" style="padding-inline-start: 1.75rem">
            <span class="tree-icon file-icon">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/></svg>
            </span>
            <input
              bind:this={inputDialogEl}
              type="text"
              class="inline-rename-input"
              placeholder={inputDialog.mode === 'new-folder' ? $t('sidebar.new_folder_prompt') : $t('sidebar.untitled_file_name')}
              bind:value={inputDialog.value}
              onkeydown={handleInputDialogKeydown}
              onblur={cancelInputDialog}
            />
          </div>
        {/if}
      </div>
    {:else}
      <!-- Tree View -->
      {#each filteredTree as entry}
        {@render fileTreeItem(entry, 0)}
      {/each}
      {#if inputDialog && inputDialog.mode !== 'rename' && inputDialog.targetPath === folderPath}
        <div class="inline-rename" style="padding-inline-start: 0.75rem">
          <span class="tree-icon file-icon">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/></svg>
          </span>
          <input
            bind:this={inputDialogEl}
            type="text"
            class="inline-rename-input"
            placeholder={inputDialog.mode === 'new-folder' ? $t('sidebar.new_folder_prompt') : $t('sidebar.untitled_file_name')}
            bind:value={inputDialog.value}
            onkeydown={handleInputDialogKeydown}
            onblur={cancelInputDialog}
          />
        </div>
      {/if}
    {/if}
  </div>
</div>

{#if memoryPanelKb}
  <KbMemoryAssetDialog kb={memoryPanelKb} onClose={() => (memoryPanelKb = null)} />
{/if}

{#snippet fileTreeItem(entry: FileEntry, depth: number)}
  {#if inputDialog?.mode === 'rename' && inputDialog.targetPath === entry.path}
    <div class="inline-rename" style="padding-inline-start: {0.75 + depth * 1}rem">
      {#if entry.is_dir}
        <span class="tree-icon expanded">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg>
        </span>
      {:else}
        <span class="tree-icon file-icon">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/></svg>
        </span>
      {/if}
      <input
        bind:this={inputDialogEl}
        type="text"
        class="inline-rename-input"
        bind:value={inputDialog.value}
        onkeydown={handleInputDialogKeydown}
        onblur={cancelInputDialog}
      />
    </div>
  {:else}
    <button
      class="tree-item"
      class:is-dir={entry.is_dir}
      class:reserved-dir={entry.is_dir && isReservedDir(entry)}
      class:drop-target={entry.is_dir && dropTargetPath === entry.path}
      style="padding-inline-start: {0.75 + depth * 1}rem"
      title={entry.is_dir ? undefined : entry.name}
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
        {@const ext = getFileExt(entry.name)}
        <span class="tree-icon file-icon file-ext-{ext || 'default'}">
          {#if ext === 'md' || ext === 'markdown'}
            <!-- Markdown icon -->
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.6"><path d="M1.5 2.5h9v7h-9v-7zm1 1v5h1.5l1.5-2 1.5 2H8.5v-5H7v3l-1.5-2L4 8.5V3.5z"/></svg>
          {:else if ext === 'json' || ext === 'yaml' || ext === 'yml' || ext === 'toml'}
            <!-- Config icon -->
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.6"><path d="M4 1C2.5 1 2 2 2 3v1.5C2 5.3 1.3 5.5 1 5.5v1c.3 0 1 .2 1 1V9c0 1 .5 2 2 2h1V10H4c-.5 0-1-.2-1-1V7.5C3 6.8 2.5 6.3 2.2 6c.3-.3.8-.8.8-1.5V3c0-.8.5-1 1-1h1V1zm4 0c1.5 0 2 1 2 2v1.5c0 .8.7 1 1 1v1c-.3 0-1 .2-1 1V9c0 1-.5 2-2 2H7v-1h1c.5 0 1-.2 1-1V7.5c0-.7.5-1.2.8-1.5-.3-.3-.8-.8-.8-1.5V3c0-.8-.5-1-1-1H7V1z"/></svg>
          {:else if ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx' || ext === 'svelte' || ext === 'vue'}
            <!-- Code icon -->
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.6"><path d="M4.5 2.5L1.5 6l3 3.5L3.5 10.5 0 6l3.5-4.5zm3 0L11 6 7.5 10.5 8.5 9.5 11 6 8.5 2.5z"/><path d="M5 10l2-8 .8.2-2 8z"/></svg>
          {:else if ext === 'html' || ext === 'htm' || ext === 'css' || ext === 'scss'}
            <!-- Web icon -->
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.6"><path d="M1 2h10v8H1V2zm1 1v6h8V3H2zm1 1h2v1H3zm0 2h4v1H3z"/></svg>
          {:else if ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'svg' || ext === 'webp' || ext === 'ico'}
            <!-- Image icon -->
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.6"><path d="M1 2h10v8H1V2zm1 1v4.5l2-2 2 2 1.5-1.5L10 8.5V3H2zm2.5 1a1 1 0 100 2 1 1 0 000-2z"/></svg>
          {:else}
            <!-- Default document icon -->
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/></svg>
          {/if}
        </span>
      {/if}
      <span class="tree-name" class:moraya-rule={!entry.is_dir && entry.name === 'MORAYA.md'}>
        {entry.is_dir ? entry.name : getDisplayName(entry.name)}
      </span>
    </button>
  {/if}

  {#if entry.is_dir && entry.children && expandedDirs.has(entry.path)}
    {#each entry.children as child}
      {@render fileTreeItem(child, depth + 1)}
    {/each}
    {#if inputDialog && inputDialog.mode !== 'rename' && inputDialog.targetPath === entry.path}
      <div class="inline-rename" style="padding-inline-start: {0.75 + (depth + 1) * 1}rem">
        <span class="tree-icon file-icon">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/></svg>
        </span>
        <input
          bind:this={inputDialogEl}
          type="text"
          class="inline-rename-input"
          placeholder={inputDialog.mode === 'new-folder' ? $t('sidebar.new_folder_prompt') : $t('sidebar.untitled_file_name')}
          bind:value={inputDialog.value}
          onkeydown={handleInputDialogKeydown}
          onblur={cancelInputDialog}
        />
      </div>
    {/if}
  {/if}
{/snippet}

{#snippet listItem(entry: FileEntry, depth: number)}
  {#if entry.is_dir}
    {#if inputDialog?.mode === 'rename' && inputDialog.targetPath === entry.path}
      <div class="inline-rename" style="padding-inline-start: {0.75 + depth}rem">
        <span class="tree-icon expanded">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg>
        </span>
        <input
          bind:this={inputDialogEl}
          type="text"
          class="inline-rename-input"
          bind:value={inputDialog.value}
          onkeydown={handleInputDialogKeydown}
          onblur={cancelInputDialog}
        />
      </div>
    {:else}
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
    {/if}
    {#if expandedDirs.has(entry.path) && entry.children}
      {#each entry.children.filter(c => !isReservedDir(c)) as child}
        {@render listItem(child, depth + 1)}
      {/each}
      {#if inputDialog && inputDialog.mode !== 'rename' && inputDialog.targetPath === entry.path}
        <div class="inline-rename" style="padding-inline-start: {0.75 + depth + 1}rem">
          <span class="tree-icon file-icon">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/></svg>
          </span>
          <input
            bind:this={inputDialogEl}
            type="text"
            class="inline-rename-input"
            placeholder={inputDialog.mode === 'new-folder' ? $t('sidebar.new_folder_prompt') : $t('sidebar.untitled_file_name')}
            bind:value={inputDialog.value}
            onkeydown={handleInputDialogKeydown}
            onblur={cancelInputDialog}
          />
        </div>
      {/if}
    {/if}
  {:else}
    {#if inputDialog?.mode === 'rename' && inputDialog.targetPath === entry.path}
      <div class="inline-rename" style="padding-inline-start: {0.75 + depth + 1}rem">
        <span class="tree-icon file-icon">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5"><path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/></svg>
        </span>
        <input
          bind:this={inputDialogEl}
          type="text"
          class="inline-rename-input"
          bind:value={inputDialog.value}
          onkeydown={handleInputDialogKeydown}
          onblur={cancelInputDialog}
        />
      </div>
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
    onIndexAll={handleIndexAll}
    onIndexFile={handleIndexFile}
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

  .content-search-results {
    border-bottom: 1px solid var(--border-light);
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: none; /* Firefox */
  }

  .content-search-results::-webkit-scrollbar {
    display: none; /* Chrome/Safari/WebKit */
  }

  .content-search-label {
    font-size: 10px;
    color: var(--text-muted);
    padding: 6px 12px 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .content-search-item {
    display: block;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    text-align: left;
    cursor: pointer;
    width: 100%;
    box-sizing: border-box;
    overflow: hidden;
    border-bottom: 1px solid var(--border-light);
  }

  .content-search-item:hover {
    background: var(--bg-hover);
  }

  .csr-file {
    color: var(--text-primary);
    font-weight: 600;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .csr-heading {
    color: var(--text-muted);
    font-size: 11px;
  }

  .csr-preview {
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.5;
    margin-top: 3px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-all;
  }

  .csr-preview :global(mark) {
    background: rgba(255, 200, 0, 0.4);
    color: inherit;
    padding: 0 1px;
    border-radius: 2px;
  }

  .inline-rename {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding-block: 0.15rem;
    padding-inline-end: 0.5rem;
    min-height: 28px;
  }

  .inline-rename-input {
    flex: 1;
    min-width: 0;
    padding: 0.15rem 0.3rem;
    border: 1px solid var(--accent-color);
    border-radius: 3px;
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

  /* Reserved directory (e.g. images/) — dimmed with accent tint */
  .tree-item.reserved-dir {
    opacity: 0.55;
  }
  .tree-item.reserved-dir .tree-name {
    font-style: italic;
  }

  /* File type icon colors (tree mode) */
  .file-icon.file-ext-md,
  .file-icon.file-ext-markdown { color: #519aba; }
  .file-icon.file-ext-json { color: #cbcb41; }
  .file-icon.file-ext-yaml,
  .file-icon.file-ext-yml,
  .file-icon.file-ext-toml { color: #a074c4; }
  .file-icon.file-ext-js,
  .file-icon.file-ext-jsx { color: #cbcb41; }
  .file-icon.file-ext-ts,
  .file-icon.file-ext-tsx { color: #519aba; }
  .file-icon.file-ext-svelte,
  .file-icon.file-ext-vue { color: #e34c26; }
  .file-icon.file-ext-html,
  .file-icon.file-ext-htm { color: #e34c26; }
  .file-icon.file-ext-css,
  .file-icon.file-ext-scss { color: #563d7c; }
  .file-icon.file-ext-png,
  .file-icon.file-ext-jpg,
  .file-icon.file-ext-jpeg,
  .file-icon.file-ext-gif,
  .file-icon.file-ext-svg,
  .file-icon.file-ext-webp,
  .file-icon.file-ext-ico { color: #a074c4; }

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

  .kb-dropdown-row {
    display: flex;
    align-items: center;
  }
  .kb-dropdown-row:hover {
    background: var(--bg-hover);
  }
  .kb-dropdown-row .kb-dropdown-item:hover {
    background: transparent;
  }

  .kb-mem-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 1.6rem;
    height: 1.6rem;
    margin-right: 0.35rem;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--transition-fast, 0.12s), background var(--transition-fast, 0.12s);
  }
  .kb-dropdown-row:hover .kb-mem-btn { opacity: 1; }
  .kb-mem-btn:hover {
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .kb-dropdown-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.5rem;
    border: none;
    /* Kill the native macOS WKWebView push-button chrome (rounded grey box) —
       without this the standalone "manage" button renders its native look. */
    appearance: none;
    -webkit-appearance: none;
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
    width: 100%;
    box-sizing: border-box;
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
  }
  .kb-dropdown-item.kb-manage:hover {
    background: var(--bg-hover);
  }

  .kb-check-spacer {
    display: inline-block;
    width: 12px;
  }

  .kb-dropdown-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 0 1 auto;
    min-width: 0;
  }

  /* Sync badge in dropdown — shows ☁ icon next to KBs with Picora binding */
  .kb-sync-badge {
    display: inline-block;
    margin-left: 0.4rem;
    font-size: 0.85em;
    color: var(--color-success, #38a169);
    flex-shrink: 0;
    line-height: 1;
    transform-origin: center;
  }
  .kb-sync-badge.syncing { color: var(--accent-color); animation: kb-sync-breathe 1.6s ease-in-out infinite; }
  .kb-sync-badge.error { color: var(--color-error, #e53e3e); }
  .kb-sync-badge.conflict { color: var(--warning-color, #e8a838); }

  /* Manual sync button next to KB switcher */
  .kb-sync-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 0.25rem;
    padding: 0 0.35rem;
    height: 1.5rem;
    border: 1px solid var(--border-light);
    background: transparent;
    color: var(--color-success, #38a169);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85rem;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  .kb-sync-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--color-success, #38a169);
  }
  .kb-sync-btn:disabled { cursor: not-allowed; opacity: 0.7; }
  .kb-sync-btn.syncing { color: var(--accent-color); border-color: var(--accent-color); }
  .kb-sync-btn.error { color: var(--color-error, #e53e3e); border-color: var(--color-error, #e53e3e); }
  .kb-sync-btn.conflict { color: var(--warning-color, #e8a838); border-color: var(--warning-color, #e8a838); }

  /* Inner-span breathing — pulses the glyph (opacity + scale + accent glow),
     leaving the button border still. */
  .kb-sync-btn-icon {
    display: inline-block;
    line-height: 1;
    transform-origin: center;
  }
  .kb-sync-btn-icon.breathing { animation: kb-sync-breathe 1.6s ease-in-out infinite; }

  /* Breathing-light effect for the "syncing" state. Opacity + subtle scale
     give the pulse; the drop-shadow adds a soft accent halo that swells and
     fades like a breathing indicator light. */
  @keyframes kb-sync-breathe {
    0%, 100% {
      opacity: 0.45;
      transform: scale(0.9);
      filter: drop-shadow(0 0 0 transparent);
    }
    50% {
      opacity: 1;
      transform: scale(1.1);
      filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent-color) 55%, transparent));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .kb-sync-btn-icon.breathing,
    .kb-sync-badge.syncing {
      animation: none;
      opacity: 0.75;
    }
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

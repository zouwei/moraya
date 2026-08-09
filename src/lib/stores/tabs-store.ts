import { writable, get } from 'svelte/store';
import { isTypstFile } from '@moraya/core/typst';
import { editorStore } from './editor-store';

export interface TabItem {
  id: string;
  filePath: string | null;
  fileName: string;
  content: string;
  isDirty: boolean;
  cursorOffset: number;
  scrollFraction: number;
  lastMtime: number | null;
  /** When true, the tab displays an image preview instead of the editor. */
  isImage?: boolean;
  /** When true, the tab is a read-only document-version preview: content is
   *  shown in the editor but editing is blocked, and its state is never synced
   *  back from the editor (see syncFromEditor). filePath is null (no real file). */
  readOnly?: boolean;
  /** Dedupe key for read-only preview tabs (e.g. `${filePath}#${snapshotFile}`
   *  or `${filePath}#cloud:${revId}`). Reopening the same version focuses the
   *  existing tab instead of creating a duplicate. */
  previewKey?: string;
  /** Document flavor. `undefined`/`'markdown'` → the ProseMirror editor;
   *  `'typst'` → the source + live-preview TypstEditor (mutually exclusive —
   *  a document is edited as EITHER markdown or Typst, never both). Detected by
   *  the `.typ` file extension at open time. */
  flavor?: 'markdown' | 'typst';
}

interface TabsState {
  tabs: TabItem[];
  activeTabId: string;
}

let nextId = 1;

function generateTabId(): string {
  return `tab-${nextId++}`;
}

function createTabsStore() {
  const initialTab: TabItem = {
    id: generateTabId(),
    filePath: null,
    fileName: 'Untitled',
    content: '',
    isDirty: false,
    cursorOffset: 0,
    scrollFraction: 0,
    lastMtime: null,
  };

  const { subscribe, set, update } = writable<TabsState>({
    tabs: [initialTab],
    activeTabId: initialTab.id,
  });

  /**
   * Reads the LIVE document out of the mounted editor.
   *
   * `editorStore.content` is not a reliable mirror of what the user has typed.
   * The visual-only editor is mounted without `onContentChange`, so it takes
   * the cheap `onDocChanged` path that only marks the document dirty — no
   * markdown is serialized per keystroke, and the text exists solely in the
   * ProseMirror doc until something calls `getFullMarkdown()`. Saving reads the
   * live doc, so files on disk were always correct; it was `syncFromEditor`,
   * reading the stale mirror, that wrote pre-edit text back into a tab. The
   * next switch loaded it into the editor and the following save — autosave
   * included — put it on disk, reverting the document.
   *
   * Injected rather than imported so the store keeps no editor dependency; the
   * host registers `getCurrentContent` once at mount.
   */
  let liveContent: (() => string) | null = null;

  /** Save current editor state into the active tab */
  function syncFromEditor() {
    const s = get({ subscribe });
    const activeTab = s.tabs.find(t => t.id === s.activeTabId);
    // Image tabs have no editor state to sync; read-only version previews must
    // never absorb editor state (their content is a fixed historical snapshot).
    if (activeTab?.isImage || activeTab?.readOnly) return;
    const edState = editorStore.getState();
    // Fall back to the mirror when no editor is mounted (secondary windows,
    // cold start, tests).
    const content = liveContent ? liveContent() : edState.content;
    update(state => ({
      ...state,
      tabs: state.tabs.map(tab =>
        tab.id === state.activeTabId
          ? {
              ...tab,
              content,
              isDirty: edState.isDirty,
              filePath: edState.currentFilePath,
              cursorOffset: edState.cursorOffset,
              scrollFraction: edState.scrollFraction,
            }
          : tab
      ),
    }));
    // Keep the mirror honest for every other reader of editorStore.content.
    if (content !== edState.content) editorStore.setContent(content);
  }

  /** Restore a tab's state into the editor.
   *  Uses batchRestore for a single store notification instead of 5 separate updates.
   *  Image tabs have no editor state — skip. */
  function syncToEditor(tab: TabItem) {
    if (tab.isImage) return;
    editorStore.batchRestore({
      filePath: tab.filePath,
      content: tab.content,
      isDirty: tab.isDirty,
      cursorOffset: tab.cursorOffset,
      scrollFraction: tab.scrollFraction,
    });
  }

  return {
    subscribe,

    /** Save current editor state into the active tab (public for pre-sync before external editorStore changes) */
    syncFromEditor,

    /** Initialize the first tab with content (called on mount) */
    initWithContent(
      content: string,
      filePath: string | null,
      fileName: string,
      flavor?: 'markdown' | 'typst',
    ) {
      // Prefer the explicitly transferred flavor (a detached unsaved Typst
      // document has no `.typ` path to infer from); fall back to the name.
      const resolved = flavor ?? (isTypstFile(fileName) ? 'typst' : undefined);
      update(state => ({
        ...state,
        tabs: state.tabs.map(tab =>
          tab.id === state.activeTabId
            ? {
                ...tab,
                content,
                filePath,
                fileName,
                isDirty: false,
                flavor: resolved === 'markdown' ? undefined : resolved,
              }
            : tab
        ),
      }));
    },

    /** Add a new empty tab */
    addTab(opts?: { flavor?: 'markdown' | 'typst'; content?: string; fileName?: string }): string {
      syncFromEditor();
      const newTab: TabItem = {
        id: generateTabId(),
        filePath: null,
        fileName: opts?.fileName ?? 'Untitled',
        content: opts?.content ?? '',
        isDirty: false,
        cursorOffset: 0,
        scrollFraction: 0,
        lastMtime: null,
        flavor: opts?.flavor,
      };
      update(state => ({
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
      }));
      syncToEditor(newTab);
      return newTab.id;
    },

    /** Open a file in a new tab or switch to existing tab if already open.
     *  When skipSync is true, skip syncFromEditor() — caller has already synced
     *  or editorStore has been modified by loadFile()/openFile() before this call.
     *  When isImage is true, the tab renders an image preview instead of the editor. */
    openFileTab(filePath: string, fileName: string, content: string, mtime?: number | null, skipSync = false, isImage = false): string {
      const state = get({ subscribe });
      // Check if file is already open in a tab
      const existing = state.tabs.find(t => t.filePath === filePath);
      if (existing) {
        // Switch to existing tab
        if (!skipSync) syncFromEditor();
        update(s => ({ ...s, activeTabId: existing.id }));
        syncToEditor(existing);
        return existing.id;
      }
      // Create new tab
      if (!skipSync) syncFromEditor();
      const newTab: TabItem = {
        id: generateTabId(),
        filePath,
        fileName,
        content,
        isDirty: false,
        cursorOffset: 0,
        scrollFraction: 0,
        lastMtime: mtime ?? null,
        isImage,
        // Flavor is decided by extension, shared with Web/Mobile via core so
        // every entry point agrees on what a `.typ` file is.
        flavor: isTypstFile(fileName) ? 'typst' : undefined,
      };
      update(s => ({
        tabs: [...s.tabs, newTab],
        activeTabId: newTab.id,
      }));
      syncToEditor(newTab);
      return newTab.id;
    },

    /** Open a document version in a new READ-ONLY preview tab, or focus the
     *  existing preview if this version is already open (deduped by previewKey).
     *  filePath is null so it never collides with real files or triggers saves/
     *  version snapshots. fileName is the tab label (e.g. "note.md #3"). */
    openReadOnlyTab(previewKey: string, fileName: string, content: string): string {
      const state = get({ subscribe });
      const existing = state.tabs.find(t => t.previewKey === previewKey);
      if (existing) {
        syncFromEditor();
        update(s => ({ ...s, activeTabId: existing.id }));
        syncToEditor(existing);
        return existing.id;
      }
      syncFromEditor();
      const newTab: TabItem = {
        id: generateTabId(),
        filePath: null,
        fileName,
        content,
        isDirty: false,
        cursorOffset: 0,
        scrollFraction: 0,
        lastMtime: null,
        readOnly: true,
        previewKey,
      };
      update(s => ({
        tabs: [...s.tabs, newTab],
        activeTabId: newTab.id,
      }));
      syncToEditor(newTab);
      return newTab.id;
    },

    /** Switch to a specific tab */
    switchTab(tabId: string) {
      const state = get({ subscribe });
      if (tabId === state.activeTabId) return;
      const target = state.tabs.find(t => t.id === tabId);
      if (!target) return;
      syncFromEditor();
      update(s => ({ ...s, activeTabId: tabId }));
      syncToEditor(target);
    },

    /** Close a tab. Returns true if closed, false if cancelled */
    closeTab(tabId: string): boolean {
      const state = get({ subscribe });
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab) return false;

      // Last tab: replace with a new empty tab
      if (state.tabs.length <= 1) {
        const newTab: TabItem = {
          id: generateTabId(),
          filePath: null,
          fileName: 'Untitled',
          content: '',
          isDirty: false,
          cursorOffset: 0,
          scrollFraction: 0,
          lastMtime: null,
        };
        set({ tabs: [newTab], activeTabId: newTab.id });
        syncToEditor(newTab);
        return true;
      }

      // If closing the active tab, switch to an adjacent tab first
      if (tabId === state.activeTabId) {
        const idx = state.tabs.findIndex(t => t.id === tabId);
        const nextIdx = idx > 0 ? idx - 1 : 1;
        const nextTab = state.tabs[nextIdx];
        syncToEditor(nextTab);
        update(s => ({
          tabs: s.tabs.filter(t => t.id !== tabId),
          activeTabId: nextTab.id,
        }));
      } else {
        update(s => ({
          ...s,
          tabs: s.tabs.filter(t => t.id !== tabId),
        }));
      }
      return true;
    },

    /** Rename a tab's file path after a file rename on disk. */
    renameTabFile(oldPath: string, newPath: string, newFileName: string) {
      update(state => ({
        ...state,
        tabs: state.tabs.map(tab =>
          tab.filePath === oldPath
            ? { ...tab, filePath: newPath, fileName: newFileName }
            : tab
        ),
      }));
    },

    /** Update the active tab's file info after a save */
    updateActiveFile(filePath: string, fileName: string, mtime?: number | null) {
      update(state => ({
        ...state,
        tabs: state.tabs.map(tab =>
          tab.id === state.activeTabId
            ? { ...tab, filePath, fileName, isDirty: false, lastMtime: mtime ?? tab.lastMtime }
            : tab
        ),
      }));
    },

    /** Update a tab's mtime (e.g. after choosing "keep local" on conflict) */
    updateTabMtime(tabId: string, mtime: number) {
      update(state => ({
        ...state,
        tabs: state.tabs.map(tab =>
          tab.id === tabId ? { ...tab, lastMtime: mtime } : tab
        ),
      }));
    },

    /** Update a tab's content and mtime after external reload */
    updateTabContent(tabId: string, content: string, mtime: number) {
      update(state => ({
        ...state,
        tabs: state.tabs.map(tab =>
          tab.id === tabId ? { ...tab, content, lastMtime: mtime, isDirty: false } : tab
        ),
      }));
    },

    /** Sync dirty state from editor to active tab */
    syncDirty(isDirty: boolean) {
      update(state => ({
        ...state,
        tabs: state.tabs.map(tab =>
          tab.id === state.activeTabId
            ? { ...tab, isDirty }
            : tab
        ),
      }));
    },

    /** Insert a tab at a specific index (used for cross-window tab transfer).
     *  Returns the new tab's id. */
    insertTabAt(index: number, filePath: string | null, fileName: string, content: string, isDirty: boolean, mtime?: number | null, flavor?: 'markdown' | 'typst'): string {
      syncFromEditor();
      // Prefer the transferred flavor; fall back to the file name so tabs that
      // arrive without one (older payload) still resolve correctly.
      const resolved = flavor ?? (isTypstFile(fileName) ? 'typst' : undefined);
      const newTab: TabItem = {
        id: generateTabId(),
        filePath,
        fileName,
        content,
        isDirty,
        cursorOffset: 0,
        scrollFraction: 0,
        lastMtime: mtime ?? null,
        flavor: resolved === 'markdown' ? undefined : resolved,
      };
      update(state => {
        const tabs = [...state.tabs];
        const clampedIndex = Math.max(0, Math.min(index, tabs.length));
        tabs.splice(clampedIndex, 0, newTab);
        return { tabs, activeTabId: newTab.id };
      });
      syncToEditor(newTab);
      return newTab.id;
    },

    /** Remove a tab without creating an empty replacement (used for cross-window transfer).
     *  Returns false if tab not found or it's the only tab (use closeTab for that). */
    removeTab(tabId: string): boolean {
      const state = get({ subscribe });
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab) return false;
      const remaining = state.tabs.filter(t => t.id !== tabId);
      if (remaining.length === 0) return false;

      if (tabId === state.activeTabId) {
        const idx = state.tabs.findIndex(t => t.id === tabId);
        const nextIdx = idx > 0 ? idx - 1 : 0;
        const nextTab = remaining[Math.min(nextIdx, remaining.length - 1)];
        syncToEditor(nextTab);
        update(() => ({ tabs: remaining, activeTabId: nextTab.id }));
      } else {
        update(s => ({ ...s, tabs: remaining }));
      }
      return true;
    },

    /** Reorder tabs by moving a tab from one index to another */
    reorderTabs(fromIndex: number, toIndex: number) {
      if (fromIndex === toIndex) return;
      update(state => {
        const tabs = [...state.tabs];
        const [moved] = tabs.splice(fromIndex, 1);
        tabs.splice(toIndex, 0, moved);
        return { ...state, tabs };
      });
    },

    /**
     * Register the live-document reader (the host's `getCurrentContent`).
     * Pass null to detach — secondary windows and tests then fall back to
     * `editorStore.content`.
     */
    setContentProvider(fn: (() => string) | null) {
      liveContent = fn;
    },

    getState() {
      return get({ subscribe });
    },
  };
}

export const tabsStore = createTabsStore();

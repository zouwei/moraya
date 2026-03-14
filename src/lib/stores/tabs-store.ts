import { writable, get } from 'svelte/store';
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

  /** Save current editor state into the active tab */
  function syncFromEditor() {
    const edState = editorStore.getState();
    update(state => ({
      ...state,
      tabs: state.tabs.map(tab =>
        tab.id === state.activeTabId
          ? {
              ...tab,
              content: edState.content,
              isDirty: edState.isDirty,
              filePath: edState.currentFilePath,
              cursorOffset: edState.cursorOffset,
              scrollFraction: edState.scrollFraction,
            }
          : tab
      ),
    }));
  }

  /** Restore a tab's state into the editor.
   *  Uses batchRestore for a single store notification instead of 5 separate updates. */
  function syncToEditor(tab: TabItem) {
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
    initWithContent(content: string, filePath: string | null, fileName: string) {
      update(state => ({
        ...state,
        tabs: state.tabs.map(tab =>
          tab.id === state.activeTabId
            ? { ...tab, content, filePath, fileName, isDirty: false }
            : tab
        ),
      }));
    },

    /** Add a new empty tab */
    addTab(): string {
      syncFromEditor();
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
      update(state => ({
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
      }));
      syncToEditor(newTab);
      return newTab.id;
    },

    /** Open a file in a new tab or switch to existing tab if already open.
     *  When skipSync is true, skip syncFromEditor() — caller has already synced
     *  or editorStore has been modified by loadFile()/openFile() before this call. */
    openFileTab(filePath: string, fileName: string, content: string, mtime?: number | null, skipSync = false): string {
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

    getState() {
      return get({ subscribe });
    },
  };
}

export const tabsStore = createTabsStore();

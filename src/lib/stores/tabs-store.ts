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

  /** Restore a tab's state into the editor */
  function syncToEditor(tab: TabItem) {
    editorStore.setCurrentFile(tab.filePath);
    editorStore.setContent(tab.content);
    editorStore.setDirty(tab.isDirty);
    editorStore.setCursorOffset(tab.cursorOffset);
    editorStore.setScrollFraction(tab.scrollFraction);
  }

  return {
    subscribe,

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
      };
      update(state => ({
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
      }));
      syncToEditor(newTab);
      return newTab.id;
    },

    /** Open a file in a new tab or switch to existing tab if already open */
    openFileTab(filePath: string, fileName: string, content: string): string {
      const state = get({ subscribe });
      // Check if file is already open in a tab
      const existing = state.tabs.find(t => t.filePath === filePath);
      if (existing) {
        // Switch to existing tab
        syncFromEditor();
        update(s => ({ ...s, activeTabId: existing.id }));
        syncToEditor(existing);
        return existing.id;
      }
      // Create new tab
      syncFromEditor();
      const newTab: TabItem = {
        id: generateTabId(),
        filePath,
        fileName,
        content,
        isDirty: false,
        cursorOffset: 0,
        scrollFraction: 0,
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

      // Don't close the last tab
      if (state.tabs.length <= 1) return false;

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

    /** Update the active tab's file info after a save */
    updateActiveFile(filePath: string, fileName: string) {
      update(state => ({
        ...state,
        tabs: state.tabs.map(tab =>
          tab.id === state.activeTabId
            ? { ...tab, filePath, fileName, isDirty: false }
            : tab
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

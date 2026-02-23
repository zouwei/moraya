import { writable, get } from 'svelte/store';
import { load } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

export interface FilePreview {
  path: string;
  name: string;
  preview: string;
  modified: number; // seconds since UNIX epoch
}

export type SidebarViewMode = 'tree' | 'list';

export interface KnowledgeBase {
  id: string;
  name: string;
  path: string;
  lastAccessedAt: number;
}

interface FilesState {
  openFolderPath: string | null;
  fileTree: FileEntry[];
  recentFiles: string[];
  sidebarViewMode: SidebarViewMode;
  filePreviews: FilePreview[];
  knowledgeBases: KnowledgeBase[];
  activeKnowledgeBaseId: string | null;
}

const FILES_STORE_FILE = 'files-prefs.json';
const KB_STORE_FILE = 'knowledge-bases.json';

/** Persist sidebar view mode to disk so it survives across windows and restarts. */
let viewModePersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistViewMode(mode: SidebarViewMode) {
  if (viewModePersistTimer) clearTimeout(viewModePersistTimer);
  viewModePersistTimer = setTimeout(async () => {
    try {
      const store = await load(FILES_STORE_FILE);
      await store.set('sidebarViewMode', mode);
      await store.save();
    } catch { /* ignore persist errors */ }
  }, 200);
}

/** Persist knowledge base list to disk. */
let kbPersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistKnowledgeBases(kbs: KnowledgeBase[]) {
  if (kbPersistTimer) clearTimeout(kbPersistTimer);
  kbPersistTimer = setTimeout(async () => {
    try {
      const store = await load(KB_STORE_FILE);
      await store.set('knowledgeBases', kbs);
      await store.save();
    } catch { /* ignore persist errors */ }
  }, 200);
}

function createFilesStore() {
  const { subscribe, set, update } = writable<FilesState>({
    openFolderPath: null,
    fileTree: [],
    recentFiles: [],
    sidebarViewMode: 'list',
    filePreviews: [],
    knowledgeBases: [],
    activeKnowledgeBaseId: null,
  });

  return {
    subscribe,
    setOpenFolder(path: string, tree: FileEntry[]) {
      update(state => ({ ...state, openFolderPath: path, fileTree: tree }));
    },
    setFileTree(tree: FileEntry[]) {
      update(state => ({ ...state, fileTree: tree }));
    },
    setFilePreviews(previews: FilePreview[]) {
      update(state => ({ ...state, filePreviews: previews }));
    },
    setSidebarViewMode(mode: SidebarViewMode) {
      update(state => ({ ...state, sidebarViewMode: mode }));
      persistViewMode(mode);
    },
    addRecentFile(path: string) {
      update(state => {
        const recent = [path, ...state.recentFiles.filter(f => f !== path)].slice(0, 20);
        return { ...state, recentFiles: recent };
      });
    },
    clearFolder() {
      update(state => ({ ...state, openFolderPath: null, fileTree: [], filePreviews: [] }));
    },
    getState() {
      return get({ subscribe });
    },

    // ── Knowledge Base management ──

    addKnowledgeBase(kb: KnowledgeBase) {
      const isFirst = get({ subscribe }).knowledgeBases.length === 0;
      update(state => {
        const kbs = [...state.knowledgeBases, kb];
        persistKnowledgeBases(kbs);
        return {
          ...state,
          knowledgeBases: kbs,
          // Auto-activate the first KB added
          activeKnowledgeBaseId: state.activeKnowledgeBaseId ?? kb.id,
        };
      });
      // Load file tree for the first KB
      if (isFirst) {
        this.setActiveKnowledgeBase(kb.id);
      }
    },

    removeKnowledgeBase(id: string) {
      const wasActive = get({ subscribe }).activeKnowledgeBaseId === id;

      update(state => {
        const kbs = state.knowledgeBases.filter(kb => kb.id !== id);
        persistKnowledgeBases(kbs);

        // No KBs left — clear sidebar completely
        if (kbs.length === 0) {
          return {
            ...state,
            knowledgeBases: [],
            activeKnowledgeBaseId: null,
            openFolderPath: null,
            fileTree: [],
            filePreviews: [],
          };
        }

        // Removed a non-active KB — only update the list
        if (!wasActive) {
          return { ...state, knowledgeBases: kbs };
        }

        // Removed the active KB but others remain — switch to first
        return { ...state, knowledgeBases: kbs, activeKnowledgeBaseId: kbs[0].id };
      });

      // If switched to another KB, load its file tree
      const newState = get({ subscribe });
      if (newState.knowledgeBases.length > 0 && wasActive) {
        this.setActiveKnowledgeBase(newState.knowledgeBases[0].id);
      }
    },

    renameKnowledgeBase(id: string, name: string) {
      update(state => {
        const kbs = state.knowledgeBases.map(kb =>
          kb.id === id ? { ...kb, name } : kb
        );
        persistKnowledgeBases(kbs);
        return { ...state, knowledgeBases: kbs };
      });
    },

    async setActiveKnowledgeBase(id: string) {
      const state = get({ subscribe });
      const kb = state.knowledgeBases.find(k => k.id === id);
      if (!kb) return;

      try {
        const tree = await invoke<FileEntry[]>('read_dir_recursive', {
          path: kb.path,
          depth: 3,
        });

        const kbs = state.knowledgeBases.map(k =>
          k.id === id ? { ...k, lastAccessedAt: Date.now() } : k
        );
        persistKnowledgeBases(kbs);

        update(s => ({
          ...s,
          knowledgeBases: kbs,
          activeKnowledgeBaseId: id,
          openFolderPath: kb.path,
          fileTree: tree,
          filePreviews: [],
        }));
      } catch {
        // Folder inaccessible (external drive removed, deleted, etc.)
      }
    },

    getActiveKnowledgeBase(): KnowledgeBase | null {
      const state = get({ subscribe });
      if (!state.activeKnowledgeBaseId) return null;
      return state.knowledgeBases.find(k => k.id === state.activeKnowledgeBaseId) ?? null;
    },

    /** Check if a path is already a knowledge base. */
    findKnowledgeBaseByPath(path: string): KnowledgeBase | undefined {
      const state = get({ subscribe });
      return state.knowledgeBases.find(kb => kb.path === path);
    },

    /** Load persisted preferences from disk. Call once at app startup. */
    async loadPersistedPrefs() {
      try {
        const store = await load(FILES_STORE_FILE);
        const mode = await store.get<SidebarViewMode>('sidebarViewMode');
        if (mode === 'tree' || mode === 'list') {
          update(state => ({ ...state, sidebarViewMode: mode }));
        }
      } catch { /* first launch — no persisted prefs */ }

      // Load knowledge bases
      try {
        const kbStore = await load(KB_STORE_FILE);
        const kbs = await kbStore.get<KnowledgeBase[]>('knowledgeBases');
        if (Array.isArray(kbs) && kbs.length > 0) {
          update(state => ({ ...state, knowledgeBases: kbs }));
        }
      } catch { /* first launch — no KBs */ }
    },
  };
}

export const filesStore = createFilesStore();

import { writable, get } from 'svelte/store';
import { load } from '@tauri-apps/plugin-store';

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

interface FilesState {
  openFolderPath: string | null;
  fileTree: FileEntry[];
  recentFiles: string[];
  sidebarViewMode: SidebarViewMode;
  filePreviews: FilePreview[];
}

const FILES_STORE_FILE = 'files-prefs.json';

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

function createFilesStore() {
  const { subscribe, set, update } = writable<FilesState>({
    openFolderPath: null,
    fileTree: [],
    recentFiles: [],
    sidebarViewMode: 'list',
    filePreviews: [],
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
    /** Load persisted preferences from disk. Call once at app startup. */
    async loadPersistedPrefs() {
      try {
        const store = await load(FILES_STORE_FILE);
        const mode = await store.get<SidebarViewMode>('sidebarViewMode');
        if (mode === 'tree' || mode === 'list') {
          update(state => ({ ...state, sidebarViewMode: mode }));
        }
      } catch { /* first launch — no persisted prefs */ }
    },
  };
}

export const filesStore = createFilesStore();

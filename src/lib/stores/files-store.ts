import { writable, get } from 'svelte/store';

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
}

interface FilesState {
  openFolderPath: string | null;
  fileTree: FileEntry[];
  recentFiles: string[];
}

function createFilesStore() {
  const { subscribe, set, update } = writable<FilesState>({
    openFolderPath: null,
    fileTree: [],
    recentFiles: [],
  });

  return {
    subscribe,
    setOpenFolder(path: string, tree: FileEntry[]) {
      update(state => ({ ...state, openFolderPath: path, fileTree: tree }));
    },
    setFileTree(tree: FileEntry[]) {
      update(state => ({ ...state, fileTree: tree }));
    },
    addRecentFile(path: string) {
      update(state => {
        const recent = [path, ...state.recentFiles.filter(f => f !== path)].slice(0, 20);
        return { ...state, recentFiles: recent };
      });
    },
    clearFolder() {
      update(state => ({ ...state, openFolderPath: null, fileTree: [] }));
    },
    getState() {
      return get({ subscribe });
    },
  };
}

export const filesStore = createFilesStore();

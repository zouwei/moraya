import { writable, get } from 'svelte/store';

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

function createFilesStore() {
  const { subscribe, set, update } = writable<FilesState>({
    openFolderPath: null,
    fileTree: [],
    recentFiles: [],
    sidebarViewMode: 'tree',
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
  };
}

export const filesStore = createFilesStore();

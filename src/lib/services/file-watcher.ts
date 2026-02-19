import { watch, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { filesStore, type FileEntry } from '$lib/stores/files-store';

let unwatchFn: UnwatchFn | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let currentWatchPath: string | null = null;

export async function refreshFileTree(folderPath: string) {
  try {
    const tree = await invoke<FileEntry[]>('read_dir_recursive', {
      path: folderPath,
      depth: 3,
    });
    filesStore.setFileTree(tree);
  } catch {
    // Folder may have been deleted — ignore
  }
}

export async function startWatching(folderPath: string): Promise<void> {
  // Stop any existing watcher first
  await stopWatching();

  currentWatchPath = folderPath;

  try {
    unwatchFn = await watch(folderPath, () => {
      // Debounce: coalesce rapid file system events
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (currentWatchPath) {
          refreshFileTree(currentWatchPath);
        }
      }, 500);
    }, { recursive: true });
  } catch {
    // watch() may fail if path doesn't exist or permission denied
    unwatchFn = null;
  }
}

export async function stopWatching(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (unwatchFn) {
    try {
      await unwatchFn();
    } catch {
      // Ignore unwatch errors
    }
    unwatchFn = null;
  }
  currentWatchPath = null;
}

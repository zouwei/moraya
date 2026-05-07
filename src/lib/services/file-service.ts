import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { editorStore } from '../stores/editor-store';
import { filesStore, type FileEntry } from '../stores/files-store';
import { invalidateDocCache } from '../editor/doc-cache';
import { computeImageDir, computeImageRelativePath } from './ai/image-path-utils';
import { get } from 'svelte/store';

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  avif: 'image/avif',
};

const MD_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
  { name: 'All Files', extensions: ['*'] },
];

export async function openFile(): Promise<string | null> {
  const selected = await openDialog({
    multiple: false,
    filters: MD_FILTERS,
    title: 'Open Markdown File',
  });

  if (!selected || typeof selected !== 'string') return null;

  const content = await invoke<string>('read_file', { path: selected });
  editorStore.setCurrentFile(selected);
  editorStore.setContent(content);
  filesStore.addRecentFile(selected);
  return content;
}

export async function saveFile(content: string): Promise<boolean> {
  const state = editorStore.getState();

  if (state.currentFilePath) {
    await invoke('write_file', { path: state.currentFilePath, content });
    invalidateDocCache(state.currentFilePath);
    editorStore.setDirty(false);
    // Auto-index on save (best-effort, non-blocking)
    const filePath = state.currentFilePath;
    import('$lib/services/kb').then(({ autoIndexOnSave }) => {
      autoIndexOnSave(filePath).catch(() => {});
    }).catch(() => {});
    // Git auto-commit on save (best-effort, non-blocking)
    autoCommitOnSave(filePath).catch(() => {});
    return true;
  }

  return saveFileAs(content);
}

export async function saveFileAs(content: string, suggestedPath?: string): Promise<boolean> {
  const selected = await saveDialog({
    filters: MD_FILTERS,
    title: 'Save Markdown File',
    defaultPath: suggestedPath || 'untitled.md',
  });

  if (!selected || typeof selected !== 'string') return false;

  const path = selected.endsWith('.md') ? selected : `${selected}.md`;
  await invoke('write_file', { path, content });
  invalidateDocCache(path);
  editorStore.setCurrentFile(path);
  editorStore.setDirty(false);
  filesStore.addRecentFile(path);
  return true;
}

export async function openFolder(): Promise<void> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: 'Open Folder',
  });

  if (selected && typeof selected === 'string') {
    const tree = await invoke<FileEntry[]>('read_dir_recursive', {
      path: selected,
      depth: 3,
    });
    filesStore.setOpenFolder(selected, tree);
  }
}

export async function loadFile(path: string): Promise<string> {
  const content = await invoke<string>('read_file', { path });
  // NOTE: editorStore.setContent / setCurrentFile intentionally omitted.
  // Callers MUST update editorStore themselves AFTER their own serial/race
  // guards (typically via tabsStore.openFileTab → syncToEditor → batchRestore).
  // Writing here would pollute editorStore on superseded clicks and cause
  // the next syncFromEditor to save the wrong file's content into the
  // previously-active tab.
  filesStore.addRecentFile(path);
  return content;
}

export async function openImageFile(): Promise<string | null> {
  const selected = await openDialog({
    multiple: false,
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    title: 'Select Image',
  });

  if (!selected || typeof selected !== 'string') return null;
  return selected;
}

/**
 * Read a local image file and return a blob: URL that the webview can display.
 */
export async function readImageAsBlobUrl(filePath: string): Promise<string> {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
  const mime = MIME_MAP[ext] ?? 'image/png';
  // Use Rust read_file_binary (validate_path allows ~/…) instead of Tauri fs
  // plugin readFile which is restricted to narrower scopes.
  const bytes = await invoke<number[]>('read_file_binary', { path: filePath });
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  return URL.createObjectURL(blob);
}

export function getFileNameFromPath(path: string): string {
  return path.split('/').pop()?.split('\\').pop() || 'Untitled';
}

/**
 * Migrate images from images/temp/ to the correct mirror directory after an
 * article is first saved (i.e. when it goes from unsaved → saved with a real path).
 *
 * @param newFilePath  The newly saved article path.
 * @param kbRoot       The knowledge base root directory.
 * @returns            Map of old relative paths → new relative paths (for updating markdown refs).
 */
export async function migrateTempImages(
  newFilePath: string,
  kbRoot: string,
): Promise<Map<string, string>> {
  const tempDir = `${kbRoot}/images/temp`;
  const movedPaths = new Map<string, string>();

  // List files in images/temp/
  let tempFiles: FileEntry[] = [];
  try {
    tempFiles = await invoke<FileEntry[]>('read_dir_recursive', {
      path: tempDir,
      depth: 1,
    });
  } catch {
    // temp directory doesn't exist — nothing to migrate
    return movedPaths;
  }

  const imageFiles = tempFiles.filter(e => !e.is_dir && isImageFile(e.name));
  if (imageFiles.length === 0) return movedPaths;

  const targetDir = computeImageDir(newFilePath, kbRoot);

  // Ensure target directory exists before moving files
  try {
    await invoke('create_dir', { path: targetDir });
  } catch {
    // Directory may already exist — that's fine
  }

  for (const file of imageFiles) {
    const oldAbsPath = file.path;
    const newAbsPath = `${targetDir}/${file.name}`;

    try {
      // Move the file using rename (same filesystem — instant, no copy overhead)
      await invoke('rename_file', { oldPath: oldAbsPath, newPath: newAbsPath });

      // Record the path mapping for markdown reference updates
      const oldRel = computeImageRelativePath(null, kbRoot, file.name);
      const newRel = computeImageRelativePath(newFilePath, kbRoot, file.name);
      movedPaths.set(oldRel, newRel);
    } catch (e) {
      console.warn(`Failed to migrate temp image ${file.name}:`, e);
    }
  }

  return movedPaths;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff', 'tif']);

export function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * If the saved file belongs to a git-bound knowledge base with autoCommit enabled,
 * stage and commit it automatically. Non-blocking, errors are silently ignored.
 */
async function autoCommitOnSave(filePath: string): Promise<void> {
  const filesState = get(filesStore);
  const kb = filesState.knowledgeBases.find(
    (k) => k.git?.autoCommit && filePath.startsWith(k.path),
  );
  if (!kb?.git) return;

  const { gitAddCommit, gitStore } = await import('$lib/services/git');

  // Use relative path for the commit message
  const relPath = filePath.startsWith(kb.path)
    ? filePath.slice(kb.path.length + 1)
    : filePath.split('/').pop() || filePath;

  gitStore.setCommitting();
  try {
    await gitAddCommit(kb.path, [relPath], `update: ${relPath}`);
    // Update sync status after commit
    const { gitSyncStatus } = await import('$lib/services/git');
    const status = await gitSyncStatus(kb.path, kb.git.configId);
    gitStore.setSyncResult(status.ahead, status.behind, status.branch);
  } catch {
    // Commit may fail if nothing changed — not an error worth showing
    gitStore.setSyncResult(0, 0, kb.git.branch);
  }
}

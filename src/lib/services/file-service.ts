import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { editorStore } from '../stores/editor-store';
import { filesStore, type FileEntry } from '../stores/files-store';

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
    editorStore.setDirty(false);
    return true;
  }

  return saveFileAs(content);
}

export async function saveFileAs(content: string): Promise<boolean> {
  const selected = await saveDialog({
    filters: MD_FILTERS,
    title: 'Save Markdown File',
    defaultPath: 'untitled.md',
  });

  if (!selected || typeof selected !== 'string') return false;

  const path = selected.endsWith('.md') ? selected : `${selected}.md`;
  await invoke('write_file', { path, content });
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
  editorStore.setCurrentFile(path);
  editorStore.setContent(content);
  filesStore.addRecentFile(path);
  return content;
}

export function getFileNameFromPath(path: string): string {
  return path.split('/').pop()?.split('\\').pop() || 'Untitled';
}

<script lang="ts">
  import { filesStore, type FileEntry } from '../stores/files-store';
  import { invoke } from '@tauri-apps/api/core';
  import { open } from '@tauri-apps/plugin-dialog';
  import { t } from '$lib/i18n';

  let {
    onFileSelect,
  }: {
    onFileSelect: (path: string) => void;
  } = $props();

  let fileTree = $state<FileEntry[]>([]);
  let folderPath = $state<string | null>(null);
  let expandedDirs = $state<Set<string>>(new Set());

  filesStore.subscribe(state => {
    fileTree = state.fileTree;
    folderPath = state.openFolderPath;
  });

  async function openFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: $t('sidebar.openFolder'),
    });

    if (selected && typeof selected === 'string') {
      const tree = await invoke<FileEntry[]>('read_dir_recursive', {
        path: selected,
        depth: 3,
      });
      filesStore.setOpenFolder(selected, tree);
      // Expand root level
      expandedDirs = new Set([selected]);
    }
  }

  function toggleDir(path: string) {
    const newSet = new Set(expandedDirs);
    if (newSet.has(path)) {
      newSet.delete(path);
    } else {
      newSet.add(path);
    }
    expandedDirs = newSet;
  }

  function handleFileClick(entry: FileEntry) {
    if (entry.is_dir) {
      toggleDir(entry.path);
    } else {
      onFileSelect(entry.path);
    }
  }

  function getFileName(path: string): string {
    return path.split('/').pop() || path;
  }
</script>

<div class="sidebar no-select">
  <div class="sidebar-header">
    <span class="sidebar-title">
      {folderPath ? getFileName(folderPath) : $t('sidebar.title')}
    </span>
    <button class="sidebar-btn" onclick={openFolder} title={$t('sidebar.openFolder')}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z"/>
      </svg>
    </button>
  </div>

  <div class="sidebar-content">
    {#if fileTree.length === 0}
      <div class="sidebar-empty">
        <p>{$t('sidebar.noFolder')}</p>
        <button class="open-btn" onclick={openFolder}>{$t('sidebar.openFolder')}</button>
      </div>
    {:else}
      {#each fileTree as entry}
        {@render fileTreeItem(entry, 0)}
      {/each}
    {/if}
  </div>
</div>

{#snippet fileTreeItem(entry: FileEntry, depth: number)}
  <button
    class="tree-item"
    class:is-dir={entry.is_dir}
    style="padding-left: {0.75 + depth * 1}rem"
    onclick={() => handleFileClick(entry)}
  >
    {#if entry.is_dir}
      <span class="tree-icon" class:expanded={expandedDirs.has(entry.path)}>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
          <path d="M2 1l4 3-4 3z"/>
        </svg>
      </span>
    {:else}
      <span class="tree-icon file-icon">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" opacity="0.5">
          <path d="M2 1h5l3 3v7H2V1zm5 0v3h3"/>
        </svg>
      </span>
    {/if}
    <span class="tree-name">{entry.name}</span>
  </button>

  {#if entry.is_dir && entry.children && expandedDirs.has(entry.path)}
    {#each entry.children as child}
      {@render fileTreeItem(child, depth + 1)}
    {/each}
  {/if}
{/snippet}

<style>
  .sidebar {
    width: var(--sidebar-width);
    height: 100%;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border-light);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border-light);
    min-height: 2rem;
  }

  .sidebar-title {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: 3px;
  }

  .sidebar-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .sidebar-content {
    flex: 1;
    overflow-y: auto;
    padding: 0.25rem 0;
  }

  .sidebar-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 0.75rem;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .open-btn {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-xs);
  }

  .open-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .tree-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.2rem 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tree-item:hover {
    background: var(--bg-hover);
  }

  .tree-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 0.75rem;
    flex-shrink: 0;
    color: var(--text-muted);
    transition: transform var(--transition-fast);
  }

  .tree-icon.expanded {
    transform: rotate(90deg);
  }

  .tree-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* iPadOS: larger touch targets and active feedback */
  :global(.platform-ipados) .tree-item {
    padding: 0.5rem 0.75rem;
    min-height: 44px;
  }

  :global(.platform-ipados) .tree-item:active {
    background: var(--bg-hover);
  }
</style>

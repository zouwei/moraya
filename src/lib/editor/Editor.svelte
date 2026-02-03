<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Editor as MilkdownEditor } from '@milkdown/core';
  import { editorViewCtx } from '@milkdown/core';
  import { callCommand } from '@milkdown/utils';
  import {
    addRowBeforeCommand,
    addRowAfterCommand,
    addColBeforeCommand,
    addColAfterCommand,
    deleteSelectedCellsCommand,
    setAlignCommand,
    selectRowCommand,
    selectColCommand,
  } from '@milkdown/preset-gfm';
  import { createEditor } from './setup';
  import { editorStore } from '../stores/editor-store';
  import TableToolbar from './TableToolbar.svelte';

  let editorEl: HTMLDivElement;
  let editor: MilkdownEditor | null = null;

  // Props
  let {
    content = $bindable(''),
    onEditorReady,
  }: {
    content?: string;
    onEditorReady?: (editor: MilkdownEditor) => void;
  } = $props();

  let isReady = $state(false);
  let showTableToolbar = $state(false);
  let tableToolbarPosition = $state({ top: 0, left: 0 });

  function isInsideTable(): boolean {
    if (!editor) return false;
    try {
      return editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const resolvedFrom = view.state.selection.$from;
        for (let d = resolvedFrom.depth; d > 0; d--) {
          if (resolvedFrom.node(d).type.name === 'table') return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  }

  function updateTableToolbar() {
    if (!editor) return;
    const inTable = isInsideTable();
    if (inTable) {
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from } = view.state.selection;
          const coords = view.coordsAtPos(from);
          tableToolbarPosition = { top: coords.top, left: coords.left };
        });
        showTableToolbar = true;
      } catch {
        showTableToolbar = false;
      }
    } else {
      showTableToolbar = false;
    }
  }

  function runCommand(cmd: any, payload?: any) {
    if (!editor) return;
    try {
      editor.action(callCommand(cmd.key ?? cmd, payload));
    } catch {
      // Command may fail if selection is invalid
    }
  }

  function handleDeleteRow() {
    if (!editor) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const resolvedFrom = view.state.selection.$from;
        for (let d = resolvedFrom.depth; d > 0; d--) {
          if (resolvedFrom.node(d).type.name === 'table_row') {
            const rowIndex = resolvedFrom.index(d - 1);
            callCommand(selectRowCommand.key, { index: rowIndex })(ctx);
            callCommand(deleteSelectedCellsCommand.key)(ctx);
            return;
          }
        }
      });
    } catch {
      runCommand(deleteSelectedCellsCommand);
    }
  }

  function handleDeleteCol() {
    if (!editor) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const resolvedFrom = view.state.selection.$from;
        for (let d = resolvedFrom.depth; d > 0; d--) {
          if (resolvedFrom.node(d).type.name === 'table_cell' || resolvedFrom.node(d).type.name === 'table_header') {
            const colIndex = resolvedFrom.index(d - 1);
            callCommand(selectColCommand.key, { index: colIndex })(ctx);
            callCommand(deleteSelectedCellsCommand.key)(ctx);
            return;
          }
        }
      });
    } catch {
      runCommand(deleteSelectedCellsCommand);
    }
  }

  onMount(async () => {
    editor = await createEditor({
      root: editorEl,
      defaultValue: content,
      onChange: (markdown) => {
        content = markdown;
        editorStore.setDirty(true);
        editorStore.setContent(markdown);
      },
      onFocus: () => {
        editorStore.setFocused(true);
      },
      onBlur: () => {
        editorStore.setFocused(false);
      },
    });
    isReady = true;
    onEditorReady?.(editor);

    // Listen for selection changes to show/hide table toolbar
    const proseMirrorEl = editorEl.querySelector('.ProseMirror');
    if (proseMirrorEl) {
      proseMirrorEl.addEventListener('click', updateTableToolbar);
      proseMirrorEl.addEventListener('keyup', updateTableToolbar);
    }
  });

  onDestroy(() => {
    if (editor) {
      editor.destroy();
    }
  });
</script>

<div class="editor-wrapper" class:ready={isReady}>
  <div bind:this={editorEl} class="editor-root"></div>
</div>

{#if showTableToolbar}
  <TableToolbar
    position={tableToolbarPosition}
    onAddRowBefore={() => runCommand(addRowBeforeCommand)}
    onAddRowAfter={() => runCommand(addRowAfterCommand)}
    onAddColBefore={() => runCommand(addColBeforeCommand)}
    onAddColAfter={() => runCommand(addColAfterCommand)}
    onDeleteRow={handleDeleteRow}
    onDeleteCol={handleDeleteCol}
    onAlignLeft={() => runCommand(setAlignCommand, 'left')}
    onAlignCenter={() => runCommand(setAlignCommand, 'center')}
    onAlignRight={() => runCommand(setAlignCommand, 'right')}
  />
{/if}

<style>
  .editor-wrapper {
    flex: 1;
    overflow-y: auto;
    padding: 2rem 3rem;
    opacity: 0;
    transition: opacity 0.2s ease;
  }

  .editor-wrapper.ready {
    opacity: 1;
  }

  .editor-root {
    max-width: 800px;
    margin: 0 auto;
    min-height: 100%;
  }
</style>

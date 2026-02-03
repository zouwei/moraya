<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Editor as MilkdownEditor } from '@milkdown/core';
  import { editorViewCtx } from '@milkdown/core';
  import { callCommand } from '@milkdown/utils';
  import { imageSchema } from '@milkdown/preset-commonmark';
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
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { createEditor } from './setup';
  import { editorStore } from '../stores/editor-store';
  import { settingsStore } from '../stores/settings-store';
  import { readImageAsBlobUrl } from '../services/file-service';
  import { uploadImage, blobUrlToBlob } from '../services/image-hosting';
  import type { ImageHostConfig } from '../services/image-hosting';
  import TableToolbar from './TableToolbar.svelte';
  import ImageContextMenu from './ImageContextMenu.svelte';

  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif']);

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

  // Image context menu state
  let showImageMenu = $state(false);
  let imageMenuPosition = $state({ top: 0, left: 0 });
  let imageMenuSrc = $state('');
  let imageMenuIsUploadable = $state(false);
  let contextMenuTargetPos = $state<number | null>(null);

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

  let dragDropUnlisten: UnlistenFn | null = null;

  function isImageFile(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return IMAGE_EXTENSIONS.has(ext);
  }

  function insertImageAtPos(src: string, pos: number) {
    if (!editor) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const imgType = imageSchema.type(ctx);
        const node = imgType.create({ src, alt: '' });
        const tr = view.state.tr.insert(pos, node);
        view.dispatch(tr);
      });
    } catch {
      // Fallback: insert at current selection
    }
  }

  function insertImageAtEnd(src: string) {
    if (!editor) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const imgType = imageSchema.type(ctx);
        const node = imgType.create({ src, alt: '' });
        const tr = view.state.tr.insert(view.state.doc.content.size, node);
        view.dispatch(tr);
      });
    } catch {
      // Insert failed
    }
  }

  function insertImageAtCursor(src: string) {
    if (!editor) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const imgType = imageSchema.type(ctx);
        const node = imgType.create({ src, alt: '' });
        const { from } = view.state.selection;
        const tr = view.state.tr.insert(from, node);
        view.dispatch(tr);
      });
    } catch {
      // Fallback
    }
  }

  /** Try to upload a blob URL image and replace it in the editor */
  async function uploadAndReplace(blobUrl: string, config: ImageHostConfig) {
    if (!editor) return;
    try {
      const blob = await blobUrlToBlob(blobUrl);
      const result = await uploadImage(blob, config);

      // Find and replace the blob URL in the document
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { doc, tr } = view.state;
        doc.descendants((node, pos) => {
          if (node.type.name === 'image' && node.attrs.src === blobUrl) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: result.url });
          }
        });
        if (tr.docChanged) {
          view.dispatch(tr);
        }
      });
    } catch {
      // Upload failed silently
    }
  }

  /** Handle paste event for clipboard images */
  function handlePaste(event: ClipboardEvent) {
    if (!event.clipboardData) return;
    const items = event.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const blobUrl = URL.createObjectURL(file);
        insertImageAtCursor(blobUrl);

        // Auto-upload if enabled
        const config = settingsStore.getState().imageHostConfig;
        if (config.autoUpload && config.apiToken) {
          uploadAndReplace(blobUrl, config);
        }
        return;
      }
    }
  }

  /** Handle right-click on images */
  function handleContextMenu(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.tagName !== 'IMG') return;
    event.preventDefault();

    const imgEl = target as HTMLImageElement;
    imageMenuSrc = imgEl.src;
    imageMenuPosition = { top: event.clientY, left: event.clientX };
    imageMenuIsUploadable = imgEl.src.startsWith('blob:');
    showImageMenu = true;

    // Find the ProseMirror position for this image
    if (editor) {
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const pos = view.posAtDOM(imgEl, 0);
          contextMenuTargetPos = pos;
        });
      } catch {
        contextMenuTargetPos = null;
      }
    }
  }

  function handleImageResize(width: string) {
    if (!editor || contextMenuTargetPos === null) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const pos = contextMenuTargetPos!;
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'image') return;

        const title = width ? `width=${width}` : '';
        const tr = view.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          title,
        });
        view.dispatch(tr);
      });
    } catch {
      // Resize failed
    }
  }

  function handleImageUpload() {
    if (!editor || contextMenuTargetPos === null) return;
    const config = settingsStore.getState().imageHostConfig;
    uploadAndReplace(imageMenuSrc, config);
  }

  function handleImageEditAlt() {
    if (!editor || contextMenuTargetPos === null) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const pos = contextMenuTargetPos!;
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'image') return;

        const currentAlt = (node.attrs.alt as string) || '';
        const newAlt = prompt('Image description:', currentAlt);
        if (newAlt === null) return;

        const tr = view.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          alt: newAlt,
        });
        view.dispatch(tr);
      });
    } catch {
      // Edit alt failed
    }
  }

  function handleImageCopyUrl() {
    navigator.clipboard.writeText(imageMenuSrc);
  }

  function handleImageDelete() {
    if (!editor || contextMenuTargetPos === null) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const pos = contextMenuTargetPos!;
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'image') return;

        const tr = view.state.tr.delete(pos, pos + node.nodeSize);
        view.dispatch(tr);
      });
    } catch {
      // Delete failed
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
      proseMirrorEl.addEventListener('paste', handlePaste as EventListener);
      proseMirrorEl.addEventListener('contextmenu', handleContextMenu as EventListener);
    }

    // Prevent default browser drop behavior on editor
    editorEl.addEventListener('dragover', (e) => e.preventDefault());
    editorEl.addEventListener('drop', (e) => e.preventDefault());

    // Listen for Tauri drag-drop events (provides file paths + drop position)
    dragDropUnlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== 'drop' || !editor) return;
      const { paths, position } = event.payload;
      const imagePaths = paths.filter(isImageFile);
      if (imagePaths.length === 0) return;

      // Resolve drop position to ProseMirror position
      let dropPos: number | null = null;
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const posResult = view.posAtCoords({
            left: position.x,
            top: position.y,
          });
          if (posResult) dropPos = posResult.pos;
        });
      } catch {
        // Position resolution failed
      }

      // Read each image file and insert as blob URL
      for (const imgPath of imagePaths) {
        try {
          const blobUrl = await readImageAsBlobUrl(imgPath);
          if (dropPos !== null) {
            insertImageAtPos(blobUrl, dropPos);
          } else {
            insertImageAtEnd(blobUrl);
          }

          // Auto-upload if enabled
          const config = settingsStore.getState().imageHostConfig;
          if (config.autoUpload && config.apiToken) {
            uploadAndReplace(blobUrl, config);
          }
        } catch {
          // Failed to read image file
        }
      }
    });
  });

  onDestroy(() => {
    dragDropUnlisten?.();
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

{#if showImageMenu}
  <ImageContextMenu
    position={imageMenuPosition}
    imageSrc={imageMenuSrc}
    isUploadable={imageMenuIsUploadable}
    onResize={handleImageResize}
    onUpload={handleImageUpload}
    onEditAlt={handleImageEditAlt}
    onCopyUrl={handleImageCopyUrl}
    onDelete={handleImageDelete}
    onClose={() => showImageMenu = false}
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

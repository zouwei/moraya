<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Editor as MilkdownEditor } from '@milkdown/core';
  import { editorViewCtx } from '@milkdown/core';
  import { TextSelection, AllSelection } from '@milkdown/prose/state';
  import { Decoration, DecorationSet } from '@milkdown/prose/view';
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
  import ImageToolbar from './ImageToolbar.svelte';

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

  // Image click toolbar state
  let showImageToolbar = $state(false);
  let imageToolbarPosition = $state({ top: 0, left: 0 });
  let imageToolbarCurrentWidth = $state('');
  let imageToolbarTargetPos = $state<number | null>(null);

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

  /** Handle left-click on images to show floating resize toolbar */
  function handleImageClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (target.tagName !== 'IMG') {
      showImageToolbar = false;
      return;
    }

    const imgEl = target as HTMLImageElement;
    const rect = imgEl.getBoundingClientRect();
    imageToolbarPosition = {
      top: rect.top - 36,
      left: rect.left + rect.width / 2,
    };

    // Get current width from title attr
    const titleAttr = imgEl.getAttribute('title') || '';
    const widthMatch = titleAttr.match(/^width=(\d+%?)$/);
    imageToolbarCurrentWidth = widthMatch ? widthMatch[1] : '';

    // Find ProseMirror position
    if (editor) {
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const pos = view.posAtDOM(imgEl, 0);
          imageToolbarTargetPos = pos;
        });
      } catch {
        imageToolbarTargetPos = null;
      }
    }

    showImageToolbar = true;
  }

  function handleToolbarResize(width: string) {
    if (!editor || imageToolbarTargetPos === null) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const pos = imageToolbarTargetPos!;
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
    imageToolbarCurrentWidth = width;
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

    // Restore cursor position from store and focus
    const proseMirrorEl = editorEl.querySelector('.ProseMirror') as HTMLElement | null;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const docSize = view.state.doc.content.size;
        const savedOffset = editorStore.getState().cursorOffset;
        // Map markdown offset to ProseMirror position using fraction
        const fraction = content.length > 0 ? savedOffset / content.length : 0;
        let pmPos = Math.round(fraction * docSize);
        // Clamp to valid range (1 .. docSize-1)
        pmPos = Math.max(1, Math.min(pmPos, Math.max(1, docSize - 1)));
        // Resolve to nearest valid text position
        const resolved = view.state.doc.resolve(pmPos);
        const sel = TextSelection.near(resolved);
        const tr = view.state.tr.setSelection(sel);
        view.dispatch(tr);
        view.focus();
      });
    } catch {
      // Fallback: just focus
      if (proseMirrorEl) proseMirrorEl.focus();
    }

    // ── Fast AllSelection deletion ──────────────────────────────────
    // Capture-phase keydown: when all content is selected, bypass ProseMirror's
    // slow AllSelection deletion path by replacing the entire document content
    // with a single empty paragraph in one fast transaction.
    // The visual caret for the empty paragraph is handled by CSS (editor.css).
    editorEl.addEventListener('keydown', (e) => {
      if ((e.key === 'Backspace' || e.key === 'Delete') && editor) {
        try {
          editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const sel = view.state.selection;
            const docSize = view.state.doc.content.size;
            const isAllSelected =
              sel instanceof AllSelection ||
              (docSize > 0 && sel.from <= 1 && sel.to >= docSize - 1);

            if (isAllSelected) {
              e.preventDefault();
              e.stopPropagation();
              const { schema } = view.state;
              const emptyParagraph = schema.nodes.paragraph.create();
              const tr = view.state.tr.replaceWith(0, docSize, emptyParagraph);
              tr.setSelection(TextSelection.create(tr.doc, 1));
              view.dispatch(tr);
            }
          });
        } catch {
          // Ignore errors
        }
      }
    }, true);

    // Listen for selection changes to show/hide table toolbar
    if (proseMirrorEl) {
      proseMirrorEl.addEventListener('click', updateTableToolbar);
      proseMirrorEl.addEventListener('click', handleImageClick as EventListener);
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

  // ── Search / Replace ──────────────────────────────────

  interface MatchPos { from: number; to: number }
  let searchMatches: MatchPos[] = [];
  let searchIndex = -1;

  function findTextMatches(text: string, cs: boolean): MatchPos[] {
    if (!editor || !text) return [];
    const matches: MatchPos[] = [];
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.state.doc.descendants((node, pos) => {
        if (node.isText && node.text) {
          const haystack = cs ? node.text : node.text.toLowerCase();
          const needle = cs ? text : text.toLowerCase();
          let idx = 0;
          while ((idx = haystack.indexOf(needle, idx)) !== -1) {
            matches.push({ from: pos + idx, to: pos + idx + needle.length });
            idx += needle.length;
          }
        }
      });
    });
    return matches;
  }

  function applySearchDecorations(matches: MatchPos[], activeIdx: number) {
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (matches.length === 0) {
        (view as any).setProps({ decorations: () => DecorationSet.empty });
        return;
      }
      const decos = matches.map((m, i) =>
        Decoration.inline(m.from, m.to, {
          class: i === activeIdx ? 'search-highlight-current' : 'search-highlight',
        })
      );
      const decoSet = DecorationSet.create(view.state.doc, decos);
      (view as any).setProps({ decorations: () => decoSet });
    });
  }

  export function searchText(text: string, cs: boolean): number {
    searchMatches = findTextMatches(text, cs);
    searchIndex = searchMatches.length > 0 ? 0 : -1;
    applySearchDecorations(searchMatches, searchIndex);
    if (searchIndex >= 0) scrollToMatch(searchIndex);
    return searchMatches.length;
  }

  export function searchFindNext(): { current: number; total: number } {
    if (searchMatches.length === 0) return { current: 0, total: 0 };
    searchIndex = (searchIndex + 1) % searchMatches.length;
    applySearchDecorations(searchMatches, searchIndex);
    scrollToMatch(searchIndex);
    return { current: searchIndex + 1, total: searchMatches.length };
  }

  export function searchFindPrev(): { current: number; total: number } {
    if (searchMatches.length === 0) return { current: 0, total: 0 };
    searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
    applySearchDecorations(searchMatches, searchIndex);
    scrollToMatch(searchIndex);
    return { current: searchIndex + 1, total: searchMatches.length };
  }

  export function searchReplaceCurrent(replaceWith: string) {
    if (!editor || searchIndex < 0 || searchIndex >= searchMatches.length) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const match = searchMatches[searchIndex];
      const tr = view.state.tr.replaceWith(
        match.from,
        match.to,
        view.state.schema.text(replaceWith)
      );
      view.dispatch(tr);
    });
  }

  export function searchReplaceAll(searchStr: string, replaceWith: string, cs: boolean): number {
    if (!editor || !searchStr) return 0;
    const matches = findTextMatches(searchStr, cs);
    if (matches.length === 0) return 0;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let tr = view.state.tr;
      for (let i = matches.length - 1; i >= 0; i--) {
        tr = tr.replaceWith(
          matches[i].from,
          matches[i].to,
          view.state.schema.text(replaceWith)
        );
      }
      view.dispatch(tr);
    });
    const count = matches.length;
    clearSearch();
    return count;
  }

  export function clearSearch() {
    searchMatches = [];
    searchIndex = -1;
    if (!editor) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        (view as any).setProps({ decorations: () => DecorationSet.empty });
      });
    } catch {
      // Editor may be destroyed
    }
  }

  function scrollToMatch(idx: number) {
    if (!editor || idx < 0 || idx >= searchMatches.length) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const match = searchMatches[idx];
      // Use ProseMirror's built-in scrollIntoView via selection
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to));
      tr.scrollIntoView();
      view.dispatch(tr);
    });
  }

  onDestroy(() => {
    // Save cursor position before destroying the editor
    if (editor) {
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from } = view.state.selection;
          const docSize = view.state.doc.content.size;
          // Map ProseMirror position to markdown offset using fraction
          const fraction = docSize > 0 ? from / docSize : 0;
          const markdownOffset = Math.round(fraction * content.length);
          editorStore.setCursorOffset(markdownOffset);
        });
      } catch {
        // Ignore errors during position save
      }
    }
    dragDropUnlisten?.();
    if (editor) {
      editor.destroy();
    }
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="editor-wrapper" class:ready={isReady} onclick={(e) => {
  // Click on empty area → focus editor and place cursor at end
  if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('editor-root')) {
    const pm = editorEl?.querySelector('.ProseMirror') as HTMLElement | null;
    if (pm) pm.focus();
  }
}}>
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

{#if showImageToolbar}
  <ImageToolbar
    position={imageToolbarPosition}
    currentWidth={imageToolbarCurrentWidth}
    onResize={handleToolbarResize}
    onClose={() => showImageToolbar = false}
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
    cursor: text;
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

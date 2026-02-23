<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { Editor as MilkdownEditor } from '@milkdown/core';
  import { editorViewCtx } from '@milkdown/core';
  import { TextSelection, AllSelection } from '@milkdown/prose/state';
  import { Decoration, DecorationSet } from '@milkdown/prose/view';
  import { callCommand, replaceAll } from '@milkdown/utils';
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
  import { createEditor, getMarkdown } from './setup';
  import { editorStore } from '../stores/editor-store';
  import { settingsStore } from '../stores/settings-store';
  import { readImageAsBlobUrl } from '../services/file-service';
  import { uploadImage, fetchImageAsBlob, targetToConfig } from '../services/image-hosting';
  import type { ImageHostConfig } from '../services/image-hosting';
  import { save as saveDialog } from '@tauri-apps/plugin-dialog';
  import { invoke } from '@tauri-apps/api/core';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { isTauri } from '$lib/utils/platform';
  import TableToolbar from './TableToolbar.svelte';
  import ImageContextMenu from './ImageContextMenu.svelte';
  import ImageToolbar from './ImageToolbar.svelte';
  import ImageAltEditor from './ImageAltEditor.svelte';

  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif']);

  import { extractFrontmatter } from '../utils/frontmatter';

  /** Stored frontmatter block (including `---` fences and trailing newline) */
  let storedFrontmatter = '';

  let editorEl: HTMLDivElement;
  let editor: MilkdownEditor | null = null;

  // Props
  let {
    content = $bindable(''),
    onEditorReady,
    onContentChange,
    onNotify,
  }: {
    content?: string;
    onEditorReady?: (editor: MilkdownEditor) => void;
    onContentChange?: (content: string) => void;
    onNotify?: (text: string, type: 'success' | 'error') => void;
  } = $props();

  let isReady = $state(false);
  let isMounted = false; // tracks whether component is still alive (guards async gaps)
  let internalChange = false; // flag to avoid replaceAll loop on Milkdown's own onChange
  let syncingFromExternal = false; // flag to suppress onChange during replaceAll from source editor
  let syncResetTimer: ReturnType<typeof setTimeout> | undefined; // delayed reset for syncingFromExternal
  let lastSyncWasExternal = false; // true when last content came from source editor (split mode)
  let externalSyncTimer: ReturnType<typeof setTimeout> | undefined; // debounce for external content sync
  let tableToolbarRaf: number | undefined; // RAF throttle for table toolbar updates

  /**
   * Convert single newlines to hard breaks (trailing two spaces + newline)
   * so the visual editor renders line breaks where the source has them.
   * Skips fenced code blocks to avoid adding trailing spaces to code.
   */
  function toHardBreaks(md: string): string {
    const lines = md.split('\n');
    const result: string[] = [];
    let inCode = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Toggle on fenced code block boundaries (``` or ~~~)
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
        inCode = !inCode;
        result.push(line);
        continue;
      }

      if (inCode) {
        result.push(line);
        continue;
      }

      // Add hard break (two trailing spaces) when:
      // - current line is non-empty
      // - next line exists and is non-empty (single newline, not paragraph break)
      // - line doesn't already end with two+ spaces (existing hard break)
      // - line doesn't already end with backslash (backslash hard break syntax)
      const nextLine = lines[i + 1];
      if (
        line.length > 0 &&
        !line.endsWith('  ') &&
        !line.endsWith('\\') &&
        nextLine !== undefined &&
        nextLine.length > 0
      ) {
        result.push(line + '  ');
      } else {
        result.push(line);
      }
    }

    return result.join('\n');
  }
  let showTableToolbar = $state(false);
  let tableToolbarPosition = $state({ top: 0, left: 0 });

  // Image context menu state
  let showImageMenu = $state(false);
  let imageMenuPosition = $state({ top: 0, left: 0 });
  let imageMenuSrc = $state('');
  let imageMenuIsUploadable = $state(false);
  let contextMenuTargetPos = $state<number | null>(null);

  // Image alt editor state
  let showAltEditor = $state(false);
  let altEditorPosition = $state({ top: 0, left: 0 });
  let altEditorInitialValue = $state('');

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

  function updateTableToolbarImmediate() {
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

  // RAF-throttled version for high-frequency events (keyup)
  function updateTableToolbar() {
    if (tableToolbarRaf) return;
    tableToolbarRaf = requestAnimationFrame(() => {
      tableToolbarRaf = undefined;
      updateTableToolbarImmediate();
    });
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
    } catch (e) {
      console.warn('[Image] insertImageAtPos failed:', e);
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
    } catch (e) {
      console.warn('[Image] insertImageAtEnd failed:', e);
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
    } catch (e) {
      console.warn('[Image] insertImageAtCursor failed:', e);
    }
  }

  /** Upload an image (any URL) and replace it in the editor.
   *  When `targetPos` is provided (right-click upload), use it directly
   *  to avoid URL mismatch between DOM-resolved src and ProseMirror attrs. */
  async function uploadAndReplace(imageSrc: string, config: ImageHostConfig, targetPos?: number | null) {
    if (!editor) return;
    try {
      const blob = await fetchImageAsBlob(imageSrc);
      const result = await uploadImage(blob, config);

      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);

        if (targetPos != null) {
          // Direct position — from context menu right-click
          const node = view.state.doc.nodeAt(targetPos);
          if (node && node.type.name === 'image') {
            view.dispatch(
              view.state.tr.setNodeMarkup(targetPos, undefined, {
                ...node.attrs,
                src: result.url,
              }),
            );
            onNotify?.('Image uploaded', 'success');
            return;
          }
        }

        // Fallback: search by URL match (for paste / drag-drop auto-upload)
        const { doc, tr } = view.state;
        doc.descendants((node, pos) => {
          if (node.type.name === 'image' && node.attrs.src === imageSrc) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: result.url });
          }
        });
        if (tr.docChanged) {
          view.dispatch(tr);
          onNotify?.('Image uploaded', 'success');
        }
      });
    } catch (e) {
      console.warn('[Image] uploadAndReplace failed:', e);
      onNotify?.(String(e instanceof Error ? e.message : e), 'error');
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
        const target = settingsStore.getDefaultImageHostTarget();
        if (target?.autoUpload) {
          uploadAndReplace(blobUrl, targetToConfig(target));
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
    event.stopPropagation();

    // Dismiss any existing image toolbar from a previous click
    showImageToolbar = false;

    const imgEl = target as HTMLImageElement;
    imageMenuSrc = imgEl.src;
    imageMenuPosition = { top: event.clientY, left: event.clientX };
    imageMenuIsUploadable = !!settingsStore.getDefaultImageHostTarget();
    showImageMenu = true;

    // Defer ProseMirror position resolution to the next frame so the context menu
    // renders immediately. posAtDOM + dispatch force a layout reflow which blocks
    // the main thread for large blob images in WKWebView.
    requestAnimationFrame(() => {
      if (!editor) return;
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const pos = view.posAtDOM(imgEl, 0);
          contextMenuTargetPos = pos;

          const node = view.state.doc.nodeAt(pos);
          if (node) {
            const resolved = view.state.doc.resolve(pos + node.nodeSize);
            const sel = TextSelection.near(resolved);
            view.dispatch(view.state.tr.setSelection(sel));
          }
        });
      } catch {
        contextMenuTargetPos = null;
      }
    });
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
    const target = settingsStore.getDefaultImageHostTarget();
    if (!target) return;
    uploadAndReplace(imageMenuSrc, targetToConfig(target), contextMenuTargetPos);
  }

  function handleImageEditAlt() {
    if (!editor || contextMenuTargetPos === null) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const pos = contextMenuTargetPos!;
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'image') return;

        altEditorInitialValue = (node.attrs.alt as string) || '';
        altEditorPosition = { ...imageMenuPosition };
        showAltEditor = true;
      });
    } catch {
      // Edit alt failed
    }
  }

  function handleAltSave(newAlt: string) {
    if (!editor || contextMenuTargetPos === null) return;
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const pos = contextMenuTargetPos!;
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'image') return;

        const tr = view.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          alt: newAlt,
        });
        view.dispatch(tr);
      });
    } catch {
      // Save alt failed
    }
    showAltEditor = false;
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

  async function handleImageCopy() {
    try {
      // Pass a Promise<Blob> to ClipboardItem so clipboard.write() is called
      // synchronously within the user gesture context. WKWebView requires this —
      // if we await fetchImageAsBlob first, the gesture expires and write() fails.
      const pngPromise = fetchImageAsBlob(imageMenuSrc).then(async (blob) => {
        if (blob.type === 'image/png') return blob;
        // Convert non-PNG images to PNG via canvas
        const img = new Image();
        const objectUrl = URL.createObjectURL(blob);
        return new Promise<Blob>((resolve, reject) => {
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            canvas.toBlob((b) => {
              URL.revokeObjectURL(objectUrl);
              if (b) resolve(b);
              else reject(new Error('Canvas toBlob failed'));
            }, 'image/png');
          };
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Image load failed'));
          };
          img.src = objectUrl;
        });
      });
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngPromise }),
      ]);
    } catch {
      await navigator.clipboard.writeText(imageMenuSrc);
    }
  }

  function handleImageOpenInBrowser() {
    if (imageMenuSrc && !imageMenuSrc.startsWith('blob:')) {
      openUrl(imageMenuSrc);
    }
  }

  async function handleImageSaveAs() {
    try {
      const blob = await fetchImageAsBlob(imageMenuSrc);
      const ext = getImageExtension(imageMenuSrc, blob.type);
      const path = await saveDialog({
        defaultPath: `image.${ext}`,
        filters: [{ name: 'Image', extensions: [ext] }],
      });
      if (!path || typeof path !== 'string') return;

      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      await invoke('write_file_binary', { path, base64Data: base64 });
    } catch {
      // Save failed
    }
  }

  function getImageExtension(src: string, mimeType: string): string {
    const urlMatch = src.match(/\.(\w+)(?:\?|$)/);
    if (urlMatch) {
      const ext = urlMatch[1].toLowerCase();
      if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'].includes(ext)) {
        return ext;
      }
    }
    const mimeMap: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
      'image/avif': 'avif',
    };
    return mimeMap[mimeType] || 'png';
  }

  /** Show pointer cursor when hovering over task list checkbox area. */
  function handleCheckboxHover(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const li = target.closest('li[data-checked]') as HTMLElement | null;
    const pmEl = (event.currentTarget as HTMLElement);
    if (li) {
      const liRect = li.getBoundingClientRect();
      if (event.clientX <= liRect.left + 4) {
        pmEl.style.cursor = 'pointer';
        return;
      }
    }
    if (pmEl.style.cursor === 'pointer') {
      pmEl.style.cursor = '';
    }
  }

  /** Toggle task list checkbox when clicking on the checkbox area (::before pseudo-element). */
  function handleCheckboxClick(event: MouseEvent) {
    if (event.button !== 0 || !editor) return;
    const target = event.target as HTMLElement;
    // Walk up to find a task list item
    const li = target.closest('li[data-checked]') as HTMLElement | null;
    if (!li) return;

    // Only toggle when clicking in the checkbox region (left of li content box).
    // The ::before checkbox is positioned at left: -1.5em outside the li's box.
    const liRect = li.getBoundingClientRect();
    if (event.clientX > liRect.left + 4) return;

    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const pos = view.posAtDOM(li, 0);
        const resolved = view.state.doc.resolve(pos);

        for (let d = resolved.depth; d > 0; d--) {
          const node = resolved.node(d);
          if (node.type.name === 'list_item' && node.attrs.checked != null) {
            view.dispatch(
              view.state.tr.setNodeMarkup(resolved.before(d), undefined, {
                ...node.attrs,
                checked: !node.attrs.checked,
              }),
            );
            break;
          }
        }
      });
    } catch {
      // Ignore position resolution errors
    }

    event.preventDefault();
    event.stopPropagation();
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

  /** Handle right-click that passes through the toolbar backdrop onto an image */
  function handleToolbarContextMenuThrough(imgEl: HTMLImageElement, x: number, y: number) {
    showImageToolbar = false;

    imageMenuSrc = imgEl.src;
    imageMenuPosition = { top: y, left: x };
    imageMenuIsUploadable = !!settingsStore.getDefaultImageHostTarget();
    showImageMenu = true;

    // Defer ProseMirror work to next frame (same rationale as handleContextMenu)
    requestAnimationFrame(() => {
      if (!editor) return;
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const pos = view.posAtDOM(imgEl, 0);
          contextMenuTargetPos = pos;

          const node = view.state.doc.nodeAt(pos);
          if (node) {
            const resolved = view.state.doc.resolve(pos + node.nodeSize);
            const sel = TextSelection.near(resolved);
            view.dispatch(view.state.tr.setSelection(sel));
          }
        });
      } catch {
        contextMenuTargetPos = null;
      }
    });
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
    isMounted = true;

    // Strip frontmatter before Milkdown sees it (avoids `---` → thematic break corruption)
    const { frontmatter, body } = extractFrontmatter(content);
    storedFrontmatter = frontmatter;

    const createdEditor = await createEditor({
      root: editorEl,
      defaultValue: body,
      onChange: (markdown) => {
        if (!isMounted) return; // Component destroyed during async gap
        if (syncingFromExternal) return; // Don't push reformatted text back to source editor
        lastSyncWasExternal = false; // User typed in visual editor
        internalChange = true;
        // Re-attach frontmatter to the serialized body
        const full = storedFrontmatter + markdown;
        content = full;
        onContentChange?.(full);
        editorStore.setDirty(true);
        editorStore.setContent(full);
      },
      onFocus: () => {
        if (isMounted) editorStore.setFocused(true);
      },
      onBlur: () => {
        if (isMounted) editorStore.setFocused(false);
      },
    });

    // Guard: if component was destroyed while createEditor was running,
    // destroy the orphaned editor immediately to prevent stale callbacks.
    if (!isMounted) {
      createdEditor.destroy();
      return;
    }

    editor = createdEditor;
    isReady = true;
    onEditorReady?.(editor);

    // Restore cursor position from store and focus (delay for DOM readiness)
    const proseMirrorEl = editorEl.querySelector('.ProseMirror') as HTMLElement | null;
    const savedOffset = editorStore.getState().cursorOffset;
    const savedScrollFraction = editorStore.getState().scrollFraction;
    await tick();
    requestAnimationFrame(() => {
      if (!editor) return;

      // 1. Restore cursor position
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const docSize = view.state.doc.content.size;
          // Map markdown offset to ProseMirror position using fraction
          const fraction = content.length > 0 ? savedOffset / content.length : 0;
          let pmPos = Math.round(fraction * docSize);
          // Clamp to valid range (1 .. docSize-1)
          pmPos = Math.max(1, Math.min(pmPos, Math.max(1, docSize - 1)));
          // Resolve to nearest valid text position
          const resolved = view.state.doc.resolve(pmPos);
          const sel = TextSelection.near(resolved);
          // Don't use scrollIntoView — we restore scroll position separately
          view.dispatch(view.state.tr.setSelection(sel));
          view.focus();
        });
      } catch {
        // Fallback: just focus
        if (proseMirrorEl) proseMirrorEl.focus();
      }

      // 2. Restore scroll position (overrides any scroll caused by focus)
      const wrapper = editorEl?.closest('.editor-wrapper') as HTMLElement | null;
      if (savedOffset === 0 && savedScrollFraction === 0) {
        if (wrapper) wrapper.scrollTop = 0;
      } else if (wrapper) {
        const maxScroll = wrapper.scrollHeight - wrapper.clientHeight;
        if (maxScroll > 0) {
          wrapper.scrollTop = Math.round(savedScrollFraction * maxScroll);
        }
      }
    });

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

    // Suppress native WKWebView context menu (Reload / Inspect Element) for editor area.
    // Must use capture phase to intercept before the native handler.
    editorEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    }, true);

    // Listen for selection changes to show/hide table toolbar
    if (proseMirrorEl) {
      proseMirrorEl.addEventListener('click', updateTableToolbar);
      proseMirrorEl.addEventListener('click', handleImageClick as EventListener);
      proseMirrorEl.addEventListener('click', handleCheckboxClick as EventListener);
      proseMirrorEl.addEventListener('mousemove', handleCheckboxHover as EventListener);
      proseMirrorEl.addEventListener('keyup', updateTableToolbar);
      proseMirrorEl.addEventListener('paste', handlePaste as EventListener);
      proseMirrorEl.addEventListener('contextmenu', handleContextMenu as EventListener);
    }

    // Prevent default browser drop behavior on editor
    editorEl.addEventListener('dragover', (e) => e.preventDefault());
    editorEl.addEventListener('drop', (e) => e.preventDefault());

    // Listen for Tauri drag-drop events (provides file paths + drop position)
    if (!isTauri) return;
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
      } catch (e) {
        console.warn('[Image] Drop position resolution failed:', e);
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
          const target = settingsStore.getDefaultImageHostTarget();
          if (target?.autoUpload) {
            uploadAndReplace(blobUrl, targetToConfig(target));
          }
        } catch (e) {
          console.warn('[Image] Failed to read/insert image file:', imgPath, e);
        }
      }
    });
  });

  // ── Sync external content changes to Milkdown (split mode) ──
  // Debounced to avoid rebuilding the ProseMirror document on every keystroke.
  function applySyncToMilkdown(md: string) {
    if (!editor || !isReady) return;
    // Re-extract frontmatter in case user edited it in source mode
    const { frontmatter, body } = extractFrontmatter(md);
    storedFrontmatter = frontmatter;

    const milkdownContent = getMarkdown(editor);
    const visualContent = toHardBreaks(body);
    if (visualContent !== milkdownContent) {
      try {
        syncingFromExternal = true;
        lastSyncWasExternal = true;
        if (syncResetTimer) clearTimeout(syncResetTimer);
        editor.action(replaceAll(visualContent));
      } catch { /* ignore during init */ }
      // The lazy-change plugin debounces onChange by 100ms (setup.ts).
      // Keep syncingFromExternal=true until after that fires so the
      // reformatted markdown doesn't flow back to the source editor.
      syncResetTimer = setTimeout(() => { syncingFromExternal = false; }, 200);
    }
  }

  // Track whether $effect has run at least once (skip first run = initial mount).
  // On mount, the editor is already initialized with `defaultValue: content`,
  // so applying replaceAll immediately would double-process the markdown and
  // corrupt backslash escapes.
  let effectMounted = false;

  $effect(() => {
    const current = content;
    if (!effectMounted) {
      effectMounted = true;
      return;
    }
    if (internalChange) {
      internalChange = false;
      return;
    }
    // Debounce: avoid running toHardBreaks + replaceAll on every keystroke
    if (externalSyncTimer) clearTimeout(externalSyncTimer);
    externalSyncTimer = setTimeout(() => applySyncToMilkdown(current), 150);
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

  /**
   * Replace editor content from an external source (file sync, AI, etc.).
   * Updates storedFrontmatter atomically before replaceAll to prevent
   * the onChange callback from re-attaching stale/empty frontmatter.
   */
  export function syncContent(md: string) {
    if (!editor || !isReady) return;
    const { frontmatter, body } = extractFrontmatter(md);
    storedFrontmatter = frontmatter;
    try {
      syncingFromExternal = true;
      if (syncResetTimer) clearTimeout(syncResetTimer);
      editor.action(replaceAll(toHardBreaks(body)));
      syncResetTimer = setTimeout(() => { syncingFromExternal = false; }, 200);
    } catch { /* ignore during init */ }
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
    isMounted = false; // Signal async callbacks to stop
    if (syncResetTimer) clearTimeout(syncResetTimer);
    if (externalSyncTimer) clearTimeout(externalSyncTimer);
    if (tableToolbarRaf) cancelAnimationFrame(tableToolbarRaf);
    if (editor) {
      // Flush content: sync ProseMirror doc to parent before destruction.
      // The lazy change plugin debounces onChange by 100ms, so if the user
      // types then immediately switches mode, the last edits haven't been
      // synced yet. This ensures no content is lost.
      // Skip flush when lastSyncWasExternal=true (split mode, source editor
      // is the source of truth) to avoid polluting content with hard-break
      // trailing spaces added by toHardBreaks().
      if (!lastSyncWasExternal) {
        try {
          const markdown = getMarkdown(editor);
          // Re-attach frontmatter to serialized body
          const full = storedFrontmatter + markdown;
          content = full;
          onContentChange?.(full);
          editorStore.setContent(full);
        } catch {
          // Serialization may fail if editor is partially destroyed
        }
      }

      // Save cursor position
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from } = view.state.selection;
          const docSize = view.state.doc.content.size;
          const fraction = docSize > 0 ? from / docSize : 0;
          const markdownOffset = Math.round(fraction * content.length);
          editorStore.setCursorOffset(markdownOffset);
        });
      } catch {
        // Ignore errors during position save
      }

      // Save scroll fraction for cross-mode restore
      const wrapper = editorEl?.closest('.editor-wrapper') as HTMLElement | null;
      if (wrapper && wrapper.scrollHeight > wrapper.clientHeight) {
        const maxScroll = wrapper.scrollHeight - wrapper.clientHeight;
        editorStore.setScrollFraction(maxScroll > 0 ? wrapper.scrollTop / maxScroll : 0);
      }

      editor.destroy();
    }
    dragDropUnlisten?.();
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
    onContextMenuThrough={handleToolbarContextMenuThrough}
  />
{/if}

{#if showImageMenu}
  <ImageContextMenu
    position={imageMenuPosition}
    imageSrc={imageMenuSrc}
    isUploadable={imageMenuIsUploadable}
    isRemoteUrl={!imageMenuSrc.startsWith('blob:')}
    onResize={handleImageResize}
    onUpload={handleImageUpload}
    onEditAlt={handleImageEditAlt}
    onCopyImage={handleImageCopy}
    onCopyUrl={handleImageCopyUrl}
    onOpenInBrowser={handleImageOpenInBrowser}
    onSaveAs={handleImageSaveAs}
    onDelete={handleImageDelete}
    onClose={() => showImageMenu = false}
  />
{/if}

{#if showAltEditor}
  <ImageAltEditor
    position={altEditorPosition}
    initialValue={altEditorInitialValue}
    onSave={handleAltSave}
    onCancel={() => showAltEditor = false}
  />
{/if}

<style>
  .editor-wrapper {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-width: 0;
    padding: 2rem 3rem;
    visibility: hidden;
    cursor: text;
  }

  .editor-wrapper.ready {
    visibility: visible;
  }

  .editor-root {
    max-width: min(800px, 100%);
    margin: 0 auto;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  /* Reduce padding when viewport is narrow (e.g., AI panel open) */
  @media (max-width: 900px) {
    .editor-wrapper {
      padding: 1.5rem 1.5rem;
    }
  }

  @media (max-width: 600px) {
    .editor-wrapper {
      padding: 1rem 1rem;
    }
  }
</style>

<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { Editor as MilkdownEditor } from '@milkdown/core';
  import { editorViewCtx, parserCtx, schemaCtx, prosePluginsCtx } from '@milkdown/core';
  import { EditorState, TextSelection, AllSelection } from '@milkdown/prose/state';
  import { Slice } from '@milkdown/prose/model';
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
  import OutlinePanel, { type OutlineHeading } from '$lib/components/OutlinePanel.svelte';

  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif']);

  import { extractFrontmatter } from '../utils/frontmatter';

  /** Stored frontmatter block (including `---` fences and trailing newline) */
  let storedFrontmatter = '';

  let editorEl: HTMLDivElement;
  let editor: MilkdownEditor | null = null;

  // Props
  let {
    content = $bindable(''),
    showOutline = false,
    onEditorReady,
    onContentChange,
    onNotify,
  }: {
    content?: string;
    showOutline?: boolean;
    onEditorReady?: (editor: MilkdownEditor) => void;
    onContentChange?: (content: string) => void;
    onNotify?: (text: string, type: 'success' | 'error') => void;
  } = $props();

  let editorLineWidth = $state(settingsStore.getState().editorLineWidth);
  const unsubSettings = settingsStore.subscribe(s => { editorLineWidth = s.editorLineWidth; });

  // ── Outline ──
  let outlineHeadings = $state<OutlineHeading[]>([]);
  let activeHeadingId = $state<string | null>(null);
  let outlineTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollRafOutline: number | undefined;
  let headingTopsRaf: number | undefined; // RAF for computeHeadingTops

  // Cached heading top positions (document-relative, in pixels).
  // Recomputed only when headings change — avoids expensive coordsAtPos
  // calls on every scroll frame that cause layout thrashing.
  let cachedHeadingTops: number[] = [];

  function computeHeadingTops() {
    headingTopsRaf = undefined;
    if (!editor) { cachedHeadingTops = []; return; }
    try {
      const view = editor.ctx.get(editorViewCtx);
      const wrapper = editorEl?.closest('.editor-wrapper') as HTMLElement | null;
      if (!wrapper) { cachedHeadingTops = []; return; }
      const wrapperTop = wrapper.getBoundingClientRect().top;
      const scrollTop = wrapper.scrollTop;
      cachedHeadingTops = outlineHeadings.map(h => {
        const pos = parseInt(h.id.slice(2));
        const coords = view.coordsAtPos(pos);
        return coords.top - wrapperTop + scrollTop;
      });
    } catch { cachedHeadingTops = []; }
  }

  /** Schedule outline heading extraction. Skipped when outline is hidden. */
  function scheduleExtractHeadings() {
    if (!showOutline) return;
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(extractHeadings, 300);
  }

  function extractHeadings() {
    if (!editor || !showOutline) { outlineHeadings = []; cachedHeadingTops = []; return; }
    try {
      const view = editor.ctx.get(editorViewCtx);
      const heads: OutlineHeading[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          heads.push({ id: `h-${pos}`, level: node.attrs.level as number, text: node.textContent });
        }
      });
      outlineHeadings = heads;
      // Recompute positions after DOM has updated; cancel previous pending RAF
      if (headingTopsRaf) cancelAnimationFrame(headingTopsRaf);
      headingTopsRaf = requestAnimationFrame(computeHeadingTops);
    } catch { outlineHeadings = []; cachedHeadingTops = []; }
  }

  function updateActiveHeading() {
    if (outlineHeadings.length === 0 || cachedHeadingTops.length === 0) { activeHeadingId = null; return; }
    const wrapper = editorEl?.closest('.editor-wrapper') as HTMLElement | null;
    if (!wrapper) return;
    const scrollY = wrapper.scrollTop + 80;
    let lastId: string | null = null;
    for (let i = 0; i < outlineHeadings.length; i++) {
      if (cachedHeadingTops[i] <= scrollY) lastId = outlineHeadings[i].id;
      else break;
    }
    activeHeadingId = lastId ?? outlineHeadings[0]?.id ?? null;
  }

  function handleOutlineSelect(h: OutlineHeading) {
    const idx = outlineHeadings.indexOf(h);
    if (idx < 0 || idx >= cachedHeadingTops.length) return;
    const wrapper = editorEl?.closest('.editor-wrapper') as HTMLElement | null;
    if (!wrapper) return;
    wrapper.scrollTo({ top: cachedHeadingTops[idx] - 60, behavior: 'smooth' });
  }

  let isReady = $state(false);
  let isMounted = false; // tracks whether component is still alive (guards async gaps)
  let internalChange = false; // flag to avoid replaceAll loop on Milkdown's own onChange
  let syncingFromExternal = false; // flag to suppress onChange during replaceAll from source editor
  let syncResetTimer: ReturnType<typeof setTimeout> | undefined; // delayed reset for syncingFromExternal
  let lastSyncWasExternal = false; // true when last content came from source editor (split mode)
  let externalSyncTimer: ReturnType<typeof setTimeout> | undefined; // debounce for external content sync
  let tableToolbarRaf: number | undefined; // RAF throttle for table toolbar updates

  // References for event listener cleanup in onDestroy
  let mountedEditorEl: HTMLDivElement | null = null;
  let mountedProseMirrorEl: HTMLElement | null = null;
  let mountedHandlers: {
    handleEditorKeydown: (e: KeyboardEvent) => void;
    handleEditorContextmenu: (e: Event) => void;
    handleDragover: (e: Event) => void;
    handleDrop: (e: Event) => void;
    handleProseMirrorClick: (e: MouseEvent) => void;
  } | null = null;

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

  // Cache for isInsideTable check — avoids redundant depth traversal when
  // cursor position hasn't changed between consecutive keyup/click events.
  let cachedSelFrom = -1;
  let cachedInTable = false;

  function isInsideTable(): boolean {
    if (!editor) return false;
    try {
      return editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from } = view.state.selection;
        if (from === cachedSelFrom) return cachedInTable;
        cachedSelFrom = from;
        const resolvedFrom = view.state.selection.$from;
        for (let d = resolvedFrom.depth; d > 0; d--) {
          const name = resolvedFrom.node(d).type.name;
          if (name === 'table_cell' || name === 'table_header') {
            cachedInTable = true;
            return true;
          }
        }
        cachedInTable = false;
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

  /** Show pointer cursor when hovering over task list checkbox area.
   *  Throttled via rAF to avoid running .closest() + getBoundingClientRect()
   *  hundreds of times per second during mouse movement. */
  let hoverRaf: number | undefined;
  let hoverCursorIsPointer = false;

  function handleCheckboxHover(event: MouseEvent) {
    if (hoverRaf) return; // already scheduled
    const clientX = event.clientX;
    const target = event.target as HTMLElement;
    const pmEl = event.currentTarget as HTMLElement;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = undefined;
      const li = target.closest('li[data-checked]') as HTMLElement | null;
      if (li) {
        const liRect = li.getBoundingClientRect();
        if (clientX <= liRect.left + 4) {
          if (!hoverCursorIsPointer) {
            pmEl.style.cursor = 'pointer';
            hoverCursorIsPointer = true;
          }
          return;
        }
      }
      if (hoverCursorIsPointer) {
        pmEl.style.cursor = '';
        hoverCursorIsPointer = false;
      }
    });
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
        // Single batched store update instead of setDirty + setContent separately
        // (each update triggers all subscribers synchronously; batching halves the cascade)
        editorStore.setDirtyContent(true, full);
        // Debounced outline update (skipped when outline is hidden)
        scheduleExtractHeadings();
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
    if (showOutline) extractHeadings();

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
    const handleEditorKeydown = (e: KeyboardEvent) => {
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
    };
    const handleEditorContextmenu = (e: Event) => { e.preventDefault(); };
    const handleDragover = (e: Event) => { e.preventDefault(); };
    const handleDrop = (e: Event) => { e.preventDefault(); };

    editorEl.addEventListener('keydown', handleEditorKeydown, true);
    // Suppress native WKWebView context menu (Reload / Inspect Element) for editor area.
    editorEl.addEventListener('contextmenu', handleEditorContextmenu, true);

    // Single combined click handler to avoid 3 separate DOM traversals per click.
    // Previously: updateTableToolbar + handleImageClick + handleCheckboxClick as 3 listeners.
    const handleProseMirrorClick = (e: MouseEvent) => {
      handleCheckboxClick(e);
      handleImageClick(e);
      updateTableToolbar();
    };

    if (proseMirrorEl) {
      proseMirrorEl.addEventListener('click', handleProseMirrorClick as EventListener);
      proseMirrorEl.addEventListener('mousemove', handleCheckboxHover as EventListener);
      proseMirrorEl.addEventListener('keyup', updateTableToolbar);
      proseMirrorEl.addEventListener('paste', handlePaste as EventListener);
      proseMirrorEl.addEventListener('contextmenu', handleContextMenu as EventListener);
    }

    // Prevent default browser drop behavior on editor
    editorEl.addEventListener('dragover', handleDragover);
    editorEl.addEventListener('drop', handleDrop);

    // Store references for cleanup in onDestroy
    mountedEditorEl = editorEl;
    mountedProseMirrorEl = proseMirrorEl;
    mountedHandlers = { handleEditorKeydown, handleEditorContextmenu, handleDragover, handleDrop, handleProseMirrorClick };

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
  // Uses addToHistory:false to avoid undo history accumulation.
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
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const parser = ctx.get(parserCtx);
          const doc = parser(visualContent);
          if (!doc) return;
          const tr = view.state.tr.replace(
            0, view.state.doc.content.size,
            new Slice(doc.content, 0, 0),
          );
          tr.setMeta('addToHistory', false);
          view.dispatch(tr);
        });
      } catch { /* ignore during init */ }
      // The lazy-change plugin debounces onChange by 100ms (setup.ts).
      // Keep syncingFromExternal=true until after that fires so the
      // reformatted markdown doesn't flow back to the source editor.
      syncResetTimer = setTimeout(() => { syncingFromExternal = false; }, 200);
    }
    // Refresh outline after external sync (onChange is suppressed by syncingFromExternal)
    scheduleExtractHeadings();
  }

  // Track whether $effect has run at least once (skip first run = initial mount).
  // On mount, the editor is already initialized with `defaultValue: content`,
  // so applying replaceAll immediately would double-process the markdown and
  // corrupt backslash escapes.
  let effectMounted = false;

  // Flag set by syncContent() to tell the $effect to skip its next trigger.
  // Without this, every file switch causes a redundant applySyncToMilkdown()
  // 150ms later (full getMarkdown serialization + compare + possible re-replace).
  let externalSyncDone = false;

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
    if (externalSyncDone) {
      externalSyncDone = false;
      // Clear any pending timer from a previous split-mode sync
      if (externalSyncTimer) clearTimeout(externalSyncTimer);
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
   * Replace editor content from an external source (file switch, AI, etc.).
   * Creates a completely fresh EditorState to reset ALL plugin state (history,
   * decorations, etc.), preventing progressive accumulation across file switches.
   * Without this, the history plugin's addMaps() grows unboundedly and highlight
   * decoration remapping becomes progressively more expensive.
   *
   * The externalSyncDone flag prevents the $effect from scheduling a redundant
   * applySyncToMilkdown() 150ms later (which would serialize the entire document
   * via getMarkdown() — the real source of accumulation lag).
   */
  export function syncContent(md: string) {
    if (!editor || !isReady) return;
    externalSyncDone = true; // Tell $effect to skip redundant applySyncToMilkdown
    const { frontmatter, body } = extractFrontmatter(md);
    storedFrontmatter = frontmatter;
    try {
      syncingFromExternal = true;
      if (syncResetTimer) clearTimeout(syncResetTimer);
      const visualContent = toHardBreaks(body);
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const doc = parser(visualContent);
        if (!doc) return;
        // Flush: create a brand new EditorState instead of dispatching a transaction.
        // This resets all plugin state (history items, decoration sets, etc.)
        // so nothing accumulates across file switches.
        const schema = ctx.get(schemaCtx);
        const plugins = ctx.get(prosePluginsCtx);
        const state = EditorState.create({ schema, doc, plugins });
        view.updateState(state);
      });
      syncResetTimer = setTimeout(() => { syncingFromExternal = false; }, 200);
    } catch { /* ignore during init */ }
    // Reset isInsideTable cache (cursor position changed with new document)
    cachedSelFrom = -1;
    // Outline update: onChange is suppressed by syncingFromExternal, and
    // externalSyncDone blocks the path through applySyncToMilkdown, so
    // we must schedule extraction directly here.
    scheduleExtractHeadings();
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
      // Set selection at match range
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to));
      tr.scrollIntoView();
      view.dispatch(tr);

      // ProseMirror's scrollIntoView may miss the .editor-wrapper scroll container.
      // Manually ensure the match is visible within the wrapper.
      requestAnimationFrame(() => {
        try {
          const coords = view.coordsAtPos(match.from);
          const wrapper = view.dom.closest('.editor-wrapper') as HTMLElement | null;
          if (!wrapper) return;
          const rect = wrapper.getBoundingClientRect();
          if (coords.top < rect.top || coords.bottom > rect.bottom) {
            wrapper.scrollTop += coords.top - rect.top - rect.height / 3;
          }
        } catch { /* ignore */ }
      });
    });
  }

  onDestroy(() => {
    isMounted = false; // Signal async callbacks to stop
    if (syncResetTimer) clearTimeout(syncResetTimer);
    if (externalSyncTimer) clearTimeout(externalSyncTimer);
    if (tableToolbarRaf) cancelAnimationFrame(tableToolbarRaf);
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    if (outlineTimer) clearTimeout(outlineTimer);
    if (scrollRafOutline) cancelAnimationFrame(scrollRafOutline);
    if (headingTopsRaf) cancelAnimationFrame(headingTopsRaf);

    // Remove all event listeners added in onMount to prevent listener accumulation
    // across editor mode switches (visual ↔ source ↔ split).
    if (mountedEditorEl && mountedHandlers) {
      mountedEditorEl.removeEventListener('keydown', mountedHandlers.handleEditorKeydown as EventListener, true);
      mountedEditorEl.removeEventListener('contextmenu', mountedHandlers.handleEditorContextmenu, true);
      mountedEditorEl.removeEventListener('dragover', mountedHandlers.handleDragover);
      mountedEditorEl.removeEventListener('drop', mountedHandlers.handleDrop);
    }
    if (mountedProseMirrorEl && mountedHandlers) {
      mountedProseMirrorEl.removeEventListener('click', mountedHandlers.handleProseMirrorClick as EventListener);
      mountedProseMirrorEl.removeEventListener('mousemove', handleCheckboxHover as EventListener);
      mountedProseMirrorEl.removeEventListener('keyup', updateTableToolbar);
      mountedProseMirrorEl.removeEventListener('paste', handlePaste as EventListener);
      mountedProseMirrorEl.removeEventListener('contextmenu', handleContextMenu as EventListener);
    }
    mountedEditorEl = null;
    mountedProseMirrorEl = null;
    mountedHandlers = null;

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
    unsubSettings();
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="editor-wrapper" class:ready={isReady} class:has-outline={showOutline} onclick={(e) => {
  // Click on empty area → focus editor and place cursor at end
  if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('editor-root')) {
    const pm = editorEl?.querySelector('.ProseMirror') as HTMLElement | null;
    if (pm) pm.focus();
  }
}} onscroll={() => {
  if (!showOutline) return;
  if (scrollRafOutline) return;
  scrollRafOutline = requestAnimationFrame(() => {
    scrollRafOutline = undefined;
    updateActiveHeading();
  });
}}>
  {#if showOutline}
    <OutlinePanel headings={outlineHeadings} activeId={activeHeadingId} onSelect={handleOutlineSelect} />
  {/if}
  <div bind:this={editorEl} class="editor-root" style="max-width: {showOutline ? '100%' : `min(${editorLineWidth}px, 100%)`}"></div>
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
    /* Horizontal padding scales with actual pane width (% is relative to
       containing block), so it shrinks automatically when the editor pane
       is narrowed by sidebar + AI panel on a wide viewport. */
    padding: 2rem clamp(1rem, 4%, 3rem);
    visibility: hidden;
    cursor: text;
  }

  .editor-wrapper.has-outline {
    display: flex;
    align-items: flex-start;
    gap: 0;
    padding-left: clamp(0.5rem, 2%, 1.5rem);
  }

  .editor-wrapper.ready {
    visibility: visible;
  }

  .editor-root {
    width: 100%;
    margin: 0 auto;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .has-outline .editor-root {
    margin: 0;
    flex: 1;
    min-width: 0;
  }
</style>

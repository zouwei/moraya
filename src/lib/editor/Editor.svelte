<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { MorayaEditor } from './setup';
  import { EditorState, TextSelection, AllSelection } from 'prosemirror-state';
  import { Slice } from 'prosemirror-model';
  import { Decoration, DecorationSet } from 'prosemirror-view';
  import {
    addRowBefore,
    addRowAfter,
    addColumnBefore,
    addColumnAfter,
    deleteRow,
    deleteColumn,
  } from 'prosemirror-tables';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { createEditor } from './setup';
  import { schema } from './schema';
  import { parseMarkdown, parseMarkdownAsync, serializeMarkdown } from './markdown';
  import { docCache } from './doc-cache';
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
  let editor: MorayaEditor | null = null;

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
    onEditorReady?: (editor: MorayaEditor) => void;
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
      const view = editor.view;
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
      const view = editor.view;
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
    // When scrolled to the bottom, the last heading may be visible but not yet
    // past the 80px threshold (not enough content below to scroll further).
    // Fix: if at bottom and the last heading is within the viewport, activate it.
    const maxScroll = wrapper.scrollHeight - wrapper.clientHeight;
    if (maxScroll > 0 && wrapper.scrollTop >= maxScroll - 2) {
      const lastTop = cachedHeadingTops[outlineHeadings.length - 1];
      if (lastTop <= wrapper.scrollTop + wrapper.clientHeight) {
        lastId = outlineHeadings[outlineHeadings.length - 1].id;
      }
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
  let internalChange = false; // flag to avoid re-sync loop on editor's own onChange
  let syncingFromExternal = false; // flag to suppress onChange during sync from source editor
  let syncResetTimer: ReturnType<typeof setTimeout> | undefined; // delayed reset for syncingFromExternal
  let lastSyncWasExternal = false; // true when last content came from source editor (split mode)
  let externalSyncTimer: ReturnType<typeof setTimeout> | undefined; // debounce for external content sync
  let tableToolbarRaf: number | undefined; // RAF throttle for table toolbar updates
  let syncGeneration = 0; // Incremented on each syncContent call; stale async callbacks bail out

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
      const view = editor.view;
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
    } catch {
      return false;
    }
  }

  function updateTableToolbarImmediate() {
    if (!editor) return;
    const inTable = isInsideTable();
    if (inTable) {
      try {
        const view = editor.view;
        const { from } = view.state.selection;
        const coords = view.coordsAtPos(from);
        tableToolbarPosition = { top: coords.top, left: coords.left };
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function runTableCmd(cmd: (state: any, dispatch?: any) => boolean) {
    if (!editor) return;
    try {
      cmd(editor.view.state, editor.view.dispatch);
    } catch {
      // Command may fail if selection is invalid
    }
  }

  function handleDeleteRow() {
    if (!editor) return;
    try {
      deleteRow(editor.view.state, editor.view.dispatch);
    } catch {
      // Delete row failed
    }
  }

  function handleDeleteCol() {
    if (!editor) return;
    try {
      deleteColumn(editor.view.state, editor.view.dispatch);
    } catch {
      // Delete column failed
    }
  }

  function handleSetAlign(align: string) {
    if (!editor) return;
    try {
      const view = editor.view;
      const resolvedFrom = view.state.selection.$from;

      // Find current column index and table boundaries
      let colIndex = -1;
      let tableStart = -1;
      let tableEnd = -1;

      for (let d = resolvedFrom.depth; d > 0; d--) {
        const node = resolvedFrom.node(d);
        if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
          colIndex = resolvedFrom.index(d - 1);
        }
        if (node.type.name === 'table') {
          tableStart = resolvedFrom.before(d);
          tableEnd = resolvedFrom.after(d);
          break;
        }
      }

      if (colIndex < 0 || tableStart < 0) return;

      let tr = view.state.tr;
      view.state.doc.nodesBetween(tableStart, tableEnd, (node, pos) => {
        if (node.type.name === 'table_row' || node.type.name === 'table_header_row') {
          let idx = 0;
          node.forEach((cell, offset) => {
            if (idx === colIndex) {
              const cellPos = pos + 1 + offset;
              tr = tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, alignment: align });
            }
            idx++;
          });
          return false; // don't descend into cells
        }
      });

      if (tr.docChanged) {
        view.dispatch(tr);
      }
    } catch {
      // Set align failed
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
      const view = editor.view;
      const node = schema.nodes.image.create({ src, alt: '' });
      const tr = view.state.tr.insert(pos, node);
      view.dispatch(tr);
    } catch (e) {
      console.warn('[Image] insertImageAtPos failed:', e);
    }
  }

  function insertImageAtEnd(src: string) {
    if (!editor) return;
    try {
      const view = editor.view;
      const node = schema.nodes.image.create({ src, alt: '' });
      const tr = view.state.tr.insert(view.state.doc.content.size, node);
      view.dispatch(tr);
    } catch (e) {
      console.warn('[Image] insertImageAtEnd failed:', e);
    }
  }

  function insertImageAtCursor(src: string) {
    if (!editor) return;
    try {
      const view = editor.view;
      const node = schema.nodes.image.create({ src, alt: '' });
      const { from } = view.state.selection;
      const tr = view.state.tr.insert(from, node);
      view.dispatch(tr);
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

      const view = editor.view;

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
        const view = editor.view;
        const pos = view.posAtDOM(imgEl, 0);
        contextMenuTargetPos = pos;

        const node = view.state.doc.nodeAt(pos);
        if (node) {
          const resolved = view.state.doc.resolve(pos + node.nodeSize);
          const sel = TextSelection.near(resolved);
          view.dispatch(view.state.tr.setSelection(sel));
        }
      } catch {
        contextMenuTargetPos = null;
      }
    });
  }

  function handleImageResize(width: string) {
    if (!editor || contextMenuTargetPos === null) return;
    try {
      const view = editor.view;
      const pos = contextMenuTargetPos!;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'image') return;

      const title = width ? `width=${width}` : '';
      const tr = view.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        title,
      });
      view.dispatch(tr);
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
      const view = editor.view;
      const pos = contextMenuTargetPos!;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'image') return;

      altEditorInitialValue = (node.attrs.alt as string) || '';
      altEditorPosition = { ...imageMenuPosition };
      showAltEditor = true;
    } catch {
      // Edit alt failed
    }
  }

  function handleAltSave(newAlt: string) {
    if (!editor || contextMenuTargetPos === null) return;
    try {
      const view = editor.view;
      const pos = contextMenuTargetPos!;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'image') return;

      const tr = view.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        alt: newAlt,
      });
      view.dispatch(tr);
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
      const view = editor.view;
      const pos = contextMenuTargetPos!;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'image') return;

      const tr = view.state.tr.delete(pos, pos + node.nodeSize);
      view.dispatch(tr);
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
      const view = editor.view;
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
        const view = editor.view;
        const pos = view.posAtDOM(imgEl, 0);
        imageToolbarTargetPos = pos;
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
        const view = editor.view;
        const pos = view.posAtDOM(imgEl, 0);
        contextMenuTargetPos = pos;

        const node = view.state.doc.nodeAt(pos);
        if (node) {
          const resolved = view.state.doc.resolve(pos + node.nodeSize);
          const sel = TextSelection.near(resolved);
          view.dispatch(view.state.tr.setSelection(sel));
        }
      } catch {
        contextMenuTargetPos = null;
      }
    });
  }

  function handleToolbarResize(width: string) {
    if (!editor || imageToolbarTargetPos === null) return;
    try {
      const view = editor.view;
      const pos = imageToolbarTargetPos!;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'image') return;

      const title = width ? `width=${width}` : '';
      const tr = view.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        title,
      });
      view.dispatch(tr);
    } catch {
      // Resize failed
    }
    imageToolbarCurrentWidth = width;
  }

  onMount(async () => {
    isMounted = true;

    // Strip frontmatter before editor sees it (avoids `---` → thematic break corruption)
    const { frontmatter, body } = extractFrontmatter(content);
    storedFrontmatter = frontmatter;

    // Split mode needs full markdown serialization (source editor sync via onChange).
    // Visual-only mode uses lightweight dirty tracking (no serialization per-keystroke).
    const needsSerialization = !!onContentChange;

    const editorOptions: Parameters<typeof createEditor>[0] = {
      root: editorEl,
      defaultValue: body,
      onFocus: () => {
        if (isMounted) editorStore.setFocused(true);
      },
      onBlur: () => {
        if (isMounted) editorStore.setFocused(false);
      },
    };

    if (needsSerialization) {
      // Split mode: full serialization every 500ms for SourceEditor sync
      editorOptions.onChange = (markdown) => {
        if (!isMounted) return;
        if (syncingFromExternal) return;
        lastSyncWasExternal = false;
        internalChange = true;
        const full = storedFrontmatter + markdown;
        content = full;
        onContentChange?.(full);
        editorStore.setDirtyContent(true, full);
        scheduleExtractHeadings();
      };
    } else {
      // Visual-only mode: O(1) dirty mark + word count from textContent.
      // No markdown serialization — content is serialized on-demand via getFullMarkdown().
      editorOptions.onDocChanged = (textContent) => {
        if (!isMounted) return;
        if (syncingFromExternal) return;
        lastSyncWasExternal = false;
        editorStore.markDirty();
        editorStore.scheduleWordCountFromText(textContent);
        scheduleExtractHeadings();
      };
    }

    const createdEditor = await createEditor(editorOptions);

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
        const view = editor.view;
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
          const view = editor.view;
          const sel = view.state.selection;
          const docSize = view.state.doc.content.size;
          const isAllSelected =
            sel instanceof AllSelection ||
            (docSize > 0 && sel.from <= 1 && sel.to >= docSize - 1);

          if (isAllSelected) {
            e.preventDefault();
            e.stopPropagation();
            const emptyParagraph = view.state.schema.nodes.paragraph.create();
            const tr = view.state.tr.replaceWith(0, docSize, emptyParagraph);
            tr.setSelection(TextSelection.create(tr.doc, 1));
            view.dispatch(tr);
          }
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
        const view = editor.view;
        const posResult = view.posAtCoords({
          left: position.x,
          top: position.y,
        });
        if (posResult) dropPos = posResult.pos;
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

  // ── Sync external content changes to editor (split mode) ──
  // Debounced to avoid rebuilding the ProseMirror document on every keystroke.
  // Uses addToHistory:false to avoid undo history accumulation.
  function applySyncToEditor(md: string) {
    if (!editor || !isReady) return;
    // Re-extract frontmatter in case user edited it in source mode
    const { frontmatter, body } = extractFrontmatter(md);
    storedFrontmatter = frontmatter;

    const editorContent = editor.getMarkdown();
    const visualContent = toHardBreaks(body);
    if (visualContent !== editorContent) {
      try {
        syncingFromExternal = true;
        lastSyncWasExternal = true;
        if (syncResetTimer) clearTimeout(syncResetTimer);
        const view = editor.view;
        const filePath = editorStore.getState().currentFilePath || '';
        // Check LRU doc cache
        let doc = docCache.get(filePath, visualContent);
        if (!doc) {
          doc = parseMarkdown(visualContent);
          if (!doc) return;
          if (filePath) docCache.set(filePath, visualContent, doc);
        }
        const tr = view.state.tr.replace(
          0, view.state.doc.content.size,
          new Slice(doc.content, 0, 0),
        );
        tr.setMeta('addToHistory', false);
        view.dispatch(tr);
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
  // so applying sync immediately would double-process the markdown and
  // corrupt backslash escapes.
  let effectMounted = false;

  // Flag set by syncContent() to tell the $effect to skip its next trigger.
  // Without this, every file switch causes a redundant applySyncToEditor()
  // 150ms later (full markdown serialization + compare + possible re-sync).
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
    // Debounce: avoid running toHardBreaks + sync on every keystroke
    if (externalSyncTimer) clearTimeout(externalSyncTimer);
    externalSyncTimer = setTimeout(() => applySyncToEditor(current), 150);
  });

  // When outline is toggled on (e.g. after async settings load), extract headings.
  $effect(() => {
    if (showOutline && editor && isReady) {
      extractHeadings();
    }
  });

  // ── Search / Replace ──────────────────────────────────

  interface MatchPos { from: number; to: number }
  let searchMatches: MatchPos[] = [];
  let searchIndex = -1;

  function findTextMatches(text: string, cs: boolean): MatchPos[] {
    if (!editor || !text) return [];
    const matches: MatchPos[] = [];
    const view = editor.view;
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
    return matches;
  }

  function applySearchDecorations(matches: MatchPos[], activeIdx: number) {
    if (!editor) return;
    const view = editor.view;
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
    const view = editor.view;
    const match = searchMatches[searchIndex];
    const tr = view.state.tr.replaceWith(
      match.from,
      match.to,
      view.state.schema.text(replaceWith)
    );
    view.dispatch(tr);
  }

  export function searchReplaceAll(searchStr: string, replaceWith: string, cs: boolean): number {
    if (!editor || !searchStr) return 0;
    const matches = findTextMatches(searchStr, cs);
    if (matches.length === 0) return 0;
    const view = editor.view;
    let tr = view.state.tr;
    for (let i = matches.length - 1; i >= 0; i--) {
      tr = tr.replaceWith(
        matches[i].from,
        matches[i].to,
        view.state.schema.text(replaceWith)
      );
    }
    view.dispatch(tr);
    const count = matches.length;
    clearSearch();
    return count;
  }

  /** Get full markdown including stored frontmatter. */
  export function getFullMarkdown(): string {
    if (!editor) return content;
    try {
      return storedFrontmatter + editor.getMarkdown();
    } catch {
      return content;
    }
  }

  /**
   * Apply a parsed ProseMirror doc to the editor view (two-step sync).
   *
   * Step 1: Dispatch a replace transaction with step maps for efficient DOM update.
   * Step 2: Swap to a fresh EditorState (same doc, reset plugin state).
   */
  function applySyncDoc(doc: import('prosemirror-model').Node) {
    if (!editor) return;
    const view = editor.view;

    // Step 1: Replace via dispatch (proper DOM update with step maps)
    const tr = view.state.tr.replace(
      0, view.state.doc.content.size,
      new Slice(doc.content, 0, 0),
    );
    tr.setMeta('addToHistory', false);
    tr.setMeta('file-switch', true);
    view.dispatch(tr);

    // Step 2: Reset all plugin state by swapping to a fresh EditorState.
    // Place cursor at end of first block (natural editing position for documents
    // with content). Falls back to document start for empty documents.
    const newDoc = view.state.doc;
    let sel: import('prosemirror-state').Selection;
    try {
      const firstChild = newDoc.firstChild;
      if (firstChild && firstChild.content.size > 0) {
        // End of first block's text content: offset 1 (block opening) + content size
        const endPos = 1 + firstChild.content.size;
        sel = TextSelection.create(newDoc, endPos);
      } else {
        sel = TextSelection.atStart(newDoc);
      }
    } catch {
      sel = TextSelection.atStart(newDoc);
    }
    const freshState = EditorState.create({
      schema: view.state.schema,
      doc: newDoc,
      plugins: view.state.plugins,
      selection: sel,
    });
    view.updateState(freshState);

    // Clear any stale search decorations from setProps (they reference old doc positions)
    if (searchMatches.length > 0) {
      searchMatches = [];
      searchIndex = -1;
      (view as any).setProps({ decorations: () => DecorationSet.empty });
    }

    syncResetTimer = setTimeout(() => { syncingFromExternal = false; }, 200);
    cachedSelFrom = -1;
    scheduleExtractHeadings();
  }

  /**
   * Replace editor content from an external source (file switch, AI, etc.).
   *
   * Two-step approach to prevent both cursor lag AND plugin state accumulation:
   * 1. Dispatch a normal replace transaction with addToHistory:false — this gives
   *    ProseMirror proper step maps for efficient, correct DOM reconciliation.
   * 2. Swap to a fresh EditorState built from the SAME doc — the DOM diff is a
   *    no-op (same document), but all plugin state (history items, decoration
   *    sets, etc.) is reset, preventing progressive accumulation.
   *
   * Optimizations:
   * - LRU doc cache: skips parseMarkdown() for previously opened files.
   * - Async parsing: files ≥50KB yield to the event loop via setTimeout(0).
   * - Generation counter: cancels stale async callbacks on rapid file switches.
   *
   * The externalSyncDone flag prevents the $effect from scheduling a redundant
   * applySyncToEditor() 150ms later.
   */
  export function syncContent(md: string) {
    if (!editor || !isReady) return;
    const myGen = ++syncGeneration;
    externalSyncDone = true; // Tell $effect to skip redundant applySyncToEditor
    const { frontmatter, body } = extractFrontmatter(md);
    storedFrontmatter = frontmatter;

    syncingFromExternal = true;
    if (syncResetTimer) clearTimeout(syncResetTimer);
    const visualContent = toHardBreaks(body);
    const filePath = editorStore.getState().currentFilePath || '';

    // Check LRU doc cache first
    const cached = docCache.get(filePath, visualContent);
    if (cached) {
      try { applySyncDoc(cached); } catch { /* ignore during init */ }
      return;
    }

    // Small file: synchronous parse + apply
    if (visualContent.length < 50_000) {
      try {
        const doc = parseMarkdown(visualContent);
        if (!doc) return;
        if (filePath) docCache.set(filePath, visualContent, doc);
        applySyncDoc(doc);
      } catch { /* ignore during init */ }
      return;
    }

    // Large file (≥50KB): async parse to avoid blocking the event loop
    parseMarkdownAsync(visualContent).then(doc => {
      if (myGen !== syncGeneration) return; // Superseded by a newer switch
      if (!editor || !isReady) return;
      if (!doc) return;
      try {
        if (filePath) docCache.set(filePath, visualContent, doc);
        applySyncDoc(doc);
      } catch { /* ignore during init */ }
    });
  }

  export function clearSearch() {
    searchMatches = [];
    searchIndex = -1;
    if (!editor) return;
    try {
      (editor.view as any).setProps({ decorations: () => DecorationSet.empty });
    } catch {
      // Editor may be destroyed
    }
  }

  function scrollToMatch(idx: number) {
    if (!editor || idx < 0 || idx >= searchMatches.length) return;
    const view = editor.view;
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
      // Flush content + save cursor/scroll in a single batched store update.
      // Previously 3 separate calls (setContent + setCursorOffset + setScrollFraction)
      // triggered 3 subscriber cascades. batchFlush merges them into 1.
      let flushContent = content;
      let cursorOffset = 0;
      let scrollFraction = 0;

      // Flush content: sync ProseMirror doc to parent before destruction.
      // Skip flush when lastSyncWasExternal=true (split mode, source editor
      // is the source of truth) to avoid polluting content with hard-break
      // trailing spaces added by toHardBreaks().
      if (!lastSyncWasExternal) {
        try {
          const markdown = editor.getMarkdown();
          const full = storedFrontmatter + markdown;
          flushContent = full;
          content = full;
          onContentChange?.(full);
        } catch {
          // Serialization may fail if editor is partially destroyed
        }
      }

      // Save cursor position
      try {
        const view = editor.view;
        const { from } = view.state.selection;
        const docSize = view.state.doc.content.size;
        const fraction = docSize > 0 ? from / docSize : 0;
        cursorOffset = Math.round(fraction * flushContent.length);
      } catch {
        // Ignore errors during position save
      }

      // Save scroll fraction for cross-mode restore
      const wrapper = editorEl?.closest('.editor-wrapper') as HTMLElement | null;
      if (wrapper && wrapper.scrollHeight > wrapper.clientHeight) {
        const maxScroll = wrapper.scrollHeight - wrapper.clientHeight;
        scrollFraction = maxScroll > 0 ? wrapper.scrollTop / maxScroll : 0;
      }

      // Single batched store update (1 subscriber notification instead of 3)
      editorStore.batchFlush({ content: flushContent, cursorOffset, scrollFraction });

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
  if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('editor-root') || (e.target as HTMLElement).classList.contains('editor-content-area')) {
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
  <div class="editor-content-area" style="max-width: {showOutline ? `${editorLineWidth + 200}px` : `${editorLineWidth}px`}">
    {#if showOutline}
      <OutlinePanel headings={outlineHeadings} activeId={activeHeadingId} onSelect={handleOutlineSelect} />
    {/if}
    <div bind:this={editorEl} class="editor-root"></div>
  </div>
</div>

{#if showTableToolbar}
  <TableToolbar
    position={tableToolbarPosition}
    onAddRowBefore={() => runTableCmd(addRowBefore)}
    onAddRowAfter={() => runTableCmd(addRowAfter)}
    onAddColBefore={() => runTableCmd(addColumnBefore)}
    onAddColAfter={() => runTableCmd(addColumnAfter)}
    onDeleteRow={handleDeleteRow}
    onDeleteCol={handleDeleteCol}
    onAlignLeft={() => handleSetAlign('left')}
    onAlignCenter={() => handleSetAlign('center')}
    onAlignRight={() => handleSetAlign('right')}
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

  .editor-wrapper.ready {
    visibility: visible;
  }

  /* Inner centering container: constrains total width and centers with auto margins.
     Without outline: max-width = editorLineWidth (e.g. 800px).
     With outline: max-width = editorLineWidth + 200px (outline width). */
  .editor-content-area {
    width: 100%;
    margin: 0 auto;
  }

  .has-outline .editor-content-area {
    display: flex;
    align-items: flex-start;
  }

  .editor-root {
    width: 100%;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .has-outline .editor-root {
    flex: 1;
    min-width: 0;
  }
</style>

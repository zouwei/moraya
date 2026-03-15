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
    deleteTable,
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
  import TableContextMenu from './TableContextMenu.svelte';
  import ImageContextMenu from './ImageContextMenu.svelte';
  import ImageToolbar from './ImageToolbar.svelte';
  import ImageAltEditor from './ImageAltEditor.svelte';
  import OutlinePanel, { type OutlineHeading } from '$lib/components/OutlinePanel.svelte';

  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif']);

  import { extractFrontmatter } from '../utils/frontmatter';
  import { t } from '$lib/i18n';
  import { get } from 'svelte/store';
  import { pluginStore } from '$lib/services/plugin';
  import { filesStore } from '$lib/stores/files-store';
  import type { InstalledPlugin } from '$lib/services/plugin/types';
  import PluginContextMenu from './PluginContextMenu.svelte';

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
    // Immediately mark the clicked item as active so the UI reflects the click
    // even before the scroll event fires (scroll-based updateActiveHeading may
    // not fire if the target is already near the current scroll position).
    activeHeadingId = h.id;
    wrapper.scrollTo({ top: cachedHeadingTops[idx] - 60, behavior: 'smooth' });
  }

  let isReady = $state(false);
  let pendingSyncMd: string | null = null; // content requested before editor was ready
  let isMounted = false; // tracks whether component is still alive (guards async gaps)
  let internalChange = false; // flag to avoid re-sync loop on editor's own onChange
  let syncingFromExternal = false; // flag to suppress onChange during sync from source editor
  let syncResetTimer: ReturnType<typeof setTimeout> | undefined; // delayed reset for syncingFromExternal
  let lastSyncWasExternal = false; // true when last content came from source editor (split mode)
  let externalSyncTimer: ReturnType<typeof setTimeout> | undefined; // debounce for external content sync
  let lastSyncedMd = ''; // tracks last markdown synced to editor to avoid redundant getMarkdown()
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
      // - current line is NOT a GFM table row (starts with |) — table rows must not
      //   get trailing spaces or markdown-it will fail to detect the table structure
      // - next line is NOT a GFM table row — same reason (protects the header line)
      const nextLine = lines[i + 1];
      const isTableRow = line.trimStart().startsWith('|');
      const nextIsTableRow = nextLine !== undefined && nextLine.trimStart().startsWith('|');
      if (
        line.length > 0 &&
        !line.endsWith('  ') &&
        !line.endsWith('\\') &&
        !isTableRow &&
        !nextIsTableRow &&
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
  let showTableMenu = $state(false);
  let tableMenuPosition = $state({ top: 0, left: 0 });

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

  // Plugin context menu state
  let showPluginMenu = $state(false);
  let pluginMenuPosition = $state({ top: 0, left: 0 });
  let pluginMenuPlugins = $state<InstalledPlugin[]>([]);
  let pluginInvokingId = $state<string | null>(null);

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

  /** Get the markdown source of the current table node, or null if not in a table. */
  function getTableMarkdown(): string | null {
    if (!editor) return null;
    try {
      const view = editor.view;
      const selFrom = view.state.selection.$from;
      for (let d = selFrom.depth; d > 0; d--) {
        if (selFrom.node(d).type.name === 'table') {
          const tableNode = selFrom.node(d);
          const tempDoc = schema.node('doc', null, [tableNode]);
          return serializeMarkdown(tempDoc).trim();
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Format a markdown table with padded columns for readability. */
  function formatMarkdownTable(md: string): string {
    const lines = md.trim().split('\n').filter(l => l.trim().startsWith('|'));
    if (lines.length < 2) return md;
    const rows = lines.map(line =>
      line.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim())
    );
    const colCount = Math.max(...rows.map(r => r.length));
    const normalized = rows.map(r => {
      while (r.length < colCount) r.push('');
      return r;
    });
    const widths: number[] = Array(colCount).fill(3);
    normalized.forEach((row, ri) => {
      if (ri === 1) return;
      row.forEach((cell, ci) => { widths[ci] = Math.max(widths[ci], cell.length); });
    });
    return normalized.map((row, ri) => {
      const cells = row.map((cell, ci) => {
        const w = widths[ci];
        if (ri === 1) {
          if (cell.startsWith(':') && cell.endsWith(':')) return ':' + '-'.repeat(Math.max(w - 2, 1)) + ':';
          if (cell.endsWith(':')) return '-'.repeat(Math.max(w - 1, 1)) + ':';
          if (cell.startsWith(':')) return ':' + '-'.repeat(Math.max(w - 1, 1));
          return '-'.repeat(w);
        }
        return cell.padEnd(w);
      });
      return '| ' + cells.join(' | ') + ' |';
    }).join('\n');
  }

  function handleCopyTable() {
    const md = getTableMarkdown();
    if (!md) return;
    navigator.clipboard.writeText(md).then(() => {
      onNotify?.(get(t)('table.copied'), 'success');
    });
  }

  function handleFormatTableSource() {
    const md = getTableMarkdown();
    if (!md) return;
    const formatted = formatMarkdownTable(md);
    navigator.clipboard.writeText(formatted).then(() => {
      onNotify?.(get(t)('table.formattedCopied'), 'success');
    });
  }

  function handleDeleteTable() {
    if (!editor) return;
    try {
      deleteTable(editor.view.state, editor.view.dispatch);
    } catch {
      // Delete table failed
    }
  }

  /** Invoke a plugin with the current editor content (Gap 1+2+3). */
  async function handlePluginAction(pluginId: string) {
    pluginInvokingId = pluginId;
    try {
      // Gap 1: read current editor markdown
      const markdown = getFullMarkdown();

      // Gap 3: get active knowledge base directory
      const filesState = filesStore.getState();
      const activeKb = filesState.knowledgeBases.find(
        kb => kb.id === filesState.activeKnowledgeBaseId
      );
      const kbDir = activeKb?.path ?? null;

      const filePath = editorStore.getState().currentFilePath ?? null;

      const result = await pluginStore.invokePlugin(pluginId, 'run', {
        markdown,
        filePath,
        kbDir,
      }) as { markdown?: string } | null;

      // Gap 2: write modified content back to editor
      if (result && typeof result.markdown === 'string' && result.markdown !== markdown) {
        syncContent(result.markdown);
        onNotify?.(get(t)('pluginAction.success'), 'success');
      } else {
        onNotify?.(get(t)('pluginAction.noChanges'), 'success');
      }
    } catch (e) {
      onNotify?.(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      pluginInvokingId = null;
      showPluginMenu = false;
    }
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
      // For right-click uploads with a known position, use fetchImageForNode to correctly
      // handle local relative paths (where imgEl.src is tauri://localhost/... in production).
      // For auto-upload (paste/drop), targetPos may be null and imageSrc is always a blob: URL.
      const blob = (targetPos != null)
        ? await fetchImageForNode()
        : await fetchImageAsBlob(imageSrc);
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

  /** Walk up DOM tree to check if element is inside a table cell (td/th). */
  function isInsideTableEl(el: HTMLElement): boolean {
    let node: HTMLElement | null = el;
    while (node && node !== mountedProseMirrorEl) {
      if (node.tagName === 'TD' || node.tagName === 'TH') return true;
      node = node.parentElement;
    }
    return false;
  }

  /** Handle right-click: image context menu, table context menu, or plugin menu */
  function handleContextMenu(event: MouseEvent) {
    const target = event.target as HTMLElement;

    // Table right-click — show table context menu
    if (isInsideTableEl(target)) {
      event.preventDefault();
      event.stopPropagation();
      tableMenuPosition = { top: event.clientY, left: event.clientX };
      showTableMenu = true;
      return;
    }

    // Image right-click — handled below
    if (target.tagName !== 'IMG') {
      // Gap 4: general editor right-click — show plugin context menu
      const running = get(pluginStore).installed.filter(
        p => p.enabled && p.processState === 'running'
      );
      if (running.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        pluginMenuPosition = { top: event.clientY, left: event.clientX };
        pluginMenuPlugins = running;
        showPluginMenu = true;
      }
      return;
    }

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

  /**
   * Fetch the image at the current context menu position as a Blob.
   * Uses the ProseMirror node's raw attrs.src to resolve local relative paths
   * correctly in production Tauri (where imgEl.src is tauri://localhost/... which
   * tauriFetch cannot handle). Falls back to imageMenuSrc for blob:/https: URLs.
   */
  async function fetchImageForNode(): Promise<Blob> {
    if (editor && contextMenuTargetPos !== null) {
      const node = editor.view.state.doc.nodeAt(contextMenuTargetPos);
      const rawSrc = node?.attrs.src as string | undefined;
      // Local path (relative or absolute, not a URL scheme)
      if (rawSrc && !rawSrc.startsWith('blob:') && !rawSrc.startsWith('http') && !rawSrc.startsWith('data:') && !rawSrc.startsWith('tauri:')) {
        const currentFilePath = editorStore.getState().currentFilePath || '';
        const dir = currentFilePath ? currentFilePath.split('/').slice(0, -1).join('/') : '';
        const absPath = !rawSrc.startsWith('/') && dir
          ? `${dir}/${rawSrc.replace(/^\.\//, '')}`
          : rawSrc;
        const blobUrl = await readImageAsBlobUrl(absPath);
        const res = await fetch(blobUrl);
        URL.revokeObjectURL(blobUrl);
        return res.blob();
      }
    }
    return fetchImageAsBlob(imageMenuSrc);
  }

  async function handleImageCopy() {
    try {
      const srcBlob = await fetchImageForNode();
      // Convert to PNG via canvas (normalizes format and resolves image/png ClipboardItem)
      const pngBlob = await new Promise<Blob>((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(srcBlob);
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(objectUrl);
          canvas.toBlob((b) => {
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
      // Write pre-resolved Blob (not Promise) — WKWebView handles this more reliably
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    } catch {
      // Last resort: copy the URL as text
      await navigator.clipboard.writeText(imageMenuSrc).catch(() => {});
    }
  }

  function handleImageOpenInBrowser() {
    if (imageMenuSrc && !imageMenuSrc.startsWith('blob:')) {
      openUrl(imageMenuSrc);
    }
  }

  async function handleImageSaveAs() {
    // Show the save dialog FIRST so it always appears regardless of fetch outcome
    const ext = getImageExtension(imageMenuSrc, '');
    const path = await saveDialog({
      defaultPath: `image.${ext}`,
      filters: [{ name: 'Image', extensions: [ext, 'png', 'jpg', 'webp'].filter((v, i, a) => a.indexOf(v) === i) }],
    }).catch(() => null);
    if (!path || typeof path !== 'string') return;

    try {
      const blob = await fetchImageForNode();
      const actualExt = getImageExtension(imageMenuSrc, blob.type);
      const finalPath = path.match(/\.\w+$/) ? path : `${path}.${actualExt}`;

      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      await invoke('write_file_binary', { path: finalPath, base64Data: base64 });
    } catch (e) {
      onNotify?.(e instanceof Error ? e.message : String(e), 'error');
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

    // Safety timeout: if createEditor takes too long (e.g. dynamic import hangs),
    // make the wrapper visible so the user doesn't see a permanently blank area.
    const readyTimeout = setTimeout(() => {
      if (!isReady) {
        console.warn('[Editor] createEditor timed out after 5s, forcing visibility');
        isReady = true;
      }
    }, 5000);

    // Strip frontmatter before editor sees it (avoids `---` → thematic break corruption)
    // Defensive: if content is empty but editorStore has content, recover from store.
    // This handles potential Svelte 5 reactivity edge cases during mode switch.
    let effectiveContent = content;
    if (effectiveContent.length === 0) {
      const storeState = editorStore.getState();
      if (storeState.content.length > 0) {
        console.warn('[Editor] content prop empty but store has content, recovering:', storeState.content.length);
        effectiveContent = storeState.content;
        content = effectiveContent;
      }
    }
    console.log('[Editor] onMount content length:', effectiveContent.length, 'preview:', JSON.stringify(effectiveContent.slice(0, 100)));
    const { frontmatter, body } = extractFrontmatter(effectiveContent);
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
      // Split mode: full serialization every 150ms for SourceEditor sync
      editorOptions.changeDebounceMs = 150;
      editorOptions.onChange = (markdown) => {
        if (!isMounted) return;
        if (syncingFromExternal) return;
        lastSyncWasExternal = false;
        internalChange = true;
        const full = storedFrontmatter + markdown;
        lastSyncedMd = full; // Prevent applySyncToEditor from re-syncing this content back
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

    let createdEditor: MorayaEditor;
    try {
      createdEditor = await createEditor(editorOptions);
    } catch (err) {
      console.error('[Editor] createEditor failed:', err);
      clearTimeout(readyTimeout);
      isReady = true; // Make wrapper visible so user sees something
      return;
    }
    clearTimeout(readyTimeout);

    // Guard: if component was destroyed while createEditor was running,
    // destroy the orphaned editor immediately to prevent stale callbacks.
    if (!isMounted) {
      createdEditor.destroy();
      return;
    }

    editor = createdEditor;
    isReady = true;
    lastSyncedMd = content; // Initialize for applySyncToEditor dedup
    console.log('[Editor] createEditor done, doc content size:', createdEditor.view.state.doc.content.size, 'textContent length:', createdEditor.view.state.doc.textContent.length);
    onEditorReady?.(editor);
    if (showOutline) extractHeadings();

    // Apply any content that was requested while the editor was still initializing
    if (pendingSyncMd !== null) {
      const md = pendingSyncMd;
      pendingSyncMd = null;
      syncContent(md);
    }

    // Restore cursor position from store and focus (delay for DOM readiness)
    const proseMirrorEl = editorEl.querySelector('.ProseMirror') as HTMLElement | null;
    const savedOffset = editorStore.getState().cursorOffset;
    const savedScrollFraction = editorStore.getState().scrollFraction;
    await tick();
    requestAnimationFrame(() => {
      if (!editor) return;

      // 1. Restore cursor position (source offset → ProseMirror position)
      try {
        const view = editor.view;
        const doc = view.state.doc;
        const docSize = doc.content.size;
        let pmPos: number | null = null;

        // Strategy: suffix-match the markdown text around the cursor in the
        // ProseMirror document's text content, then binary-search for the
        // corresponding ProseMirror position.
        const pmText = doc.textBetween(0, docSize, '\n', '');
        const beforeCursor = content.slice(0, savedOffset);
        const approxFraction = content.length > 0 ? savedOffset / content.length : 0;
        const approxTextIdx = Math.floor(approxFraction * pmText.length);

        for (const suffLen of [30, 20, 10, 5, 3]) {
          if (beforeCursor.length < suffLen) continue;
          const suffix = beforeCursor.slice(-suffLen);
          if (!suffix.trim()) continue;
          // Search near the estimated position to avoid false matches
          const searchFrom = Math.max(0, approxTextIdx - suffLen * 5);
          const idx = pmText.indexOf(suffix, searchFrom);
          if (idx !== -1) {
            // Binary search: smallest pmPos where textBetween length >= target
            const target = idx + suffLen;
            let lo = 1, hi = docSize;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              try {
                if (doc.textBetween(0, mid, '\n', '').length < target) lo = mid + 1;
                else hi = mid;
              } catch { lo = mid + 1; }
            }
            pmPos = Math.max(1, Math.min(lo, docSize - 1));
            break;
          }
        }

        // Fallback: fraction-based approximation
        if (pmPos === null) {
          pmPos = Math.max(1, Math.min(Math.round(approxFraction * docSize), Math.max(1, docSize - 1)));
        }

        const resolved = doc.resolve(pmPos);
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

    const handleProseMirrorClick = (e: MouseEvent) => {
      handleCheckboxClick(e);
      handleImageClick(e);
    };

    if (proseMirrorEl) {
      proseMirrorEl.addEventListener('click', handleProseMirrorClick as EventListener);
      proseMirrorEl.addEventListener('mousemove', handleCheckboxHover as EventListener);
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
    // Fast string comparison — skip if content unchanged (avoids O(n) getMarkdown)
    if (md === lastSyncedMd) return;
    lastSyncedMd = md;

    // Re-extract frontmatter in case user edited it in source mode
    const { frontmatter, body } = extractFrontmatter(md);
    storedFrontmatter = frontmatter;

    const visualContent = toHardBreaks(body);
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
    // The lazy-change plugin debounces onChange by 150ms (split mode).
    // Keep syncingFromExternal=true until after that fires so the
    // reformatted markdown doesn't flow back to the source editor.
    syncResetTimer = setTimeout(() => { syncingFromExternal = false; }, 200);
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
    externalSyncTimer = setTimeout(() => applySyncToEditor(current), 80);
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
  /** Cached search state for regex replace with capture groups */
  let lastSearchRegex: boolean = false;
  let lastSearchPattern: string = '';
  let lastSearchCS: boolean = false;

  const MAX_MATCHES = 10000;

  /**
   * Build flat text from ProseMirror doc with offset mapping.
   * Block boundaries become '\n'. Returns { text, offsets[] } where
   * offsets[i] maps flat text index i to ProseMirror position.
   */
  function buildFlatText(doc: import('prosemirror-model').Node): { text: string; offsets: number[] } {
    const parts: string[] = [];
    const offsets: number[] = [];
    let first = true;
    doc.descendants((node, pos) => {
      if (node.isBlock && node.isTextblock) {
        if (!first) {
          // Insert '\n' for block boundary
          parts.push('\n');
          offsets.push(-1); // -1 = block boundary marker
        }
        first = false;
        // Walk inline content
        node.forEach((child, childOffset) => {
          if (child.isText && child.text) {
            for (let i = 0; i < child.text.length; i++) {
              parts.push(child.text[i]);
              offsets.push(pos + 1 + childOffset + i);
            }
          }
        });
        return false; // don't descend further
      }
      return true;
    });
    return { text: parts.join(''), offsets };
  }

  /**
   * Convert flat text match range to ProseMirror MatchPos[].
   * A single flat-text match may span multiple blocks, producing
   * multiple ProseMirror ranges (one per block segment).
   */
  function flatRangeToPmRanges(offsets: number[], start: number, end: number): MatchPos[] {
    const ranges: MatchPos[] = [];
    let segStart = -1;
    for (let i = start; i < end; i++) {
      if (offsets[i] === -1) {
        // Block boundary — flush current segment
        if (segStart >= 0) {
          ranges.push({ from: segStart, to: offsets[i - 1] + 1 });
          segStart = -1;
        }
      } else {
        if (segStart < 0) segStart = offsets[i];
      }
    }
    if (segStart >= 0 && end > start) {
      const lastIdx = end - 1;
      // Walk backwards to find last non-boundary offset
      for (let i = lastIdx; i >= start; i--) {
        if (offsets[i] !== -1) {
          ranges.push({ from: segStart, to: offsets[i] + 1 });
          break;
        }
      }
    }
    return ranges;
  }

  function findTextMatches(text: string, cs: boolean, useRegex: boolean = false): MatchPos[] | { error: string } {
    if (!editor || !text) return [];
    const view = editor.view;
    const { text: flatText, offsets } = buildFlatText(view.state.doc);

    if (useRegex) {
      let regex: RegExp;
      try {
        regex = new RegExp(text, cs ? 'gm' : 'gim');
      } catch (e) {
        return { error: (e as Error).message };
      }
      const matches: MatchPos[] = [];
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = regex.exec(flatText)) !== null) {
        if (m[0].length === 0) { regex.lastIndex++; continue; }
        const pmRanges = flatRangeToPmRanges(offsets, m.index, m.index + m[0].length);
        // For decoration we use the first range (primary match)
        if (pmRanges.length > 0) {
          matches.push({ from: pmRanges[0].from, to: pmRanges[pmRanges.length - 1].to });
        }
        if (++count >= MAX_MATCHES) break;
      }
      return matches;
    }

    // Plain text search (supports multi-line via flat text)
    const haystack = cs ? flatText : flatText.toLowerCase();
    const needle = cs ? text : text.toLowerCase();
    const matches: MatchPos[] = [];
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
      const pmRanges = flatRangeToPmRanges(offsets, idx, idx + needle.length);
      if (pmRanges.length > 0) {
        matches.push({ from: pmRanges[0].from, to: pmRanges[pmRanges.length - 1].to });
      }
      idx += needle.length;
      if (matches.length >= MAX_MATCHES) break;
    }
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

  export function searchText(text: string, cs: boolean, useRegex: boolean = false): number | { error: string } {
    lastSearchRegex = useRegex;
    lastSearchPattern = text;
    lastSearchCS = cs;
    const result = findTextMatches(text, cs, useRegex);
    if ('error' in result) {
      searchMatches = [];
      searchIndex = -1;
      applySearchDecorations([], -1);
      return result;
    }
    searchMatches = result;
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

    let replacement = replaceWith;
    // Regex capture group replacement: re-run regex on matched text
    if (lastSearchRegex && lastSearchPattern) {
      try {
        const regex = new RegExp(lastSearchPattern, lastSearchCS ? '' : 'i');
        const { text: flatText } = buildFlatText(view.state.doc);
        // Find the matched flat text substring for this match position
        const matchedText = getMatchedFlatText(view.state.doc, match);
        replacement = matchedText.replace(regex, replaceWith);
      } catch {
        // Fall through to literal replacement
      }
    }

    const tr = view.state.tr.replaceWith(
      match.from,
      match.to,
      view.state.schema.text(replacement)
    );
    view.dispatch(tr);
  }

  /** Extract the text matched by a ProseMirror range, including cross-block '\n'. */
  function getMatchedFlatText(doc: import('prosemirror-model').Node, match: MatchPos): string {
    const parts: string[] = [];
    doc.nodesBetween(match.from, match.to, (node, pos) => {
      if (node.isTextblock) {
        if (parts.length > 0) parts.push('\n');
        const startInNode = Math.max(match.from - pos - 1, 0);
        const endInNode = Math.min(match.to - pos - 1, node.content.size);
        if (endInNode > startInNode) {
          parts.push(node.textBetween(startInNode, endInNode));
        }
        return false;
      }
      return true;
    });
    return parts.join('');
  }

  export function searchReplaceAll(searchStr: string, replaceWith: string, cs: boolean, useRegex: boolean = false): number {
    if (!editor || !searchStr) return 0;
    const result = findTextMatches(searchStr, cs, useRegex);
    if ('error' in result || result.length === 0) return 0;
    const matches = result;
    const view = editor.view;
    let tr = view.state.tr;

    if (useRegex) {
      // Regex replace: process each match with capture groups
      try {
        const regex = new RegExp(searchStr, cs ? '' : 'i');
        for (let i = matches.length - 1; i >= 0; i--) {
          const matchedText = getMatchedFlatText(view.state.doc, matches[i]);
          const replacement = matchedText.replace(regex, replaceWith);
          tr = tr.replaceWith(
            matches[i].from,
            matches[i].to,
            view.state.schema.text(replacement)
          );
        }
      } catch {
        // Fallback to literal replacement
        for (let i = matches.length - 1; i >= 0; i--) {
          tr = tr.replaceWith(matches[i].from, matches[i].to, view.state.schema.text(replaceWith));
        }
      }
    } else {
      for (let i = matches.length - 1; i >= 0; i--) {
        tr = tr.replaceWith(
          matches[i].from,
          matches[i].to,
          view.state.schema.text(replaceWith)
        );
      }
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
    if (!editor || !isReady) {
      pendingSyncMd = md; // Save for when editor finishes initializing
      return;
    }
    lastSyncedMd = md; // Track for applySyncToEditor dedup
    const myGen = ++syncGeneration;
    // NOTE: externalSyncDone is set AFTER applySyncDoc succeeds (not here at the top).
    // If parsing or applying fails silently (caught by try/catch), externalSyncDone stays
    // false so the $effect's 150ms fallback timer can still run and recover.
    const { frontmatter, body } = extractFrontmatter(md);
    storedFrontmatter = frontmatter;

    syncingFromExternal = true;
    if (syncResetTimer) clearTimeout(syncResetTimer);
    const visualContent = toHardBreaks(body);
    const filePath = editorStore.getState().currentFilePath || '';

    // Check LRU doc cache first
    const cached = docCache.get(filePath, visualContent);
    if (cached) {
      try {
        applySyncDoc(cached);
        externalSyncDone = true; // Tell $effect to skip redundant applySyncToEditor
      } catch (err) { console.error('[Editor] syncContent applySyncDoc (cached) failed:', err); }
      return;
    }

    // Small file: synchronous parse + apply
    if (visualContent.length < 50_000) {
      try {
        const doc = parseMarkdown(visualContent);
        if (!doc) return;
        if (filePath) docCache.set(filePath, visualContent, doc);
        applySyncDoc(doc);
        externalSyncDone = true; // Tell $effect to skip redundant applySyncToEditor
      } catch (err) { console.error('[Editor] syncContent applySyncDoc failed:', err); }
      return;
    }

    // Large file (≥50KB): async parse to avoid blocking the event loop.
    // externalSyncDone is NOT set synchronously here — the $effect's 150ms timer
    // acts as a fallback while parsing is in progress.
    parseMarkdownAsync(visualContent).then(doc => {
      if (myGen !== syncGeneration) return; // Superseded by a newer switch
      if (!editor || !isReady) return;
      if (!doc) return;
      try {
        if (filePath) docCache.set(filePath, visualContent, doc);
        applySyncDoc(doc);
        externalSyncDone = true; // Prevent $effect timer from re-applying on next content change
      } catch (err) { console.error('[Editor] syncContent applySyncDoc (async) failed:', err); }
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
    if (tableToolbarRaf) cancelAnimationFrame(tableToolbarRaf); // legacy guard, noop
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

      // Save cursor position using text-content matching (fraction-based is inaccurate
      // because ProseMirror positions include node boundary tokens that inflate docSize)
      try {
        const view = editor.view;
        const { from } = view.state.selection;
        const doc = view.state.doc;
        // Get plain text before the cursor (no separator — pure text content)
        const textBefore = doc.textBetween(0, from, '\n', '');
        // Find where this text ends in the markdown string by searching from an approximate
        // position backwards. Use a suffix search: try progressively shorter suffixes until
        // we find a match, then return the end position of the first match.
        const approxFraction = doc.content.size > 0 ? from / doc.content.size : 0;
        const approxPos = Math.floor(approxFraction * flushContent.length);
        // Try suffix lengths: 20 chars, 10 chars, 5 chars, 1 char, fallback to 0
        const suffixLengths = [20, 10, 5, 1];
        let found = false;
        for (const suffLen of suffixLengths) {
          if (textBefore.length < suffLen) continue;
          const suffix = textBefore.slice(-suffLen);
          // Search forward from approxPos - suffix length context
          const searchFrom = Math.max(0, approxPos - suffLen * 3);
          const idx = flushContent.indexOf(suffix, searchFrom);
          if (idx !== -1) {
            cursorOffset = idx + suffix.length;
            found = true;
            break;
          }
        }
        if (!found) {
          // Fallback: use fraction-based approximation
          cursorOffset = approxPos;
        }
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

{#if showPluginMenu}
  <PluginContextMenu
    position={pluginMenuPosition}
    plugins={pluginMenuPlugins}
    invokingId={pluginInvokingId}
    onInvoke={handlePluginAction}
    onClose={() => showPluginMenu = false}
  />
{/if}

{#if showTableMenu}
  <TableContextMenu
    position={tableMenuPosition}
    onAddRowBefore={() => runTableCmd(addRowBefore)}
    onAddRowAfter={() => runTableCmd(addRowAfter)}
    onAddColBefore={() => runTableCmd(addColumnBefore)}
    onAddColAfter={() => runTableCmd(addColumnAfter)}
    onDeleteRow={handleDeleteRow}
    onDeleteCol={handleDeleteCol}
    onCopyTable={handleCopyTable}
    onFormatTableSource={handleFormatTableSource}
    onDeleteTable={handleDeleteTable}
    onClose={() => showTableMenu = false}
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

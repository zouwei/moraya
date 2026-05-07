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
  import { schema, setDocumentBaseDir } from './schema';
  import { parseMarkdown, parseMarkdownAsync, serializeMarkdown } from './markdown';
  import { docCache } from './doc-cache';
  import { editorStore } from '../stores/editor-store';
  import { settingsStore } from '../stores/settings-store';
  import { readImageAsBlobUrl } from '../services/file-service';
  import { uploadImage, fetchImageAsBlob, targetToConfig } from '../services/image-hosting';
  import { aiStore } from '../services/ai';
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
  import katex from 'katex';

  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif']);

  import { extractFrontmatter } from '../utils/frontmatter';
  import { t } from '$lib/i18n';
  import { get } from 'svelte/store';
  import { pluginStore } from '$lib/services/plugin';
  import { filesStore } from '$lib/stores/files-store';
  import type { InstalledPlugin } from '$lib/services/plugin/types';
  import PluginContextMenu from './PluginContextMenu.svelte';
  import EditorContextMenu from './EditorContextMenu.svelte';

  /** Stored frontmatter block (including `---` fences and trailing newline) */
  let storedFrontmatter = '';

  let editorEl: HTMLDivElement;
  let editor: MorayaEditor | null = null;

  // Props
  let {
    content = $bindable(''),
    showOutline = false,
    outlineWidth = 200,
    onEditorReady,
    onContentChange,
    onNotify,
    onOutlineWidthChange,
    onWorkflowSEO,
    onWorkflowImageGen,
    onWorkflowPublish,
    onCursorLineChange,
    onForceShowAIPanel,
    onAddReview,
    onInsertCloudImage,
    onInsertCloudAudio,
    onInsertCloudVideo,
  }: {
    content?: string;
    showOutline?: boolean;
    outlineWidth?: number;
    onEditorReady?: (editor: MorayaEditor) => void;
    onContentChange?: (content: string) => void;
    onNotify?: (text: string, type: 'success' | 'error') => void;
    onOutlineWidthChange?: (width: number) => void;
    onWorkflowSEO?: () => void;
    onWorkflowImageGen?: () => void;
    onWorkflowPublish?: () => void;
    onCursorLineChange?: (lineIndex: number) => void;
    onForceShowAIPanel?: () => void;
    /** Called when the user wants to add a review comment on the selected text. */
    onAddReview?: (selectedText: string, contextBefore: string, contextAfter: string) => void;
    /** Called when user picks cloud insert from context menu; pos = right-click ProseMirror position. */
    onInsertCloudImage?: (pos: number | null) => void;
    onInsertCloudAudio?: (pos: number | null) => void;
    onInsertCloudVideo?: (pos: number | null) => void;
  } = $props();

  let editorLineWidth = $state(settingsStore.getState().editorLineWidth);
  const unsubSettings = settingsStore.subscribe(s => { editorLineWidth = s.editorLineWidth; });

  // ── Scroll container height (for OutlinePanel) ──
  let wrapperHeight = $state(0);

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

  /**
   * Update custom caret overlay position from ProseMirror cursor.
   * Native caret height follows font metrics (~17px for 15px font);
   * custom caret is fixed at 25px to match source mode.
   */
  function updateVisualCaret() {
    if (!editor || !visualCaretEl || !editorEl) return;
    const view = editor.view;
    const sel = view.state.selection;

    if (!sel.empty || !view.hasFocus()) {
      visualCaretEl.style.display = 'none';
      return;
    }

    try {
      const coords = view.coordsAtPos(sel.from);
      const rootRect = editorEl.getBoundingClientRect();
      const nativeH = coords.bottom - coords.top;
      const targetH = 25; // Match source mode line-height
      const offsetY = (targetH - nativeH) / 2;

      visualCaretEl.style.display = 'block';
      visualCaretEl.style.left = `${coords.left - rootRect.left}px`;
      visualCaretEl.style.top = `${coords.top - rootRect.top - offsetY}px`;
      visualCaretEl.style.height = `${targetH}px`;

      // Restart blink: remove class, re-add in next frame
      visualCaretEl.classList.remove('blink');
      if (caretBlinkRaf) cancelAnimationFrame(caretBlinkRaf);
      caretBlinkRaf = requestAnimationFrame(() => {
        caretBlinkRaf = undefined;
        visualCaretEl?.classList.add('blink');
      });
    } catch {
      visualCaretEl.style.display = 'none';
    }
  }

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

  /** Build HTML string for a heading node, rendering math_inline via KaTeX */
  function headingToHtml(node: import('prosemirror-model').Node): string {
    let hasMath = false;
    node.forEach(child => { if (child.type.name === 'math_inline') hasMath = true; });
    if (!hasMath) return '';
    const parts: string[] = [];
    node.forEach(child => {
      if (child.type.name === 'math_inline') {
        const tex = child.textContent;
        try { parts.push(katex.renderToString(tex, { throwOnError: false })); }
        catch { parts.push(tex); }
      } else {
        // Escape HTML for plain text
        parts.push(child.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      }
    });
    return parts.join('');
  }

  function extractHeadings() {
    if (!editor || !showOutline) { outlineHeadings = []; cachedHeadingTops = []; return; }
    try {
      const view = editor.view;
      const heads: OutlineHeading[] = [];
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          const html = headingToHtml(node);
          heads.push({ id: `h-${pos}`, level: node.attrs.level as number, text: node.textContent, ...(html ? { html } : {}) });
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
    // Use scrollTop instead of scrollTo() for better Windows compatibility
    wrapper.scrollTop = cachedHeadingTops[idx] - 60;
  }

  let isReady = $state(false);
  /**
   * Set to a non-null string when createEditor() throws or times out so the
   * user sees something other than a silent blank pane. Critical for diagnosing
   * environment-specific WKWebView/WebView2 failures from bug reports — without
   * this, the only signal is "rendering does not display" with nothing in the
   * UI to copy/paste back to maintainers (e.g. issue #50).
   */
  let initFailure = $state<string | null>(null);
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
  let focusRetryInterval: ReturnType<typeof setInterval> | undefined; // interval for new-window focus retries
  let cursorLineCleanup: (() => void) | null = null; // selectionchange listener for cursor line tracking
  let lastReportedCursorLine = -1; // dedup cursor line reports
  let visualCaretEl: HTMLDivElement | null = null; // Custom caret overlay for consistent 25px height
  let caretBlinkRaf: number | undefined; // RAF for restarting blink animation

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

  /** Cached fallback directory for unsaved documents (lazy-loaded). */
  let cachedDocumentsDir = '';

  /**
   * Update the schema's base directory for resolving relative image paths.
   * For saved files: uses the parent directory of the file.
   * For unsaved files: uses the user's Documents directory.
   */
  function updateDocumentBaseDir(filePath: string): void {
    if (filePath) {
      // Saved file: parent directory
      const sep = filePath.includes('\\') ? '\\' : '/';
      const lastSep = filePath.lastIndexOf(sep);
      setDocumentBaseDir(lastSep > 0 ? filePath.slice(0, lastSep) : '');
    } else if (cachedDocumentsDir) {
      setDocumentBaseDir(cachedDocumentsDir);
    } else {
      // Lazy-load the Documents directory for unsaved files
      import('@tauri-apps/api/path').then(({ documentDir }) => {
        documentDir().then(dir => {
          cachedDocumentsDir = dir;
          setDocumentBaseDir(dir);
        }).catch(() => {});
      }).catch(() => {});
    }
  }

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

  // Editor context menu (workflow items + clipboard)
  let showEditorContextMenu = $state(false);
  let editorContextMenuPosition = $state({ top: 0, left: 0 });
  let editorContextMenuHasSelection = $state(false);
  let editorContextMenuClickPos = $state<number | null>(null);
  let editorContextMenuInSpecialBlock = $state(false);
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
      const sf = view.state.selection.$from;
      for (let d = sf.depth; d > 0; d--) {
        const name = sf.node(d).type.name;
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
      const selF = view.state.selection.$from;
      for (let d = selF.depth; d > 0; d--) {
        if (selF.node(d).type.name === 'table') {
          const tableNode = selF.node(d);
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
      const rFrom = view.state.selection.$from;

      // Find current column index and table boundaries
      let colIndex = -1;
      let tableStart = -1;
      let tableEnd = -1;

      for (let d = rFrom.depth; d > 0; d--) {
        const node = rFrom.node(d);
        if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
          colIndex = rFrom.index(d - 1);
        }
        if (node.type.name === 'table') {
          tableStart = rFrom.before(d);
          tableEnd = rFrom.after(d);
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
          const shortName = (node.attrs.src as string || '').split('/').pop() || 'image';
          view.dispatch(
            view.state.tr.setNodeMarkup(targetPos, undefined, {
              ...node.attrs,
              src: result.url,
            }),
          );
          onForceShowAIPanel?.();
          aiStore.addMessage({
            role: 'assistant',
            content: get(t)('contextMenu.uploadImageSuccess').replace('{name}', shortName),
            timestamp: Date.now(),
            isSuccess: true,
          });
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
        const shortName = imageSrc.split('?')[0].split('#')[0].split('/').pop() || 'image';
        view.dispatch(tr);
        onForceShowAIPanel?.();
        aiStore.addMessage({
          role: 'assistant',
          content: get(t)('contextMenu.uploadImageSuccess').replace('{name}', shortName),
          timestamp: Date.now(),
          isSuccess: true,
        });
      }
    } catch (e) {
      console.warn('[Image] uploadAndReplace failed:', e);
      const errMsg = e instanceof Error ? e.message : String(e);
      const shortName = imageSrc.split('?')[0].split('#')[0].split('/').pop() || 'image';
      onForceShowAIPanel?.();
      aiStore.addMessage({
        role: 'assistant',
        content: get(t)('contextMenu.uploadImageFailed').replace('{name}', shortName).replace('{error}', errMsg),
        timestamp: Date.now(),
        isError: true,
      });
    }
  }

  /**
   * Save a clipboard/dropped image to disk and return the path to use in markdown.
   * - Saved doc in KB: save to {kbRoot}/images/{mirror}/, return relative path from doc
   * - Saved doc outside KB: save to {docDir}/images/, return relative path ./images/...
   * - Unsaved doc: always absolute path (save location unpredictable, relative would break)
   */
  /** Normalize a file path to forward slashes (cross-platform compatibility).
   *  Windows paths like C:\Users\... → C:/Users/... */
  function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
  }

  async function saveImageToDisk(file: File): Promise<string | null> {
    try {
      const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const timestamp = Date.now();
      const filename = `image-${timestamp}.${ext}`;

      // Read file as base64
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);

      const currentFilePath = normalizePath(editorStore.getState().currentFilePath || '');
      const kb = filesStore.getActiveKnowledgeBase?.();
      const kbPath = kb ? normalizePath(kb.path) : '';

      if (kbPath && currentFilePath && currentFilePath.startsWith(kbPath)) {
        // Saved doc inside knowledge base → use KB image directory convention
        const { computeImageDir } = await import('../services/ai/image-path-utils');
        const imageDir = normalizePath(computeImageDir(currentFilePath, kbPath));
        const absPath = `${imageDir}/${filename}`;
        await invoke('write_file_binary', { path: absPath, base64Data: base64 });

        // Compute relative path from document directory
        const docDir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));
        return computeRelativePath(docDir, absPath);
      }

      if (currentFilePath) {
        // Saved doc outside knowledge base → save to {docDir}/images/
        const docDir = currentFilePath.substring(0, currentFilePath.lastIndexOf('/'));
        const imageDir = `${docDir}/images`;
        const absPath = `${imageDir}/${filename}`;
        await invoke('write_file_binary', { path: absPath, base64Data: base64 });
        return `./images/${filename}`;
      }

      // Unsaved doc → always use absolute path (save location is unpredictable,
      // relative paths would break after the user picks an arbitrary save location)
      if (kbPath) {
        const { computeImageDir } = await import('../services/ai/image-path-utils');
        const imageDir = normalizePath(computeImageDir(null, kbPath));
        const absPath = `${imageDir}/${filename}`;
        await invoke('write_file_binary', { path: absPath, base64Data: base64 });
        return absPath;
      }

      const { tempDir } = await import('@tauri-apps/api/path');
      const tmp = normalizePath(await tempDir());
      const absPath = `${tmp}moraya-images/${filename}`;
      await invoke('write_file_binary', { path: absPath, base64Data: base64 });
      return absPath;
    } catch (e) {
      console.warn('[Image] saveImageToDisk failed:', e);
      return null;
    }
  }

  /** Compute a relative path from `fromDir` to `toPath`.
   *  Both paths should be normalized to forward slashes before calling. */
  function computeRelativePath(fromDir: string, toPath: string): string {
    const fromParts = normalizePath(fromDir).split('/').filter(Boolean);
    const toParts = normalizePath(toPath).split('/').filter(Boolean);
    // Find common prefix length
    let common = 0;
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
      common++;
    }
    const ups = fromParts.length - common;
    const remainder = toParts.slice(common).join('/');
    if (ups === 0) return `./${remainder}`;
    return '../'.repeat(ups) + remainder;
  }

  /** Handle paste event for clipboard images.
   *  Must be registered on the capture phase so it runs BEFORE ProseMirror's
   *  default paste handler, which would otherwise insert base64 <img> from HTML. */
  function handlePaste(event: ClipboardEvent) {
    if (!event.clipboardData) return;

    // Check if clipboard contains an image file (blob).
    // This takes priority over HTML content — browsers copying images from web pages
    // include both text/html (with <img src="data:...">) and image/png (blob).
    // We only want one image: the locally saved file, not the base64 from HTML.
    let imageFile: File | null = null;
    const items = event.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        imageFile = items[i].getAsFile();
        if (imageFile) break;
      }
    }

    if (!imageFile) return; // No image in clipboard — let ProseMirror handle text/html

    // Prevent ProseMirror from also processing the HTML (which would insert a base64 image)
    event.preventDefault();
    event.stopImmediatePropagation();

    if (isTauri) {
      // Save image to disk and insert file path
      saveImageToDisk(imageFile).then(path => {
        if (path) {
          insertImageAtCursor(path);
        } else {
          // Fallback to blob URL if save failed
          insertImageAtCursor(URL.createObjectURL(imageFile!));
        }
      });
    } else {
      // Non-Tauri: use blob URL (web preview)
      insertImageAtCursor(URL.createObjectURL(imageFile));
    }

    // Auto-upload if enabled
    const target = settingsStore.getDefaultImageHostTarget();
    if (target?.autoUpload) {
      const blobUrl = URL.createObjectURL(imageFile);
      uploadAndReplace(blobUrl, targetToConfig(target));
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
      // Show editor context menu (clipboard + workflow items)
      event.preventDefault();
      event.stopPropagation();
      editorContextMenuPosition = { top: event.clientY, left: event.clientX };
      editorContextMenuHasSelection = !!(editor && !editor.view.state.selection.empty);

      // Resolve ProseMirror position at click coords for cloud insert
      if (editor) {
        const resolved = editor.view.posAtCoords({ left: event.clientX, top: event.clientY });
        editorContextMenuClickPos = resolved?.pos ?? null;
        // Detect special blocks (code/math/mermaid) — disable cloud insert inside them
        const pos = editorContextMenuClickPos ?? editor.view.state.selection.$from.pos;
        const resolvedPos = editor.view.state.doc.resolve(pos);
        const parentType = resolvedPos.parent.type.name;
        editorContextMenuInSpecialBlock = (
          parentType === 'code_block' ||
          parentType === 'math_block' ||
          parentType === 'mermaid_block' ||
          parentType === 'fence'
        );
      } else {
        editorContextMenuClickPos = null;
        editorContextMenuInSpecialBlock = false;
      }

      showEditorContextMenu = true;
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

  /** Check if document contains at least one image (markdown image node or HTML img tag) */
  function hasDocumentImages(): boolean {
    if (!editor) return false;
    let found = false;
    editor.view.state.doc.descendants(node => {
      if (found) return false;
      if (node.type.name === 'image') { found = true; return false; }
      // html_inline atom with <img> tag
      if (node.type.name === 'html_inline') {
        const val = node.attrs.value as string;
        if (/^<img\s/i.test(val)) { found = true; return false; }
      }
      // html_block containing <img> tags
      if (node.type.name === 'html_block') {
        if (/<img\s/i.test(node.textContent)) { found = true; return false; }
      }
    });
    return found;
  }

  /** Resolve an image source to a Blob for upload */
  async function resolveImageBlob(src: string): Promise<Blob> {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      return fetchImageAsBlob(src);
    }
    if (src.startsWith('blob:') || src.startsWith('data:')) {
      return fetchImageAsBlob(src);
    }
    // Local path — resolve relative to current document
    const currentFilePath = editorStore.getState().currentFilePath || '';
    const dir = currentFilePath ? currentFilePath.split('/').slice(0, -1).join('/') : '';
    const absPath = !src.startsWith('/') && dir
      ? `${dir}/${src.replace(/^\.\//, '')}`
      : src;
    const blobUrl = await readImageAsBlobUrl(absPath);
    const res = await fetch(blobUrl);
    URL.revokeObjectURL(blobUrl);
    return res.blob();
  }

  /** Upload all images in the document to the configured image host */
  async function handleUploadAllImages() {
    if (!editor) return;
    const target = settingsStore.getDefaultImageHostTarget();
    if (!target) {
      onForceShowAIPanel?.();
      aiStore.addMessage({
        role: 'assistant',
        content: get(t)('contextMenu.uploadNoConfig'),
        timestamp: Date.now(),
        isError: true,
      });
      return;
    }
    const config = targetToConfig(target);
    const view = editor.view;

    // 1. Collect all uploadable image sources (deduplicate)
    interface ImageEntry {
      src: string;
      name: string;
      type: 'markdown' | 'html_inline' | 'html_block';
    }
    const seen = new Set<string>();
    const imageList: ImageEntry[] = [];

    // Display-friendly filename from a src (strips query/fragment so base64 `/` in
    // OSS signatures doesn't leak into the "filename" shown in upload messages).
    const filenameOf = (src: string): string => {
      const path = src.split('?')[0].split('#')[0];
      return path.split('/').pop() || 'image';
    };

    view.state.doc.descendants((node) => {
      if (node.type.name === 'image') {
        const src = node.attrs.src as string;
        if (src && !seen.has(src)) {
          seen.add(src);
          imageList.push({ src, name: filenameOf(src), type: 'markdown' });
        }
      }
      if (node.type.name === 'html_inline') {
        const val = node.attrs.value as string;
        if (/^<img\s/i.test(val)) {
          const m = val.match(/src=["']([^"']+)["']/i);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            imageList.push({ src: m[1], name: filenameOf(m[1]), type: 'html_inline' });
          }
        }
      }
      if (node.type.name === 'html_block') {
        const html = node.textContent;
        const imgRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
        let match;
        while ((match = imgRegex.exec(html)) !== null) {
          if (!seen.has(match[1])) {
            seen.add(match[1]);
            imageList.push({ src: match[1], name: filenameOf(match[1]), type: 'html_block' });
          }
        }
      }
    });

    if (imageList.length === 0) return;

    // 2. Show AI panel immediately with "starting upload" message
    onForceShowAIPanel?.();
    const startTs = Date.now();
    aiStore.addMessage({
      role: 'assistant',
      content: get(t)('contextMenu.uploadStarting'),
      timestamp: startTs,
    });

    // 3. Upload each unique source, build old→new URL map
    const urlMap = new Map<string, string>(); // oldSrc → newUrl
    let successCount = 0;
    let firstResult = true;

    for (const img of imageList) {
      try {
        const blob = await resolveImageBlob(img.src);
        const result = await uploadImage(blob, config);
        urlMap.set(img.src, result.url);
        successCount++;

        // Remove "starting" message on first result
        if (firstResult) {
          aiStore.removeMessageByTimestamp(startTs);
          firstResult = false;
        }
        aiStore.addMessage({
          role: 'assistant',
          content: get(t)('contextMenu.uploadImageSuccess').replace('{name}', img.name),
          timestamp: Date.now(),
          isSuccess: true,
        });
      } catch (e) {
        if (firstResult) {
          aiStore.removeMessageByTimestamp(startTs);
          firstResult = false;
        }
        const errMsg = e instanceof Error ? e.message : String(e);
        aiStore.addMessage({
          role: 'assistant',
          content: get(t)('contextMenu.uploadImageFailed').replace('{name}', img.name).replace('{error}', errMsg),
          timestamp: Date.now(),
          isError: true,
        });
      }
    }

    // 4. Replace all matched URLs in the document in one transaction
    if (urlMap.size > 0) {
      const tr = view.state.tr;
      // Collect replacements first, apply in reverse position order for html_block/html_inline
      const htmlReplacements: { pos: number; node: import('prosemirror-model').Node; newContent: string }[] = [];

      view.state.doc.descendants((node, pos) => {
        // Markdown image nodes: setNodeMarkup (no size change)
        if (node.type.name === 'image') {
          const oldSrc = node.attrs.src as string;
          const newUrl = urlMap.get(oldSrc);
          if (newUrl) {
            tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...node.attrs, src: newUrl });
          }
        }
        // html_inline: replace src in the value attribute
        if (node.type.name === 'html_inline') {
          const val = node.attrs.value as string;
          if (/^<img\s/i.test(val)) {
            let newVal = val;
            for (const [oldSrc, newUrl] of urlMap) {
              if (newVal.includes(oldSrc)) {
                newVal = newVal.split(oldSrc).join(newUrl);
              }
            }
            if (newVal !== val) {
              htmlReplacements.push({ pos, node, newContent: newVal });
            }
          }
        }
        // html_block: replace src in text content
        if (node.type.name === 'html_block') {
          const html = node.textContent;
          let newHtml = html;
          for (const [oldSrc, newUrl] of urlMap) {
            if (newHtml.includes(oldSrc)) {
              newHtml = newHtml.split(oldSrc).join(newUrl);
            }
          }
          if (newHtml !== html) {
            htmlReplacements.push({ pos, node, newContent: newHtml });
          }
        }
      });

      // Apply HTML replacements in reverse order (to preserve positions)
      htmlReplacements.sort((a, b) => b.pos - a.pos);
      for (const rep of htmlReplacements) {
        const mappedPos = tr.mapping.map(rep.pos);
        if (rep.node.type.name === 'html_inline') {
          // Atom node: replace with new node that has updated value attr
          tr.setNodeMarkup(mappedPos, undefined, { ...rep.node.attrs, value: rep.newContent });
        } else {
          // html_block: replace text content
          const from = mappedPos + 1; // inside the node
          const to = mappedPos + rep.node.nodeSize - 1;
          tr.replaceWith(from, to, schema.text(rep.newContent));
        }
      }

      if (tr.docChanged) {
        view.dispatch(tr);
      }
    }

    // 5. Summary message
    aiStore.addMessage({
      role: 'assistant',
      content: get(t)('contextMenu.uploadAllComplete')
        .replace('{success}', String(successCount))
        .replace('{total}', String(imageList.length)),
      timestamp: Date.now(),
    });
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
        initFailure = 'Editor initialization timed out after 5s (dynamic import or plugin load may be hanging).';
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

    // Set base dir for relative image resolution before editor renders
    updateDocumentBaseDir(editorStore.getState().currentFilePath || '');

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
      const msg = err instanceof Error
        ? `${err.name}: ${err.message}\n${err.stack ?? ''}`
        : String(err);
      initFailure = msg;
      isReady = true; // Make wrapper visible so user sees the error message
      return;
    }
    clearTimeout(readyTimeout);
    // Editor created successfully — clear any stale timeout-induced failure marker.
    initFailure = null;

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

    // ── Custom caret overlay ──────────────────────────────────
    // Native caret height follows font metrics (~17px for 15px font).
    // Custom caret is fixed at 25px to match source mode.
    visualCaretEl = document.createElement('div');
    visualCaretEl.className = 'visual-custom-caret blink';
    visualCaretEl.setAttribute('aria-hidden', 'true');
    editorEl.appendChild(visualCaretEl);

    // Cursor line reporter for split mode sync
    const reportCursorLine = onCursorLineChange ? () => {
      if (!editor) return;
      const sel = editor.view.state.selection;
      const textBefore = editor.view.state.doc.textBetween(0, sel.from, '\n\n', '');
      const frontmatterLines = storedFrontmatter ? storedFrontmatter.split('\n').length - 1 : 0;
      const lineIndex = frontmatterLines + (textBefore.split('\n').length - 1);
      if (lineIndex !== lastReportedCursorLine) {
        lastReportedCursorLine = lineIndex;
        onCursorLineChange!(lineIndex);
      }
    } : null;

    // Override dispatchTransaction: update caret + cursor line on every transaction
    createdEditor.view.setProps({
      dispatchTransaction(tr) {
        const view = editor!.view;
        const oldFrom = view.state.selection.from;
        view.updateState(view.state.apply(tr));
        updateVisualCaret();
        if (view.state.selection.from !== oldFrom) {
          reportCursorLine?.();
        }
      },
    });

    // Track clicks + focus/blur for caret updates
    const pmEl = editorEl.querySelector('.ProseMirror') as HTMLElement | null;
    const handleCaretMouseup = () => { updateVisualCaret(); reportCursorLine?.(); };
    const handleCaretFocus = () => { requestAnimationFrame(updateVisualCaret); };
    const handleCaretBlur = () => { if (visualCaretEl) visualCaretEl.style.display = 'none'; };
    pmEl?.addEventListener('mouseup', handleCaretMouseup);
    pmEl?.addEventListener('focus', handleCaretFocus);
    pmEl?.addEventListener('blur', handleCaretBlur);
    cursorLineCleanup = () => {
      pmEl?.removeEventListener('mouseup', handleCaretMouseup);
      pmEl?.removeEventListener('focus', handleCaretFocus);
      pmEl?.removeEventListener('blur', handleCaretBlur);
    };

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
      // Uses binary search with doc.cut + serialize + common-prefix comparison.
      // This is the inverse of the visual→source approach: find the PM position
      // whose serialized-cut-doc common prefix length matches the target markdown offset.
      try {
        const view = editor.view;
        const doc = view.state.doc;
        const docSize = doc.content.size;
        const fmLen = storedFrontmatter.length;
        const targetMdPos = savedOffset - fmLen;
        const fullMd = content.slice(fmLen);
        let pmPos: number;

        if (targetMdPos <= 0) {
          pmPos = 1;
        } else if (targetMdPos >= fullMd.length) {
          pmPos = Math.max(1, docSize - 1);
        } else {
          // Helper: compute markdown offset for a given PM position
          const mdOffsetAt = (p: number): number => {
            try {
              const cutMd = serializeMarkdown(doc.cut(0, p)).replace(/\n+$/, '');
              let cl = 0;
              const ml = Math.min(cutMd.length, fullMd.length);
              while (cl < ml && cutMd[cl] === fullMd[cl]) cl++;
              return cl;
            } catch { return 0; }
          };

          // Binary search: find smallest PM position where mdOffset >= targetMdPos
          let lo = 1, hi = docSize;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (mdOffsetAt(mid) < targetMdPos) lo = mid + 1;
            else hi = mid;
          }
          pmPos = Math.max(1, Math.min(lo, docSize - 1));
        }

        const resolved = doc.resolve(pmPos);
        const sel = TextSelection.near(resolved);
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

      // 3. Retry focus for new windows: WKWebView may not be ready on the
      // first attempt (contenteditable needs layout before it accepts focus).
      // Use an interval that retries every 100ms for up to 1.5s, then stops.
      let focusRetries = 0;
      if (focusRetryInterval) clearInterval(focusRetryInterval);
      focusRetryInterval = setInterval(() => {
        if (!editor || focusRetries >= 15) { clearInterval(focusRetryInterval!); focusRetryInterval = undefined; return; }
        try {
          if (editor.view.hasFocus()) { clearInterval(focusRetryInterval!); focusRetryInterval = undefined; return; }
          editor.view.focus();
        } catch { /* editor may have been destroyed */ clearInterval(focusRetryInterval!); focusRetryInterval = undefined; }
        focusRetries++;
      }, 100);
    });

    // ── Fast AllSelection deletion ──────────────────────────────────
    // Capture-phase keydown: when all content is selected, bypass ProseMirror's
    // slow AllSelection deletion path by replacing the entire document content
    // with a single empty paragraph in one fast transaction.
    // The visual caret for the empty paragraph is handled by CSS (editor.css).
    const handleEditorKeydown = (e: KeyboardEvent) => {
      if (e.isComposing) return;

      if ((e.key === 'Backspace' || e.key === 'Delete') && editor) {
        try {
          const view = editor.view;
          const docSize = view.state.doc.content.size;
          if (docSize <= 0) return;

          // On macOS, Cmd+A is handled by the native menu accelerator
          // (PredefinedMenuItem::select_all), which changes the DOM selection
          // but ProseMirror's selectionchange observer may NOT have synced
          // yet — view.state.selection can be STALE. Check multiple sources.

          // Force ProseMirror to process any pending DOM mutations/selection
          // changes so view.state.selection is up-to-date.
          try { (view as any).domObserver?.flush?.(); } catch { /* internal API */ }

          let isAllSelected = false;

          // Check 1: ProseMirror internal selection
          const sel = view.state.selection;
          if (sel instanceof AllSelection ||
              (docSize > 0 && sel.from <= 1 && sel.to >= docSize - 1)) {
            isAllSelected = true;
          }

          // Check 2: DOM Range comparison (robust, no posAtDOM needed)
          // Compare the native selection range against the editor's full content range.
          if (!isAllSelected && docSize > 0) {
            try {
              const domSel = window.getSelection();
              if (domSel && !domSel.isCollapsed && domSel.rangeCount > 0) {
                const range = domSel.getRangeAt(0);
                const editorRange = document.createRange();
                editorRange.selectNodeContents(view.dom);
                // Selection starts at or before editor start AND ends at or after editor end
                if (range.compareBoundaryPoints(Range.START_TO_START, editorRange) <= 0 &&
                    range.compareBoundaryPoints(Range.END_TO_END, editorRange) >= 0) {
                  isAllSelected = true;
                }
              }
            } catch { /* Range API can throw in edge cases */ }
          }

          // Check 3: Text content length comparison (last resort fallback)
          if (!isAllSelected && docSize > 0) {
            try {
              const domSel = window.getSelection();
              if (domSel && !domSel.isCollapsed) {
                const selectedText = domSel.toString();
                const fullText = view.dom.textContent || '';
                if (selectedText.length > 0 && fullText.length > 0 &&
                    selectedText.length >= fullText.length * 0.9) {
                  isAllSelected = true;
                }
              }
            } catch { /* ignore */ }
          }

          if (isAllSelected) {
            e.preventDefault();
            e.stopPropagation();
            const emptyParagraph = view.state.schema.nodes.paragraph.create();
            const tr = view.state.tr.replaceWith(0, docSize, emptyParagraph);
            tr.setSelection(TextSelection.create(tr.doc, 1));
            tr.setMeta('full-delete', true);
            view.dispatch(tr);
            const wrapper = editorEl?.closest('.editor-wrapper') as HTMLElement | null;
            if (wrapper) wrapper.scrollTop = 0;
            requestAnimationFrame(() => {
              try { if (editor && !editor.view.hasFocus()) editor.view.focus(); } catch {}
            });
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
      proseMirrorEl.addEventListener('paste', handlePaste as EventListener, true);
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

    const tr = replacement
      ? view.state.tr.replaceWith(match.from, match.to, view.state.schema.text(replacement))
      : view.state.tr.delete(match.from, match.to);
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

    const replaceNode = (t: typeof tr, from: number, to: number, text: string) =>
      text ? t.replaceWith(from, to, view.state.schema.text(text)) : t.delete(from, to);

    if (useRegex) {
      // Regex replace: process each match with capture groups
      try {
        const regex = new RegExp(searchStr, cs ? '' : 'i');
        for (let i = matches.length - 1; i >= 0; i--) {
          const matchedText = getMatchedFlatText(view.state.doc, matches[i]);
          const replacement = matchedText.replace(regex, replaceWith);
          tr = replaceNode(tr, matches[i].from, matches[i].to, replacement);
        }
      } catch {
        // Fallback to literal replacement
        for (let i = matches.length - 1; i >= 0; i--) {
          tr = replaceNode(tr, matches[i].from, matches[i].to, replaceWith);
        }
      }
    } else {
      for (let i = matches.length - 1; i >= 0; i--) {
        tr = replaceNode(tr, matches[i].from, matches[i].to, replaceWith);
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

    // Update base dir for relative image path resolution in schema.ts toDOM()
    updateDocumentBaseDir(filePath);

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
    if (caretBlinkRaf) cancelAnimationFrame(caretBlinkRaf);
    if (visualCaretEl) { visualCaretEl.remove(); visualCaretEl = null; }
    if (syncResetTimer) clearTimeout(syncResetTimer);
    if (externalSyncTimer) clearTimeout(externalSyncTimer);
    if (focusRetryInterval) clearInterval(focusRetryInterval);
    cursorLineCleanup?.();
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

      mountedProseMirrorEl.removeEventListener('paste', handlePaste as EventListener, true);
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

      // Save cursor position using doc.cut + common-prefix comparison.
      // Serialize the doc up to the cursor, then find the longest common prefix
      // between that output and the full markdown. This correctly handles all
      // inline syntax (marks like **bold**, atoms like $math$, raw HTML, etc.)
      // because both strings go through the same serializer.
      try {
        const view = editor.view;
        const { from } = view.state.selection;
        const doc = view.state.doc;
        const fmLen = storedFrontmatter.length;

        if (from <= 0) {
          cursorOffset = fmLen;
        } else {
          const resolvedFrom = doc.resolve(from);
          const isBlockBoundary = !resolvedFrom.parent.isTextblock;

          // Serialize the doc content before the cursor
          const cutDoc = doc.cut(0, from);
          const cutMd = serializeMarkdown(cutDoc).replace(/\n+$/, '');

          // The cut serialization may include extra closing syntax added by the
          // serializer (e.g., closing **bold**, closing ```, closing $$).
          // Find the longest common prefix with the full markdown body to get the
          // exact cursor position — divergence point = where the closing syntax starts.
          const fullMd = flushContent.slice(fmLen);
          let commonLen = 0;
          const maxLen = Math.min(cutMd.length, fullMd.length);
          while (commonLen < maxLen && cutMd[commonLen] === fullMd[commonLen]) {
            commonLen++;
          }

          cursorOffset = fmLen + commonLen;

          // For block boundaries (cursor between blocks, e.g., NodeSelection on
          // an atom block), advance past inter-block newlines to the next block start
          if (isBlockBoundary && resolvedFrom.nodeAfter) {
            while (cursorOffset < flushContent.length && flushContent[cursorOffset] === '\n') {
              cursorOffset++;
            }
          }
        }
      } catch {
        // Fallback: fraction-based approximation
        const fmLen = storedFrontmatter.length;
        const mdLen = flushContent.length - fmLen;
        const approxFraction = editor ? editor.view.state.selection.from / Math.max(1, editor.view.state.doc.content.size) : 0;
        cursorOffset = fmLen + Math.floor(approxFraction * mdLen);
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
<div class="editor-wrapper" class:ready={isReady} class:has-outline={showOutline} bind:clientHeight={wrapperHeight} oncontextmenu={(e) => {
  // Right-click in empty area below content (outside .ProseMirror) — show editor context menu.
  // Clicks inside .ProseMirror are handled by handleContextMenu (registered on proseMirrorEl)
  // which calls stopPropagation(), so this handler only fires for the empty space.
  handleContextMenu(e);
}} onclick={(e) => {
  // Click on empty area or empty ProseMirror content → focus editor
  const target = e.target as HTMLElement;
  if (target === e.currentTarget || target.classList.contains('editor-root') || target.classList.contains('editor-content-area')) {
    const pm = editorEl?.querySelector('.ProseMirror') as HTMLElement | null;
    if (pm) pm.focus();
  } else if (editor && !editor.view.hasFocus()) {
    // WKWebView may fail to focus contenteditable on click in empty docs
    editor.view.focus();
  }
}} onscroll={() => {
  if (!showOutline) return;
  if (scrollRafOutline) return;
  scrollRafOutline = requestAnimationFrame(() => {
    scrollRafOutline = undefined;
    updateActiveHeading();
  });
}}>
  <div class="editor-content-area" style="max-width: {showOutline ? `${editorLineWidth + outlineWidth}px` : `${editorLineWidth}px`}">
    {#if showOutline}
      <OutlinePanel headings={outlineHeadings} activeId={activeHeadingId} width={outlineWidth} containerHeight={wrapperHeight} onSelect={handleOutlineSelect} onWidthChange={onOutlineWidthChange} />
    {/if}
    <div bind:this={editorEl} class="editor-root"></div>
    {#if initFailure}
      <div class="editor-init-error" role="alert">
        <strong>Editor failed to render.</strong>
        <p>Please open Help → Toggle Developer Tools, copy this message and any console errors into the GitHub issue:</p>
        <pre>{initFailure}</pre>
        <p class="hint">Workaround: switch to <em>Source</em> mode (bottom-right) to view and edit the markdown directly.</p>
      </div>
    {/if}
  </div>
</div>

{#if showEditorContextMenu}
  <EditorContextMenu
    position={editorContextMenuPosition}
    hasImages={hasDocumentImages()}
    hasSelection={editorContextMenuHasSelection}
    inSpecialBlock={editorContextMenuInSpecialBlock}
    onCut={() => { document.execCommand('cut'); }}
    onCopy={() => { document.execCommand('copy'); }}
    onPaste={async () => {
      try {
        const text = await navigator.clipboard.readText();
        editor?.view.dispatch(
          editor.view.state.tr.replaceSelectionWith(
            schema.text(text),
            true
          )
        );
      } catch { /* clipboard permission denied */ }
    }}
    onUploadAllImages={handleUploadAllImages}
    onSEO={() => { onWorkflowSEO?.(); }}
    onImageGen={() => { onWorkflowImageGen?.(); }}
    onPublish={() => { onWorkflowPublish?.(); }}
    onAddReview={onAddReview ? () => {
      if (!editor) return;
      const { from, to } = editor.view.state.selection;
      if (from === to) return;
      const docText = editor.view.state.doc.textContent;
      const selectedText = editor.view.state.doc.textBetween(from, to, ' ');
      const contextBefore = docText.slice(Math.max(0, from - 51), from);
      const contextAfter = docText.slice(to, to + 50);
      onAddReview(selectedText, contextBefore, contextAfter);
    } : undefined}
    onInsertCloudImage={onInsertCloudImage ? () => onInsertCloudImage!(editorContextMenuClickPos) : undefined}
    onInsertCloudAudio={onInsertCloudAudio ? () => onInsertCloudAudio!(editorContextMenuClickPos) : undefined}
    onInsertCloudVideo={onInsertCloudVideo ? () => onInsertCloudVideo!(editorContextMenuClickPos) : undefined}
    onClose={() => showEditorContextMenu = false}
  />
{/if}

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

  /* Visible failure state for createEditor() exceptions / timeouts.
     Without this, environment-specific WebView failures (e.g. issue #50 on
     macOS Monterey 12.7.5 Intel) showed only a blank pane and the user could
     not copy any error to report. */
  .editor-init-error {
    margin: 1rem 0;
    padding: 1rem 1.25rem;
    border: 1px solid var(--border-color, #f0a0a0);
    border-left: 4px solid #d33;
    border-radius: 6px;
    background: var(--surface-1, rgba(220, 50, 50, 0.06));
    color: var(--text-primary, #333);
    font-size: 0.9rem;
    line-height: 1.5;
  }
  .editor-init-error strong {
    color: #d33;
    display: block;
    margin-bottom: 0.5rem;
    font-size: 1rem;
  }
  .editor-init-error pre {
    margin: 0.5rem 0;
    padding: 0.6rem 0.75rem;
    background: rgba(0, 0, 0, 0.05);
    border-radius: 4px;
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
    -webkit-user-select: text;
  }
  .editor-init-error .hint {
    margin: 0.5rem 0 0;
    color: var(--text-muted, #666);
    font-size: 0.85rem;
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
    position: relative;
    width: 100%;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .has-outline .editor-root {
    flex: 1;
    min-width: 0;
  }
</style>

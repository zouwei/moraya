<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { MorayaEditor } from '$lib/editor/setup';
  import { TextSelection } from 'prosemirror-state';
  import {
    setHeading,
    wrapInBlockquote,
    wrapInBulletList,
    wrapInOrderedList,
    insertCodeBlock,
    insertHorizontalRule,
    toggleBold,
    toggleItalic,
    toggleCode,
    toggleLink,
    toggleStrikethrough,
    insertTable,
    insertImage,
    insertMathBlock as insertMathBlockCmd,
  } from '$lib/editor/commands';
  import { undo, redo } from 'prosemirror-history';
  import Editor from '$lib/editor/Editor.svelte';
  import SourceEditor from '$lib/editor/SourceEditor.svelte';
  import SearchBar from '$lib/editor/SearchBar.svelte';
  import type { EditorMode } from '$lib/stores/editor-store';
  import TitleBar from '$lib/components/TitleBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import type { SEOData } from '$lib/services/ai/types';
  import type { PublishResult } from '$lib/services/publish/types';
  import { editorStore } from '$lib/stores/editor-store';
  import { settingsStore, initSettingsStore } from '$lib/stores/settings-store';
  import { filesStore, type FileEntry } from '$lib/stores/files-store';
  import { initAIStore, aiStore, sendChatMessage } from '$lib/services/ai';
  import { initMCPStore, connectAllServers, type MCPTool, type MCPServerConfig } from '$lib/services/mcp';
  import { initContainerManager } from '$lib/services/mcp/container-manager';
  import { preloadEnhancementPlugins } from '$lib/editor/setup';
  import { openFile, saveFile, saveFileAs, loadFile, getFileNameFromPath, readImageAsBlobUrl } from '$lib/services/file-service';
  import { exportDocument, type ExportFormat } from '$lib/services/export-service';
  import { checkForUpdate, shouldCheckToday, getTodayDateString } from '$lib/services/update-service';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { t } from '$lib/i18n';
  import { getPlatformClass, isIPadOS, isMacOS, isTauri, isVirtualKeyboardVisible } from '$lib/utils/platform';
  import TabBar from '$lib/components/TabBar.svelte';
  import TouchToolbar from '$lib/editor/TouchToolbar.svelte';
  import { tabsStore } from '$lib/stores/tabs-store';

  import '$lib/styles/global.css';
  import '$lib/styles/editor.css';

  // Set platform class BEFORE first render so CSS layout (titlebar, padding)
  // is correct from the start. Avoids WebKit flex layout caching issues when
  // the class is added later in onMount.
  if (typeof document !== 'undefined') {
    document.body.classList.add(getPlatformClass());
  }

  function getDefaultContent(): string {
    const tr = $t;
    return `# ${tr('welcome.title')}

${tr('welcome.subtitle')}

## ${tr('welcome.featuresTitle')}

- ${tr('welcome.featureWysiwyg')}
- ${tr('welcome.featureMath')}
- ${tr('welcome.featureThemes')}
- ${tr('welcome.featureAI')}
- ${tr('welcome.featureMCP')}
- ${tr('welcome.featureLightweight')}

## ${tr('welcome.mathTitle')}

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

## ${tr('welcome.advancedMathTitle')}

$$
\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
$$

$$
\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}
$$

## ${tr('welcome.codeTitle')}

Inline code: \`console.log\`, \`println!\`, \`标记文本\`

\`\`\`javascript
const greeting = "Hello, Moraya!";
console.log(greeting);
\`\`\`

\`\`\`rust
fn main() {
    println!("Hello from Rust!");
    let numbers: Vec<i32> = (1..=10).collect();
    let sum: i32 = numbers.iter().sum();
    println!("Sum of 1..10 = {}", sum);
}
\`\`\`

## ${tr('welcome.blockquoteTitle')}

> ${tr('welcome.blockquoteContent')}

## ${tr('welcome.tableTitle')}

| ${tr('welcome.tableFeature')} | ${tr('welcome.tableStatus')} |
|---------|--------|
| Markdown | ${tr('welcome.tableDone')} |
| Math | ${tr('welcome.tableDone')} |
| AI Integration | ${tr('welcome.tableDone')} |
| MCP Publishing | ${tr('welcome.tableDone')} |

## ${tr('welcome.listTitle')}

1. ${tr('welcome.listItem1')}
   - ${tr('welcome.listItem1a')}
   - ${tr('welcome.listItem1b')}
   - ${tr('welcome.listItem1c')}
2. ${tr('welcome.listItem2')}
   - ${tr('welcome.listItem2a')}
   - ${tr('welcome.listItem2b')}
   - ${tr('welcome.listItem2c')}
3. ${tr('welcome.listItem3')}
   - ${tr('welcome.listItem3a')}
   - ${tr('welcome.listItem3b')}
   - ${tr('welcome.listItem3c')}

## ${tr('welcome.shortcutsTitle')}

- ${tr('welcome.shortcutSave')}
- ${tr('welcome.shortcutOpen')}
- ${tr('welcome.shortcutNew')}
- ${tr('welcome.shortcutToggleMode')}
- ${tr('welcome.shortcutSplitMode')}
- ${tr('welcome.shortcutSidebar')}
- ${tr('welcome.shortcutSettings')}
- ${tr('welcome.shortcutAI')}
- ${tr('welcome.shortcutExport')}

---

## ${tr('welcome.paragraphTitle')}

${tr('welcome.paragraph1')}

${tr('welcome.paragraph2')}

${tr('welcome.paragraph3')}

---

${tr('welcome.startWriting')}

${tr('welcome.tip')}
`;
  }

  let content = $state('');
  let showSidebar = $state(false);
  let showSettings = $state(false);
  let settingsInitialTab = $state<'general' | 'ai' | 'voice'>('general');
  let showAIPanel = $state(false);
  let showOutline = $state(false);
  let showImageDialog = $state(false);
  let showSearch = $state(false);
  let showReplace = $state(false);
  let showTouchToolbar = $state(isIPadOS);
  let searchMatchCount = $state(0);
  let searchCurrentMatch = $state(0);
  let currentFileName = $state($t('common.untitled'));
  let selectedText = $state('');
  let editorMode = $state<EditorMode>('visual');

  // AI store state for sparkle indicator
  let aiConfigured = $state(false);
  let aiLoading = $state(false);
  let aiError = $state(false);

  // Top-level store subscription — do NOT wrap in $effect().
  // In Svelte 5, $effect tracks reads inside subscribe callbacks, causing
  // infinite re-subscription loops when callbacks compare/write $state vars.
  aiStore.subscribe(state => {
    aiConfigured = state.isConfigured;
    aiLoading = state.isLoading;
    aiError = !!state.error;
  });

  // Publish workflow state
  let showWorkflow = $state(false);
  let showSEOPanel = $state(false);
  let showImageGenDialog = $state(false);
  let imageGenDialogMounted = $state(false);
  let showPublishConfirm = $state(false);
  let showUpdateDialog = $state(false);
  let showKBManager = $state(false);
  let seoCompleted = $state(false);
  let imageGenCompleted = $state(false);
  let currentSEOData = $state<SEOData | null>(null);

  // Toast notifications
  let toastMessages = $state<{ id: number; text: string; type: 'success' | 'error' }[]>([]);
  let toastIdCounter = 0;

  // Publish progress
  interface PublishProgressItem {
    targetName: string;
    status: 'publishing' | 'rss' | 'done' | 'error';
    message?: string;
  }
  let publishProgress = $state<PublishProgressItem[]>([]);

  function resetWorkflowState() {
    showWorkflow = false;
    showSEOPanel = false;
    showImageGenDialog = false;
    imageGenDialogMounted = false;
    showPublishConfirm = false;
    seoCompleted = false;
    imageGenCompleted = false;
    currentSEOData = null;
  }

  function showToast(text: string, type: 'success' | 'error' = 'success') {
    const id = ++toastIdCounter;
    toastMessages = [...toastMessages, { id, text, type }];
    setTimeout(() => {
      toastMessages = toastMessages.filter(m => m.id !== id);
    }, 4000);
  }

  // Editor reference for menu commands
  let morayaEditor: MorayaEditor | null = null;

  // Editor component references for search
  let visualEditorRef: Editor | undefined = $state();
  let sourceEditorRef: SourceEditor | undefined = $state();
  let splitSourceRef: SourceEditor | undefined = $state();
  let splitVisualRef: Editor | undefined = $state();

  function handleEditorReady(editor: MorayaEditor) {
    morayaEditor = editor;
  }

  /** Get the current document content on-demand.
   *  In visual mode: serializes ProseMirror doc to markdown (avoids per-keystroke cost).
   *  In source/split mode: returns the `content` binding directly (already up-to-date). */
  function getCurrentContent(): string {
    const mode = editorStore.getState().editorMode;
    if (mode === 'visual' && visualEditorRef) {
      const md = visualEditorRef.getFullMarkdown();
      content = md; // Sync the local binding for subsequent reads
      return md;
    }
    if (mode === 'split' && splitVisualRef) {
      const md = splitVisualRef.getFullMarkdown();
      content = md;
      return md;
    }
    // Source mode or no editor ref: content binding is already up-to-date
    return content;
  }

  /** Sync content to the active visual editor (atomically updates storedFrontmatter). */
  function syncVisualEditor(md: string) {
    const mode = editorStore.getState().editorMode;
    if (mode === 'source') return;
    const ve = mode === 'visual' ? visualEditorRef : mode === 'split' ? splitVisualRef : undefined;
    ve?.syncContent(md);
  }

  /** Scroll the editor scroll container to the top (works for both visual and source modes). */
  async function scrollEditorToTop() {
    await tick();
    document.querySelector('.editor-wrapper')?.scrollTo(0, 0);
    document.querySelector('.source-editor-outer')?.scrollTo(0, 0);
  }

  /** Replace editor content and scroll to the top for a newly opened file. */
  async function replaceContentAndScrollToTop(newContent: string) {
    editorStore.setCursorOffset(0);
    syncVisualEditor(newContent);
    if (morayaEditor) {
      try {
        const view = morayaEditor.view;
        const tr = view.state.tr.setSelection(
          TextSelection.create(view.state.doc, 1)
        );
        tr.setMeta('addToHistory', false);
        view.dispatch(tr);
      } catch {
        // Editor may not be fully ready yet
      }
    }
    await scrollEditorToTop();
  }

  /** Save with tab sync on iPad */
  async function handleSave(asNew = false): Promise<boolean> {
    const latestContent = getCurrentContent();
    const saved = asNew ? await saveFileAs(latestContent) : await saveFile(latestContent);
    if (saved && isIPadOS) {
      const state = editorStore.getState();
      if (state.currentFilePath) {
        tabsStore.updateActiveFile(state.currentFilePath, getFileNameFromPath(state.currentFilePath));
      }
    }
    return saved;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function runCmd(cmd: (state: any, dispatch?: any, view?: any) => boolean) {
    if (!morayaEditor) return;
    try {
      const { view } = morayaEditor;
      cmd(view.state, view.dispatch, view);
    } catch {
      // Command may fail if editor not ready or selection invalid
    }
  }

  /** Handle commands from the iPad touch toolbar */
  function handleTouchCommand(cmd: string) {
    const commandMap: Record<string, () => void> = {
      bold: () => runCmd(toggleBold),
      italic: () => runCmd(toggleItalic),
      strikethrough: () => runCmd(toggleStrikethrough),
      code: () => runCmd(toggleCode),
      link: () => runCmd(toggleLink({ href: '' })),
      h1: () => runCmd(setHeading(1)),
      h2: () => runCmd(setHeading(2)),
      h3: () => runCmd(setHeading(3)),
      quote: () => runCmd(wrapInBlockquote),
      bullet_list: () => runCmd(wrapInBulletList),
      ordered_list: () => runCmd(wrapInOrderedList),
      code_block: () => runCmd(insertCodeBlock),
      math_block: () => runCmd(insertMathBlockCmd),
      table: () => runCmd(insertTable(3, 3)),
      image: () => { showImageDialog = true; },
      hr: () => runCmd(insertHorizontalRule),
      undo: () => runCmd(undo),
      redo: () => runCmd(redo),
    };
    commandMap[cmd]?.();
  }

  // ── Search / Replace callbacks ─────────────────────────

  function getActiveSearchTarget(): Editor | SourceEditor | undefined {
    if (editorMode === 'visual') return visualEditorRef;
    if (editorMode === 'source') return sourceEditorRef;
    if (editorMode === 'split') return splitVisualRef ?? splitSourceRef;
    return undefined;
  }

  function handleSearch(text: string, caseSensitive: boolean) {
    const target = getActiveSearchTarget();
    if (!target) { searchMatchCount = 0; searchCurrentMatch = 0; return; }
    const count = target.searchText(text, caseSensitive);
    searchMatchCount = count;
    searchCurrentMatch = count > 0 ? 1 : 0;
  }

  function handleFindNext() {
    const target = getActiveSearchTarget();
    if (!target) return;
    const result = target.searchFindNext();
    searchCurrentMatch = result.current;
    searchMatchCount = result.total;
  }

  function handleFindPrev() {
    const target = getActiveSearchTarget();
    if (!target) return;
    const result = target.searchFindPrev();
    searchCurrentMatch = result.current;
    searchMatchCount = result.total;
  }

  function handleReplace(replaceText: string) {
    const target = getActiveSearchTarget();
    if (!target) return;
    target.searchReplaceCurrent(replaceText);
    // Re-search to update highlights and counts
    handleFindNext();
  }

  function handleReplaceAll(searchText: string, replaceText: string, caseSensitive: boolean) {
    const target = getActiveSearchTarget();
    if (!target) return;
    target.searchReplaceAll(searchText, replaceText, caseSensitive);
    searchMatchCount = 0;
    searchCurrentMatch = 0;
  }

  function handleSearchClose() {
    showSearch = false;
    showReplace = false;
    searchMatchCount = 0;
    searchCurrentMatch = 0;
    const target = getActiveSearchTarget();
    target?.clearSearch();
  }

  // Split mode scroll sync
  let splitSourceEl: HTMLDivElement | undefined = $state();
  let splitVisualEl: HTMLDivElement | undefined = $state();
  let activeScrollPane: 'source' | 'visual' | null = null;

  // Top-level store subscriptions — do NOT wrap in $effect().
  // In Svelte 5, $effect tracks reads inside subscribe callbacks, causing
  // infinite re-subscription loops when callbacks compare/write $state vars.
  // This was the root cause of the AI panel freeze (introduced in v0.17.1).
  settingsStore.subscribe(state => {
    showSidebar = state.showSidebar;
    showOutline = state.showOutline;
  });

  // Track previous values to skip redundant work in hot subscriber path.
  // This subscriber fires on every store update (setContent, setDirty, setFocused, etc.)
  // so we must avoid doing unnecessary work or writing $state on each call.
  let prevFilePath: string | null = null;
  let prevEditorMode: EditorMode | null = null;

  editorStore.subscribe(state => {
    // Only recompute file name when path actually changes
    if (state.currentFilePath !== prevFilePath) {
      prevFilePath = state.currentFilePath;
      currentFileName = state.currentFilePath
        ? getFileNameFromPath(state.currentFilePath)
        : $t('common.untitled');
    }
    // Guard: only write $state when mode actually changes to avoid re-entrancy
    // during Svelte's render flush (e.g., when Editor.onDestroy calls setContent,
    // which triggers this subscriber while the component tree is being updated).
    if (state.editorMode !== prevEditorMode) {
      prevEditorMode = state.editorMode;
      editorMode = state.editorMode;
      // Clear editor reference when switching to source-only mode
      if (state.editorMode === 'source') {
        morayaEditor = null;
      }
    }
    // Sync dirty state to tabs store on iPad
    if (isIPadOS) {
      tabsStore.syncDirty(state.isDirty);
    }
  });

  // iPad tabs: reload content when active tab changes
  if (isIPadOS) {
    let prevActiveTabId = '';
    tabsStore.subscribe(state => {
      if (state.activeTabId !== prevActiveTabId) {
        prevActiveTabId = state.activeTabId;
        const tab = state.tabs.find(t => t.id === state.activeTabId);
        if (tab) {
          content = tab.content;
          currentFileName = tab.fileName;
          replaceContentAndScrollToTop(tab.content);
        }
      }
    });
  }

  // Sync native menu checkmarks when editor mode changes (all desktop platforms).
  $effect(() => {
    if (!isTauri) return;

    invoke('set_editor_mode_menu', { mode: editorMode }).catch(() => {});
  });

  // Expose sidebar width to titlebar for centering via CSS custom property
  $effect(() => {
    if (showSidebar) {
      document.documentElement.style.setProperty('--sidebar-visible-width', 'var(--sidebar-width)');
    } else {
      document.documentElement.style.removeProperty('--sidebar-visible-width');
    }
  });

  // Sync native menu labels when locale changes
  $effect(() => {
    const tr = $t;
    const labels: Record<string, string> = {
      // Submenu titles
      menu_file: tr('menu.file'),
      menu_edit: tr('menu.edit'),
      menu_paragraph: tr('menu.paragraph'),
      menu_format: tr('menu.format'),
      menu_view: tr('menu.view'),
      menu_window: tr('menu.window'),
      menu_help: tr('menu.help'),
      // File menu
      file_new: tr('menu.new'),
      file_new_window: tr('menu.newWindow'),
      file_open: tr('menu.open'),
      file_save: tr('menu.save'),
      file_save_as: tr('menu.saveAs'),
      menu_export: tr('menu.export'),
      file_export_html: tr('menu.exportHtml'),
      file_export_pdf: tr('menu.exportPdf'),
      file_export_image: tr('menu.exportImage'),
      file_export_doc: tr('menu.exportDoc'),
      // Paragraph menu
      para_h1: tr('menu.heading1'),
      para_h2: tr('menu.heading2'),
      para_h3: tr('menu.heading3'),
      para_h4: tr('menu.heading4'),
      para_h5: tr('menu.heading5'),
      para_h6: tr('menu.heading6'),
      para_table: tr('menu.table'),
      para_code_block: tr('menu.codeBlock'),
      para_math_block: tr('menu.mathBlock'),
      para_quote: tr('menu.quote'),
      para_bullet_list: tr('menu.bulletList'),
      para_ordered_list: tr('menu.orderedList'),
      para_hr: tr('menu.horizontalRule'),
      // Format menu
      fmt_bold: tr('menu.bold'),
      fmt_italic: tr('menu.italic'),
      fmt_strikethrough: tr('menu.strikethrough'),
      fmt_code: tr('menu.code'),
      fmt_link: tr('menu.link'),
      fmt_image: tr('menu.image'),
      // View menu — append platform-appropriate shortcut hints
      view_mode_visual: tr('menu.visualMode') + (isMacOS ? '          ⌘/' : '          Ctrl+/'),
      view_mode_source: tr('menu.sourceMode') + (isMacOS ? '         ⌘/' : '         Ctrl+/'),
      view_mode_split: tr('menu.splitMode') + (isMacOS ? '       ⇧⌘/' : '       Ctrl+Shift+/'),
      view_sidebar: tr('menu.toggleSidebar'),
      view_ai_panel: tr('menu.toggleAIPanel'),
      view_outline: tr('menu.toggleOutline'),
      view_zoom_in: tr('menu.zoomIn'),
      view_zoom_out: tr('menu.zoomOut'),
      view_actual_size: tr('menu.actualSize'),
      // Help menu
      help_version_info: tr('menu.versionInfo'),
      help_changelog: tr('menu.changelog'),
      help_privacy: tr('menu.privacyPolicy'),
      help_website: tr('menu.officialWebsite'),
      help_about: tr('menu.aboutMoraya'),
      help_feedback: tr('menu.feedback'),
      // Edit — search
      edit_find: tr('menu.find'),
      edit_replace: tr('menu.replace'),
      // macOS app menu
      preferences: tr('menu.settings'),
    };
    if (isTauri) invoke('update_menu_labels', { labels });
  });

  // Auto-save timer
  let autoSaveTimer: ReturnType<typeof setInterval> | null = null;

  function setupAutoSave() {
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    const settings = settingsStore.getState();
    if (settings.autoSave) {
      autoSaveTimer = setInterval(() => {
        const editorState = editorStore.getState();
        if (editorState.isDirty && editorState.currentFilePath) {
          handleSave();
        }
      }, settings.autoSaveInterval);
    }
  }

  // Minimalist-style keyboard shortcuts
  function handleKeydown(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;

    // File shortcuts
    if (mod && event.key === 's') {
      event.preventDefault();
      handleSave(event.shiftKey);
      return;
    }

    if (mod && event.key === 'o' && !event.shiftKey) {
      event.preventDefault();
      handleOpenFile();
      return;
    }

    if (mod && event.key === 'n') {
      event.preventDefault();
      handleNewFile();
      return;
    }

    // View shortcuts — on Tauri, CheckMenuItem accelerators handle these natively.
    // JS keydown would cause double-toggle (JS toggle + native menu event).
    if (!isTauri && mod && event.key === '\\') {
      event.preventDefault();
      settingsStore.toggleSidebar();
      return;
    }

    if (mod && event.key === ',') {
      event.preventDefault();
      showSettings = !showSettings;
      return;
    }

    // Toggle source/visual mode: Cmd+/ (macOS) or Ctrl+/ (Windows/Linux)
    // On macOS, only metaKey triggers — ctrlKey would also insert '/' into the editor
    // Check event.code for Windows keyboard layout compatibility
    const slashMod = isMacOS ? event.metaKey : event.ctrlKey;
    if (slashMod && !event.shiftKey && (event.key === '/' || event.code === 'Slash')) {
      event.preventDefault();
      const newMode: EditorMode = editorMode === 'visual' ? 'source' : 'visual';
      editorMode = newMode;
      editorStore.setEditorMode(newMode);
      return;
    }

    // Split mode: Cmd+Shift+/ (Shift+/ produces '?' on most keyboards)
    if (slashMod && event.shiftKey && (event.key === '/' || event.key === '?' || event.code === 'Slash')) {
      event.preventDefault();
      const newMode: EditorMode = editorMode === 'split' ? 'visual' : 'split';
      editorMode = newMode;
      editorStore.setEditorMode(newMode);
      return;
    }

    // AI Panel toggle: Cmd+Shift+I / Ctrl+Shift+I
    // On Tauri, the native CheckMenuItem accelerator handles this.
    if (!isTauri && mod && event.shiftKey && (event.key === 'I' || event.key === 'i')) {
      event.preventDefault();
      showAIPanel = !showAIPanel;
      return;
    }

    // Outline toggle: Cmd+Shift+O / Ctrl+Shift+O
    // On Tauri, the native CheckMenuItem accelerator handles this.
    if (!isTauri && mod && event.shiftKey && (event.key === 'O' || event.key === 'o')) {
      event.preventDefault();
      settingsStore.update({ showOutline: !showOutline });
      return;
    }

    // Export shortcut
    if (mod && event.shiftKey && event.key === 'E') {
      event.preventDefault();
      exportDocument(getCurrentContent(), 'html');
      return;
    }

    // Cmd+F → open search
    if (mod && event.key === 'f' && !event.shiftKey) {
      event.preventDefault();
      showSearch = true;
      return;
    }

    // Cmd+H → open search + replace
    if (mod && event.key === 'h') {
      event.preventDefault();
      showSearch = true;
      showReplace = true;
      return;
    }

    // Escape → close search
    if (event.key === 'Escape' && showSearch) {
      event.preventDefault();
      handleSearchClose();
      return;
    }

    // Insert image: Cmd+Shift+G
    if (mod && event.shiftKey && event.key === 'G') {
      event.preventDefault();
      showImageDialog = true;
      return;
    }

    // Heading 1-6: Cmd+1 through Cmd+6 (fallback for menu accelerator)
    if (mod && !event.shiftKey && event.key >= '1' && event.key <= '6') {
      event.preventDefault();
      runCmd(setHeading(parseInt(event.key)));
      return;
    }

    // Code block: Cmd+Shift+K (fallback for menu accelerator)
    if (mod && event.shiftKey && event.key === 'K') {
      event.preventDefault();
      runCmd(insertCodeBlock);
      return;
    }

    // Quote: Cmd+Shift+Q (fallback for menu accelerator)
    if (mod && event.shiftKey && event.key === 'Q') {
      event.preventDefault();
      runCmd(wrapInBlockquote);
      return;
    }

    // Zoom
    if (mod && event.key === '=') {
      event.preventDefault();
      const settings = settingsStore.getState();
      const newSize = Math.min(settings.fontSize + 1, 24);
      settingsStore.update({ fontSize: newSize });
      document.documentElement.style.setProperty('--font-size-base', `${newSize}px`);
      return;
    }

    if (mod && event.key === '-' && !event.shiftKey) {
      event.preventDefault();
      const settings = settingsStore.getState();
      const newSize = Math.max(settings.fontSize - 1, 12);
      settingsStore.update({ fontSize: newSize });
      document.documentElement.style.setProperty('--font-size-base', `${newSize}px`);
      return;
    }

    if (mod && event.key === '0' && !event.shiftKey) {
      event.preventDefault();
      settingsStore.update({ fontSize: 16 });
      document.documentElement.style.setProperty('--font-size-base', '16px');
      return;
    }
  }

  /**
   * Check for unsaved changes before switching files.
   * Returns true if it's safe to proceed, false to abort the switch.
   */
  async function guardUnsavedChanges(): Promise<boolean> {
    if (isIPadOS) return true; // iPad uses multi-tab with per-tab dirty state

    const { isDirty, currentFilePath } = editorStore.getState();
    if (!isDirty) return true;
    // Use getCurrentContent() to get latest content from ProseMirror
    // (in visual-only mode, store.content is not updated per-keystroke)
    const editorContent = getCurrentContent();
    if (!editorContent?.trim()) return true; // Empty content — nothing to lose

    if (currentFilePath) {
      // Existing file with unsaved changes — silent save (consistent with autoSave)
      await handleSave();
      return true;
    }

    // New unsaved document with content — ask user via native dialog
    const shouldSave = await ask(
      $t('editor.unsavedNewDocMsg'),
      {
        title: $t('editor.unsavedTitle'),
        kind: 'warning',
        okLabel: $t('editor.saveFirst'),
        cancelLabel: $t('editor.discardChanges'),
      }
    );

    if (shouldSave) {
      // User chose "Save" → open SaveAs dialog
      const saved = await handleSave(true);
      return saved; // If user cancelled SaveAs → abort the switch
    }
    // User chose "Don't Save" → discard and proceed
    return true;
  }

  async function handleOpenFile() {
    if (!(await guardUnsavedChanges())) return;
    const fileContent = await openFile();
    if (fileContent !== null) {
      if (isIPadOS) {
        // openFile() already updated editorStore.currentFilePath
        const filePath = editorStore.getState().currentFilePath;
        const fileName = filePath ? getFileNameFromPath(filePath) : $t('common.untitled');
        tabsStore.openFileTab(filePath ?? '', fileName, fileContent);
      }
      content = fileContent;
      resetWorkflowState();
      await replaceContentAndScrollToTop(content);
    }
  }

  async function handleNewFile() {
    if (!(await guardUnsavedChanges())) return;
    if (isIPadOS) {
      tabsStore.addTab();
      content = '';
      resetWorkflowState();
      await replaceContentAndScrollToTop(content);
      return;
    }
    content = '';
    editorStore.reset();
    resetWorkflowState();
    await replaceContentAndScrollToTop(content);
  }

  // Guard against concurrent file loads: rapid clicks (e.g. KB file switching)
  // create overlapping async loadFile → replaceAll chains, each expensive.
  // Debounce + serial guard: rapid clicks are coalesced into a single operation,
  // preventing concurrent guardUnsavedChanges/save/loadFile/replaceAll calls entirely.
  let fileSelectSerial = 0;
  let fileSelectDebounce: ReturnType<typeof setTimeout> | undefined;

  function handleFileSelect(path: string) {
    const mySerial = ++fileSelectSerial;
    clearTimeout(fileSelectDebounce);
    fileSelectDebounce = setTimeout(() => doFileSelect(path, mySerial), 50);
  }

  async function doFileSelect(path: string, mySerial: number) {
    if (mySerial !== fileSelectSerial) return;
    if (!(await guardUnsavedChanges())) return;
    if (mySerial !== fileSelectSerial) return; // Superseded by a newer click
    const fileContent = await loadFile(path);
    if (mySerial !== fileSelectSerial) return; // Superseded while IPC was in-flight
    if (isIPadOS) {
      const fileName = getFileNameFromPath(path);
      tabsStore.openFileTab(path, fileName, fileContent);
      content = fileContent;
      resetWorkflowState();
      await replaceContentAndScrollToTop(content);
      return;
    }
    content = fileContent;
    // Note: loadFile() already calls editorStore.setCurrentFile + setContent,
    // so no duplicate setContent call here.
    resetWorkflowState();
    await replaceContentAndScrollToTop(content);
  }

  function handleContentChange(newContent: string) {
    content = newContent;
  }

  function handleAIInsert(text: string) {
    // Append to content string (works for all modes) and re-sync visual editor.
    // NOTE: Do NOT use Milkdown's `insert()` — it inserts raw text without
    // markdown parsing, so fenced code blocks (e.g. ```image-prompts) render
    // as plain text instead of actual code blocks.
    const latestContent = getCurrentContent();
    content = latestContent.trimEnd() + '\n\n' + text + '\n';
    const mode = editorStore.getState().editorMode;
    if (mode !== 'source') {
      // Save scroll position before replaceAll (which resets it)
      const wrapper = document.querySelector('.editor-wrapper') as HTMLElement | null;
      const savedScroll = wrapper?.scrollTop ?? 0;
      syncVisualEditor(content);
      // Restore scroll after sync, scrolling to bottom if we were near the end
      requestAnimationFrame(() => {
        if (wrapper) {
          const maxScroll = wrapper.scrollHeight - wrapper.clientHeight;
          // If we were in the bottom 200px, scroll to the very bottom to show new content
          if (savedScroll >= maxScroll - 200) {
            wrapper.scrollTop = wrapper.scrollHeight;
          } else {
            wrapper.scrollTop = savedScroll;
          }
        }
      });
    }
  }

  function handleAIReplace(text: string) {
    // Always update content string and re-sync visual editor for proper markdown parsing.
    // NOTE: Do NOT use ProseMirror's insertText() — it inserts raw text without
    // markdown parsing, so fenced code blocks render as plain text.
    const latestContent = getCurrentContent();
    content = latestContent.trimEnd() + '\n\n' + text + '\n';
    syncVisualEditor(content);
  }

  function isLocalPath(src: string): boolean {
    return src.startsWith('/') || /^[A-Z]:\\/i.test(src);
  }

  async function handleInsertImage(data: { src: string; alt: string }) {
    showImageDialog = false;
    try {
      const src = isLocalPath(data.src) ? await readImageAsBlobUrl(data.src) : data.src;
      const mode = editorStore.getState().editorMode;
      if (mode === 'source') {
        const imgMarkdown = `![${data.alt}](${src})`;
        content = content.trimEnd() + '\n\n' + imgMarkdown + '\n';
      } else {
        runCmd(insertImage({ src, alt: data.alt }));
      }
    } catch (e) {
      console.warn('[Image] handleInsertImage failed:', e);
    }
  }

  // ── Publish Workflow Handlers ─────────────────────────

  function handlePublishWorkflow() {
    showWorkflow = !showWorkflow;
  }

  function handleWorkflowSEO() {
    getCurrentContent(); // Ensure content is fresh for SEO analysis
    showWorkflow = false;
    showSEOPanel = true;
  }

  function handleWorkflowImageGen() {
    getCurrentContent(); // Ensure content is fresh for image prompt extraction
    showWorkflow = false;
    imageGenDialogMounted = true;
    showImageGenDialog = true;
  }

  function handleWorkflowPublish() {
    showWorkflow = false;
    showPublishConfirm = true;
  }

  async function handleWorkflowMCPTool(tool: MCPTool, server: MCPServerConfig) {
    showWorkflow = false;
    showAIPanel = true;
    const message = $t('ai.prompts.mcpToolPrompt', { toolName: tool.name, serverName: server.name });
    try {
      await sendChatMessage(message, getCurrentContent());
    } catch { /* handled by store */ }
  }

  function handleSEOApply(data: SEOData) {
    currentSEOData = data;
    seoCompleted = true;
    showSEOPanel = false;
  }

  function handleImageGenInsert(images: { url: string; target: number }[], mode: 'paragraph' | 'end' | 'replace' | 'clipboard') {
    // Ensure content is up-to-date before image operations
    getCurrentContent();
    if (mode === 'end') {
      // Insert all images at end
      const imgMarkdown = images.map(img => `![](${img.url})`).join('\n\n');
      content = content.trimEnd() + '\n\n' + imgMarkdown + '\n';
      syncVisualEditor(content);
    } else if (mode === 'paragraph') {
      // Insert each image after its target paragraph
      const lines = content.split('\n');
      let paragraphIdx = 0;
      const insertions: Map<number, string[]> = new Map();

      for (const img of images) {
        const existing = insertions.get(img.target) || [];
        existing.push(`![](${img.url})`);
        insertions.set(img.target, existing);
      }

      // Pre-compute fenced code block regions to avoid inserting images inside them
      const inCodeBlockAt: boolean[] = new Array(lines.length).fill(false);
      let inBlock = false;
      for (let i = 0; i < lines.length; i++) {
        if (/^\s{0,3}(`{3,}|~{3,})/.test(lines[i])) {
          inCodeBlockAt[i] = true;
          inBlock = !inBlock;
        } else {
          inCodeBlockAt[i] = inBlock;
        }
      }

      const result: string[] = [];
      let deferredImages: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        result.push(lines[i]);
        // Count non-empty lines as paragraphs
        if (lines[i].trim() && (i + 1 >= lines.length || !lines[i + 1]?.trim())) {
          const imgs = insertions.get(paragraphIdx);
          if (inCodeBlockAt[i]) {
            // Inside code block: defer insertion to after the block
            if (imgs) deferredImages.push(...imgs);
          } else {
            // Normal paragraph: flush deferred images first, then this paragraph's images
            if (deferredImages.length > 0) {
              result.push('');
              result.push(...deferredImages);
              deferredImages = [];
            }
            if (imgs) {
              result.push('');
              result.push(...imgs);
            }
          }
          paragraphIdx++;
        }
      }
      // Flush any remaining deferred images at the end
      if (deferredImages.length > 0) {
        result.push('');
        result.push(...deferredImages);
      }

      content = result.join('\n');
      syncVisualEditor(content);
    } else if (mode === 'replace') {
      // Replace existing images in the article with generated images
      const imgRegex = /!\[[^\]]*\]\([^)]*\)/g;
      let replaceIdx = 0;
      let replaced = content.replace(imgRegex, (match) => {
        if (replaceIdx < images.length) {
          return `![](${images[replaceIdx++].url})`;
        }
        return match; // no more generated images, keep original
      });
      // Append remaining images at end
      if (replaceIdx < images.length) {
        const remaining = images.slice(replaceIdx).map(img => `![](${img.url})`).join('\n\n');
        replaced = replaced.trimEnd() + '\n\n' + remaining + '\n';
      }
      content = replaced;
      syncVisualEditor(content);
    }

    // Remove image-prompt(s) code block(s) after insertion
    content = content.replace(/\n*```\s*image-prompts?\s*\n[\s\S]*?```\n*/g, '\n');
    syncVisualEditor(content);

    imageGenCompleted = true;
    showImageGenDialog = false;
    imageGenDialogMounted = false;
  }

  async function handlePublishConfirm(targetIds: string[]) {
    showPublishConfirm = false;
    const targets = settingsStore.getState().publishTargets.filter(t => targetIds.includes(t.id));
    const publishContent = getCurrentContent();

    // Fallback title: SEO title → first markdown heading → file name
    const fallbackTitle =
      currentSEOData?.selectedTitle ||
      publishContent.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
      currentFileName.replace(/\.md$/i, '');

    const variables: Record<string, string> = {
      title: fallbackTitle,
      filename: currentFileName.replace(/\.md$/i, ''),
      date: new Date().toISOString().split('T')[0],
      tags: currentSEOData?.tags?.join(', ') || '',
      description: currentSEOData?.metaDescription || '',
      slug: currentSEOData?.slug || 'untitled',
      cover: '',
      excerpt: currentSEOData?.excerpt || '',
      content: publishContent,
    };

    // Lazy-load publish services
    const [{ publishToGitHub }, { publishToCustomAPI }] = await Promise.all([
      import('$lib/services/publish/github-publisher'),
      import('$lib/services/publish/api-publisher'),
    ]);

    // Initialize progress for all targets
    publishProgress = targets.map(t => ({
      targetName: t.name || t.id,
      status: 'publishing' as const,
    }));

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      // Step 1: Publish
      let result: PublishResult;
      if (target.type === 'github') {
        result = await publishToGitHub(target, variables, publishContent);
      } else {
        result = await publishToCustomAPI(target, variables);
      }

      if (result.success) {
        // Step 2: RSS (if enabled)
        if ((target.type === 'github' || target.type === 'custom-api') && target.rss?.enabled) {
          publishProgress[i] = { ...publishProgress[i], status: 'rss' };
          publishProgress = [...publishProgress];
          try {
            if (target.type === 'github') {
              const { updateGitHubRSSFeed } = await import('$lib/services/publish/rss-publisher');
              await updateGitHubRSSFeed(target, variables, publishContent);
            } else {
              const { updateCustomAPIRSSFeed } = await import('$lib/services/publish/rss-publisher');
              await updateCustomAPIRSSFeed(target, variables, publishContent);
            }
          } catch {
            // RSS failure is non-fatal
          }
        }

        publishProgress[i] = { ...publishProgress[i], status: 'done' };
      } else {
        publishProgress[i] = { ...publishProgress[i], status: 'error', message: result.message };
      }
      publishProgress = [...publishProgress];
    }

    // Auto-dismiss after 3s
    setTimeout(() => { publishProgress = []; }, 3000);
  }

  // Split mode scroll sync — block-level anchor mapping
  //
  // Instead of mapping by global scroll fraction (which breaks when content
  // heights diverge, e.g. mermaid code blocks → tall SVG diagrams), we:
  //   1. Walk ProseMirror's top-level DOM children to get visual Y positions
  //   2. Estimate each block's source line count from its DOM content
  //   3. Build (sourceY, visualY) anchor pairs
  //   4. Interpolate between the nearest two anchors when scrolling

  type ScrollAnchor = { sourceY: number; visualY: number };

  function buildBlockAnchors(
    sourceScroll: HTMLElement,
    visualScroll: HTMLElement,
  ): ScrollAnchor[] {
    const textarea = sourceScroll.querySelector('.source-textarea') as HTMLTextAreaElement;
    const pm = visualScroll.querySelector('.ProseMirror') as HTMLElement;
    if (!textarea || !pm) return [];

    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 24;
    const srcRect = sourceScroll.getBoundingClientRect();
    const visRect = visualScroll.getBoundingClientRect();
    const srcST = sourceScroll.scrollTop;
    const visST = visualScroll.scrollTop;
    const textareaTop = textarea.getBoundingClientRect().top - srcRect.top + srcST;

    const anchors: ScrollAnchor[] = [{ sourceY: 0, visualY: 0 }];
    let currentLine = 0;

    for (const child of pm.children) {
      const el = child as HTMLElement;
      const vY = el.getBoundingClientRect().top - visRect.top + visST;
      const sY = textareaTop + currentLine * lineHeight;
      anchors.push({ sourceY: sY, visualY: vY });

      // Estimate how many source lines this block occupies
      const tag = el.tagName.toLowerCase();
      if (el.classList.contains('code-block-wrapper')) {
        const codeEl = el.querySelector('.code-block-code');
        const codeLines = (codeEl?.textContent || '').split('\n').length;
        currentLine += codeLines + 2; // + opening/closing fence
      } else if (tag === 'table') {
        currentLine += el.querySelectorAll('tr').length + 1; // +1 separator
      } else if (/^h[1-6]$/.test(tag)) {
        currentLine += 1;
      } else if (tag === 'hr') {
        currentLine += 1;
      } else if (tag === 'ul' || tag === 'ol') {
        currentLine += el.querySelectorAll('li').length;
      } else if (tag === 'blockquote') {
        currentLine += (el.textContent || '').split('\n').length;
      } else {
        currentLine += Math.max(1, (el.textContent || '').split('\n').length);
      }
      currentLine += 1; // blank line separator
    }

    anchors.push({
      sourceY: sourceScroll.scrollHeight,
      visualY: visualScroll.scrollHeight,
    });
    return anchors;
  }

  function interpolateAnchors(
    anchors: ScrollAnchor[],
    scrollTop: number,
    fromKey: 'sourceY' | 'visualY',
    toKey: 'sourceY' | 'visualY',
  ): number {
    if (anchors.length < 2) return scrollTop;
    // Find bounding segment
    for (let i = 1; i < anchors.length; i++) {
      if (scrollTop <= anchors[i][fromKey]) {
        const lo = anchors[i - 1];
        const hi = anchors[i];
        const range = hi[fromKey] - lo[fromKey];
        const t = range > 0 ? (scrollTop - lo[fromKey]) / range : 0;
        return lo[toKey] + t * (hi[toKey] - lo[toKey]);
      }
    }
    // Past last anchor
    return anchors[anchors.length - 1][toKey];
  }

  function setupScrollSync() {
    if (!splitSourceEl || !splitVisualEl) return;
    const sourceScroll = splitSourceEl.querySelector('.source-editor-outer') as HTMLElement;
    const visualScroll = splitVisualEl.querySelector('.editor-wrapper') as HTMLElement;
    if (!sourceScroll || !visualScroll) return;

    let scrollRaf: number | undefined;
    let cachedAnchors: ScrollAnchor[] | null = null;

    function invalidate() { cachedAnchors = null; }

    function getAnchors(): ScrollAnchor[] {
      if (!cachedAnchors) cachedAnchors = buildBlockAnchors(sourceScroll, visualScroll);
      return cachedAnchors;
    }

    // Invalidate anchors when visual DOM changes (content edits, mermaid renders)
    const pm = visualScroll.querySelector('.ProseMirror');
    const observer = pm ? new MutationObserver(invalidate) : null;
    observer?.observe(pm!, { childList: true, subtree: true, attributes: false });

    // Also invalidate on resize (layout reflow changes block heights)
    const resizeObs = new ResizeObserver(invalidate);
    resizeObs.observe(sourceScroll);
    resizeObs.observe(visualScroll);

    const onSourceScroll = () => {
      if (activeScrollPane !== 'source') return;
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = undefined;
        const anchors = getAnchors();
        if (anchors.length < 2) {
          // Fallback to fraction-based
          const max = sourceScroll.scrollHeight - sourceScroll.clientHeight;
          const ratio = max > 0 ? sourceScroll.scrollTop / max : 0;
          visualScroll.scrollTop = ratio * (visualScroll.scrollHeight - visualScroll.clientHeight);
        } else {
          visualScroll.scrollTop = interpolateAnchors(anchors, sourceScroll.scrollTop, 'sourceY', 'visualY');
        }
      });
    };

    const onVisualScroll = () => {
      if (activeScrollPane !== 'visual') return;
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = undefined;
        const anchors = getAnchors();
        if (anchors.length < 2) {
          const max = visualScroll.scrollHeight - visualScroll.clientHeight;
          const ratio = max > 0 ? visualScroll.scrollTop / max : 0;
          sourceScroll.scrollTop = ratio * (sourceScroll.scrollHeight - sourceScroll.clientHeight);
        } else {
          sourceScroll.scrollTop = interpolateAnchors(anchors, visualScroll.scrollTop, 'visualY', 'sourceY');
        }
      });
    };

    const onSourceEnter = () => { activeScrollPane = 'source'; };
    const onVisualEnter = () => { activeScrollPane = 'visual'; };
    const onPaneLeave = () => { activeScrollPane = null; };

    sourceScroll.addEventListener('scroll', onSourceScroll, { passive: true });
    visualScroll.addEventListener('scroll', onVisualScroll, { passive: true });
    sourceScroll.addEventListener('mouseenter', onSourceEnter);
    visualScroll.addEventListener('mouseenter', onVisualEnter);
    sourceScroll.addEventListener('mouseleave', onPaneLeave);
    visualScroll.addEventListener('mouseleave', onPaneLeave);

    return () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      observer?.disconnect();
      resizeObs.disconnect();
      sourceScroll.removeEventListener('scroll', onSourceScroll);
      visualScroll.removeEventListener('scroll', onVisualScroll);
      sourceScroll.removeEventListener('mouseenter', onSourceEnter);
      visualScroll.removeEventListener('mouseenter', onVisualEnter);
      sourceScroll.removeEventListener('mouseleave', onPaneLeave);
      visualScroll.removeEventListener('mouseleave', onPaneLeave);
    };
  }

  $effect(() => {
    if (editorMode === 'split' && splitSourceEl && splitVisualEl) {
      let scrollCleanup: (() => void) | undefined;
      // Small delay to ensure child components are mounted
      const timer = setTimeout(() => {
        scrollCleanup = setupScrollSync();
      }, 100);
      return () => {
        clearTimeout(timer);
        scrollCleanup?.();
      };
    }
  });

  onMount(() => {
    // Platform class is set above (before first render) for correct initial layout.
    // iPadOS + Tauri: track visual viewport height for virtual keyboard handling
    // (browser testing mode uses 100dvh fallback, no need for --app-height)
    let vvUnlisten: (() => void) | undefined;
    if (isTauri && isIPadOS && window.visualViewport) {
      const onVVResize = () => {
        const vh = window.visualViewport!.height;
        document.documentElement.style.setProperty('--app-height', `${vh}px`);
      };
      window.visualViewport.addEventListener('resize', onVVResize);
      vvUnlisten = () => window.visualViewport?.removeEventListener('resize', onVVResize);
      // Set initial value
      onVVResize();
    }

    // Tauri desktop: nudge WKWebView to recalculate viewport units (100dvh/100vh)
    // after the native window has fully settled. Prevents stale layout in new windows.
    if (isTauri && !isIPadOS) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }

    // Preload enhancement plugins in background (warms cache for editor creation)
    preloadEnhancementPlugins();

    // Restore persisted settings, AI config, and MCP servers (Tauri-only: uses plugin-store)
    if (isTauri) {
      Promise.all([initSettingsStore(), initAIStore(), initMCPStore(), filesStore.loadPersistedPrefs()])
        .then(() => {
          // Auto-connect all enabled MCP servers
          connectAllServers().catch(() => {});

          // Initialize dynamic service container (checks Node.js, reconnects saved services)
          initContainerManager().catch(() => {});

          // Restore knowledge base or last opened folder
          const settings = settingsStore.getState();
          const filesState = filesStore.getState();
          if (filesState.knowledgeBases.length > 0) {
            // Activate most recently used knowledge base
            const sorted = [...filesState.knowledgeBases].sort(
              (a, b) => b.lastAccessedAt - a.lastAccessedAt
            );
            filesStore.setActiveKnowledgeBase(sorted[0].id).catch(() => {});
          } else if (settings.rememberLastFolder && settings.lastOpenedFolder) {
            invoke<FileEntry[]>('read_dir_recursive', {
              path: settings.lastOpenedFolder,
              depth: 3,
            })
              .then(tree => {
                filesStore.setOpenFolder(settings.lastOpenedFolder!, tree);
              })
              .catch(() => {
                // Directory no longer exists — clear saved path silently
                settingsStore.update({ lastOpenedFolder: null });
              });
          }

          // Auto-check for updates (once daily)
          if (shouldCheckToday(settings.lastUpdateCheckDate)) {
            checkForUpdate()
              .then(() => {
                settingsStore.update({ lastUpdateCheckDate: getTodayDateString() });
              })
              .catch(() => {}); // Silently fail on background check
          }
        })
        .catch(() => {});

      setupAutoSave();
    }

    // Initialize word count
    editorStore.setContent(content);

    // Listen for AI/MCP file-synced events to reload content into the editor
    function handleFileSynced(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.content != null) {
        content = detail.content;
        syncVisualEditor(content);
      }
    }
    window.addEventListener('moraya:file-synced', handleFileSynced);

    // Dynamic MCP service creation notification
    function handleDynamicServiceCreated(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.name) {
        showToast(`AI: ${detail.name} (${detail.tools?.length || 0} tools)`, 'success');
      }
    }
    window.addEventListener('moraya:dynamic-service-created', handleDynamicServiceCreated);

    // ── Tauri-only: native menu events, file association, drag-drop ──
    const menuUnlisteners: UnlistenFn[] = [];
    let openFileUnlisten: UnlistenFn | undefined;
    let dragDropUnlisten: UnlistenFn | undefined;

    if (isTauri) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const menuHandlers: Record<string, (payload?: any) => void> = {
        // File
        'menu:file_new': () => handleNewFile(),
        'menu:file_new_window': () => isIPadOS ? handleNewFile() : invoke('create_new_window').catch(() => {}),
        'menu:file_open': () => handleOpenFile(),
        'menu:file_save': () => handleSave(),
        'menu:file_save_as': () => handleSave(true),
        'menu:file_export_html': () => exportDocument(getCurrentContent(), 'html'),
        'menu:file_export_pdf': () => exportDocument(getCurrentContent(), 'pdf'),
        'menu:file_export_image': () => exportDocument(getCurrentContent(), 'image'),
        'menu:file_export_doc': () => exportDocument(getCurrentContent(), 'doc'),
        // Edit — undo/redo
        'menu:edit_undo': () => {
          if (editorMode === 'source') {
            document.execCommand('undo');
          } else {
            runCmd(undo);
          }
        },
        'menu:edit_redo': () => {
          if (editorMode === 'source') {
            document.execCommand('redo');
          } else {
            runCmd(redo);
          }
        },
        // Select All: handled by PredefinedMenuItem::select_all (source mode)
        // and selectAllFixPlugin in ProseMirror (visual mode).
        // Edit — search
        'menu:edit_find': () => { showSearch = true; },
        'menu:edit_replace': () => { showSearch = true; showReplace = true; },
        // Paragraph
        'menu:para_h1': () => runCmd(setHeading(1)),
        'menu:para_h2': () => runCmd(setHeading(2)),
        'menu:para_h3': () => runCmd(setHeading(3)),
        'menu:para_h4': () => runCmd(setHeading(4)),
        'menu:para_h5': () => runCmd(setHeading(5)),
        'menu:para_h6': () => runCmd(setHeading(6)),
        'menu:para_table': () => runCmd(insertTable(3, 3)),
        'menu:para_code_block': () => runCmd(insertCodeBlock),
        'menu:para_math_block': () => runCmd(insertMathBlockCmd),
        'menu:para_quote': () => runCmd(wrapInBlockquote),
        'menu:para_bullet_list': () => runCmd(wrapInBulletList),
        'menu:para_ordered_list': () => runCmd(wrapInOrderedList),
        'menu:para_hr': () => runCmd(insertHorizontalRule),
        // Format
        'menu:fmt_bold': () => runCmd(toggleBold),
        'menu:fmt_italic': () => runCmd(toggleItalic),
        'menu:fmt_strikethrough': () => runCmd(toggleStrikethrough),
        'menu:fmt_code': () => runCmd(toggleCode),
        'menu:fmt_link': () => runCmd(toggleLink({ href: '' })),
        'menu:fmt_image': () => { showImageDialog = true; },
        // View — editor modes: payload is boolean (is_checked state from native menu).
        // On macOS, Cocoa auto-toggles CheckMenuItem before firing the event, so the
        // checked item indicates the mode the user selected.
        'menu:view_mode_visual': (p) => { if (p === true) { editorMode = 'visual'; editorStore.setEditorMode('visual'); } },
        'menu:view_mode_source': (p) => { if (p === true) { editorMode = 'source'; editorStore.setEditorMode('source'); } },
        'menu:view_mode_split': (p) => { if (p === true) { editorMode = 'split'; editorStore.setEditorMode('split'); } },
        // View — panels (regular MenuItems, no check state — just toggle)
        'menu:view_sidebar': () => settingsStore.toggleSidebar(),
        'menu:view_ai_panel': () => { showAIPanel = !showAIPanel; },
        'menu:view_outline': () => { settingsStore.update({ showOutline: !showOutline }); },
        // View — zoom
        'menu:view_zoom_in': () => {
          const s = settingsStore.getState();
          const sz = Math.min(s.fontSize + 1, 24);
          settingsStore.update({ fontSize: sz });
          document.documentElement.style.setProperty('--font-size-base', `${sz}px`);
        },
        'menu:view_zoom_out': () => {
          const s = settingsStore.getState();
          const sz = Math.max(s.fontSize - 1, 12);
          settingsStore.update({ fontSize: sz });
          document.documentElement.style.setProperty('--font-size-base', `${sz}px`);
        },
        'menu:view_actual_size': () => {
          settingsStore.update({ fontSize: 16 });
          document.documentElement.style.setProperty('--font-size-base', '16px');
        },
        // Help
        'menu:help_version_info': () => { showUpdateDialog = true; },
        'menu:help_changelog': () => { openUrl('https://github.com/zouwei/moraya/releases'); },
        'menu:help_privacy': async () => {
          try {
            const privacyContent = await invoke<string>('read_resource_file', { name: 'privacy-policy.md' });
            content = privacyContent;
            editorStore.setContent(privacyContent);
            syncVisualEditor(content);
          } catch {
            // Resource not found
          }
        },
        'menu:help_website': () => { openUrl('https://moraya.app'); },
        'menu:help_about': () => { openUrl('https://moraya.app/en/about/'); },
        'menu:help_feedback': () => { openUrl('https://github.com/zouwei/moraya/issues'); },
        // App
        'menu:preferences': () => { showSettings = !showSettings; },
      };

      Object.entries(menuHandlers).forEach(([event, handler]) => {
        listen(event, (e) => handler(e.payload)).then(unlisten => menuUnlisteners.push(unlisten));
      });

      // Helper: load a file by path and sync to all editor modes
      async function openFileByPath(filePath: string) {
        const fileContent = await loadFile(filePath);
        content = fileContent;
        resetWorkflowState();
        await replaceContentAndScrollToTop(content);
      }

      // Listen for file open events from OS file association (while app is running)
      listen<string>('open-file', async (event) => {
        const filePath = event.payload;
        if (filePath) {
          await openFileByPath(filePath);
        }
      }).then(unlisten => { openFileUnlisten = unlisten; });

      // Check if a file was passed via OS file association on startup
      invoke<string | null>('get_opened_file').then(async (filePath) => {
        if (filePath) {
          await openFileByPath(filePath);
        }
      });

      // Drag-drop: open MD files (new windows on desktop, new tabs on iPad)
      const MD_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdx', 'txt']);
      if (!isIPadOS) {
        getCurrentWebview().onDragDropEvent(async (event) => {
          if (event.payload.type !== 'drop') return;
          const { paths } = event.payload;
          for (const p of paths) {
            const ext = p.split('.').pop()?.toLowerCase() ?? '';
            if (MD_EXTENSIONS.has(ext)) {
              try {
                await invoke('open_file_in_new_window', { path: p });
              } catch (err) {
                console.error('Failed to open file in new window:', err);
              }
            }
          }
        }).then(unlisten => { dragDropUnlisten = unlisten; });
      }
    }

    return () => {
      if (autoSaveTimer) clearInterval(autoSaveTimer);
      menuUnlisteners.forEach(unlisten => unlisten());
      openFileUnlisten?.();
      dragDropUnlisten?.();
      vvUnlisten?.();
      window.removeEventListener('moraya:file-synced', handleFileSynced);
      window.removeEventListener('moraya:dynamic-service-created', handleDynamicServiceCreated);
      // Dynamic MCP services are now always persisted (lifecycle: 'saved')
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app-container">
  <TitleBar title={currentFileName} />

  {#if isIPadOS}
    <TabBar
      onNewTab={() => handleNewFile()}
      onCloseTab={(tab) => {
        if (tab.isDirty) {
          // TODO: show unsaved changes dialog
          tabsStore.closeTab(tab.id);
        } else {
          tabsStore.closeTab(tab.id);
        }
      }}
    />
  {/if}

  <div class="app-body">
    {#if showSidebar}
      <Sidebar onFileSelect={handleFileSelect} onOpenKBManager={() => showKBManager = true} />
    {/if}

    <main class="editor-area">
      {#if editorMode === 'visual'}
        <Editor bind:this={visualEditorRef} bind:content {showOutline} onEditorReady={handleEditorReady} onNotify={showToast} />
      {:else if editorMode === 'source'}
        <SourceEditor bind:this={sourceEditorRef} bind:content {showOutline} onContentChange={handleContentChange} />
      {:else if editorMode === 'split'}
        <div class="split-container">
          <div class="split-source" bind:this={splitSourceEl}>
            <SourceEditor bind:this={splitSourceRef} bind:content onContentChange={handleContentChange} hideScrollbar />
          </div>
          <div class="split-visual" bind:this={splitVisualEl}>
            <Editor bind:this={splitVisualRef} bind:content onEditorReady={handleEditorReady} onContentChange={handleContentChange} onNotify={showToast} />
          </div>
        </div>
      {/if}

      {#if showSearch}
        <SearchBar
          {showReplace}
          matchCount={searchMatchCount}
          currentMatch={searchCurrentMatch}
          onSearch={handleSearch}
          onFindNext={handleFindNext}
          onFindPrev={handleFindPrev}
          onReplace={handleReplace}
          onReplaceAll={handleReplaceAll}
          onToggleReplace={() => showReplace = !showReplace}
          onClose={handleSearchClose}
        />
      {/if}
    </main>

    {#if showAIPanel}
      {#await import('$lib/components/ai/AIChatPanel.svelte') then { default: AIChatPanel }}
        <AIChatPanel
          documentContent={content}
          {selectedText}
          getDocumentContent={getCurrentContent}
          onInsert={handleAIInsert}
          onReplace={handleAIReplace}
          onOpenSettings={() => { settingsInitialTab = 'ai'; showSettings = true; }}
          onOpenVoiceSettings={() => { settingsInitialTab = 'voice'; showSettings = true; }}
        />
      {/await}
    {/if}
  </div>

  {#if showTouchToolbar && editorMode !== 'source'}
    <TouchToolbar onCommand={handleTouchCommand} />
  {/if}

  <StatusBar
    onPublishWorkflow={handlePublishWorkflow}
    onShowUpdateDialog={() => showUpdateDialog = true}
    onToggleAI={() => showAIPanel = !showAIPanel}
    onModeChange={(mode) => { editorMode = mode; editorStore.setEditorMode(mode); }}
    currentMode={editorMode}
    aiPanelOpen={showAIPanel}
    {aiConfigured}
    {aiLoading}
    {aiError}
  />
</div>

{#if showSettings}
  {#await import('$lib/components/SettingsPanel.svelte') then { default: SettingsPanel }}
    <SettingsPanel initialTab={settingsInitialTab} onClose={() => { showSettings = false; settingsInitialTab = 'general'; }} />
  {/await}
{/if}

{#if showImageDialog}
  {#await import('$lib/components/ImageInsertDialog.svelte') then { default: ImageInsertDialog }}
    <ImageInsertDialog
      onInsert={handleInsertImage}
      onClose={() => showImageDialog = false}
    />
  {/await}
{/if}

{#if showWorkflow}
  {#await import('$lib/components/PublishWorkflow.svelte') then { default: PublishWorkflow }}
    <PublishWorkflow
      onClose={() => showWorkflow = false}
      onSEO={handleWorkflowSEO}
      onImageGen={handleWorkflowImageGen}
      onPublish={handleWorkflowPublish}
      onMCPTool={handleWorkflowMCPTool}
      {seoCompleted}
      {imageGenCompleted}
    />
  {/await}
{/if}

{#if showSEOPanel}
  {#await import('$lib/components/SEOPanel.svelte') then { default: SEOPanel }}
    <SEOPanel
      onClose={() => showSEOPanel = false}
      onApply={handleSEOApply}
      onOpenSettings={() => { showSEOPanel = false; settingsInitialTab = 'ai'; showSettings = true; }}
    />
  {/await}
{/if}

{#if imageGenDialogMounted}
  <div class="dialog-visibility" class:hidden={!showImageGenDialog}>
    {#await import('$lib/components/ImageGenDialog.svelte') then { default: ImageGenDialog }}
      <ImageGenDialog
        onClose={() => { showImageGenDialog = false; imageGenDialogMounted = false; }}
        onInsert={handleImageGenInsert}
        onOpenSettings={() => { showImageGenDialog = false; imageGenDialogMounted = false; settingsInitialTab = 'ai'; showSettings = true; }}
        documentContent={content}
      />
    {/await}
  </div>
{/if}

{#if showPublishConfirm}
  {#await import('$lib/components/PublishConfirm.svelte') then { default: PublishConfirm }}
    <PublishConfirm
      onClose={() => showPublishConfirm = false}
      onConfirm={handlePublishConfirm}
    />
  {/await}
{/if}

{#if showUpdateDialog}
  {#await import('$lib/components/UpdateDialog.svelte') then { default: UpdateDialog }}
    <UpdateDialog onClose={() => showUpdateDialog = false} />
  {/await}
{/if}

{#if showKBManager}
  {#await import('$lib/components/KnowledgeBaseManager.svelte') then { default: KnowledgeBaseManager }}
    <KnowledgeBaseManager onClose={() => showKBManager = false} />
  {/await}
{/if}

{#if publishProgress.length > 0}
  <div class="publish-progress">
    <div class="progress-title">{$t('publish.progressTitle')}</div>
    {#each publishProgress as item}
      <div class="progress-item" class:done={item.status === 'done'} class:error={item.status === 'error'}>
        <span class="progress-icon">
          {#if item.status === 'publishing' || item.status === 'rss'}
            <span class="spinner"></span>
          {:else if item.status === 'done'}
            ✓
          {:else}
            ✗
          {/if}
        </span>
        <span class="progress-name">{item.targetName}</span>
        <span class="progress-status">
          {#if item.status === 'publishing'}
            {$t('publish.progressPublishing')}
          {:else if item.status === 'rss'}
            {$t('publish.progressRss')}
          {:else if item.status === 'done'}
            {$t('publish.progressDone')}
          {:else}
            {item.message || $t('publish.progressFailed')}
          {/if}
        </span>
      </div>
    {/each}
  </div>
{/if}

<Toast messages={toastMessages} />

<style>
  .app-container {
    display: flex;
    flex-direction: column;
    height: var(--app-height, 100dvh);
    overflow: hidden;
  }

  /* Fallback for browsers without dvh support */
  @supports not (height: 100dvh) {
    .app-container {
      height: var(--app-height, 100vh);
    }
  }

  /* macOS: offset content below native traffic lights (TitleBarStyle::Overlay).
     Padding is applied to individual content panes (not .app-container) so that
     structural borders (sidebar border-right, split divider border-left) extend
     flush to the top of the window. */
  :global(.platform-macos) .editor-area {
    padding-top: 28px;
  }

  :global(.platform-macos) .editor-area:has(.split-container) {
    padding-top: 0;
  }

  :global(.platform-macos) .split-source,
  :global(.platform-macos) .split-visual {
    padding-top: 28px;
  }

  :global(.platform-macos) .app-body > :global(.sidebar) {
    padding-top: 28px;
  }

  :global(.platform-macos) .app-body > :global(.ai-panel) {
    padding-top: 28px;
  }

  .app-body {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: var(--bg-primary);
  }

  /* Split mode: golden ratio 38.2% source, 61.8% visual */
  .split-container {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  .split-source {
    flex: 382;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .split-visual {
    flex: 618;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-left: 1px solid var(--border-color);
  }

  .dialog-visibility {
    display: contents;
  }

  .dialog-visibility.hidden {
    display: none;
  }

  /* Publish progress overlay */
  .publish-progress {
    position: fixed;
    top: 40px;
    right: 1rem;
    width: 280px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
    padding: 12px 14px;
    z-index: 199;
  }

  .progress-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    margin-bottom: 8px;
    color: var(--text-primary);
  }

  .progress-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }

  .progress-item.done {
    color: #34c759;
  }

  .progress-item.error {
    color: #ff3b30;
  }

  .progress-icon {
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 12px;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border-color);
    border-top-color: #007aff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .progress-name {
    font-weight: 500;
    flex-shrink: 0;
  }

  .progress-status {
    flex: 1;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { Editor as MilkdownEditor } from '@milkdown/core';
  import { editorViewCtx } from '@milkdown/core';
  import { TextSelection } from '@milkdown/prose/state';
  import { callCommand, replaceAll, insert } from '@milkdown/utils';
  import {
    wrapInHeadingCommand,
    wrapInBlockquoteCommand,
    wrapInBulletListCommand,
    wrapInOrderedListCommand,
    createCodeBlockCommand,
    insertHrCommand,
    toggleStrongCommand,
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    toggleLinkCommand,
    insertImageCommand,
  } from '@milkdown/preset-commonmark';
  import {
    insertTableCommand,
    toggleStrikethroughCommand,
  } from '@milkdown/preset-gfm';
  import { undoCommand, redoCommand } from '@milkdown/plugin-history';
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
  import { initAIStore, aiStore } from '$lib/services/ai';
  import { initMCPStore, connectAllServers } from '$lib/services/mcp';
  import { initContainerManager, cleanupTempServices } from '$lib/services/mcp/container-manager';
  import { preloadEnhancementPlugins } from '$lib/editor/setup';
  import { openFile, saveFile, saveFileAs, loadFile, getFileNameFromPath, readImageAsBlobUrl } from '$lib/services/file-service';
  import { exportDocument, type ExportFormat } from '$lib/services/export-service';
  import { checkForUpdate, shouldCheckToday, getTodayDateString } from '$lib/services/update-service';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { t } from '$lib/i18n';
  import { getPlatformClass, isIPadOS, isMacOS, isTauri, isVirtualKeyboardVisible } from '$lib/utils/platform';
  import TabBar from '$lib/components/TabBar.svelte';
  import TouchToolbar from '$lib/editor/TouchToolbar.svelte';
  import { tabsStore } from '$lib/stores/tabs-store';

  import '$lib/styles/global.css';
  import '$lib/styles/editor.css';

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
  let settingsInitialTab = $state<'general' | 'ai'>('general');
  let showAIPanel = $state(false);
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
  let seoCompleted = $state(false);
  let imageGenCompleted = $state(false);
  let currentSEOData = $state<SEOData | null>(null);

  // Toast notifications
  let toastMessages = $state<{ id: number; text: string; type: 'success' | 'error' }[]>([]);
  let toastIdCounter = 0;

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

  // Milkdown editor reference for menu commands
  let milkdownEditor: MilkdownEditor | null = null;

  // Editor component references for search
  let visualEditorRef: Editor | undefined = $state();
  let sourceEditorRef: SourceEditor | undefined = $state();
  let splitSourceRef: SourceEditor | undefined = $state();
  let splitVisualRef: Editor | undefined = $state();

  function handleEditorReady(editor: MilkdownEditor) {
    milkdownEditor = editor;
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
    if (milkdownEditor && editorStore.getState().editorMode !== 'source') {
      try {
        milkdownEditor.action(replaceAll(newContent));
        milkdownEditor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const tr = view.state.tr.setSelection(
            TextSelection.create(view.state.doc, 1)
          );
          view.dispatch(tr);
        });
      } catch {
        // Editor may not be fully ready yet
      }
    }
    await scrollEditorToTop();
  }

  /** Save with tab sync on iPad */
  async function handleSave(asNew = false) {
    const saved = asNew ? await saveFileAs(content) : await saveFile(content);
    if (saved && isIPadOS) {
      const state = editorStore.getState();
      if (state.currentFilePath) {
        tabsStore.updateActiveFile(state.currentFilePath, getFileNameFromPath(state.currentFilePath));
      }
    }
  }

  function runEditorCommand(cmd: any, payload?: any) {
    if (!milkdownEditor) return;
    try {
      milkdownEditor.action(callCommand(cmd.key ?? cmd, payload));
    } catch {
      // Command may fail if editor not ready or selection invalid
    }
  }

  /** Handle commands from the iPad touch toolbar */
  function handleTouchCommand(cmd: string) {
    const commandMap: Record<string, () => void> = {
      bold: () => runEditorCommand(toggleStrongCommand),
      italic: () => runEditorCommand(toggleEmphasisCommand),
      strikethrough: () => runEditorCommand(toggleStrikethroughCommand),
      code: () => runEditorCommand(toggleInlineCodeCommand),
      link: () => runEditorCommand(toggleLinkCommand, { href: '' }),
      h1: () => runEditorCommand(wrapInHeadingCommand, 1),
      h2: () => runEditorCommand(wrapInHeadingCommand, 2),
      h3: () => runEditorCommand(wrapInHeadingCommand, 3),
      quote: () => runEditorCommand(wrapInBlockquoteCommand),
      bullet_list: () => runEditorCommand(wrapInBulletListCommand),
      ordered_list: () => runEditorCommand(wrapInOrderedListCommand),
      code_block: () => runEditorCommand(createCodeBlockCommand),
      math_block: () => insertMathBlock(),
      table: () => runEditorCommand(insertTableCommand, { row: 3, col: 3 }),
      image: () => { showImageDialog = true; },
      hr: () => runEditorCommand(insertHrCommand),
      undo: () => runEditorCommand(undoCommand),
      redo: () => runEditorCommand(redoCommand),
    };
    commandMap[cmd]?.();
  }

  async function insertMathBlock() {
    if (!milkdownEditor) return;
    try {
      const { mathBlockSchema } = await import('@milkdown/plugin-math');
      milkdownEditor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state, dispatch } = view;
        const mathType = mathBlockSchema.type(ctx);
        const node = mathType.create({}, state.schema.text(''));
        const tr = state.tr.replaceSelectionWith(node);
        dispatch(tr);
      });
    } catch {
      // Math block insert failed
    }
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

  settingsStore.subscribe(state => {
    showSidebar = state.showSidebar;
  });

  editorStore.subscribe(state => {
    if (state.currentFilePath) {
      currentFileName = getFileNameFromPath(state.currentFilePath);
    } else {
      currentFileName = $t('common.untitled');
    }
    // Guard: only write $state when mode actually changes to avoid re-entrancy
    // during Svelte's render flush (e.g., when Editor.onDestroy calls setContent,
    // which triggers this subscriber while the component tree is being updated).
    if (editorMode !== state.editorMode) {
      editorMode = state.editorMode;
    }
    // Clear editor reference when switching to source-only mode
    if (state.editorMode === 'source') {
      milkdownEditor = null;
    }
    // Sync dirty state to tabs store on iPad
    if (isIPadOS) {
      tabsStore.syncDirty(state.isDirty);
    }
  });

  // iPad tabs: reload content when active tab changes
  let prevActiveTabId = '';
  if (isIPadOS) {
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

  // Sync native menu checkmarks when editor mode changes.
  // macOS only — on Windows/Linux mode items are regular MenuItems (no checkmarks).
  $effect(() => {
    if (!isTauri || !isMacOS) return;
    invoke('set_editor_mode_menu', { mode: editorMode }).catch(() => {});
  });

  // Sync sidebar and AI panel check state to native menu
  $effect(() => {
    if (!isTauri) return;
    invoke('set_menu_check', { id: 'view_sidebar', checked: showSidebar });
  });

  $effect(() => {
    if (!isTauri) return;
    invoke('set_menu_check', { id: 'view_ai_panel', checked: showAIPanel });
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

    // View shortcuts
    if (mod && event.key === '\\') {
      event.preventDefault();
      // In Tauri, the native menu accelerator (CmdOrCtrl+\) handles this via
      // menu:view_sidebar event. Only toggle here for non-Tauri environments.
      if (!isTauri) settingsStore.toggleSidebar();
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
      // Direct $state update ensures Svelte picks up the change in this handler's
      // execution context, not just through the store subscriber path.
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

    // AI Panel toggle: Cmd+J (avoids Ctrl+Shift+I DevTools conflict on Windows)
    if (mod && !event.shiftKey && event.key === 'j') {
      event.preventDefault();
      // In Tauri, the native menu accelerator (CmdOrCtrl+J) handles this via
      // menu:view_ai_panel event. Only toggle here for non-Tauri environments.
      if (!isTauri) showAIPanel = !showAIPanel;
      return;
    }

    // Export shortcut
    if (mod && event.shiftKey && event.key === 'E') {
      event.preventDefault();
      exportDocument(content, 'html');
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
      runEditorCommand(wrapInHeadingCommand, parseInt(event.key));
      return;
    }

    // Code block: Cmd+Shift+K (fallback for menu accelerator)
    if (mod && event.shiftKey && event.key === 'K') {
      event.preventDefault();
      runEditorCommand(createCodeBlockCommand);
      return;
    }

    // Quote: Cmd+Shift+Q (fallback for menu accelerator)
    if (mod && event.shiftKey && event.key === 'Q') {
      event.preventDefault();
      runEditorCommand(wrapInBlockquoteCommand);
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

  async function handleOpenFile() {
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

  async function handleFileSelect(path: string) {
    const fileContent = await loadFile(path);
    if (isIPadOS) {
      const fileName = getFileNameFromPath(path);
      tabsStore.openFileTab(path, fileName, fileContent);
      content = fileContent;
      resetWorkflowState();
      await replaceContentAndScrollToTop(content);
      return;
    }
    content = fileContent;
    editorStore.setContent(fileContent);
    resetWorkflowState();
    await replaceContentAndScrollToTop(content);
  }

  function handleContentChange(newContent: string) {
    content = newContent;
  }

  function handleAIInsert(text: string) {
    if (milkdownEditor && editorStore.getState().editorMode !== 'source') {
      try {
        // Insert AI text at current cursor position (not replaceAll which resets scroll)
        milkdownEditor.action(insert('\n\n' + text));
      } catch {
        // Fallback: append to content string
        content = content.trimEnd() + '\n\n' + text + '\n';
      }
    } else {
      // Source mode: directly update content string
      content = content.trimEnd() + '\n\n' + text + '\n';
    }
  }

  function handleAIReplace(text: string) {
    // If there's selected text in the editor, replace it; otherwise append
    if (selectedText && milkdownEditor && editorStore.getState().editorMode !== 'source') {
      try {
        milkdownEditor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { from, to } = view.state.selection;
          if (from !== to) {
            const tr = view.state.tr.insertText(text, from, to);
            view.dispatch(tr);
          }
        });
      } catch {
        // Fallback to append
        content = content.trimEnd() + '\n\n' + text + '\n';
      }
    } else {
      content = content.trimEnd() + '\n\n' + text + '\n';
      if (milkdownEditor && editorStore.getState().editorMode !== 'source') {
        try {
          milkdownEditor.action(replaceAll(content));
        } catch {
          // Editor may not be ready
        }
      }
    }
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
        runEditorCommand(insertImageCommand, { src, alt: data.alt });
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
    showWorkflow = false;
    showSEOPanel = true;
  }

  function handleWorkflowImageGen() {
    showWorkflow = false;
    imageGenDialogMounted = true;
    showImageGenDialog = true;
  }

  function handleWorkflowPublish() {
    showWorkflow = false;
    showPublishConfirm = true;
  }

  function handleSEOApply(data: SEOData) {
    currentSEOData = data;
    seoCompleted = true;
    showSEOPanel = false;
  }

  function handleImageGenInsert(images: { url: string; target: number }[], mode: 'paragraph' | 'end' | 'clipboard') {
    if (mode === 'end') {
      // Insert all images at end
      const imgMarkdown = images.map(img => `![](${img.url})`).join('\n\n');
      content = content.trimEnd() + '\n\n' + imgMarkdown + '\n';
      if (milkdownEditor && editorStore.getState().editorMode !== 'source') {
        try { milkdownEditor.action(replaceAll(content)); } catch { /* ignore */ }
      }
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
      if (milkdownEditor && editorStore.getState().editorMode !== 'source') {
        try { milkdownEditor.action(replaceAll(content)); } catch { /* ignore */ }
      }
    }

    imageGenCompleted = true;
    showImageGenDialog = false;
  }

  async function handlePublishConfirm(targetIds: string[]) {
    showPublishConfirm = false;
    const targets = settingsStore.getState().publishTargets.filter(t => targetIds.includes(t.id));

    // Fallback title: SEO title → first markdown heading → file name
    const fallbackTitle =
      currentSEOData?.selectedTitle ||
      content.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
      currentFileName.replace(/\.md$/i, '');

    const variables: Record<string, string> = {
      title: fallbackTitle,
      date: new Date().toISOString().split('T')[0],
      tags: currentSEOData?.tags?.join(', ') || '',
      description: currentSEOData?.metaDescription || '',
      slug: currentSEOData?.slug || 'untitled',
      cover: '',
      excerpt: currentSEOData?.excerpt || '',
      content,
    };

    // Lazy-load publish services
    const [{ publishToGitHub }, { publishToCustomAPI }] = await Promise.all([
      import('$lib/services/publish/github-publisher'),
      import('$lib/services/publish/api-publisher'),
    ]);

    const tr = $t;
    for (const target of targets) {
      let result: PublishResult;
      if (target.type === 'github') {
        result = await publishToGitHub(target, variables, content);
      } else {
        result = await publishToCustomAPI(target, variables);
      }

      if (result.success) {
        showToast(`${tr('workflow.publishSuccess')} → ${result.targetName}`, 'success');

        // Update RSS feed if enabled (non-fatal)
        try {
          if (target.type === 'github' && target.rss?.enabled) {
            const { updateGitHubRSSFeed } = await import('$lib/services/publish/rss-publisher');
            await updateGitHubRSSFeed(target, variables, content);
          } else if (target.type === 'custom-api' && target.rss?.enabled) {
            const { updateCustomAPIRSSFeed } = await import('$lib/services/publish/rss-publisher');
            await updateCustomAPIRSSFeed(target, variables, content);
          }
        } catch (rssErr) {
          showToast(`${tr('publish.rssUpdateFailed')}: ${rssErr instanceof Error ? rssErr.message : ''}`, 'error');
        }
      } else {
        showToast(`${tr('workflow.publishFailed')} → ${result.targetName}: ${result.message}`, 'error');
      }
    }
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
    // Detect platform for CSS classes (iPadOS UA mimics macOS, needs maxTouchPoints check)
    document.body.classList.add(getPlatformClass());

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

    // Preload enhancement plugins in background (warms cache for editor creation)
    preloadEnhancementPlugins();

    // Restore persisted settings, AI config, and MCP servers (Tauri-only: uses plugin-store)
    if (isTauri) {
      Promise.all([initSettingsStore(), initAIStore(), initMCPStore()])
        .then(() => {
          // Auto-connect all enabled MCP servers
          connectAllServers().catch(() => {});

          // Initialize dynamic service container (checks Node.js, reconnects saved services)
          initContainerManager().catch(() => {});

          // Auto-check for updates (once daily)
          const settings = settingsStore.getState();
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
        if (milkdownEditor && editorStore.getState().editorMode !== 'source') {
          try { milkdownEditor.action(replaceAll(content)); } catch { /* ignore */ }
        }
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
      const menuHandlers: Record<string, () => void> = {
        // File
        'menu:file_new': () => handleNewFile(),
        'menu:file_new_window': () => isIPadOS ? handleNewFile() : invoke('create_new_window').catch(() => {}),
        'menu:file_open': () => handleOpenFile(),
        'menu:file_save': () => handleSave(),
        'menu:file_save_as': () => handleSave(true),
        'menu:file_export_html': () => exportDocument(content, 'html'),
        'menu:file_export_pdf': () => exportDocument(content, 'pdf'),
        'menu:file_export_image': () => exportDocument(content, 'image'),
        'menu:file_export_doc': () => exportDocument(content, 'doc'),
        // Edit — search
        'menu:edit_find': () => { showSearch = true; },
        'menu:edit_replace': () => { showSearch = true; showReplace = true; },
        // Paragraph
        'menu:para_h1': () => runEditorCommand(wrapInHeadingCommand, 1),
        'menu:para_h2': () => runEditorCommand(wrapInHeadingCommand, 2),
        'menu:para_h3': () => runEditorCommand(wrapInHeadingCommand, 3),
        'menu:para_h4': () => runEditorCommand(wrapInHeadingCommand, 4),
        'menu:para_h5': () => runEditorCommand(wrapInHeadingCommand, 5),
        'menu:para_h6': () => runEditorCommand(wrapInHeadingCommand, 6),
        'menu:para_table': () => runEditorCommand(insertTableCommand, { row: 3, col: 3 }),
        'menu:para_code_block': () => runEditorCommand(createCodeBlockCommand),
        'menu:para_math_block': () => insertMathBlock(),
        'menu:para_quote': () => runEditorCommand(wrapInBlockquoteCommand),
        'menu:para_bullet_list': () => runEditorCommand(wrapInBulletListCommand),
        'menu:para_ordered_list': () => runEditorCommand(wrapInOrderedListCommand),
        'menu:para_hr': () => runEditorCommand(insertHrCommand),
        // Format
        'menu:fmt_bold': () => runEditorCommand(toggleStrongCommand),
        'menu:fmt_italic': () => runEditorCommand(toggleEmphasisCommand),
        'menu:fmt_strikethrough': () => runEditorCommand(toggleStrikethroughCommand),
        'menu:fmt_code': () => runEditorCommand(toggleInlineCodeCommand),
        'menu:fmt_link': () => runEditorCommand(toggleLinkCommand, { href: '' }),
        'menu:fmt_image': () => { showImageDialog = true; },
        // View — editor modes (direct $state update + store update for robustness)
        'menu:view_mode_visual': () => { editorMode = 'visual'; editorStore.setEditorMode('visual'); },
        'menu:view_mode_source': () => { editorMode = 'source'; editorStore.setEditorMode('source'); },
        'menu:view_mode_split': () => { editorMode = 'split'; editorStore.setEditorMode('split'); },
        // View — panels
        'menu:view_sidebar': () => settingsStore.toggleSidebar(),
        'menu:view_ai_panel': () => { showAIPanel = !showAIPanel; },
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
            if (milkdownEditor && editorStore.getState().editorMode !== 'source') {
              try { milkdownEditor.action(replaceAll(content)); } catch { /* ignore */ }
            }
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
        listen(event, () => handler()).then(unlisten => menuUnlisteners.push(unlisten));
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
      cleanupTempServices().catch(() => {});
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
      <Sidebar onFileSelect={handleFileSelect} />
    {/if}

    <main class="editor-area">
      {#if editorMode === 'visual'}
        <Editor bind:this={visualEditorRef} bind:content onEditorReady={handleEditorReady} onContentChange={handleContentChange} />
      {:else if editorMode === 'source'}
        <SourceEditor bind:this={sourceEditorRef} bind:content onContentChange={handleContentChange} />
      {:else if editorMode === 'split'}
        <div class="split-container">
          <div class="split-source" bind:this={splitSourceEl}>
            <SourceEditor bind:this={splitSourceRef} bind:content onContentChange={handleContentChange} hideScrollbar />
          </div>
          <div class="split-visual" bind:this={splitVisualEl}>
            <Editor bind:this={splitVisualRef} bind:content onEditorReady={handleEditorReady} onContentChange={handleContentChange} />
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
          onInsert={handleAIInsert}
          onReplace={handleAIReplace}
          onOpenSettings={() => { settingsInitialTab = 'ai'; showSettings = true; }}
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
        onClose={() => showImageGenDialog = false}
        onInsert={handleImageGenInsert}
        onOpenSettings={() => { showImageGenDialog = false; settingsInitialTab = 'ai'; showSettings = true; }}
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
</style>

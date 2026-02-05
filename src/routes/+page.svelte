<script lang="ts">
  import { onMount } from 'svelte';
  import type { Editor as MilkdownEditor } from '@milkdown/core';
  import { editorViewCtx } from '@milkdown/core';
  import { callCommand, replaceAll } from '@milkdown/utils';
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
  import { mathBlockSchema } from '@milkdown/plugin-math';
  import Editor from '$lib/editor/Editor.svelte';
  import SourceEditor from '$lib/editor/SourceEditor.svelte';
  import SearchBar from '$lib/editor/SearchBar.svelte';
  import type { EditorMode } from '$lib/stores/editor-store';
  import TitleBar from '$lib/components/TitleBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import SettingsPanel from '$lib/components/SettingsPanel.svelte';
  import AIChatPanel from '$lib/components/ai/AIChatPanel.svelte';
  import ImageInsertDialog from '$lib/components/ImageInsertDialog.svelte';
  import PublishWorkflow from '$lib/components/PublishWorkflow.svelte';
  import SEOPanel from '$lib/components/SEOPanel.svelte';
  import ImageGenDialog from '$lib/components/ImageGenDialog.svelte';
  import PublishConfirm from '$lib/components/PublishConfirm.svelte';
  import UpdateDialog from '$lib/components/UpdateDialog.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import type { SEOData } from '$lib/services/ai/types';
  import type { PublishResult } from '$lib/services/publish/types';
  import { publishToGitHub } from '$lib/services/publish/github-publisher';
  import { publishToCustomAPI } from '$lib/services/publish/api-publisher';
  import { editorStore } from '$lib/stores/editor-store';
  import { settingsStore, initSettingsStore } from '$lib/stores/settings-store';
  import { initAIStore } from '$lib/services/ai';
  import { initMCPStore } from '$lib/services/mcp';
  import { openFile, saveFile, saveFileAs, loadFile, getFileNameFromPath, readImageAsBlobUrl } from '$lib/services/file-service';
  import { exportDocument, type ExportFormat } from '$lib/services/export-service';
  import { checkForUpdate, shouldCheckToday, getTodayDateString } from '$lib/services/update-service';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { t } from '$lib/i18n';

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

  let content = $state(import.meta.env.DEV ? getDefaultContent() : '');
  let showSidebar = $state(false);
  let showSettings = $state(false);
  let showAIPanel = $state(false);
  let showImageDialog = $state(false);
  let showSearch = $state(false);
  let showReplace = $state(false);
  let searchMatchCount = $state(0);
  let searchCurrentMatch = $state(0);
  let currentFileName = $state($t('common.untitled'));
  let selectedText = $state('');
  let editorMode = $state<EditorMode>('visual');

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

  function runEditorCommand(cmd: any, payload?: any) {
    if (!milkdownEditor) return;
    try {
      milkdownEditor.action(callCommand(cmd.key ?? cmd, payload));
    } catch {
      // Command may fail if editor not ready or selection invalid
    }
  }

  function insertMathBlock() {
    if (!milkdownEditor) return;
    try {
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
    editorMode = state.editorMode;
    // Clear editor reference when switching to source-only mode
    if (state.editorMode === 'source') {
      milkdownEditor = null;
    }
  });

  // Sync native menu checkmarks when editor mode changes
  $effect(() => {
    invoke('set_editor_mode_menu', { mode: editorMode });
  });

  // Sync sidebar and AI panel check state to native menu
  $effect(() => {
    invoke('set_menu_check', { id: 'view_sidebar', checked: showSidebar });
  });

  $effect(() => {
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
      // View menu
      view_mode_visual: tr('menu.visualMode'),
      view_mode_source: tr('menu.sourceMode'),
      view_mode_split: tr('menu.splitMode'),
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
    invoke('update_menu_labels', { labels });
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
          saveFile(content);
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
      if (event.shiftKey) {
        saveFileAs(content);
      } else {
        saveFile(content);
      }
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
      settingsStore.toggleSidebar();
      return;
    }

    if (mod && event.key === ',') {
      event.preventDefault();
      showSettings = !showSettings;
      return;
    }

    // Toggle source/visual mode: Cmd+/ (without shift)
    if (mod && !event.shiftKey && event.key === '/') {
      event.preventDefault();
      editorStore.toggleEditorMode();
      return;
    }

    // Split mode: Cmd+Shift+/ (Shift+/ produces '?' on most keyboards)
    if (mod && event.shiftKey && (event.key === '/' || event.key === '?')) {
      event.preventDefault();
      const current = editorStore.getState().editorMode;
      editorStore.setEditorMode(current === 'split' ? 'visual' : 'split');
      return;
    }

    // AI Panel toggle: Cmd+Shift+I (not Cmd+I which is italic)
    if (mod && event.shiftKey && event.key === 'I') {
      event.preventDefault();
      showAIPanel = !showAIPanel;
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
  }

  async function handleOpenFile() {
    const fileContent = await openFile();
    if (fileContent !== null) {
      content = fileContent;
      resetWorkflowState();
    }
  }

  function handleNewFile() {
    content = '';
    editorStore.reset();
    resetWorkflowState();
  }

  async function handleFileSelect(path: string) {
    const fileContent = await loadFile(path);
    content = fileContent;
    resetWorkflowState();
  }

  function handleAIInsert(text: string) {
    content = content.trimEnd() + '\n\n' + text + '\n';
    // In visual/split mode, sync the new content into Milkdown
    if (milkdownEditor && editorStore.getState().editorMode !== 'source') {
      try {
        milkdownEditor.action(replaceAll(content));
      } catch {
        // Editor may not be ready
      }
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
    const src = isLocalPath(data.src) ? await readImageAsBlobUrl(data.src) : data.src;
    const mode = editorStore.getState().editorMode;
    if (mode === 'source') {
      const imgMarkdown = `![${data.alt}](${src})`;
      content = content.trimEnd() + '\n\n' + imgMarkdown + '\n';
    } else {
      runEditorCommand(insertImageCommand, { src, alt: data.alt });
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

    const variables: Record<string, string> = {
      title: currentSEOData?.selectedTitle || '',
      date: new Date().toISOString().split('T')[0],
      tags: currentSEOData?.tags?.join(', ') || '',
      description: currentSEOData?.metaDescription || '',
      slug: currentSEOData?.slug || 'untitled',
      cover: '',
      excerpt: currentSEOData?.excerpt || '',
      content,
    };

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
      } else {
        showToast(`${tr('workflow.publishFailed')} → ${result.targetName}: ${result.message}`, 'error');
      }
    }
  }

  // Split mode scroll sync — only sync from the pane the user is hovering
  function setupScrollSync() {
    if (!splitSourceEl || !splitVisualEl) return;
    const sourceScroll = splitSourceEl.querySelector('.source-editor-outer') as HTMLElement;
    const visualScroll = splitVisualEl.querySelector('.editor-wrapper') as HTMLElement;
    if (!sourceScroll || !visualScroll) return;

    function syncFrom(source: HTMLElement, target: HTMLElement) {
      const maxScroll = source.scrollHeight - source.clientHeight;
      const ratio = maxScroll > 0 ? source.scrollTop / maxScroll : 0;
      const targetMax = target.scrollHeight - target.clientHeight;
      target.scrollTop = ratio * targetMax;
    }

    const onSourceScroll = () => {
      if (activeScrollPane === 'source') syncFrom(sourceScroll, visualScroll);
    };
    const onVisualScroll = () => {
      if (activeScrollPane === 'visual') syncFrom(visualScroll, sourceScroll);
    };

    const onSourceEnter = () => { activeScrollPane = 'source'; };
    const onVisualEnter = () => { activeScrollPane = 'visual'; };
    const onPaneLeave = () => { activeScrollPane = null; };

    sourceScroll.addEventListener('scroll', onSourceScroll);
    visualScroll.addEventListener('scroll', onVisualScroll);
    sourceScroll.addEventListener('mouseenter', onSourceEnter);
    visualScroll.addEventListener('mouseenter', onVisualEnter);
    sourceScroll.addEventListener('mouseleave', onPaneLeave);
    visualScroll.addEventListener('mouseleave', onPaneLeave);

    return () => {
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
    // Detect platform for CSS classes
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac')) {
      document.body.classList.add('platform-macos');
    } else if (ua.includes('win')) {
      document.body.classList.add('platform-windows');
    } else {
      document.body.classList.add('platform-linux');
    }

    // Restore persisted settings, AI config, and MCP servers
    Promise.all([initSettingsStore(), initAIStore(), initMCPStore()])
      .then(() => {
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

    // Initialize word count for default content
    editorStore.setContent(content);

    // Listen for native menu events from Tauri
    const menuUnlisteners: UnlistenFn[] = [];

    const menuHandlers: Record<string, () => void> = {
      // File
      'menu:file_new': () => handleNewFile(),
      'menu:file_new_window': () => invoke('create_new_window').catch(() => {}),
      'menu:file_open': () => handleOpenFile(),
      'menu:file_save': () => saveFile(content),
      'menu:file_save_as': () => saveFileAs(content),
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
      // View — editor modes
      'menu:view_mode_visual': () => editorStore.setEditorMode('visual'),
      'menu:view_mode_source': () => editorStore.setEditorMode('source'),
      'menu:view_mode_split': () => editorStore.setEditorMode('split'),
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
      listen(event, () => {
        if (document.hasFocus()) handler();
      }).then(unlisten => menuUnlisteners.push(unlisten));
    });

    // Helper: load a file by path and sync to all editor modes
    async function openFileByPath(filePath: string) {
      const fileContent = await loadFile(filePath);
      content = fileContent;
      resetWorkflowState();
      // Sync into Milkdown if it's already mounted (visual/split mode)
      if (milkdownEditor && editorStore.getState().editorMode !== 'source') {
        try {
          milkdownEditor.action(replaceAll(content));
        } catch {
          // Editor may not be fully ready yet
        }
      }
    }

    // Listen for file open events from OS file association (while app is running)
    let openFileUnlisten: UnlistenFn | undefined;
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

    // Drag-drop: open MD files in new windows
    const MD_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdx', 'txt']);
    let dragDropUnlisten: UnlistenFn | undefined;
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

    return () => {
      if (autoSaveTimer) clearInterval(autoSaveTimer);
      menuUnlisteners.forEach(unlisten => unlisten());
      openFileUnlisten?.();
      dragDropUnlisten?.();
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app-container">
  <TitleBar title={currentFileName} />

  <div class="app-body">
    {#if showSidebar}
      <Sidebar onFileSelect={handleFileSelect} />
    {/if}

    <main class="editor-area">
      {#if editorMode === 'visual'}
        <Editor bind:this={visualEditorRef} bind:content onEditorReady={handleEditorReady} />
      {:else if editorMode === 'source'}
        <SourceEditor bind:this={sourceEditorRef} bind:content />
      {:else if editorMode === 'split'}
        <div class="split-container">
          <div class="split-source" bind:this={splitSourceEl}>
            <SourceEditor bind:this={splitSourceRef} bind:content hideScrollbar />
          </div>
          <div class="split-divider"></div>
          <div class="split-visual" bind:this={splitVisualEl}>
            <Editor bind:this={splitVisualRef} bind:content onEditorReady={handleEditorReady} />
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
      <AIChatPanel
        documentContent={content}
        {selectedText}
        onInsert={handleAIInsert}
        onReplace={handleAIReplace}
      />
    {/if}
  </div>

  <StatusBar onPublishWorkflow={handlePublishWorkflow} onShowUpdateDialog={() => showUpdateDialog = true} />
</div>

{#if showSettings}
  <SettingsPanel onClose={() => showSettings = false} />
{/if}

{#if showImageDialog}
  <ImageInsertDialog
    onInsert={handleInsertImage}
    onClose={() => showImageDialog = false}
  />
{/if}

{#if showWorkflow}
  <PublishWorkflow
    onClose={() => showWorkflow = false}
    onSEO={handleWorkflowSEO}
    onImageGen={handleWorkflowImageGen}
    onPublish={handleWorkflowPublish}
    {seoCompleted}
    {imageGenCompleted}
  />
{/if}

{#if showSEOPanel}
  <SEOPanel
    onClose={() => showSEOPanel = false}
    onApply={handleSEOApply}
  />
{/if}

{#if imageGenDialogMounted}
  <div class="dialog-visibility" class:hidden={!showImageGenDialog}>
    <ImageGenDialog
      onClose={() => showImageGenDialog = false}
      onInsert={handleImageGenInsert}
    />
  </div>
{/if}

{#if showPublishConfirm}
  <PublishConfirm
    onClose={() => showPublishConfirm = false}
    onConfirm={handlePublishConfirm}
  />
{/if}

{#if showUpdateDialog}
  <UpdateDialog onClose={() => showUpdateDialog = false} />
{/if}

<Toast messages={toastMessages} />

<style>
  .app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
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
    overflow: hidden;
    background: var(--bg-primary);
  }

  /* Split mode: golden ratio 38.2% source, 61.8% visual */
  .split-container {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .split-source {
    flex: 0 0 38.2%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .split-divider {
    width: 1px;
    background: var(--border-color);
    flex-shrink: 0;
  }

  .split-visual {
    flex: 0 0 61.8%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .dialog-visibility {
    display: contents;
  }

  .dialog-visibility.hidden {
    display: none;
  }
</style>

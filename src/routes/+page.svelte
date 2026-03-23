<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
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
  import { initMCPStore, connectAllServers, mcpStore } from '$lib/services/mcp';
  import { initContainerManager } from '$lib/services/mcp/container-manager';
  import { preloadEnhancementPlugins } from '$lib/editor/setup';
  import { openFile, saveFile, saveFileAs, loadFile, getFileNameFromPath, readImageAsBlobUrl, migrateTempImages, isImageFile } from '$lib/services/file-service';
  import { exportDocument, type ExportFormat } from '$lib/services/export-service';
  import { checkForUpdate, shouldCheckToday, getTodayDateString } from '$lib/services/update-service';
  import { listen, emitTo, type UnlistenFn } from '@tauri-apps/api/event';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
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
  // DEBUG: track content becoming empty (possible blank-content regression)
  let _prevContentLen = 0;
  $effect(() => {
    const len = content.length;
    if (len === 0 && _prevContentLen > 0) {
      console.warn('[Content$effect] content became EMPTY! was:', _prevContentLen, 'chars. Stack:', new Error().stack);
    }
    _prevContentLen = len;
  });
  let showSidebar = $state(false);
  let showSettings = $state(false);
  let settingsInitialTab = $state<'general' | 'ai' | 'voice'>('general');
  let showAIPanel = $state(false);
  let showOutline = $state(false);
  let outlineWidth = $state(200);
  let showImageDialog = $state(false);
  let showSearch = $state(false);
  let showReplace = $state(false);
  // Image tab preview state — derived from active tab
  let activeImageTab = $state<import('$lib/stores/tabs-store').TabItem | null>(null);
  let imagePreviewUrl = $state<string | null>(null);
  let showTouchToolbar = $state(isIPadOS);
  let searchMatchCount = $state(0);
  let searchCurrentMatch = $state(0);
  let searchRegexError = $state('');
  // Cache last search params so we can re-run search after mode switch
  let lastSearchText = '';
  let lastSearchCS = false;
  let lastSearchRegex = false;
  let currentFileName = $state($t('common.untitled'));
  let selectedText = $state('');
  let editorMode = $state<EditorMode>('visual');

  // Tab state for TitleBar and TabBar rendering
  let tabs = $state<import('$lib/stores/tabs-store').TabItem[]>([]);
  let activeTabId = $state('');
  // Index where external tab would be inserted (-1 = hidden, >=0 = show indicator at that position)
  let externalDropIndex = $state(-1);

  // AI store state for sparkle indicator
  let aiConfigured = $state(false);
  let aiLoading = $state(false);
  let aiError = $state(false);

  // Top-level store subscriptions — do NOT wrap in $effect().
  // In Svelte 5, $effect tracks reads inside subscribe callbacks, causing
  // infinite re-subscription loops when callbacks compare/write $state vars.
  // Capture unsubscribe handles for onDestroy cleanup (prevents HMR accumulation).
  const unsubAI = aiStore.subscribe(state => {
    aiConfigured = state.isConfigured;
    aiLoading = state.isLoading;
    aiError = !!state.error;
  });

  // Publish workflow state
  let showSEOPanel = $state(false);
  let showImageGenDialog = $state(false);
  let imageGenDialogMounted = $state(false);
  let showPublishConfirm = $state(false);
  let showUpdateDialog = $state(false);
  let showKBManager = $state(false);
  let showCommandPalette = $state(false);
  let commandPaletteMode: 'files' | 'commands' = $state('files');

  // KB indexing progress
  let indexingPhase = $state('');
  let indexingCurrent = $state(0);
  let indexingTotal = $state(0);
  let indexingClearTimer: ReturnType<typeof setTimeout> | undefined;
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
    // Focus is handled by Editor.svelte's onMount (cursor restore + focus).
    // Do not duplicate focus here — racing RAFs can cause focus to be lost
    // in new windows where the WebView is still initializing.
  }

  /** Get the current document content on-demand.
   *  In visual mode: serializes ProseMirror doc to markdown (avoids per-keystroke cost).
   *  In source/split mode: returns the `content` binding directly (already up-to-date). */
  function getCurrentContent(): string {
    const mode = editorStore.getState().editorMode;
    if (mode === 'visual' && visualEditorRef) {
      return visualEditorRef.getFullMarkdown();
    }
    if (mode === 'split' && splitVisualRef) {
      return splitVisualRef.getFullMarkdown();
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
    const mySerial = fileSelectSerial;
    editorStore.setCursorOffset(0);
    syncVisualEditor(newContent);
    // syncVisualEditor → syncContent → applySyncDoc already sets
    // TextSelection.atStart(doc). Do NOT dispatch another selection
    // here — two rapid DOM selection updates confuse WebKit's caret rendering,
    // causing the cursor to appear between blocks instead of inside text.
    if (mySerial !== fileSelectSerial) return; // Superseded by a newer switch
    await scrollEditorToTop();
    // Re-focus the editor after layout settles so WebKit renders the caret correctly.
    if (morayaEditor && mySerial === fileSelectSerial) {
      requestAnimationFrame(() => {
        try { morayaEditor?.view.focus(); } catch { /* destroyed */ }
      });
    }
  }

  /** Create a versioned backup in .moraya/history/ when saving MORAYA.md. */
  async function createMorayaHistory(filePath: string, content: string) {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    const historyDir = `${dir}/.moraya/history`;
    const timestamp = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
    try {
      await invoke('write_file', { path: `${historyDir}/${timestamp}.md`, content });
      // Prune old versions
      const maxVersions = settingsStore.getState().rulesHistoryCount ?? 10;
      const entries = await invoke<FileEntry[]>('read_dir_recursive', { path: historyDir, depth: 1 });
      const historyFiles = entries
        .filter(e => !e.is_dir && e.name?.endsWith('.md'))
        .sort((a, b) => b.name.localeCompare(a.name)); // newest first
      if (historyFiles.length > maxVersions) {
        for (const old of historyFiles.slice(maxVersions)) {
          await invoke('delete_file', { path: old.path }).catch(() => {});
        }
      }
    } catch {
      // Ignore — history is a best-effort feature
    }
  }

  /** Save with tab sync on iPad */
  async function handleSave(asNew = false): Promise<boolean> {
    const prevFilePath = editorStore.getState().currentFilePath;
    const latestContent = getCurrentContent();
    const saved = asNew ? await saveFileAs(latestContent) : await saveFile(latestContent);

    if (saved) {
      const state = editorStore.getState();
      const newFilePath = state.currentFilePath;

      if (newFilePath) {
        // Fetch mtime after save for external change detection
        invoke('get_files_mtime', { paths: [newFilePath] }).then((result: unknown) => {
          const mtimes = result as [string, number][];
          if (mtimes.length > 0) {
            tabsStore.updateActiveFile(newFilePath, getFileNameFromPath(newFilePath), mtimes[0][1]);
          } else {
            tabsStore.updateActiveFile(newFilePath, getFileNameFromPath(newFilePath));
          }
        }).catch(() => {
          tabsStore.updateActiveFile(newFilePath, getFileNameFromPath(newFilePath));
        });
      }

      if (!asNew && newFilePath && getFileNameFromPath(newFilePath) === 'MORAYA.md') {
        createMorayaHistory(newFilePath, latestContent);
      }

      // Migrate temp images when article is first saved (prevPath was null → now has a path)
      if (!prevFilePath && newFilePath) {
        const kb = filesStore.getActiveKnowledgeBase?.();
        if (kb && newFilePath.startsWith(kb.path)) {
          const movedPaths = await migrateTempImages(newFilePath, kb.path);
          if (movedPaths.size > 0) {
            // Update markdown refs: images/temp/filename → images/{mirror}/filename
            let updatedContent = latestContent;
            for (const [oldRel, newRel] of movedPaths) {
              updatedContent = updatedContent.split(oldRel).join(newRel);
            }
            if (updatedContent !== latestContent) {
              await invoke('write_file', { path: newFilePath, content: updatedContent });
              editorStore.setContent(updatedContent);
              window.dispatchEvent(new CustomEvent('moraya:file-synced', { detail: { content: updatedContent } }));
            }
          }
        }
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

  /** Check if focus is inside the source textarea pane (split mode). */
  function isSourcePaneFocused(): boolean {
    return document.activeElement?.tagName === 'TEXTAREA';
  }

  // ── Search / Replace callbacks ─────────────────────────

  function getActiveSearchTarget(): Editor | SourceEditor | undefined {
    if (editorMode === 'visual') return visualEditorRef;
    if (editorMode === 'source') return sourceEditorRef;
    if (editorMode === 'split') return splitVisualRef ?? splitSourceRef;
    return undefined;
  }

  function handleSearch(text: string, caseSensitive: boolean, useRegex: boolean = false) {
    lastSearchText = text;
    lastSearchCS = caseSensitive;
    lastSearchRegex = useRegex;
    searchRegexError = '';
    const target = getActiveSearchTarget();
    if (!target) { searchMatchCount = 0; searchCurrentMatch = 0; return; }
    const result = target.searchText(text, caseSensitive, useRegex);
    if (typeof result === 'object' && 'error' in result) {
      searchRegexError = result.error;
      searchMatchCount = 0;
      searchCurrentMatch = 0;
    } else {
      const count = typeof result === 'number' ? result : 0;
      searchMatchCount = count;
      searchCurrentMatch = count > 0 ? 1 : 0;
    }
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

  function handleReplaceAll(searchText: string, replaceText: string, caseSensitive: boolean, useRegex: boolean = false) {
    const target = getActiveSearchTarget();
    if (!target) return;
    target.searchReplaceAll(searchText, replaceText, caseSensitive, useRegex);
    searchMatchCount = 0;
    searchCurrentMatch = 0;
  }

  function handleSearchClose() {
    showSearch = false;
    showReplace = false;
    searchMatchCount = 0;
    searchCurrentMatch = 0;
    searchRegexError = '';
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
  const unsubSettings = settingsStore.subscribe(state => {
    showSidebar = state.showSidebar;
    showOutline = state.showOutline;
    if (state.outlineWidth !== outlineWidth) outlineWidth = state.outlineWidth;
  });

  // Track previous values to skip redundant work in hot subscriber path.
  // This subscriber fires on every store update (setContent, setDirty, setFocused, etc.)
  // so we must avoid doing unnecessary work or writing $state on each call.
  // Use undefined sentinel so even the initial null → null fires registration
  let prevFilePath: string | null | undefined = undefined;
  let prevEditorMode: EditorMode | null = null;

  const unsubEditor = editorStore.subscribe(state => {
    // Only recompute file name when path actually changes
    if (state.currentFilePath !== prevFilePath) {
      prevFilePath = state.currentFilePath;
      currentFileName = state.currentFilePath
        ? getFileNameFromPath(state.currentFilePath)
        : $t('common.untitled');

      // Register with macOS Dock menu tracker
      if (isTauri && isMacOS) {
        invoke('register_dock_document', {
          displayName: currentFileName,
          filePath: state.currentFilePath ?? null,
        }).catch(() => {});
      }
    }
    // Guard: only write $state when mode actually changes to avoid re-entrancy
    // during Svelte's render flush (e.g., when Editor.onDestroy calls setContent,
    // which triggers this subscriber while the component tree is being updated).
    if (state.editorMode !== prevEditorMode) {
      const prevMode = prevEditorMode;
      prevEditorMode = state.editorMode;
      editorMode = state.editorMode;
      console.log('[EditorSub] mode change:', prevMode, '->', state.editorMode, 'content length:', content.length);
      // Sync content when leaving any mode to ensure the incoming editor gets fresh data.
      if (prevMode === 'visual' && visualEditorRef) {
        content = visualEditorRef.getFullMarkdown();
        console.log('[EditorSub] synced from visual, content length:', content.length);
      } else if (prevMode === 'split' && splitVisualRef) {
        content = splitVisualRef.getFullMarkdown();
      }
      // When leaving source mode, editorStore.content should be up-to-date
      // (SourceEditor flushes via bind:value and onDestroy).
      // But as a safety net, also sync from editorStore if content is empty but store has content.
      if (prevMode === 'source' && content.length === 0) {
        const storeContent = state.content;
        if (storeContent.length > 0) {
          console.warn('[EditorSub] content was empty after source→visual, recovering from editorStore:', storeContent.length);
          content = storeContent;
        }
      }
      // Clear editor reference when switching to source-only mode
      if (state.editorMode === 'source') {
        morayaEditor = null;
      }
    }
    // Sync dirty state to tabs store
    tabsStore.syncDirty(state.isDirty);
  });

  // Tabs: sync tab state for TitleBar/TabBar + reload content when active tab changes
  let prevActiveTabId = '';
  const unsubTabs = tabsStore.subscribe(state => {
    tabs = state.tabs;
    activeTabId = state.activeTabId;
    if (state.activeTabId !== prevActiveTabId) {
      prevActiveTabId = state.activeTabId;
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (tab) {
        // Image tab: load blob URL for preview
        if (tab.isImage) {
          activeImageTab = tab;
          currentFileName = tab.fileName;
          if (tab.filePath) {
            readImageAsBlobUrl(tab.filePath).then(url => {
              // Only apply if still the active tab
              if (tabsStore.getState().activeTabId === tab.id) {
                if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
                imagePreviewUrl = url;
              } else {
                URL.revokeObjectURL(url);
              }
            }).catch(() => { imagePreviewUrl = null; });
          }
          return;
        }

        // Non-image tab: clear image preview
        activeImageTab = null;
        if (imagePreviewUrl) { URL.revokeObjectURL(imagePreviewUrl); imagePreviewUrl = null; }

        console.log('[TabsSub] activeTab changed, setting content length:', tab.content.length, 'preview:', JSON.stringify(tab.content.slice(0, 80)));
        content = tab.content;
        currentFileName = tab.fileName;
        replaceContentAndScrollToTop(tab.content);
        // Re-run search on new tab's content if search bar is open
        if (showSearch && lastSearchText) {
          requestAnimationFrame(() => {
            handleSearch(lastSearchText, lastSearchCS, lastSearchRegex);
          });
        }
      }
    }
  });

  // MCP: sync native Workflow → MCP Tools submenu when connections change
  // Store a flat mapping of connected server tools for resolving menu clicks.
  let mcpMenuMapping: Array<{ serverId: string; serverName: string; tools: Array<{ name: string; description: string }> }> = [];
  let prevMcpToolsJson = '';

  const unsubMCP = mcpStore.subscribe(state => {
    if (!isTauri) return;
    // Build the server+tools structure for connected servers that have tools
    const serversWithTools = state.servers
      .filter(s => state.connectedServers.has(s.id))
      .map(s => ({
        serverId: s.id,
        serverName: s.name,
        tools: state.tools.filter(t => t.serverId === s.id).map(t => ({ name: t.name, description: t.description || '' })),
      }))
      .filter(s => s.tools.length > 0);

    // Only call invoke when the data actually changes
    const json = JSON.stringify(serversWithTools);
    if (json === prevMcpToolsJson) return;
    prevMcpToolsJson = json;
    mcpMenuMapping = serversWithTools;

    const menuServers = serversWithTools.map(s => ({ name: s.serverName, tools: s.tools }));
    invoke('update_mcp_menu', { servers: menuServers, noToolsLabel: $t('menu.noMCPTools') }).catch(() => {});
  });

  onDestroy(() => {
    unsubAI();
    unsubSettings();
    unsubEditor();
    unsubTabs();
    unsubMCP();
  });

  // Sync native menu checkmarks when editor mode changes (all desktop platforms).
  $effect(() => {
    if (!isTauri) return;

    invoke('set_editor_mode_menu', { mode: editorMode }).catch(() => {});
  });

  // Sync native menu checkmarks when view panels are toggled.
  $effect(() => {
    if (!isTauri) return;
    invoke('set_menu_check', { id: 'view_sidebar', checked: showSidebar }).catch(() => {});
  });
  $effect(() => {
    if (!isTauri) return;
    invoke('set_menu_check', { id: 'view_ai_panel', checked: showAIPanel }).catch(() => {});
  });
  $effect(() => {
    if (!isTauri) return;
    invoke('set_menu_check', { id: 'view_outline', checked: showOutline }).catch(() => {});
  });

  // Re-run search when editor mode changes while search bar is open.
  // The new editor component has fresh state, so we need to re-execute the search
  // to populate its matches for findNext/findPrev to work.
  let prevModeForSearch: EditorMode | null = null;
  $effect(() => {
    const mode = editorMode; // track
    if (prevModeForSearch !== null && prevModeForSearch !== mode && showSearch && lastSearchText) {
      // Delay to let the new editor component mount
      requestAnimationFrame(() => {
        handleSearch(lastSearchText, lastSearchCS, lastSearchRegex);
      });
    }
    prevModeForSearch = mode;
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
      menu_workflow: tr('menu.workflow'),
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
      // Workflow menu
      wf_seo: tr('menu.seoOptimization'),
      wf_image_gen: tr('menu.aiImageGeneration'),
      wf_publish: tr('menu.publish'),
      wf_mcp: tr('menu.mcpTools'),
      wf_mcp_empty: tr('menu.noMCPTools'),
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
    // When Command Palette is open, only allow Escape (handled by palette itself)
    // Skip all global shortcuts to prevent Cmd+O etc. from firing while typing
    if (showCommandPalette) return;

    const mod = event.metaKey || event.ctrlKey;

    // Undo: Cmd+Z / Ctrl+Z on all platforms
    if (mod && !event.shiftKey && event.key === 'z') {
      // ProseMirror already handled it via keymap → skip to avoid double undo
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (editorMode === 'source' || (editorMode === 'split' && isSourcePaneFocused())) {
        document.execCommand('undo');
      } else {
        morayaEditor?.view.focus();
        runCmd(undo);
      }
      return;
    }

    // Redo: Cmd+Shift+Z / Ctrl+Shift+Z / Cmd+Y / Ctrl+Y
    if ((mod && event.shiftKey && event.key === 'z') ||
        (mod && !event.shiftKey && event.key === 'y')) {
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (editorMode === 'source' || (editorMode === 'split' && isSourcePaneFocused())) {
        document.execCommand('redo');
      } else {
        morayaEditor?.view.focus();
        runCmd(redo);
      }
      return;
    }

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

    if (mod && !event.shiftKey && (event.key === 'n' || event.key === 'N')) {
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
      console.log('[ModeSwitch]', editorMode, '->', newMode, 'content length:', content.length, 'preview:', JSON.stringify(content.slice(0, 100)));
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

    // Command Palette: Cmd+Shift+P → command mode
    if (mod && event.shiftKey && (event.key === 'p' || event.key === 'P')) {
      event.preventDefault();
      commandPaletteMode = 'commands';
      showCommandPalette = true;
      return;
    }

    // Quick Open: Cmd+P → file search mode
    if (mod && !event.shiftKey && event.key === 'p') {
      event.preventDefault();
      commandPaletteMode = 'files';
      showCommandPalette = true;
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
    // Multi-tab: each tab has independent state, no need to guard for sidebar file selection.
    // This guard is still used for window close scenarios.
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
    // Sync current tab state BEFORE openFile() modifies editorStore
    tabsStore.syncFromEditor();
    const fileContent = await openFile();
    if (fileContent !== null) {
      // openFile() already called editorStore.setCurrentFile(path)
      const filePath = editorStore.getState().currentFilePath;
      const fileName = filePath ? getFileNameFromPath(filePath) : $t('common.untitled');
      let mtime: number | null = null;
      if (filePath) {
        try {
          const result = await invoke('get_files_mtime', { paths: [filePath] }) as [string, number][];
          if (result.length > 0) mtime = result[0][1];
        } catch { /* ignore */ }
      }
      // skipSync=true: we already synced above before openFile() modified editorStore
      tabsStore.openFileTab(filePath ?? '', fileName, fileContent, mtime, true);
      resetWorkflowState();
    }
  }

  async function handleNewFile() {
    tabsStore.addTab();
    content = '';
    resetWorkflowState();
    await replaceContentAndScrollToTop(content);
  }

  // Guard against concurrent file loads: rapid clicks (e.g. KB file switching)
  // create overlapping async loadFile → replaceAll chains, each expensive.
  // Debounce + serial guard: rapid clicks are coalesced into a single operation,
  // preventing concurrent guardUnsavedChanges/save/loadFile/replaceAll calls entirely.
  let fileSelectSerial = 0;
  let fileSelectDebounce: ReturnType<typeof setTimeout> | undefined;

  /** Schedule scroll-to-keyword + flash highlight after editor renders */
  function scheduleScrollAndHighlight(keyword: string) {
    let attempts = 0;
    const maxAttempts = 8;
    const tryFind = () => {
      attempts++;
      if (!morayaEditor?.view) {
        if (attempts < maxAttempts) setTimeout(tryFind, 300);
        return;
      }
      const view = morayaEditor.view;
      const found = findAllKeywordOccurrences(view, keyword);
      if (found.length === 0) {
        if (attempts < maxAttempts) setTimeout(tryFind, 300);
        return;
      }
      const match = found[0];
      // Scroll precisely to the keyword
      try {
        const coords = view.coordsAtPos(match.from);
        const wrapper = document.querySelector('.editor-wrapper') as HTMLElement | null;
        if (wrapper && coords) {
          const wrapperRect = wrapper.getBoundingClientRect();
          const targetTop = wrapper.scrollTop + coords.top - wrapperRect.top - wrapperRect.height * 0.15;
          wrapper.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
        }
      } catch { /* ignore */ }
      // Flash highlight after scroll settles
      setTimeout(() => applyFlashHighlight(view, match), 600);
    };
    // Start after initial approximate scroll has begun
    setTimeout(tryFind, 600);
  }

  /** Find all occurrences of keyword (or CJK chars) in ProseMirror doc */
  function findAllKeywordOccurrences(view: any, keyword: string): { from: number; to: number }[] {
    const results: { from: number; to: number }[] = [];
    const kwLower = keyword.toLowerCase();
    // Try full keyword
    view.state.doc.descendants((node: any, pos: number) => {
      if (!node.isText || !node.text) return;
      const text = node.text.toLowerCase();
      let idx = 0;
      while ((idx = text.indexOf(kwLower, idx)) !== -1) {
        results.push({ from: pos + idx, to: pos + idx + keyword.length });
        idx += keyword.length;
      }
    });
    if (results.length > 0) return results;
    // Fallback: individual CJK characters
    for (const ch of keyword) {
      if (/[\u4e00-\u9fff]/.test(ch)) {
        view.state.doc.descendants((node: any, pos: number) => {
          if (!node.isText || !node.text) return;
          let idx = 0;
          while ((idx = node.text.indexOf(ch, idx)) !== -1) {
            results.push({ from: pos + idx, to: pos + idx + 1 });
            idx += 1;
          }
        });
        if (results.length > 0) return results;
      }
    }
    return results;
  }

  /** Apply flash highlight using an overlay div (doesn't modify ProseMirror DOM) */
  function applyFlashHighlight(view: any, match: { from: number; to: number }) {
    try {
      const startCoords = view.coordsAtPos(match.from);
      const endCoords = view.coordsAtPos(match.to);
      const wrapper = document.querySelector('.editor-wrapper') as HTMLElement | null;
      if (!wrapper || !startCoords || !endCoords) return;

      const wrapperRect = wrapper.getBoundingClientRect();

      // Remove previous overlay if any
      document.querySelectorAll('.kb-flash-overlay').forEach((el) => el.remove());

      const overlay = document.createElement('div');
      overlay.className = 'kb-flash-overlay';
      overlay.style.cssText = [
        'position: absolute',
        `left: ${startCoords.left - wrapperRect.left + wrapper.scrollLeft}px`,
        `top: ${startCoords.top - wrapperRect.top + wrapper.scrollTop}px`,
        `width: ${endCoords.right - startCoords.left}px`,
        `height: ${Math.max(startCoords.bottom - startCoords.top, 20)}px`,
        'background: rgba(255, 200, 0, 0.45)',
        'pointer-events: none',
        'z-index: 5',
        'border-radius: 3px',
        'transition: opacity 0.5s ease',
      ].join('; ');

      wrapper.appendChild(overlay);

      // Fade out and remove after 3 seconds
      clearTimeout(flashHighlightTimer);
      flashHighlightTimer = setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 500);
      }, 3000);
    } catch { /* best-effort */ }
  }

  /** Pending character offset and keyword to scroll to + highlight after file opens */
  let pendingScrollCharOffset = 0;
  let pendingSearchKeyword = '';
  let flashHighlightTimer: ReturnType<typeof setTimeout> | undefined;

  function handleFileSelect(path: string, scrollOffset?: number, searchKeyword?: string) {
    pendingScrollCharOffset = scrollOffset || 0;
    pendingSearchKeyword = searchKeyword || '';
    const mySerial = ++fileSelectSerial;
    clearTimeout(fileSelectDebounce);
    fileSelectDebounce = setTimeout(() => doFileSelect(path, mySerial), 50);
  }

  /** Handle command execution from Command Palette */
  function handlePaletteCommand(action: string) {
    const paletteActions: Record<string, () => void> = {
      // File
      'new-file': () => handleNewFile(),
      'new-window': () => { /* handled by native menu */ },
      'open-file': () => handleOpenFile(),
      'save': () => handleSave(false),
      'save-as': () => handleSave(true),
      // Edit
      'undo': () => runCmd(undo),
      'redo': () => runCmd(redo),
      // Paragraph
      'heading-1': () => runCmd(setHeading(1)),
      'heading-2': () => runCmd(setHeading(2)),
      'heading-3': () => runCmd(setHeading(3)),
      'heading-4': () => runCmd(setHeading(4)),
      'heading-5': () => runCmd(setHeading(5)),
      'heading-6': () => runCmd(setHeading(6)),
      'paragraph': () => runCmd(setHeading(0)),
      'table': () => runCmd(insertTable(3, 3)),
      'code-block': () => runCmd(insertCodeBlock),
      'math-block': () => runCmd(insertMathBlockCmd),
      'blockquote': () => runCmd(wrapInBlockquote),
      'bullet-list': () => runCmd(wrapInBulletList),
      'ordered-list': () => runCmd(wrapInOrderedList),
      // Format
      'bold': () => runCmd(toggleBold),
      'italic': () => runCmd(toggleItalic),
      'strikethrough': () => runCmd(toggleStrikethrough),
      'code': () => runCmd(toggleCode),
      'link': () => runCmd(toggleLink({ href: '' })),
      'image': () => { showImageDialog = true; },
      // View
      'toggle-sidebar': () => settingsStore.toggleSidebar(),
      'toggle-source': () => {
        const newMode: EditorMode = editorMode === 'visual' ? 'source' : 'visual';
        editorMode = newMode;
        editorStore.setEditorMode(newMode);
      },
      'zoom-in': () => {
        const s = settingsStore.getState();
        const sz = Math.min(s.fontSize + 1, 24);
        settingsStore.update({ fontSize: sz });
        document.documentElement.style.setProperty('--font-size-base', `${sz}px`);
      },
      'zoom-out': () => {
        const s = settingsStore.getState();
        const sz = Math.max(s.fontSize - 1, 12);
        settingsStore.update({ fontSize: sz });
        document.documentElement.style.setProperty('--font-size-base', `${sz}px`);
      },
      'zoom-reset': () => {
        settingsStore.update({ fontSize: 16 });
        document.documentElement.style.setProperty('--font-size-base', '16px');
      },
      // Custom
      'settings': () => { showSettings = true; },
      'index-kb': () => { settingsInitialTab = 'knowledge-base' as any; showSettings = true; },
    };
    paletteActions[action]?.();
  }


  /** Called by Sidebar after a successful rename on disk.
   *  Updates editorStore and tabsStore so the current tab/editor reflects the new path. */
  function handleFileRename(oldPath: string, newPath: string) {
    const newFileName = getFileNameFromPath(newPath);
    tabsStore.renameTabFile(oldPath, newPath, newFileName);
    const { currentFilePath } = editorStore.getState();
    if (currentFilePath === oldPath) {
      editorStore.updateFilePath(newPath);
    }
  }

  function handleSwitchTab(tabId: string) {
    tabsStore.switchTab(tabId);
  }

  async function handleCloseTab(tab: import('$lib/stores/tabs-store').TabItem) {
    if (tab.isDirty) {
      const shouldSave = await ask(
        $t('tabs.unsavedMsg', { fileName: tab.fileName }),
        {
          title: $t('tabs.unsavedTitle'),
          kind: 'warning',
          okLabel: $t('tabs.save'),
          cancelLabel: $t('tabs.discard'),
        }
      );
      if (shouldSave) {
        const saved = await handleSave();
        if (!saved) return; // User cancelled SaveAs → don't close
      }
    }

    // If this is the last tab, close the window instead of creating an empty tab
    const state = tabsStore.getState();
    if (state.tabs.length <= 1) {
      getCurrentWindow().close();
      return;
    }

    tabsStore.closeTab(tab.id);
  }

  // ── Tab Detach / Attach (Chrome-like cross-window tab transfer) ──

  /** Phase 1: Create the detached window immediately (called during drag).
   *  Returns the new window label. Does NOT remove the tab from source. */
  async function performTabDetachStart(tabIndex: number, screenX: number, screenY: number, offsetX?: number, offsetY?: number): Promise<string | undefined> {
    const state = tabsStore.getState();
    const tab = state.tabs[tabIndex];
    if (!tab || state.tabs.length <= 1) return undefined;

    if (tab.id === state.activeTabId) {
      // In visual-only mode, editorStore.content is stale — update it first
      const freshContent = getCurrentContent();
      editorStore.setContent(freshContent);
      tabsStore.syncFromEditor();
    }

    // Re-read after sync
    const freshState = tabsStore.getState();
    const freshTab = freshState.tabs[tabIndex];
    if (!freshTab) return undefined;

    const tabData = {
      file_path: freshTab.filePath,
      file_name: freshTab.fileName,
      content: freshTab.content,
      is_dirty: freshTab.isDirty,
      cursor_offset: freshTab.cursorOffset,
      scroll_fraction: freshTab.scrollFraction,
      last_mtime: freshTab.lastMtime,
    };

    // Use exact offsets from TitleBar/TabBar (click position within tab + layout padding).
    // These match the dragOffsetX/Y used by move_window, so no visible jump occurs.
    const tabOffsetX = offsetX ?? (isMacOS ? 108 : 30);
    const tabOffsetY = offsetY ?? (isMacOS ? 14 : 54);
    try {
      return await invoke<string>('detach_tab_to_window', {
        tabData,
        x: Math.max(0, screenX - tabOffsetX),
        y: Math.max(0, screenY - tabOffsetY),
      });
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err), 'error');
      return undefined;
    }
  }

  /** Phase 2: Finalize detach on pointer up. Removes source tab.
   *  If reattachTarget is set, closes the detached window and transfers to target instead. */
  async function performTabDetachEnd(tabIndex: number, detachedLabel: string | null, reattachTarget: string | null) {
    const state = tabsStore.getState();
    const tab = state.tabs[tabIndex];
    if (!tab) return;

    if (reattachTarget) {
      // Re-attach: transfer tab data to target window, close the detached window
      if (tab.id === state.activeTabId) {
        // In visual-only mode, editorStore.content is stale — update it first
        const freshContent = getCurrentContent();
        editorStore.setContent(freshContent);
        tabsStore.syncFromEditor();
      }
      const freshState = tabsStore.getState();
      const freshTab = freshState.tabs[tabIndex];
      if (freshTab) {
        const tabData = {
          file_path: freshTab.filePath,
          file_name: freshTab.fileName,
          content: freshTab.content,
          is_dirty: freshTab.isDirty,
          cursor_offset: freshTab.cursorOffset,
          scroll_fraction: freshTab.scrollFraction,
          last_mtime: freshTab.lastMtime,
        };
        try {
          await emitTo(reattachTarget, 'tab-transfer', { tabData });
          // Clear drop indicator AFTER transfer is processed (avoids race with tab-drag-end)
          emitTo(reattachTarget, 'tab-drag-end', {}).catch(() => {});
        } catch { /* ignore */ }
      }
      // Close the detached window
      if (detachedLabel) {
        try { await invoke('close_window_by_label', { label: detachedLabel }); } catch { /* ignore */ }
      }
    }

    // Remove tab from source window (re-read state — it may have changed during the awaits above)
    const currentState = tabsStore.getState();
    if (currentState.tabs.length > 1) {
      tabsStore.removeTab(tab.id);
    } else {
      tabsStore.closeTab(tab.id);
    }
  }

  async function performTabAttach(tabIndex: number, targetLabel: string) {
    const state = tabsStore.getState();
    const tab = state.tabs[tabIndex];
    if (!tab) return;

    if (tab.id === state.activeTabId) {
      // In visual-only mode, editorStore.content is stale — update it first
      const freshContent = getCurrentContent();
      editorStore.setContent(freshContent);
      tabsStore.syncFromEditor();
    }

    // Re-read tab after sync to get up-to-date content
    const freshState = tabsStore.getState();
    const freshTab = freshState.tabs[tabIndex];
    if (!freshTab) return;

    const tabData = {
      file_path: freshTab.filePath,
      file_name: freshTab.fileName,
      content: freshTab.content,
      is_dirty: freshTab.isDirty,
      cursor_offset: freshTab.cursorOffset,
      scroll_fraction: freshTab.scrollFraction,
      last_mtime: freshTab.lastMtime,
    };

    try {
      await emitTo(targetLabel, 'tab-transfer', { tabData });
      // Clear drop indicator AFTER transfer is processed
      emitTo(targetLabel, 'tab-drag-end', {}).catch(() => {});

      if (state.tabs.length <= 1) {
        // Last tab — close window directly (don't go through closeTab which creates empty replacement)
        getCurrentWindow().close();
      } else {
        tabsStore.removeTab(tab.id);
      }
    } catch (err) {
      showToast(String(err instanceof Error ? err.message : err), 'error');
    }
  }

  // External file change detection: check on window focus
  let isCheckingChanges = false;

  async function checkExternalChanges() {
    const state = tabsStore.getState();
    const fileTabs = state.tabs.filter(t => t.filePath && t.lastMtime != null);
    if (fileTabs.length === 0) return;

    const paths = fileTabs.map(t => t.filePath!);
    let mtimes: [string, number][];
    try {
      mtimes = await invoke('get_files_mtime', { paths }) as [string, number][];
    } catch { return; }
    const mtimeMap = new Map(mtimes);

    for (const tab of fileTabs) {
      const currentMtime = mtimeMap.get(tab.filePath!);
      if (currentMtime == null || currentMtime === tab.lastMtime) continue;

      if (!tab.isDirty) {
        // Clean tab: auto-reload silently
        try {
          const newContent = await invoke('read_file', { path: tab.filePath }) as string;
          tabsStore.updateTabContent(tab.id, newContent, currentMtime);
          if (tab.id === state.activeTabId) {
            content = newContent;
            await replaceContentAndScrollToTop(content);
          }
        } catch { /* file may have been deleted */ }
      } else {
        // Dirty tab: conflict dialog
        const keepLocal = await ask(
          $t('tabs.externalChangeMsg', { fileName: tab.fileName }),
          {
            title: $t('tabs.externalChangeTitle'),
            kind: 'warning',
            okLabel: $t('tabs.keepLocal'),
            cancelLabel: $t('tabs.loadFromDisk'),
          }
        );
        if (keepLocal) {
          tabsStore.updateTabMtime(tab.id, currentMtime);
        } else {
          try {
            const newContent = await invoke('read_file', { path: tab.filePath }) as string;
            tabsStore.updateTabContent(tab.id, newContent, currentMtime);
            if (tab.id === state.activeTabId) {
              content = newContent;
              await replaceContentAndScrollToTop(content);
            }
          } catch { /* ignore */ }
        }
      }
    }
  }

  async function doFileSelect(path: string, mySerial: number) {
    if (mySerial !== fileSelectSerial) return;
    if (mySerial !== fileSelectSerial) return; // Superseded by a newer click

    const fileName = getFileNameFromPath(path);

    // Image files: open as image tab (read-only preview)
    if (isImageFile(fileName)) {
      tabsStore.syncFromEditor();
      tabsStore.openFileTab(path, fileName, '', null, true, true);
      return;
    }

    // Sync current tab state BEFORE loadFile() — loadFile calls editorStore.setContent()
    // which would pollute the old tab if syncFromEditor runs after it.
    tabsStore.syncFromEditor();
    const fileContent = await loadFile(path);
    if (mySerial !== fileSelectSerial) return; // Superseded while IPC was in-flight
    // Fetch mtime for external change detection
    let mtime: number | null = null;
    try {
      const result = await invoke('get_files_mtime', { paths: [path] }) as [string, number][];
      if (result.length > 0) mtime = result[0][1];
    } catch { /* ignore */ }
    // skipSync=true: we already synced above before loadFile polluted editorStore
    tabsStore.openFileTab(path, fileName, fileContent, mtime, true);
    resetWorkflowState();

    // Scroll to search result + flash highlight keyword
    if (pendingScrollCharOffset > 0 || pendingSearchKeyword) {
      const keyword = pendingSearchKeyword;
      const byteOffset = pendingScrollCharOffset;
      pendingScrollCharOffset = 0;
      pendingSearchKeyword = '';

      // Step 1: Scroll using byte offset (approximate but immediate)
      if (byteOffset > 0) {
        setTimeout(() => {
          try {
            if (!morayaEditor?.view) return;
            const view = morayaEditor.view;
            // Approximate: for CJK text, divide by ~2 to roughly convert bytes→chars
            const approxPos = Math.min(Math.floor(byteOffset / 2) + 1, view.state.doc.content.size - 1);
            if (approxPos > 0) {
              const coords = view.coordsAtPos(approxPos);
              const wrapper = document.querySelector('.editor-wrapper') as HTMLElement | null;
              if (wrapper && coords) {
                const wrapperRect = wrapper.getBoundingClientRect();
                const targetTop = wrapper.scrollTop + coords.top - wrapperRect.top - wrapperRect.height * 0.15;
                wrapper.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
              }
            }
          } catch { /* ignore */ }
        }, 300);
      }

      // Step 2: Find keyword in doc, scroll precisely to it, and flash highlight
      if (keyword) {
        scheduleScrollAndHighlight(keyword);
      }
    }
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

  function handleWorkflowSEO() {
    getCurrentContent(); // Ensure content is fresh for SEO analysis
    showSEOPanel = true;
  }

  function handleWorkflowImageGen() {
    // Sync content state from visual editor before opening the dialog.
    // documentContent={content} passes the Svelte state, which is stale in visual mode
    // (visual editor doesn't update `content` on every keystroke). Explicitly assigning
    // here is safe: applySyncToEditor guards against replacement when content is unchanged.
    content = getCurrentContent();
    imageGenDialogMounted = true;
    showImageGenDialog = true;
  }

  function handleWorkflowPublish() {
    showPublishConfirm = true;
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

    // Remove prompt / image-prompt(s) code blocks after insertion
    content = content.replace(/\n*```\s*(?:prompt|image-prompts?)\s*\n[\s\S]*?```\n*/g, '\n');
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

    // Auto-dismiss: 3s for success, 8s if any errors (so user can read the message)
    const hasError = publishProgress.some(p => p.status === 'error');
    setTimeout(() => { publishProgress = []; }, hasError ? 8000 : 3000);
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

    // Tauri desktop: nudge WebView to recalculate viewport units (100dvh/100vh)
    // after the native window has fully settled. Prevents stale layout in new windows.
    // Also explicitly request focus — on Windows, WebView2 in new windows may not
    // receive keyboard input until the native window + WebView both have focus.
    if (isTauri && !isIPadOS) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
        window.focus();
      });
      // On Windows, WebView2 needs an extra focus nudge after the initial render
      // completes. The first requestAnimationFrame runs before layout settles.
      setTimeout(() => { window.focus(); }, 100);
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

          // Check if a file was passed via OS file association on startup
          // Use initWithContent to replace the initial empty Untitled tab (not openFileByPath which adds a new tab)
          // Placed here (inside Promise.all.then) to ensure knowledgeBases are loaded before adjustSidebarForFile
          invoke<string | null>('get_opened_file').then(async (filePath) => {
            if (filePath) {
              const fileContent = await loadFile(filePath);
              const fileName = getFileNameFromPath(filePath);
              let mtime: number | null = null;
              try {
                const result = await invoke('get_files_mtime', { paths: [filePath] }) as [string, number][];
                if (result.length > 0) mtime = result[0][1];
              } catch { /* ignore */ }
              tabsStore.initWithContent(fileContent, filePath, fileName);
              if (mtime !== null) {
                const state = tabsStore.getState();
                tabsStore.updateTabMtime(state.activeTabId, mtime);
              }
              content = fileContent;
              currentFileName = fileName;
              editorStore.batchRestore({
                filePath, content: fileContent, isDirty: false, cursorOffset: 0, scrollFraction: 0,
              });
              await replaceContentAndScrollToTop(fileContent);
              resetWorkflowState();
              adjustSidebarForFile(filePath);
            }
          });

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
    let tabTransferUnlisten: UnlistenFn | undefined;
    let tabDragHoverUnlisten: UnlistenFn | undefined;
    let tabDragEndUnlisten: UnlistenFn | undefined;

    /** Adjust sidebar visibility based on whether the opened file belongs to a knowledge base. */
    function adjustSidebarForFile(filePath: string): void {
      const matchingKB = filesStore.findKnowledgeBaseForFile(filePath);
      if (matchingKB) {
        if (!showSidebar) settingsStore.update({ showSidebar: true });
        const filesState = filesStore.getState();
        if (filesState.activeKnowledgeBaseId !== matchingKB.id) {
          filesStore.setActiveKnowledgeBase(matchingKB.id).catch(() => {});
        }
      } else {
        if (showSidebar) settingsStore.update({ showSidebar: false });
      }
    }

    if (isTauri) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const menuHandlers: Record<string, (payload?: any) => void> = {
        // File
        'menu:file_new': () => handleNewFile(),
        'menu:file_new_window': () => isIPadOS ? handleNewFile() : invoke('create_new_window').catch(e => { console.error('[NewWindow] create_new_window failed:', e); }),
        'menu:file_open': () => handleOpenFile(),
        'menu:file_save': () => handleSave(),
        'menu:file_save_as': () => handleSave(true),
        'menu:file_export_html': () => exportDocument(getCurrentContent(), 'html'),
        'menu:file_export_pdf': () => exportDocument(getCurrentContent(), 'pdf'),
        'menu:file_export_image': () => exportDocument(getCurrentContent(), 'image'),
        'menu:file_export_doc': () => exportDocument(getCurrentContent(), 'doc'),
        // Edit — undo/redo (split mode: route to whichever pane is focused)
        'menu:edit_undo': () => {
          if (editorMode === 'source' || (editorMode === 'split' && isSourcePaneFocused())) {
            (document.activeElement as HTMLElement)?.focus();
            document.execCommand('undo');
          } else {
            morayaEditor?.view.focus();
            runCmd(undo);
          }
        },
        'menu:edit_redo': () => {
          if (editorMode === 'source' || (editorMode === 'split' && isSourcePaneFocused())) {
            (document.activeElement as HTMLElement)?.focus();
            document.execCommand('redo');
          } else {
            morayaEditor?.view.focus();
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
        // View — panels (CheckMenuItems: payload is boolean checked state)
        'menu:view_sidebar': (p) => { if (typeof p === 'boolean') { if (p !== showSidebar) settingsStore.toggleSidebar(); } else { settingsStore.toggleSidebar(); } },
        'menu:view_ai_panel': (p) => { if (typeof p === 'boolean') { showAIPanel = p; } else { showAIPanel = !showAIPanel; } },
        'menu:view_outline': (p) => { if (typeof p === 'boolean') { if (p !== showOutline) settingsStore.update({ showOutline: p }); } else { settingsStore.update({ showOutline: !showOutline }); } },
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
        // Workflow
        'menu:wf_seo': () => handleWorkflowSEO(),
        'menu:wf_image_gen': () => handleWorkflowImageGen(),
        'menu:wf_publish': () => handleWorkflowPublish(),
        // wf_mcp is now a Submenu — tool clicks handled by 'mcp-tool-clicked' listener
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
        listen(event, (e) => {
          // Suppress menu events when Command Palette is open
          // (prevents Cmd+O etc. from firing via native menu accelerators while typing)
          if (showCommandPalette) return;
          handler(e.payload);
        }).then(unlisten => menuUnlisteners.push(unlisten));
      });

      // Listen for MCP tool clicks from native Workflow → MCP Tools submenu
      listen<string>('mcp-tool-clicked', async (event) => {
        const toolId = event.payload; // format: "wf_mcp_{serverIdx}_{toolIdx}"
        const match = toolId.match(/^wf_mcp_(\d+)_(\d+)$/);
        if (!match) return;
        const si = parseInt(match[1], 10);
        const ti = parseInt(match[2], 10);
        const server = mcpMenuMapping[si];
        if (!server) return;
        const tool = server.tools[ti];
        if (!tool) return;

        showAIPanel = true;
        const message = $t('ai.prompts.mcpToolPrompt', { toolName: tool.name, serverName: server.serverName });
        try {
          await sendChatMessage(message, getCurrentContent());
        } catch (e) {
          console.warn('[MCP Menu] Failed to send tool message:', e);
        }
      }).then(unlisten => menuUnlisteners.push(unlisten));

      // Listen for KB indexing progress
      listen<{ phase: string; current: number; total: number; file_name: string }>('kb-index-progress', (event) => {
        console.log('[KB progress]', event.payload.phase, event.payload.current, '/', event.payload.total, event.payload.file_name);
        indexingPhase = event.payload.phase;
        indexingCurrent = event.payload.current;
        indexingTotal = event.payload.total;
        // Auto-clear after "done" or "error" phase (10s delay for user visibility)
        if (event.payload.phase === 'done' || event.payload.phase === 'error') {
          if (event.payload.phase === 'error') {
            console.error('[KB] Indexing error:', event.payload.file_name);
          }
          clearTimeout(indexingClearTimer);
          indexingClearTimer = setTimeout(() => { indexingPhase = ''; }, 10000);
        } else {
          // New indexing activity — cancel pending clear (replaces previous done/error)
          clearTimeout(indexingClearTimer);
        }
      }).then(unlisten => menuUnlisteners.push(unlisten));

      // Helper: load a file by path and open in a tab
      async function openFileByPath(filePath: string) {
        // Sync current tab BEFORE loadFile() pollutes editorStore
        tabsStore.syncFromEditor();
        const fileContent = await loadFile(filePath);
        const fileName = getFileNameFromPath(filePath);
        let mtime: number | null = null;
        try {
          const result = await invoke('get_files_mtime', { paths: [filePath] }) as [string, number][];
          if (result.length > 0) mtime = result[0][1];
        } catch { /* ignore */ }
        // skipSync=true: we already synced above
        tabsStore.openFileTab(filePath, fileName, fileContent, mtime, true);
        resetWorkflowState();
      }

      // Listen for file open events from OS file association (while app is running)
      listen<string>('open-file', async (event) => {
        const filePath = event.payload;
        if (filePath) {
          await openFileByPath(filePath);
          adjustSidebarForFile(filePath);
        }
      }).then(unlisten => { openFileUnlisten = unlisten; });

      // Check if this window was created by tab detach (pending tab data)
      invoke<{
        file_path: string | null;
        file_name: string;
        content: string;
        is_dirty: boolean;
        cursor_offset: number;
        scroll_fraction: number;
        last_mtime: number | null;
      } | null>('get_pending_tab').then(async (tabData) => {
        if (!tabData) return;
        content = tabData.content;
        tabsStore.initWithContent(tabData.content, tabData.file_path, tabData.file_name);
        editorStore.batchRestore({
          filePath: tabData.file_path,
          content: tabData.content,
          isDirty: tabData.is_dirty,
          cursorOffset: tabData.cursor_offset,
          scrollFraction: tabData.scroll_fraction,
        });
        currentFileName = tabData.file_name;
        await replaceContentAndScrollToTop(tabData.content);
      });

      // Cross-window tab transfer: receive tab from another window.
      // IMPORTANT: Use getCurrentWindow().listen() — NOT the module-level listen() —
      // so that only this window receives events targeted at it via emitTo(label).
      // The module-level listen() uses target { kind: 'Any' } which receives events
      // from ALL windows, causing stray tab insertions on the source window.
      const curWin = getCurrentWindow();
      curWin.listen<{ tabData: {
        file_path: string | null;
        file_name: string;
        content: string;
        is_dirty: boolean;
        cursor_offset: number;
        scroll_fraction: number;
        last_mtime: number | null;
      } }>('tab-transfer', async (event) => {
        const td = event.payload.tabData;
        const insertIdx = externalDropIndex >= 0 ? externalDropIndex : tabs.length;
        externalDropIndex = -1;
        // Sync current visual editor content to editorStore before insertTabAt calls syncFromEditor
        // (in visual-only mode, editorStore.content is stale)
        const freshContent = getCurrentContent();
        editorStore.setContent(freshContent);
        tabsStore.insertTabAt(insertIdx, td.file_path, td.file_name, td.content, td.is_dirty, td.last_mtime);
      }).then(unlisten => { tabTransferUnlisten = unlisten; });

      // Cross-window drag indicator events (window-scoped for same reason as above)
      curWin.listen<{ screenX: number }>('tab-drag-hover', (event) => {
        // Calculate insert index based on screenX over local tab elements
        const scrollEl = document.querySelector('.mac-tabs-scroll') ?? document.querySelector('.tabs-scroll');
        if (!scrollEl) { externalDropIndex = tabs.length; return; }
        const tabEls = scrollEl.querySelectorAll('.tab-item');
        let idx = tabs.length; // default: append at end
        for (let i = 0; i < tabEls.length; i++) {
          const rect = tabEls[i].getBoundingClientRect();
          const mid = rect.left + rect.width / 2;
          // Convert screenX to clientX (approximate: screenX - window.screenX)
          const clientX = event.payload.screenX - window.screenX;
          if (clientX < mid) {
            idx = i;
            break;
          }
        }
        externalDropIndex = idx;
      }).then(unlisten => { tabDragHoverUnlisten = unlisten; });

      curWin.listen('tab-drag-end', () => {
        externalDropIndex = -1;
      }).then(unlisten => { tabDragEndUnlisten = unlisten; });

      // Drag-drop: open MD files each in a new window.
      // Use listen() with no target (defaults to Any) instead of
      // getCurrentWebview().onDragDropEvent() which scopes to {kind:'Webview'}
      // and misses events that Tauri 2.9 emits at the Window level.
      const MD_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdx', 'txt']);
      if (!isIPadOS) {
        listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
          const paths = event.payload?.paths ?? [];
          const mdPaths = paths.filter(p => MD_EXTENSIONS.has(p.split('.').pop()?.toLowerCase() ?? ''));
          if (mdPaths.length === 0) return;
          for (const p of mdPaths) {
            try {
              await invoke('open_file_in_new_window', { path: p });
            } catch (err) {
              showToast(String(err instanceof Error ? err.message : err), 'error');
            }
          }
        }).then(unlisten => { dragDropUnlisten = unlisten; });
      }
    }

    // Window focus: check for external file changes on all open tabs
    let focusUnlisten: UnlistenFn | undefined;
    if (isTauri && !isIPadOS) {
      getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
        if (!focused || isCheckingChanges) return;
        isCheckingChanges = true;
        try {
          await checkExternalChanges();
          // Refresh sidebar file tree when window gains focus (another window
          // may have saved a new file to the same knowledge base directory)
          const fsState = filesStore.getState();
          const folderPath = fsState.openFolderPath;
          if (folderPath) {
            const allFiles = fsState.sidebarViewMode === 'tree';
            const tree = await invoke<import('$lib/stores/files-store').FileEntry[]>(
              'read_dir_recursive', { path: folderPath, depth: 3, allFiles }
            );
            filesStore.setFileTree(tree);
          }
        }
        finally { isCheckingChanges = false; }
      }).then(unlisten => { focusUnlisten = unlisten; });
    }

    return () => {
      if (autoSaveTimer) clearInterval(autoSaveTimer);
      menuUnlisteners.forEach(unlisten => unlisten());
      openFileUnlisten?.();
      dragDropUnlisten?.();
      tabTransferUnlisten?.();
      tabDragHoverUnlisten?.();
      tabDragEndUnlisten?.();
      focusUnlisten?.();
      vvUnlisten?.();
      window.removeEventListener('moraya:file-synced', handleFileSynced);
      window.removeEventListener('moraya:dynamic-service-created', handleDynamicServiceCreated);
      // Dynamic MCP services are now always persisted (lifecycle: 'saved')
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app-container">
  <TitleBar title={currentFileName} {tabs} {activeTabId} {externalDropIndex}
    onSwitchTab={handleSwitchTab} onCloseTab={handleCloseTab}
    onNewFile={() => handleNewFile()} onOpenFile={() => handleOpenFile()}
    onReorderTabs={(from, to) => tabsStore.reorderTabs(from, to)}
    onDetachStart={performTabDetachStart} onDetachEnd={performTabDetachEnd}
    onAttachTab={performTabAttach} />

  {#if false && !isMacOS}
    <TabBar
      onNewTab={() => handleNewFile()}
      onCloseTab={handleCloseTab}
      {externalDropIndex}
      onDetachStart={performTabDetachStart}
      onDetachEnd={performTabDetachEnd}
      onAttachTab={performTabAttach}
    />
  {/if}

  <div class="app-body">
    {#if showSidebar}
      <Sidebar onFileSelect={handleFileSelect} onRename={handleFileRename} onOpenKBManager={() => showKBManager = true} onOpenSettings={(tab) => { settingsInitialTab = tab as any; showSettings = true; }} />
    {/if}

    <main class="editor-area">
      {#if activeImageTab}
        <!-- Image tab preview (read-only) -->
        <div class="image-preview-container">
          <div class="image-preview-body">
            {#if imagePreviewUrl}
              <img src={imagePreviewUrl} alt={activeImageTab.fileName} class="image-preview-img" draggable="false" />
            {/if}
          </div>
        </div>
      {:else if editorMode === 'visual'}
        <Editor bind:this={visualEditorRef} bind:content {showOutline} {outlineWidth} onEditorReady={handleEditorReady} onNotify={showToast} onOutlineWidthChange={(w) => settingsStore.update({ outlineWidth: w })} onWorkflowSEO={handleWorkflowSEO} onWorkflowImageGen={handleWorkflowImageGen} onWorkflowPublish={handleWorkflowPublish} />
      {:else if editorMode === 'source'}
        <SourceEditor bind:this={sourceEditorRef} bind:content {showOutline} {outlineWidth} onContentChange={handleContentChange} onOutlineWidthChange={(w) => settingsStore.update({ outlineWidth: w })} />
      {:else if editorMode === 'split'}
        <div class="split-container">
          <div class="split-source" bind:this={splitSourceEl}>
            <SourceEditor bind:this={splitSourceRef} bind:content onContentChange={handleContentChange} hideScrollbar />
          </div>
          <div class="split-visual" bind:this={splitVisualEl}>
            <Editor bind:this={splitVisualRef} bind:content onEditorReady={handleEditorReady} onContentChange={handleContentChange} onNotify={showToast} onWorkflowSEO={handleWorkflowSEO} onWorkflowImageGen={handleWorkflowImageGen} onWorkflowPublish={handleWorkflowPublish} />
          </div>
        </div>
      {/if}

      {#if showSearch}
        <SearchBar
          {showReplace}
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
    onShowUpdateDialog={() => showUpdateDialog = true}
    onToggleAI={() => showAIPanel = !showAIPanel}
    onModeChange={(mode) => { editorMode = mode; editorStore.setEditorMode(mode); }}
    currentMode={editorMode}
    hideModeSwitcher={!!activeImageTab}
    aiPanelOpen={showAIPanel}
    {aiConfigured}
    {aiLoading}
    {aiError}
    searchActive={showSearch}
    {searchMatchCount}
    {searchCurrentMatch}
    {searchRegexError}
    {indexingPhase}
    {indexingCurrent}
    {indexingTotal}
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
      {currentSEOData}
      onSEODataChange={(data) => { currentSEOData = data; seoCompleted = true; }}
      documentContent={getCurrentContent()}
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

{#if showCommandPalette}
  {#await import('$lib/components/CommandPalette.svelte') then { default: CommandPalette }}
    <CommandPalette
      initialMode={commandPaletteMode}
      onFileSelect={handleFileSelect}
      onCommand={handlePaletteCommand}
      onClose={() => showCommandPalette = false}
    />
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
     margin-top on .editor-area avoids the WebKit scrollbar quirk caused by
     padding-top on a flex parent with overflow:auto children. */
  :global(.platform-macos) .editor-area {
    margin-top: 28px;
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
    width: 340px;
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
    align-items: flex-start;
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
    word-break: break-word;
    overflow-wrap: break-word;
  }

  /* RTL overrides */
  :global([dir="rtl"]) .split-visual {
    border-left: none;
    border-right: 1px solid var(--border-color);
  }

  :global([dir="rtl"]) .publish-progress {
    right: auto;
    left: 1rem;
  }

  :global([dir="rtl"]) .progress-status {
    text-align: left;
  }

  /* ── Image file preview ── */
  .image-preview-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .image-preview-body {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    padding: 24px;
    background: var(--bg-secondary, var(--bg-primary));
  }

  .image-preview-img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }
</style>

<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { startMemoryAutoSync, stopMemoryAutoSync } from '$lib/services/memory';
  import type { MorayaEditor } from '$lib/editor/setup';
  import { AllSelection, TextSelection } from 'prosemirror-state';
  import {
    setHeading,
    wrapInBlockquote,
    wrapInBulletList,
    wrapInOrderedList,
    wrapInTaskList,

    insertCodeBlock,
    insertHorizontalRule,
    toggleBold,
    toggleItalic,
    toggleCode,
    toggleLink,
    toggleStrikethrough,
    insertTable,
    insertImage,
    insertImageAt,
    insertAudioAt,
    insertVideoAt,
    insertMathBlock as insertMathBlockCmd,
    insertTextAtCursor,
  } from '$lib/editor/commands';
  import { undo, redo } from 'prosemirror-history';
  import Editor from '$lib/editor/Editor.svelte';
  import SourceEditor from '$lib/editor/SourceEditor.svelte';
  import TypstEditor from '$lib/editor/TypstEditor.svelte';
  import type { TypstAction } from '$lib/editor/typst-commands';
  import SearchBar from '$lib/editor/SearchBar.svelte';
  import type { EditorMode } from '$lib/stores/editor-store';
  import TitleBar from '$lib/components/TitleBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import type { SEOData } from '$lib/services/ai/types';
  import type { PublishResult } from '$lib/services/publish/types';
  import type { UnifiedMediaItem } from '$lib/services/cloud-resource/types';
  import { getMediaDetail, picoraApiBaseFromUploadUrl } from '$lib/services/cloud-resource';
  import { editorStore, suppressMarkdownFlush } from '$lib/stores/editor-store';
  import { settingsStore, initSettingsStore } from '$lib/stores/settings-store';
  import { filesStore, type FileEntry } from '$lib/stores/files-store';
  import { initAIStore, aiStore, sendChatMessage } from '$lib/services/ai';
  import { abortAIRequest } from '$lib/services/ai/ai-service';
  import { initMCPStore, connectAllServers, mcpStore } from '$lib/services/mcp';
  import { reviewStore } from '$lib/services/review';
  import { initContainerManager } from '$lib/services/mcp/container-manager';
  import { registerKbInterval, clearAllIntervals, runSync, kbSyncStore } from '$lib/services/kb-sync/sync-service';
  import type { KbSyncState } from '$lib/services/kb-sync/types';
  import { snapshotVersion, isVersionedPath } from '$lib/services/version-history';
  import { shouldAutoSave } from '$lib/utils/autosave';
  import { preloadEnhancementPlugins } from '$lib/editor/setup';
  import { openFile, saveFile, saveFileAs, loadFile, getFileNameFromPath, readImageAsBlobUrl, migrateTempImages, isImageFile } from '$lib/services/file-service';
  import { isTypstFile } from '@moraya/core/typst';
  import { schema } from '$lib/editor/schema';
  import { exportDocument, exportTypstPdf, exportTypstSource, type ExportFormat } from '$lib/services/export-service';
  import { checkForUpdate, shouldCheckToday, getTodayDateString } from '$lib/services/update-service';
  import { listen, emitTo, type UnlistenFn } from '@tauri-apps/api/event';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { t, locale } from '$lib/i18n';
  import { get } from 'svelte/store';
  import { getPlatformClass, isIPadOS, isMacOS, isTauri, isVirtualKeyboardVisible } from '$lib/utils/platform';
  import {
    SHORTCUT_CATALOG,
    FLAVOR_ONLY_MENU_ITEMS,
    disabledMenuItemsFor,
    effectiveBinding,
    eventMatchesBinding,
    scopeOf,
  } from '$lib/shortcuts/catalog';
  import TabBar from '$lib/components/TabBar.svelte';
  import TouchToolbar from '$lib/editor/TouchToolbar.svelte';
  import { tabsStore } from '$lib/stores/tabs-store';
  import { editorLoadingStore } from '$lib/stores/editor-loading-store';

  import '$lib/styles/global.css';
  import '$lib/styles/editor.css';
  // Code-block NodeView visual language now lives in @moraya/core (v0.5.1).
  // Loading side-effect-only wires the language picker popup, toolbar, chip,
  // copy button, and inner <pre>/<code>. Previously duplicated inline in
  // editor.css lines 80-300 — that block was removed in the same commit.
  import '@moraya/core/plugins/code-block.css';
  // Typora-style in-place math source editing (math_block / math_inline
  // NodeViews) now lives in @moraya/core (v0.6.0). This stylesheet carries the
  // overlay geometry + LaTeX token colors; the --math-src-* theme tokens in
  // variables.css override its fallbacks for light/dark.
  import '@moraya/core/plugins/math-source.css';
  import '$lib/styles/settings.css';
  // KaTeX renders math via katex.render() in @moraya/core's schema with default
  // output='htmlAndMathml'. Without katex.css, the MathML accessibility layer
  // shows visually as duplicated raw text below the rendered formula. This CSS
  // hides the MathML container while preserving HTML rendering + screen reader
  // access via the still-present MathML in the DOM.
  import 'katex/dist/katex.min.css';

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

## ${tr('welcome.features_title')}

- ${tr('welcome.feature_wysiwyg')}
- ${tr('welcome.feature_math')}
- ${tr('welcome.feature_themes')}
- ${tr('welcome.feature_ai')}
- ${tr('welcome.feature_mcp')}
- ${tr('welcome.feature_lightweight')}

## ${tr('welcome.math_title')}

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}
$$

## ${tr('welcome.advanced_math_title')}

$$
\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
$$

$$
\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}
$$

## ${tr('welcome.code_title')}

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

## ${tr('welcome.blockquote_title')}

> ${tr('welcome.blockquote_content')}

## ${tr('welcome.table_title')}

| ${tr('welcome.table_feature')} | ${tr('welcome.table_status')} |
|---------|--------|
| Markdown | ${tr('welcome.table_done')} |
| Math | ${tr('welcome.table_done')} |
| AI Integration | ${tr('welcome.table_done')} |
| MCP Publishing | ${tr('welcome.table_done')} |

## ${tr('welcome.list_title')}

1. ${tr('welcome.list_item1')}
   - ${tr('welcome.list_item1a')}
   - ${tr('welcome.list_item1b')}
   - ${tr('welcome.list_item1c')}
2. ${tr('welcome.list_item2')}
   - ${tr('welcome.list_item2a')}
   - ${tr('welcome.list_item2b')}
   - ${tr('welcome.list_item2c')}
3. ${tr('welcome.list_item3')}
   - ${tr('welcome.list_item3a')}
   - ${tr('welcome.list_item3b')}
   - ${tr('welcome.list_item3c')}

## ${tr('welcome.shortcuts_title')}

- ${tr('welcome.shortcut_save')}
- ${tr('welcome.shortcut_open')}
- ${tr('welcome.shortcut_new')}
- ${tr('welcome.shortcut_toggle_mode')}
- ${tr('welcome.shortcut_split_mode')}
- ${tr('welcome.shortcut_sidebar')}
- ${tr('welcome.shortcut_settings')}
- ${tr('welcome.shortcut_ai')}
- ${tr('welcome.shortcut_export')}

---

## ${tr('welcome.paragraph_title')}

${tr('welcome.paragraph1')}

${tr('welcome.paragraph2')}

${tr('welcome.paragraph3')}

---

${tr('welcome.start_writing')}

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
  let showReviewPanel = $state(false);
  // v0.32.0: history panel + DiffView state
  let showHistoryPanel = $state(false);
  // v1.21.0: local document version history (bottom sheet from the status bar)
  let showVersionHistory = $state(false);
  let versionHistoryAvailable = $state(false);
  // v1.23.0: read-only version-preview tab — the active tab is a historical
  // version snapshot; the editor is mounted non-editable.
  let editorReadOnly = $state(false);
  let showBlame = $state(false);
  let blameData = $state<import('$lib/services/git').GitBlameEntry[]>([]);
  let diffViewState = $state<null | { leftHash: string | null; rightHash: string | null }>(null);
  let currentFileLock = $state<import('$lib/services/review/types').Lock | null>(null);
  let selfName = $state('');
  let selfEmail = $state('');
  let reviewPanelRef = $state<import('$lib/components/ReviewPanel.svelte').default | undefined>();
  let showOutline = $state(false);
  let outlineWidth = $state(200);
  let showImageDialog = $state(false);
  // Cloud resource picker state: which type is open + where to insert
  let cloudPickerState = $state<{ kind: 'image' | 'audio' | 'video'; pos: number | null } | null>(null);
  let showSearch = $state(false);
  let showReplace = $state(false);
  // Image tab preview state — derived from active tab
  let activeImageTab = $state<import('$lib/stores/tabs-store').TabItem | null>(null);
  let activeTypstTab = $state<import('$lib/stores/tabs-store').TabItem | null>(null);
  /** Instance handle on the mounted TypstEditor, so shared menu/shortcut
   *  actions can rewrite the .typ source (see `runSharedAction`). */
  let typstEditorRef = $state<TypstEditor | null>(null);
  /** The editorMode active right before switching INTO a Typst tab (which
   *  forces 'split'), so switching back out to markdown restores the user's
   *  prior visual/source/split preference instead of leaving it on 'split'. */
  let preTypstEditorMode: import('$lib/stores/editor-store').EditorMode | null = null;
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
  /**
   * Sticky base mode (Visual / Source). See editor-store.ts for the
   * full rationale — in short, Visual/Source is one mutex axis and
   * single/split is a separate one, but the rendered `editorMode`
   * collapses them. This $state mirrors `editorStore.lastSingleMode`
   * so the shortcut handlers + menu sync $effect can reason about
   * both axes independently.
   */
  let lastSingleMode = $state<'visual' | 'source'>('visual');

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
  let showPromptPalette = $state(false);
  let commandPaletteMode: 'files' | 'commands' = $state('files');

  // KB indexing progress
  let indexingPhase = $state('');
  let indexingCurrent = $state(0);
  let indexingTotal = $state(0);

  // Git sync: determine if current KB has git binding
  let gitBound = $state(false);
  const unsubGitKB = filesStore.subscribe(state => {
    const activeKb = state.knowledgeBases.find(k => k.id === state.activeKnowledgeBaseId);
    gitBound = !!activeKb?.git;
  });

  // KB sync conflict panel — opened from the StatusBar sync-warning click.
  let conflictKbId = $state<string | null>(null);
  let kbSyncStates = $state<Map<string, KbSyncState>>(new Map());
  const unsubKbSyncStates = kbSyncStore.subscribe((m) => { kbSyncStates = m; });

  async function handleGitSync() {
    const state = filesStore.getState();
    const kb = state.knowledgeBases.find(k => k.id === state.activeKnowledgeBaseId);
    if (!kb?.git) return;
    const { gitSync, gitSyncStatus, gitStore } = await import('$lib/services/git');
    gitStore.setSyncing();
    try {
      await gitSync(kb.path, kb.git.configId);
      const status = await gitSyncStatus(kb.path, kb.git.configId);
      gitStore.setSyncResult(status.ahead, status.behind, status.branch);
      // Refresh file tree after pull to show remote changes
      const tree = await invoke<import('$lib/stores/files-store').FileEntry[]>('read_dir_recursive', {
        path: kb.path,
        depth: 3,
        allFiles: filesStore.getState().sidebarViewMode === 'tree',
      });
      filesStore.setFileTree(tree);
    } catch (e) {
      gitStore.setError(String(e));
    }
  }

  // Auto-sync timer: periodically sync git-bound KBs that have autoSync enabled
  let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    // Re-evaluate when gitBound changes (KB selection or git config change)
    if (!gitBound) {
      if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
      return;
    }
    const state = filesStore.getState();
    const kb = state.knowledgeBases.find(k => k.id === state.activeKnowledgeBaseId);
    if (!kb?.git?.autoSync) {
      if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
      return;
    }
    const intervalMs = (kb.git.syncIntervalMin || 5) * 60 * 1000;
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    autoSyncTimer = setInterval(() => { handleGitSync(); }, intervalMs);
  });
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
    editorReadyForSplash = true;
    tryDispatchAppReady();
  }

  /**
   * Splash dismissal (see app.html). We want the splash to stay up until
   * the user has something MEANINGFUL to look at, not just an empty
   * editor shell. The two gates:
   *   - `editorReadyForSplash`: createEditor finished.
   *   - `coldStartHydrated`: the OS-handed cold-start file (if any) has
   *     been applied to the editor; for a no-file launch this flips
   *     true as soon as the init Promise.all settles.
   * Whichever flips last fires the dispatch.
   */
  let appReadyDispatched = false;
  let editorReadyForSplash = false;
  let coldStartHydrated = false;
  function tryDispatchAppReady() {
    if (appReadyDispatched) return;
    if (!editorReadyForSplash || !coldStartHydrated) return;
    appReadyDispatched = true;
    window.dispatchEvent(new CustomEvent('moraya:app-ready'));
  }
  /** Force the splash off, even if our gates haven't flipped — used by the
   *  non-Tauri / init-failure / 8 s safety paths so the user is never
   *  trapped behind the spinner. */
  function forceDispatchAppReady() {
    if (appReadyDispatched) return;
    appReadyDispatched = true;
    window.dispatchEvent(new CustomEvent('moraya:app-ready'));
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
  async function computeSuggestedPath(content: string): Promise<string | undefined> {
    const settings = settingsStore.getState();
    if (!settings.autoIndexOnSave) return undefined;
    if (!content.trim()) return undefined;

    const { suggestFileName } = await import('$lib/utils/filename-suggest');

    // Check for MORAYA.md naming rules in active KB
    let morayaContent: string | undefined;
    const kb = filesStore.getActiveKnowledgeBase();
    if (kb) {
      try {
        morayaContent = await invoke<string>('read_file', { path: `${kb.path}/MORAYA.md` });
      } catch { /* no MORAYA.md — fine */ }
    }

    const name = await suggestFileName(content, morayaContent);
    if (name === 'untitled') return undefined;

    // If in a KB, suggest saving in the KB root directory
    if (kb) return `${kb.path}/${name}.md`;
    return `${name}.md`;
  }

  async function handleSave(asNew = false, opts?: { auto?: boolean }): Promise<boolean> {
    // v1.23.0: read-only version-preview tab — never save or snapshot.
    const activeTab = tabsStore.getState().tabs.find(t => t.id === tabsStore.getState().activeTabId);
    if (activeTab?.readOnly) return false;
    const prevFilePath = editorStore.getState().currentFilePath;
    const latestContent = getCurrentContent();

    let saved: boolean;
    if (asNew || !prevFilePath) {
      // New file or Save As — try to suggest a meaningful filename. Typst tabs
      // save as `.typ` (flavor-aware) so a new Typst document keeps its mode.
      const suggestedPath = await computeSuggestedPath(latestContent);
      const kind = activeTab?.flavor === 'typst' ? 'typst' : 'markdown';
      saved = await saveFileAs(latestContent, suggestedPath, kind);
    } else {
      saved = await saveFile(latestContent);
    }

    if (saved) {
      pendingEditsSince = 0; // autosave clock: no pending edits after a successful save
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

      // Local version history: snapshot every successful save of a KB document
      // (hash-deduped inside; best-effort, never blocks the save path)
      if (newFilePath) {
        snapshotVersion(newFilePath, latestContent, opts?.auto ? 'auto' : 'manual');
      }

      // on-save KB sync: trigger 3 seconds after save to batch rapid saves
      if (saved && newFilePath) {
        const activeKb = filesStore.getActiveKnowledgeBase?.();
        const binding = activeKb?.picoraBinding;
        if (binding && binding.strategy.mode === 'on-save' && settingsStore.getState().kbSyncEnabled !== false) {
          const target = settingsStore.getState().imageHostTargets.find(t => t.id === binding.picoraTargetId);
          if (target) {
            setTimeout(() => {
              runSync(binding, activeKb!, target, false, (report) => {
                filesStore.updateKbSyncReport(activeKb!.id, {
                  lastSyncAt: new Date().toISOString(),
                  lastSyncReport: report,
                  lastSyncError: null,
                });
              }).catch(() => {});
            }, 3000);
          }
        }
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

  // ── Local version history (v1.21.0) ─────────────────────────────────

  function toggleVersionHistory() {
    // Re-check availability at click time (a KB may have been registered
    // after this file was opened)
    const fp = editorStore.getState().currentFilePath;
    versionHistoryAvailable = isVersionedPath(fp);
    if (!versionHistoryAvailable) return;
    showVersionHistory = !showVersionHistory;
  }

  /** Reload the editor after a snapshot was restored to disk. */
  function handleVersionRestored(restored: string) {
    content = restored;
    editorStore.setDirtyContent(false, restored);
    syncVisualEditor(restored);
    const fp = editorStore.getState().currentFilePath;
    if (fp) {
      // Refresh the tab mtime so the external-change watcher doesn't flag the restore
      invoke('get_files_mtime', { paths: [fp] }).then((result: unknown) => {
        const mtimes = result as [string, number][];
        if (mtimes.length > 0) {
          tabsStore.updateActiveFile(fp, getFileNameFromPath(fp), mtimes[0][1]);
        }
      }).catch(() => {});
    }
    showToast($t('version_history.restored'), 'success');
  }

  /** Open a historical version's content in a read-only preview tab. */
  function handleOpenVersion(versionContent: string, label: string, previewKey: string) {
    tabsStore.openReadOnlyTab(previewKey, label, versionContent);
    // The tabs subscriber loads the content into the editor and sets
    // editorReadOnly; nothing else to do here.
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

  // ── Flavor-aware shared actions (v0.46.0) ─────────────────────────────
  // Every Paragraph/Format action below exists in BOTH document flavors, so it
  // keeps ONE menu item and ONE shortcut: markdown runs a ProseMirror command,
  // Typst rewrites the .typ source (markup rules in typst-commands.ts).
  //
  // Before this, a Typst tab left `morayaEditor` pointing at the destroyed
  // markdown EditorView, so every one of these was a silent no-op.

  /** Canonical names for actions shared by both document flavors. */
  type SharedAction =
    | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
    | 'bold' | 'italic' | 'strike' | 'inlineCode' | 'link'
    | 'bulletList' | 'orderedList' | 'quote'
    | 'codeBlock' | 'mathBlock' | 'horizontalRule' | 'table';

  /** Markdown (ProseMirror) command + Typst source action for each shared name. */
  const SHARED_ACTIONS: Record<SharedAction, { md: () => void; typst: TypstAction }> = {
    h1: { md: () => runCmd(setHeading(1)), typst: { type: 'heading', level: 1 } },
    h2: { md: () => runCmd(setHeading(2)), typst: { type: 'heading', level: 2 } },
    h3: { md: () => runCmd(setHeading(3)), typst: { type: 'heading', level: 3 } },
    h4: { md: () => runCmd(setHeading(4)), typst: { type: 'heading', level: 4 } },
    h5: { md: () => runCmd(setHeading(5)), typst: { type: 'heading', level: 5 } },
    h6: { md: () => runCmd(setHeading(6)), typst: { type: 'heading', level: 6 } },
    bold: { md: () => runCmd(toggleBold), typst: { type: 'bold' } },
    italic: { md: () => runCmd(toggleItalic), typst: { type: 'italic' } },
    strike: { md: () => runCmd(toggleStrikethrough), typst: { type: 'strike' } },
    inlineCode: { md: () => runCmd(toggleCode), typst: { type: 'inlineCode' } },
    link: { md: () => runCmd(toggleLink({ href: '' })), typst: { type: 'link' } },
    bulletList: { md: () => runCmd(wrapInBulletList), typst: { type: 'bulletList' } },
    orderedList: { md: () => runCmd(wrapInOrderedList), typst: { type: 'orderedList' } },
    quote: { md: () => runCmd(wrapInBlockquote), typst: { type: 'quote' } },
    codeBlock: { md: () => runCmd(insertCodeBlock), typst: { type: 'codeBlock' } },
    mathBlock: { md: () => runCmd(insertMathBlockCmd), typst: { type: 'mathBlock' } },
    horizontalRule: { md: () => runCmd(insertHorizontalRule), typst: { type: 'horizontalRule' } },
    table: { md: () => runCmd(insertTable(3, 3)), typst: { type: 'table', rows: 3, cols: 3 } },
  };

  /** Run a shared action against whichever editor the active tab is using. */
  function runSharedAction(name: SharedAction) {
    const action = SHARED_ACTIONS[name];
    if (activeTypstTab) {
      typstEditorRef?.runAction(action.typst);
      return;
    }
    action.md();
  }

  /** Handle commands from the iPad touch toolbar */
  function handleTouchCommand(cmd: string) {
    // Shared actions go through runSharedAction so the toolbar behaves the same
    // on a Typst tab as the menu and shortcuts do.
    const commandMap: Record<string, () => void> = {
      bold: () => runSharedAction('bold'),
      italic: () => runSharedAction('italic'),
      strikethrough: () => runSharedAction('strike'),
      code: () => runSharedAction('inlineCode'),
      link: () => runSharedAction('link'),
      h1: () => runSharedAction('h1'),
      h2: () => runSharedAction('h2'),
      h3: () => runSharedAction('h3'),
      quote: () => runSharedAction('quote'),
      bullet_list: () => runSharedAction('bulletList'),
      ordered_list: () => runSharedAction('orderedList'),
      code_block: () => runSharedAction('codeBlock'),
      math_block: () => runSharedAction('mathBlock'),
      table: () => runSharedAction('table'),
      image: () => { showImageDialog = true; },
      hr: () => runSharedAction('horizontalRule'),
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
  let prevAutoSaveKey = '';
  const unsubSettings = settingsStore.subscribe(state => {
    showSidebar = state.showSidebar;
    showOutline = state.showOutline;
    if (state.outlineWidth !== outlineWidth) outlineWidth = state.outlineWidth;
    // Rebuild the autosave ticker when its settings change (previously a
    // toggle only took effect after an app restart). prev-value key guard
    // keeps this hot subscriber a no-op on unrelated updates.
    const autoSaveKey = `${state.autoSave}|${state.autoSaveMaxMinutes}|${state.autoSaveIdleMinutes}`;
    if (autoSaveKey !== prevAutoSaveKey) {
      const isFirstRun = prevAutoSaveKey === '';
      prevAutoSaveKey = autoSaveKey;
      if (!isFirstRun) setupAutoSave();
    }
  });

  // Track previous values to skip redundant work in hot subscriber path.
  // This subscriber fires on every store update (setContent, setDirty, setFocused, etc.)
  // so we must avoid doing unnecessary work or writing $state on each call.
  // Use undefined sentinel so even the initial null → null fires registration
  let prevFilePath: string | null | undefined = undefined;
  let prevEditorMode: EditorMode | null = null;

  // Autosave activity tracking (plain vars, not $state — read by the ticker only).
  // pendingEditsSince = when the first unsaved edit occurred (0 = none pending);
  // lastEditAt = most recent edit. handleSave resets pendingEditsSince on success.
  let pendingEditsSince = 0;
  let lastEditAt = 0;
  let prevAutosaveContent: string | null = null;

  const unsubEditor = editorStore.subscribe(state => {
    // Autosave: record edit activity on dirty content changes. Unchanged
    // content is usually the same string reference, so the !== check is cheap.
    if (state.isDirty && state.content !== prevAutosaveContent) {
      prevAutosaveContent = state.content;
      lastEditAt = Date.now();
      if (pendingEditsSince === 0) pendingEditsSince = lastEditAt;
    }
    // Only recompute file name when path actually changes
    if (state.currentFilePath !== prevFilePath) {
      // v0.32.1 §F2: auto-exit DiffView on file switch
      if (diffViewState) {
        diffViewState = null;
      }
      // v0.32.1 §F3: cancel any in-flight AI review when switching files
      try {
        abortAIRequest();
      } catch {
        /* noop */
      }
      prevFilePath = state.currentFilePath;
      currentFileName = state.currentFilePath
        ? getFileNameFromPath(state.currentFilePath)
        : $t('common.untitled');

      // v1.21.0: version-history entry is only meaningful for KB documents;
      // close a sheet left open for the previous file
      versionHistoryAvailable = isVersionedPath(state.currentFilePath);
      if (showVersionHistory) showVersionHistory = false;

      // Register with macOS Dock menu tracker
      if (isTauri && isMacOS) {
        invoke('register_dock_document', {
          displayName: currentFileName,
          filePath: state.currentFilePath ?? null,
        }).catch(() => {});
      }
    }
    // Mirror lastSingleMode from the store. Guarded by equality so this
    // subscriber stays a no-op when only unrelated fields (content,
    // wordCount, …) change.
    if (state.lastSingleMode !== lastSingleMode) {
      lastSingleMode = state.lastSingleMode;
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
      //
      // Guarded by `!activeTypstTab`: entering a Typst tab forces editorMode to
      // 'split' (see tabsStore subscribe below), which fires THIS subscriber
      // synchronously while the outgoing Editor/SourceEditor may still be
      // mounted. Without this guard, that forced mode change would pull the
      // OLD document's full markdown from visualEditorRef/splitVisualRef and
      // stomp the just-set Typst template — the new .typ tab would open with
      // the previous document's content instead of blank.
      if (prevMode === 'visual' && visualEditorRef && !activeTypstTab) {
        content = visualEditorRef.getFullMarkdown();
        console.log('[EditorSub] synced from visual, content length:', content.length);
      } else if (prevMode === 'split' && splitVisualRef && !activeTypstTab) {
        content = splitVisualRef.getFullMarkdown();
      }
      // When leaving source mode, editorStore.content should be up-to-date
      // (SourceEditor flushes via bind:value and onDestroy).
      // But as a safety net, also sync from editorStore if content is empty but store has content.
      if (prevMode === 'source' && content.length === 0 && !activeTypstTab) {
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
  let prevActiveFlavor: 'markdown' | 'typst' | undefined;
  const unsubTabs = tabsStore.subscribe(state => {
    tabs = state.tabs;
    activeTabId = state.activeTabId;
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    // React to a flavor change on the SAME tab as well as to a tab switch:
    // detaching a tab into a new window calls `initWithContent`, which rewrites
    // the already-active tab in place (content + flavor) without changing
    // activeTabId. Keying only on the id would skip the mount dispatch below,
    // leaving a Typst document rendered by the markdown editor.
    const flavorChanged = (activeTab?.flavor) !== prevActiveFlavor;
    if (state.activeTabId !== prevActiveTabId || flavorChanged) {
      prevActiveTabId = state.activeTabId;
      prevActiveFlavor = activeTab?.flavor;
      const tab = activeTab;
      if (tab) {
        const wasTypst = activeTypstTab !== null;

        // Crossing OUT of a Typst tab (to markdown or an image tab): restore
        // whatever visual/source/split mode was active before Typst forced
        // 'split', so markdown's sticky mode preference is unaffected by
        // having viewed a Typst document in between.
        if (wasTypst && tab.flavor !== 'typst') {
          editorStore.setEditorMode(preTypstEditorMode ?? 'visual');
          preTypstEditorMode = null;
        }
        // Latch/unlatch the markdown destroy-flush suppression (see
        // suppressMarkdownFlush): held for the whole time a Typst tab is
        // active, so the outgoing Editor's unmount can't write stale markdown
        // through the shared `content` binding.
        suppressMarkdownFlush(tab.flavor === 'typst');

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

        // Typst flavor: source + live preview surface, NOT the ProseMirror
        // editor. Keep editorStore in sync (filePath + content + dirty) so
        // Save / dirty-tracking / tab-switch persistence all work against the
        // .typ file, but skip the ProseMirror replaceContent pipeline entirely.
        if (tab.flavor === 'typst') {
          // Set activeTypstTab + content BEFORE forcing editorMode below. The
          // mode change synchronously notifies editorStore's subscriber, which
          // guards its old-editor content sync on `!activeTypstTab` — setting
          // these first ensures that guard is already active by the time it runs.
          activeImageTab = null;
          if (imagePreviewUrl) { URL.revokeObjectURL(imagePreviewUrl); imagePreviewUrl = null; }
          activeTypstTab = tab;
          editorReadOnly = tab.readOnly ?? false;
          content = tab.content;
          currentFileName = tab.fileName;
          // Crossing INTO Typst from a non-Typst tab: remember the current
          // mode and default to 'split' — the source+preview comparison view
          // is the only one that matches what TypstEditor renders by default,
          // so the StatusBar mode indicator must reflect that, not whatever
          // markdown mode happened to be active before.
          if (!wasTypst) {
            preTypstEditorMode = editorStore.getState().editorMode;
            editorStore.setEditorMode('split');
          }
          editorStore.batchRestore({
            filePath: tab.filePath,
            content: tab.content,
            isDirty: tab.isDirty,
            cursorOffset: 0,
            scrollFraction: 0,
          });
          return;
        }
        activeTypstTab = null;

        // Non-image tab: clear image preview
        activeImageTab = null;
        if (imagePreviewUrl) { URL.revokeObjectURL(imagePreviewUrl); imagePreviewUrl = null; }

        // v1.23.0: read-only version-preview tab → mount editor non-editable
        editorReadOnly = tab.readOnly ?? false;

        console.log('[TabsSub] activeTab changed, setting content length:', tab.content.length, 'preview:', JSON.stringify(tab.content.slice(0, 80)));
        content = tab.content;
        currentFileName = tab.fileName;
        replaceContentAndScrollToTop(tab.content);

        // Refresh review anchors for the newly active tab (non-image, non-preview, git-bound KB)
        if (!tab.isImage && !tab.readOnly && tab.filePath) {
          const kb2 = filesStore.getActiveKnowledgeBase?.();
          if (kb2?.git) {
            const rp = tab.filePath.startsWith(kb2.path + '/')
              ? tab.filePath.slice(kb2.path.length + 1)
              : tab.filePath;
            reviewStore.loadForFile(kb2.path, rp, tab.content).catch(() => {});
          } else {
            reviewStore.unload();
          }
        } else {
          reviewStore.unload();
        }
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
    invoke('update_mcp_menu', { servers: menuServers, noToolsLabel: $t('menu.no_mcptools') }).catch(() => {});
  });

  onDestroy(() => {
    stopMemoryAutoSync();
    unsubAI();
    unsubSettings();
    unsubEditor();
    unsubTabs();
    unsubMCP();
    unsubGitKB();
    unsubKbSyncStates();
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    clearAllIntervals();

    // on-startup-and-close: fire sync on close (best-effort, fire-and-forget)
    const fsStateClose = filesStore.getState();
    const settingsClose = settingsStore.getState();
    if (settingsClose.kbSyncEnabled !== false) {
      for (const kb of fsStateClose.knowledgeBases) {
        const binding = kb.picoraBinding;
        if (!binding || binding.strategy.mode !== 'on-startup-and-close') continue;
        const target = settingsClose.imageHostTargets.find(t => t.id === binding.picoraTargetId);
        if (target) runSync(binding, kb, target, false).catch(() => {});
      }
    }

    // Release file lock + unload review store on window close
    reviewStore.unload();
    const edState = editorStore.getState();
    const curPath = edState.currentFilePath;
    if (curPath) {
      const kb3 = filesStore.getActiveKnowledgeBase?.();
      if (kb3?.git) {
        const rp3 = curPath.startsWith(kb3.path + '/')
          ? curPath.slice(kb3.path.length + 1)
          : curPath;
        import('$lib/services/review').then(({ releaseLock }) => {
          releaseLock(kb3.path, rp3, kb3).catch(() => {});
        }).catch(() => {});
      }
    }
  });

  // Sync native menu checkmarks for the editor-mode trio. Visual/Source
  // is one mutex axis (base mode), Split is independent (layout axis), so
  // we push each CheckMenuItem on its own — NOT via the radio-style
  // `set_editor_mode_menu` helper, which would force exactly one of the
  // three to be checked and undo the two-axis design. With this wiring:
  //   • Visual is checked iff lastSingleMode === 'visual'
  //   • Source is checked iff lastSingleMode === 'source'
  //   • Split is checked iff editorMode === 'split'
  // So in split mode the user sees BOTH Split AND their chosen base mode
  // checked, exactly matching the mental model.
  $effect(() => {
    if (!isTauri) return;
    invoke('set_menu_check', { id: 'view_mode_visual', checked: lastSingleMode === 'visual' }).catch(() => {});
    invoke('set_menu_check', { id: 'view_mode_source', checked: lastSingleMode === 'source' }).catch(() => {});
    invoke('set_menu_check', { id: 'view_mode_split', checked: editorMode === 'split' }).catch(() => {});
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

  // Grey out menu items that belong to the OTHER document flavor (v0.46.0).
  // Shared actions (Paragraph/Format/…) stay enabled in both formats — they keep
  // one menu item and one shortcut — while format-exclusive ones (Task List has
  // no Typst counterpart, cloud audio/video cannot go in a print format) are
  // disabled rather than hidden, so the menu shape never shifts under the user.
  //
  // Safe against the CheckMenuItem feedback loop documented in CLAUDE.md:
  // `set_enabled` does not emit menu events, unlike `set_checked`.
  $effect(() => {
    if (!isTauri) return;
    const flavor: 'markdown' | 'typst' = activeTypstTab ? 'typst' : 'markdown';
    const off = new Set(disabledMenuItemsFor(flavor));
    const states: Record<string, boolean> = {};
    // Send BOTH lists every time so switching back re-enables what was greyed.
    for (const id of [...FLAVOR_ONLY_MENU_ITEMS.markdown, ...FLAVOR_ONLY_MENU_ITEMS.typst]) {
      states[id] = !off.has(id);
    }
    invoke('set_menu_items_enabled', { states }).catch(() => {});
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
      file_new_typst: tr('menu.new_typst'),
      // Flavor-aware: the entry offers whichever flavor the document is not.
      file_convert_typst: activeTypstTab ? tr('menu.save_as_markdown') : tr('menu.save_as_typst'),
      file_new_window: tr('menu.new_window'),
      file_open: tr('menu.open'),
      file_save: tr('menu.save'),
      file_save_as: tr('menu.save_as'),
      menu_export: tr('menu.export'),
      file_export_html: tr('menu.export_html'),
      file_export_pdf: tr('menu.export_pdf'),
      file_export_typst_pdf: tr('menu.export_typst_pdf'),
      file_export_image: tr('menu.export_image'),
      file_export_doc: tr('menu.export_doc'),
      // Paragraph menu
      para_h1: tr('menu.heading1'),
      para_h2: tr('menu.heading2'),
      para_h3: tr('menu.heading3'),
      para_h4: tr('menu.heading4'),
      para_h5: tr('menu.heading5'),
      para_h6: tr('menu.heading6'),
      para_table: tr('menu.table'),
      para_code_block: tr('menu.code_block'),
      para_math_block: tr('menu.math_block'),
      para_quote: tr('menu.quote'),
      para_bullet_list: tr('menu.bullet_list'),
      para_ordered_list: tr('menu.ordered_list'),
      para_task_list: tr('menu.task_list'),

      para_hr: tr('menu.horizontal_rule'),
      // Format menu
      fmt_bold: tr('menu.bold'),
      fmt_italic: tr('menu.italic'),
      fmt_strikethrough: tr('menu.strikethrough'),
      fmt_code: tr('menu.code'),
      fmt_link: tr('menu.link'),
      fmt_image: tr('menu.image'),
      // Cloud insert items (reuse the context-menu strings — same wording)
      insert_cloud_image: tr('context_menu.insert_cloud_image'),
      insert_cloud_audio: tr('context_menu.insert_cloud_audio'),
      insert_cloud_video: tr('context_menu.insert_cloud_video'),
      // View menu — append platform-appropriate shortcut hints
      // v0.41.5 (A5): accelerators are now native — no Unicode hints in labels.
      view_mode_visual: tr('menu.visual_mode'),
      view_mode_source: tr('menu.source_mode'),
      view_mode_split: tr('menu.split_mode'),
      view_sidebar: tr('menu.toggle_sidebar'),
      view_ai_panel: tr('menu.toggle_aipanel'),
      view_outline: tr('menu.toggle_outline'),
      view_zoom_in: tr('menu.zoom_in'),
      view_zoom_out: tr('menu.zoom_out'),
      view_actual_size: tr('menu.actual_size'),
      // Help menu
      help_version_info: tr('menu.version_info'),
      help_changelog: tr('menu.changelog'),
      help_terms: tr('menu.terms_of_service'),
      help_privacy: tr('menu.privacy_policy'),
      help_website: tr('menu.official_website'),
      help_about: tr('menu.about_moraya'),
      help_feedback: tr('menu.feedback'),
      // Workflow menu
      wf_seo: tr('menu.seo_optimization'),
      wf_image_gen: tr('menu.ai_image_generation'),
      wf_publish: tr('menu.publish'),
      wf_mcp: tr('menu.mcp_tools'),
      wf_mcp_empty: tr('menu.no_mcptools'),
      // Edit — search
      edit_undo: tr('menu.undo'),
      edit_redo: tr('menu.redo'),
      edit_select_all: tr('menu.select_all'),
      edit_find: tr('menu.find'),
      edit_replace: tr('menu.replace'),
      // macOS app menu
      preferences: tr('menu.settings'),
    };
    if (isTauri) invoke('update_menu_labels', { labels });
  });

  // Auto-save (v1.21.0): dual-condition scheduler — force-save pending edits
  // after autoSaveMaxMinutes, or once input pauses for autoSaveIdleMinutes.
  // A coarse 15s ticker polls the pure shouldAutoSave() decision; edit
  // timestamps are tracked in the editorStore subscriber above.
  const AUTOSAVE_TICK_MS = 15_000;
  let autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  // KB sync trash purge timer (v0.68.0) — purge entries older than 7 days
  let trashPurgeTimer: ReturnType<typeof setInterval> | null = null;

  function setupAutoSave() {
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    if (!settingsStore.getState().autoSave) return;
    autoSaveTimer = setInterval(() => {
      const editorState = editorStore.getState();
      if (!editorState.isDirty || !editorState.currentFilePath) return;
      // Dirty without a tracked edit (e.g. dirty tab restored) — start the clock now
      if (pendingEditsSince === 0) pendingEditsSince = Date.now();
      const s = settingsStore.getState();
      if (shouldAutoSave(Date.now(), pendingEditsSince, lastEditAt, {
        maxMinutes: s.autoSaveMaxMinutes,
        idleMinutes: s.autoSaveIdleMinutes,
      })) {
        handleSave(false, { auto: true });
      }
    }, AUTOSAVE_TICK_MS);
  }

  // ── MCP shortcut action handlers (v0.41.6) ─────────────────────────
  async function runMCPServerToggle(serverId: string): Promise<void> {
    const { toggleMCPServer } = await import('$lib/services/mcp/shortcut-actions');
    const result = await toggleMCPServer(serverId);
    if (result.kind === 'connected') {
      showToast($t('shortcuts.mcp.toggled.on', { name: result.server.name }), 'success');
    } else if (result.kind === 'disconnected') {
      showToast($t('shortcuts.mcp.toggled.off', { name: result.server.name }), 'success');
    } else if (result.kind === 'not-found') {
      showToast($t('shortcuts.mcp.server_gone'), 'error');
    } else {
      showToast(result.reason, 'error');
    }
  }

  async function runMCPToolPrompt(serverId: string, toolName: string): Promise<void> {
    const { resolveMCPToolPrompt } = await import('$lib/services/mcp/shortcut-actions');
    const r = resolveMCPToolPrompt(serverId, toolName);
    if (r.kind === 'not-found') {
      showToast($t('shortcuts.mcp.unavailable'), 'error');
      return;
    }
    showAIPanel = true;
    try {
      await sendChatMessage(r.message, getCurrentContent());
    } catch (e) {
      console.warn('[MCP shortcut] sendChatMessage failed:', e);
    }
  }

  // Minimalist-style keyboard shortcuts
  /**
   * Perform the action for a catalog-defined shortcut id. Used by the
   * user-customizable shortcut override dispatcher below — when a user has
   * remapped e.g. `file.save` to a non-default combo, this function does
   * what `Cmd+S` would normally do.
   *
   * Returns `true` if the id was handled, `false` for unknown ids (so the
   * caller can fall through to the existing hardcoded handlers).
   */
  function runShortcutAction(id: string): boolean {
    // Flavor gate (v0.46.0): a binding scoped to the other document format is
    // inert, matching the greyed-out native menu item. Without this the JS
    // shortcut path would still fire (e.g. Cmd+F on a Typst tab opening a search
    // bar that cannot reach the Typst source pane).
    const entry = SHORTCUT_CATALOG.find((e) => e.id === id);
    if (entry && !entry.alwaysAvailable) {
      const scope = scopeOf(entry);
      const flavor = activeTypstTab ? 'typst' : 'markdown';
      if (scope !== 'shared' && scope !== flavor) return false;
    }

    // ── MCP dynamic-id branches (v0.41.6) ────────────────────────
    // Format: `mcp.server.<serverId>.toggle` / `mcp.tool.<serverId>.<toolName>.prompt`
    // (serverId is the persisted ID from mcp-config.json; toolName is
    // stable for as long as the MCP server keeps exposing it.)
    if (id.startsWith('mcp.server.') && id.endsWith('.toggle')) {
      const serverId = id.slice('mcp.server.'.length, -'.toggle'.length);
      void runMCPServerToggle(serverId);
      return true;
    }
    if (id.startsWith('mcp.tool.') && id.endsWith('.prompt')) {
      const ref = $settingsStore.mcpToolShortcuts?.find(r => r.catalogId === id);
      if (ref) void runMCPToolPrompt(ref.serverId, ref.toolName);
      return true;
    }

    switch (id) {
      case 'file.new': handleNewFile(); return true;
      case 'file.newTypst': handleNewTypstFile(); return true;
      case 'file.convertTypst': handleConvertFlavor(); return true;
      case 'file.newWindow':
        if (isIPadOS) handleNewFile();
        else invoke('create_new_window').catch(() => {});
        return true;
      case 'file.open': handleOpenFile(); return true;
      case 'file.save': handleSave(); return true;
      case 'file.saveAs': handleSave(true); return true;
      case 'file.exportHtml': handleExport('html'); return true;
      case 'file.exportPdf': handleExport('pdf'); return true;
      case 'file.exportTypstPdf': handleExportTypstPdf(); return true;
      case 'file.exportImage': handleExport('image'); return true;
      case 'file.exportDoc': handleExport('doc'); return true;

      case 'edit.undo':
        if (editorMode === 'source' || (editorMode === 'split' && isSourcePaneFocused())) {
          document.execCommand('undo');
        } else {
          morayaEditor?.view.focus();
          runCmd(undo);
        }
        return true;
      case 'edit.redo':
        if (editorMode === 'source' || (editorMode === 'split' && isSourcePaneFocused())) {
          document.execCommand('redo');
        } else {
          morayaEditor?.view.focus();
          runCmd(redo);
        }
        return true;
      case 'edit.find': showSearch = true; return true;
      case 'edit.replace': showSearch = true; showReplace = true; return true;

      case 'paragraph.h1': runSharedAction('h1'); return true;
      case 'paragraph.h2': runSharedAction('h2'); return true;
      case 'paragraph.h3': runSharedAction('h3'); return true;
      case 'paragraph.h4': runSharedAction('h4'); return true;
      case 'paragraph.h5': runSharedAction('h5'); return true;
      case 'paragraph.h6': runSharedAction('h6'); return true;
      case 'paragraph.codeBlock': runSharedAction('codeBlock'); return true;
      case 'paragraph.quote': runSharedAction('quote'); return true;

      case 'format.bold': runSharedAction('bold'); return true;
      case 'format.italic': runSharedAction('italic'); return true;
      case 'format.strike': runSharedAction('strike'); return true;
      case 'format.code': runSharedAction('inlineCode'); return true;
      case 'format.link': runSharedAction('link'); return true;
      case 'format.insertImage': showImageDialog = true; return true;

      case 'view.toggleMode': {
        // Cmd+/ — flip the base mode (Visual ↔ Source).
        //  • In single layout (visual / source): flip the rendered editorMode
        //    as well, taking the user from one base mode to the other.
        //  • In split layout: just flip lastSingleMode. The user stays in
        //    split (both panes still showing), but the menu's
        //    Visual/Source checkmark moves, and the NEXT Cmd+Shift+/ will
        //    exit split into the newly-chosen base. This matches the
        //    "two-axis" mental model (see editor-store.ts).
        const newBase: 'visual' | 'source' = lastSingleMode === 'visual' ? 'source' : 'visual';
        editorStore.setLastSingleMode(newBase);
        if (editorMode !== 'split') {
          editorMode = newBase;
          editorStore.setEditorMode(newBase);
        }
        return true;
      }
      case 'view.toggleSplit': {
        // Cmd+Shift+/ — toggle the layout axis. Returning from split
        // restores the last single base (visual or source), NOT always
        // visual; entering split keeps lastSingleMode where it is so
        // the round-trip is non-destructive.
        const next: EditorMode = editorMode === 'split' ? lastSingleMode : 'split';
        editorMode = next;
        editorStore.setEditorMode(next);
        return true;
      }
      case 'view.toggleSidebar': settingsStore.toggleSidebar(); return true;
      case 'view.toggleAIPanel': showAIPanel = !showAIPanel; return true;
      case 'view.toggleOutline':
        settingsStore.update({ showOutline: !showOutline });
        return true;
      case 'view.openSettings': showSettings = !showSettings; return true;
      case 'view.zoomIn': {
        const s = settingsStore.getState();
        const sz = Math.min(s.fontSize + 1, 24);
        settingsStore.update({ fontSize: sz });
        document.documentElement.style.setProperty('--font-size-base', `${sz}px`);
        return true;
      }
      case 'view.zoomOut': {
        const s = settingsStore.getState();
        const sz = Math.max(s.fontSize - 1, 12);
        settingsStore.update({ fontSize: sz });
        document.documentElement.style.setProperty('--font-size-base', `${sz}px`);
        return true;
      }
      case 'view.zoomReset':
        settingsStore.update({ fontSize: 16 });
        document.documentElement.style.setProperty('--font-size-base', '16px');
        return true;

      // Quick Open and the full Command Palette share the same modal in
      // this build — `showCommandPalette` is the trigger for both.
      case 'workflow.quickOpen':
      case 'workflow.commandPalette':
        showCommandPalette = true;
        return true;

      // AI chat shortcuts are managed by the input box keydown — not by
      // the global handler. Returning false lets the caller skip them.
      case 'aiChat.send':
      case 'aiChat.newline':
        return false;

      default:
        return false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    // When Command Palette is open, only allow Escape (handled by palette itself)
    // Skip all global shortcuts to prevent Cmd+O etc. from firing while typing
    if (showCommandPalette || showPromptPalette) return;

    // User-customized shortcut overrides take precedence over hardcoded
    // bindings. Only entries the user has explicitly remapped enter this
    // loop — the empty case is O(1).
    const overrides = $settingsStore.shortcutOverrides;
    if (overrides) {
      for (const id in overrides) {
        const ovr = overrides[id];
        if (!ovr) continue;
        if (!eventMatchesBinding(event, ovr, isMacOS)) continue;
        if (runShortcutAction(id)) {
          event.preventDefault();
          return;
        }
      }
    }

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

    // File shortcuts — on Tauri the native menu accelerator handles
    // the default bindings; the override loop above handles user-customized
    // bindings. The hardcoded fallbacks below kick in only for non-Tauri
    // contexts (web preview, dev mode without a native menu).
    if (!isTauri && mod && event.key === 's') {
      event.preventDefault();
      handleSave(event.shiftKey);
      return;
    }

    if (!isTauri && mod && !event.altKey && event.key === 'o' && !event.shiftKey) {
      event.preventDefault();
      handleOpenFile();
      return;
    }

    if (!isTauri && mod && !event.shiftKey && (event.key === 'n' || event.key === 'N')) {
      event.preventDefault();
      handleNewFile();
      return;
    }

    if (!isTauri && mod && event.key === '\\') {
      event.preventDefault();
      settingsStore.toggleSidebar();
      return;
    }

    if (!isTauri && mod && event.key === ',') {
      event.preventDefault();
      showSettings = !showSettings;
      return;
    }

    // Toggle base mode (Visual ↔ Source) and layout (single ↔ Split) —
    // two-axis model, matches the shortcut handler in the `view.*` cases
    // above. Tauri's native menu accelerators handle this for the
    // desktop build; this branch only runs in the browser dev preview.
    const slashMod = isMacOS ? event.metaKey : event.ctrlKey;
    if (!isTauri && slashMod && !event.shiftKey && (event.key === '/' || event.code === 'Slash')) {
      event.preventDefault();
      const newBase: 'visual' | 'source' = lastSingleMode === 'visual' ? 'source' : 'visual';
      editorStore.setLastSingleMode(newBase);
      if (editorMode !== 'split') {
        editorMode = newBase;
        editorStore.setEditorMode(newBase);
      }
      return;
    }

    if (!isTauri && slashMod && event.shiftKey && (event.key === '/' || event.key === '?' || event.code === 'Slash')) {
      event.preventDefault();
      const newMode: EditorMode = editorMode === 'split' ? lastSingleMode : 'split';
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

    // v0.32.0: History Panel toggle: Cmd+Shift+H / Ctrl+Shift+H
    if (mod && event.shiftKey && (event.key === 'H' || event.key === 'h')) {
      event.preventDefault();
      // If a DiffView is open, close it first instead of toggling history
      if (diffViewState) {
        diffViewState = null;
        showHistoryPanel = true;
      } else {
        showHistoryPanel = !showHistoryPanel;
        if (showHistoryPanel) {
          showAIPanel = false;
          showReviewPanel = false;
        }
      }
      return;
    }

    // Add Review: Cmd+Shift+R / Ctrl+Shift+R
    if (mod && event.shiftKey && (event.key === 'R' || event.key === 'r')) {
      event.preventDefault();
      if (editorMode !== 'visual' && editorMode !== 'split') {
        showToast($t('review.source_mode_limit_hint'), 'error');
        return;
      }
      const view = morayaEditor?.view;
      if (!view) return;
      const { from, to } = view.state.selection;
      if (from === to) {
        showToast($t('review.select_text_first'), 'error');
        return;
      }
      const selText = view.state.doc.textBetween(from, to, ' ');
      const docText = view.state.doc.textContent;
      const ctxBefore = docText.slice(Math.max(0, from - 50), from);
      const ctxAfter = docText.slice(to, to + 50);
      handleAddReview(selText, ctxBefore, ctxAfter);
      return;
    }

    // Export HTML — native menu accel on Tauri, fallback below for non-Tauri.
    if (!isTauri && mod && event.shiftKey && event.key === 'E') {
      event.preventDefault();
      handleExport('html');
      return;
    }

    // Prompt Palette (recall captured prompt assets): Cmd/Ctrl+Shift+A
    if (mod && event.shiftKey && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      showPromptPalette = true;
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

    // Find / Replace — bindings honor user overrides set in
    // Settings → Shortcuts (see `shortcutOverrides`). Defaults are
    // Cmd+F / Cmd+H on macOS, Ctrl+F / Ctrl+H elsewhere.
    {
      const overrides = $settingsStore.shortcutOverrides;
      const findEntry = SHORTCUT_CATALOG.find(e => e.id === 'edit.find')!;
      const replaceEntry = SHORTCUT_CATALOG.find(e => e.id === 'edit.replace')!;
      const findBinding = effectiveBinding(findEntry, isMacOS, overrides);
      const replaceBinding = effectiveBinding(replaceEntry, isMacOS, overrides);
      if (eventMatchesBinding(event, replaceBinding, isMacOS)) {
        event.preventDefault();
        showSearch = true;
        showReplace = true;
        return;
      }
      if (eventMatchesBinding(event, findBinding, isMacOS)) {
        event.preventDefault();
        showSearch = true;
        return;
      }
    }

    // Escape → close search
    if (event.key === 'Escape' && showSearch) {
      event.preventDefault();
      handleSearchClose();
      return;
    }

    // The following blocks are non-Tauri fallbacks for keystrokes the
    // native menu otherwise handles. On Tauri the native menu (now
    // override-aware via menu-sync) drives these.
    if (!isTauri && mod && event.shiftKey && event.key === 'G') {
      event.preventDefault();
      showImageDialog = true;
      return;
    }

    if (!isTauri && mod && !event.shiftKey && event.key >= '1' && event.key <= '6') {
      event.preventDefault();
      runCmd(setHeading(parseInt(event.key)));
      return;
    }

    if (!isTauri && mod && event.shiftKey && event.key === 'K') {
      event.preventDefault();
      runCmd(insertCodeBlock);
      return;
    }

    if (!isTauri && mod && event.shiftKey && event.key === 'Q') {
      event.preventDefault();
      runCmd(wrapInBlockquote);
      return;
    }

    if (!isTauri && mod && event.key === '=') {
      event.preventDefault();
      const settings = settingsStore.getState();
      const newSize = Math.min(settings.fontSize + 1, 24);
      settingsStore.update({ fontSize: newSize });
      document.documentElement.style.setProperty('--font-size-base', `${newSize}px`);
      return;
    }

    if (!isTauri && mod && event.key === '-' && !event.shiftKey) {
      event.preventDefault();
      const settings = settingsStore.getState();
      const newSize = Math.max(settings.fontSize - 1, 12);
      settingsStore.update({ fontSize: newSize });
      document.documentElement.style.setProperty('--font-size-base', `${newSize}px`);
      return;
    }

    if (!isTauri && mod && event.key === '0' && !event.shiftKey) {
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
      $t('editor.unsaved_new_doc_msg'),
      {
        title: $t('editor.unsaved_title'),
        kind: 'warning',
        okLabel: $t('editor.save_first'),
        cancelLabel: $t('editor.discard_changes'),
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
    // Bump the serial to invalidate any in-flight sidebar/open-file-event load
    // (doFileSelect / openFileByPath observe fileSelectSerial via the
    // replaceContentAndScrollToTop guard). Without this, a slow sidebar load
    // racing with a File → Open could land tab B's content into tab A or
    // run two `replaceContentAndScrollToTop` cycles back-to-back, producing
    // the "open another MD → editor stops responding" symptom.
    const mySerial = ++fileSelectSerial;
    // Sync current tab state BEFORE openFile() modifies editorStore
    tabsStore.syncFromEditor();
    const fileContent = await openFile();
    if (mySerial !== fileSelectSerial) return; // Superseded while picker was open
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
      if (mySerial !== fileSelectSerial) return; // Superseded during mtime fetch
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

  /** Create a new, blank Typst document (source + live preview flavor). Unlike
   *  markdown new-file, this bypasses the ProseMirror pipeline — the tabs-store
   *  subscribe handler's typst branch sets content + editorStore +
   *  activeTypstTab. The source pane's placeholder hints at the syntax, so no
   *  starter content is seeded. */
  async function handleNewTypstFile() {
    tabsStore.addTab({ flavor: 'typst', content: '', fileName: 'Untitled.typ' });
    content = '';
    resetWorkflowState();
  }

  /**
   * Convert the active document to the other flavor, opening the result as a
   * NEW unsaved tab. The source document is never modified — conversion is
   * lossy in both directions (raw HTML and implied layout one way; Typst
   * layout, shapes and generated content the other), so overwriting it would
   * destroy information the user cannot get back.
   *
   * Typst → Markdown hands core the native compiler: Typst is a programming
   * language, so the document has to be *run* to be converted, and the desktop
   * binary can export HTML for exactly that. (The browser cannot, and falls
   * back to a source-level read — see `convertTypstToMarkdown`.) Running the
   * compiler means the engine may need downloading on first use.
   */
  async function handleConvertFlavor() {
    const source = getCurrentContent();
    if (!source.trim()) {
      showToast($t('convert.empty'), 'error');
      return;
    }
    const toTypst = !activeTypstTab;
    const convert = await import('@moraya/core/convert');

    let result;
    if (toTypst) {
      result = convert.convertMarkdownToTypst(source, schema);
    } else {
      const { tauriTypstCompiler } = await import('$lib/editor/typst-compiler');
      await tauriTypstCompiler.prepare?.();
      result = await convert.convertTypstToMarkdown(source, { compiler: tauriTypstCompiler });
    }
    if (!result.ok) {
      showToast(result.message || $t('convert.failed'), 'error');
      return;
    }

    const baseName = (currentFileName || 'Untitled').replace(/\.[^.]+$/, '');
    tabsStore.addTab({
      flavor: toTypst ? 'typst' : 'markdown',
      content: result.content,
      fileName: `${baseName}${toTypst ? '.typ' : '.md'}`,
    });
    content = result.content;
    resetWorkflowState();
    // Surface what could not be carried over rather than failing silently.
    const done = toTypst ? $t('convert.done') : $t('convert.done_md');
    const lossy = toTypst ? $t('convert.done_lossy') : $t('convert.done_lossy_md');
    showToast(
      result.warnings.length > 0 ? `${lossy} ${result.warnings.join(' ')}` : done,
      'success',
    );
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
      'task-list': () => runCmd(wrapInTaskList),

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
        $t('tabs.unsaved_msg', { fileName: tab.fileName }),
        {
          title: $t('tabs.unsaved_title'),
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
      // Carry the markup language across the window boundary — an unsaved
      // Typst document has no `.typ` path for the destination to re-detect
      // from, so without this it would reopen as markdown.
      flavor: freshTab.flavor ?? 'markdown',
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
      // Carry the markup language across the window boundary — an unsaved
      // Typst document has no `.typ` path for the destination to re-detect
      // from, so without this it would reopen as markdown.
      flavor: freshTab.flavor ?? 'markdown',
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
          $t('tabs.external_change_msg', { fileName: tab.fileName }),
          {
            title: $t('tabs.external_change_title'),
            kind: 'warning',
            okLabel: $t('tabs.keep_local'),
            cancelLabel: $t('tabs.load_from_disk'),
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
    if (mySerial !== fileSelectSerial) return; // Superseded by a newer click

    const fileName = getFileNameFromPath(path);

    // Image files: open as image tab (read-only preview)
    if (isImageFile(fileName)) {
      tabsStore.syncFromEditor();
      tabsStore.openFileTab(path, fileName, '', null, true, true);
      return;
    }

    // Sync current tab state BEFORE the new file is loaded so the previous
    // tab's editor state (cursor, scroll, dirty) is captured intact.
    tabsStore.syncFromEditor();
    const fileContent = await loadFile(path);
    if (mySerial !== fileSelectSerial) return; // Superseded while IPC was in-flight
    // Fetch mtime for external change detection
    let mtime: number | null = null;
    try {
      const result = await invoke('get_files_mtime', { paths: [path] }) as [string, number][];
      if (result.length > 0) mtime = result[0][1];
    } catch { /* ignore */ }
    if (mySerial !== fileSelectSerial) return; // Superseded while mtime IPC was in-flight
    // skipSync=true: we already synced above before this file was loaded.
    tabsStore.openFileTab(path, fileName, fileContent, mtime, true);
    resetWorkflowState();

    // Load reviews + acquire lock for git-bound KB (non-image files only)
    if (!isImageFile(fileName)) {
      const activeKb = filesStore.getActiveKnowledgeBase?.();
      if (activeKb?.git) {
        const docRelPath = path.startsWith(activeKb.path + '/')
          ? path.slice(activeKb.path.length + 1)
          : path;

        // Fetch git user info (cached in selfName/selfEmail)
        if (!selfName) {
          try {
            const { gitGetUserInfo } = await import('$lib/services/git');
            const info = await gitGetUserInfo(activeKb.path);
            selfName = info.name;
            selfEmail = info.email;
          } catch { /* ignore */ }
        }

        // Load reviews asynchronously
        reviewStore.loadForFile(activeKb.path, docRelPath, fileContent).catch(() => {});

        // Acquire lock (non-blocking display)
        try {
          const { acquireLock, readLocks } = await import('$lib/services/review');
          const lockResult = await acquireLock(
            activeKb.path,
            docRelPath,
            { name: selfName, email: selfEmail },
            activeKb,
          );
          if (!lockResult.success) {
            // Someone else holds the lock — read locks.json for the full Lock object
            const locksFile = await readLocks(activeKb.path);
            currentFileLock = locksFile.locks[docRelPath] ?? null;
          } else {
            currentFileLock = null;
          }
        } catch {
          currentFileLock = null;
        }
      } else {
        reviewStore.unload();
        currentFileLock = null;
      }
    }

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
    // Guard against a stale callback: split mode's lazy-change plugin
    // serializes markdown on a 150ms debounce, and switching to a Typst tab
    // bypasses the ProseMirror syncContent() path entirely (there's nothing to
    // sync — Typst isn't ProseMirror), so the usual `syncingFromExternal`
    // suppression never engages. If that debounce was still in flight, it
    // fires AFTER the switch and would otherwise overwrite the new Typst tab's
    // content with the previous document's markdown. Since Editor/SourceEditor
    // are never mounted while a Typst tab is active, any call here in that
    // state is necessarily stale — drop it.
    if (activeTypstTab) return;
    content = newContent;
  }

  /** File → Export dispatch. The menu is shared by both document flavors: a
   *  markdown tab uses the existing markdown-it / DOM-screenshot pipeline,
   *  while a `.typ` tab compiles the same format through the Typst engine. */
  function handleExport(format: ExportFormat) {
    if (activeTypstTab) {
      exportTypstSource(format, getCurrentContent, { onToast: showToast });
    } else {
      exportDocument(getCurrentContent, format);
    }
  }

  /** Export → "PDF (Typst)": markdown-only entry that routes the current
   *  markdown through cmarker for true typesetting. Typst tabs already get
   *  native typeset output from the regular PDF item, so this is hidden there. */
  function handleExportTypstPdf() {
    exportTypstPdf(getCurrentContent, { onToast: showToast });
  }

  /** Typst source edits: keep `content` + editorStore in sync so Save /
   *  dirty-tracking / tab-switch persistence work against the .typ file. */
  function handleTypstContentChange(newContent: string) {
    content = newContent;
    editorStore.setDirtyContent(true, newContent);
  }

  async function handleAddReview(selectedText: string, contextBefore: string, contextAfter: string) {
    if (!selectedText) {
      showToast($t('review.select_text_first'), 'error');
      return;
    }
    const editorState = editorStore.getState();
    const filePath = editorState.currentFilePath;
    if (!filePath) return;

    const kb = filesStore.getActiveKnowledgeBase?.();
    if (!kb?.git) {
      showToast($t('review.not_git_bound'), 'error');
      return;
    }

    const kbRoot = kb.path;

    const { gitHeadCommit } = await import('$lib/services/git');
    let commitHash = '';
    try { commitHash = await gitHeadCommit(kbRoot); } catch { /* no commits yet */ }

    const docText = getCurrentContent();
    const markedIdx = docText.indexOf(selectedText);
    const originalLine = markedIdx >= 0
      ? (docText.slice(0, markedIdx).match(/\n/g) || []).length + 1
      : 1;

    const anchor = {
      commitHash,
      markedText: selectedText,
      contextBefore: contextBefore.slice(-50),
      contextAfter: contextAfter.slice(0, 50),
      originalLine,
    };

    // If review panel is waiting for a text selection to re-anchor, route there instead.
    if (reviewPanelRef?.getIsReanchoring()) {
      reviewPanelRef.confirmReanchor(anchor);
      return;
    }

    const { createReview } = await import('$lib/services/review/review-service');
    const review = createReview(selfName, selfEmail, anchor, '');

    try {
      await reviewStore.addReview(review);
      showReviewPanel = true;
      showAIPanel = false;
      reviewStore.setActive(review.id);
    } catch (e) {
      showToast(String(e), 'error');
    }
  }

  function handleJumpToReview(reviewId: string) {
    reviewStore.setActive(reviewId);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-review-id="${reviewId}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
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
      // Typst tab: emit `#image("src")` / `#figure(…)` into the .typ source. A
      // blob: URL would not survive a compile, so keep the original path.
      if (activeTypstTab) {
        typstEditorRef?.runAction({ type: 'image', src: data.src, alt: data.alt || undefined });
        return;
      }
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

  // ── Cloud Resource Insert ─────────────────────────────

  /**
   * Resolve a media item to a playable URL, fetching the detail endpoint
   * if the listing response didn't include one. Picora's `/v1/media` listing
   * may omit `playbackUrl` for performance; the detail endpoint always has it.
   *
   * Returns `{ url, error }`. When `url` is empty, `error` describes why so
   * the caller can surface a useful toast instead of a generic "missing URL".
   */
  async function resolveMediaUrl(item: UnifiedMediaItem): Promise<{ url: string; error?: string }> {
    const direct = item.playbackUrl ?? item.url ?? '';
    if (direct) return { url: direct };
    if (item.status && item.status !== 'ready') {
      return { url: '', error: `media not ready (status=${item.status})` };
    }
    const target = settingsStore.getDefaultPicoraTarget?.();
    if (!target) return { url: '', error: 'no Picora target configured' };
    try {
      const apiBase = picoraApiBaseFromUploadUrl(target.picoraApiUrl);
      const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
      const apiKey = await getPicoraApiKey(target);
      const detail = await getMediaDetail(apiBase, apiKey, item.type, item.id);
      const u = detail.playbackUrl ?? detail.url ?? '';
      if (u) return { url: u };
      // Fallback diagnostic: list the keys actually present in the detail
      // response so we can see WHICH fields Picora populated (e.g. streamUrl,
      // mp4Url, sources[]). Skips obviously-not-URL keys for brevity.
      const keys = Object.keys(detail as unknown as Record<string, unknown>)
        .filter(k => k !== 'tags' && k !== 'mimeType')
        .join(', ');
      return { url: '', error: `no URL in detail (status=${detail.status ?? 'unknown'}; keys=${keys})` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { url: '', error: `detail fetch failed: ${msg}` };
    }
  }

  async function handleCloudInsert(items: UnifiedMediaItem[], asHtml: boolean, pos?: number) {
    // Typst tab: images map to `#image("url")`. Audio/video have no Typst
    // counterpart (it is a print format), so those menu items are disabled for
    // Typst documents — see FLAVOR_MENU_GATES.
    if (activeTypstTab) {
      for (const item of items) {
        if (item.type !== 'image') continue;
        typstEditorRef?.runAction({
          type: 'image',
          src: item.url ?? '',
          alt: item.title ?? item.filename,
        });
      }
      return;
    }
    const mode = editorStore.getState().editorMode;
    if (mode === 'source') {
      // Insert as text into source textarea
      const snippets = items.map(item => {
        if (item.type === 'audio') {
          // Picora returns the playable URL as `playbackUrl` for audio (same as video).
          // Fall back to `url` for legacy/transitional shapes.
          const src = item.playbackUrl ?? item.url ?? '';
          return `<audio src="${src}" controls preload="metadata"></audio>`;
        }
        if (item.type === 'video') {
          const src = item.playbackUrl ?? item.url ?? '';
          const poster = item.thumbnailUrl ? ` poster="${item.thumbnailUrl}"` : '';
          return `<video src="${src}" controls preload="metadata"${poster}></video>`;
        }
        // image
        const url = item.url ?? '';
        const alt = item.title ?? item.filename;
        if (asHtml) return `<img src="${url}" alt="${alt}">`;
        return `![${alt}](${url})`;
      });
      content = content.trimEnd() + '\n\n' + snippets.join('\n\n') + '\n';
      return;
    }

    // Visual/split mode — use ProseMirror commands
    if (items.length === 0 || !morayaEditor) return;
    const view = morayaEditor.view;
    const insertPos = pos ?? view.state.selection.$from.pos;

    if (items[0].type === 'image') {
      // Multi-image: single transaction
      const { tr } = view.state;
      let cursor = insertPos;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const url = item.url ?? '';
        if (asHtml) {
          const { nodes } = view.state.schema;
          // html_inline schema attribute is `value`, not `content`.
          const htmlNode = nodes.html_inline.create({ value: `<img src="${url}" alt="${item.title ?? item.filename}">` });
          const para = nodes.paragraph.create({}, htmlNode);
          tr.insert(cursor, para);
          cursor += para.nodeSize;
        } else {
          const imgNode = view.state.schema.nodes.image.create({
            src: url,
            alt: item.title ?? item.filename,
            title: item.title ?? '',
          });
          tr.insert(cursor, imgNode);
          cursor += imgNode.nodeSize;
        }
        if (i < items.length - 1) {
          const emptyPara = view.state.schema.nodes.paragraph.create();
          tr.insert(cursor, emptyPara);
          cursor += emptyPara.nodeSize;
        }
      }
      view.dispatch(tr.scrollIntoView());
    } else if (items[0].type === 'audio') {
      // Picora's listing endpoint may omit `playbackUrl`; fetch detail if so.
      const r = await resolveMediaUrl(items[0]);
      if (!r.url) {
        const msg = r.error ? `${$t('cloud_picker.url_missing')} (${r.error})` : $t('cloud_picker.url_missing');
        showToast(msg, 'error');
        return;
      }
      runCmd(insertAudioAt({ src: r.url, title: items[0].title }, insertPos));
    } else if (items[0].type === 'video') {
      const r = await resolveMediaUrl(items[0]);
      if (!r.url) {
        const msg = r.error ? `${$t('cloud_picker.url_missing')} (${r.error})` : $t('cloud_picker.url_missing');
        showToast(msg, 'error');
        return;
      }
      runCmd(insertVideoAt({ src: r.url, poster: items[0].thumbnailUrl, title: items[0].title }, insertPos));
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

      // Count total paragraphs in the current article so we can validate /
      // redistribute targets. Stale caches, bad AI output, or plain-text
      // prompt blocks can all produce duplicate target=0 values → safety net.
      let paraTotal = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() && (i + 1 >= lines.length || !lines[i + 1]?.trim())) paraTotal++;
      }

      const targets = images.map(img => Math.max(0, Math.min(img.target, Math.max(0, paraTotal - 1))));
      const uniqueTargets = new Set(targets);
      const shouldRedistribute = paraTotal >= 2 && uniqueTargets.size < images.length;
      if (shouldRedistribute) {
        // Spread evenly across all paragraphs when images cluster on the
        // same target paragraph (common when prompt generation used truncated
        // content or all targets defaulted to 0).
        const segment = paraTotal / images.length;
        for (let i = 0; i < images.length; i++) {
          targets[i] = Math.min(Math.round(segment * i + segment / 2), paraTotal - 1);
        }
      }

      let paragraphIdx = 0;
      const insertions: Map<number, string[]> = new Map();
      for (let i = 0; i < images.length; i++) {
        const t = targets[i];
        const existing = insertions.get(t) || [];
        existing.push(`![](${images[i].url})`);
        insertions.set(t, existing);
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
    // Background memory auto-sync (focus + interval, debounced; no-op until
    // cloud sync is configured).
    startMemoryAutoSync();
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
    let desktopResizeUnlisten: (() => void) | undefined;
    if (isTauri && !isIPadOS) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
        window.focus();
      });
      // On Windows, WebView2 needs an extra focus nudge after the initial render
      // completes. The first requestAnimationFrame runs before layout settles.
      setTimeout(() => { window.focus(); }, 100);

      // WKWebView on macOS does NOT update `100dvh`/`100vh` continuously while
      // the user drags a window edge — viewport-unit reflow only fires on a
      // few discrete events (initial layout, maximize/zoom toggle, etc.).
      // Mirror `window.innerHeight` into `--app-height` on every resize so
      // the `.app-container`'s flex column honors the px-locked height
      // instead of the stale `100dvh`. The listener can't fire while the JS
      // thread is blocked parsing a huge file — that's an unavoidable
      // limitation; once the parse finishes, the queued resize event will
      // fire and the layout will snap to the correct position.
      const onResize = () => {
        document.documentElement.style.setProperty(
          '--app-height',
          `${window.innerHeight}px`,
        );
      };
      window.addEventListener('resize', onResize);
      desktopResizeUnlisten = () => window.removeEventListener('resize', onResize);
      onResize();
    }

    // Preload enhancement plugins in background (warms cache for editor creation)
    preloadEnhancementPlugins();

    // Warm the SettingsPanel chunk on idle so the first open (menu → 设置 /
    // Cmd+,) is instant. It's dynamically imported at the `{#await}` below, so
    // without this the first click pays the chunk fetch+parse cost — a visible
    // delay before the panel appears. Fire-and-forget; the module cache makes
    // the later `import()` resolve immediately.
    {
      const warmSettings = () => { void import('$lib/components/SettingsPanel.svelte'); };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(warmSettings, { timeout: 2000 });
      } else {
        setTimeout(warmSettings, 400);
      }
    }

    // macOS only: detect stale `/Volumes/Moraya*` DMG mounts left by older
    // downloads and offer to eject. Fire-and-forget — runs after a short
    // delay so the editor mount path stays uncontested. Skipped on
    // non-macOS by the service itself.
    if (isTauri) {
      setTimeout(() => {
        import('$lib/services/dmg-cleanup')
          .then(m => m.maybePromptStaleDmgCleanup())
          .catch(() => { /* best-effort */ });
      }, 1500);
    }

    // Restore persisted settings, AI config, and MCP servers (Tauri-only: uses plugin-store)
    if (isTauri) {
      // Start loading the opened file(s) in PARALLEL with store initialization.
      // File read (IPC) is fast; store init (Tauri plugin-store load × 4) is slow.
      // By the time Promise.all resolves, the file content is already available.
      //
      // The Rust side now returns ALL queued startup paths, not just the first —
      // macOS Finder "Open With" / `open -a Moraya.app *.md` selects multiple
      // files at once, and v0.41.7 silently dropped everything after [0]
      // (issue #65). Order is preserved; we make the LAST one the active tab
      // so the file the user clicked last wins, matching system-app behavior
      // (TextEdit / Preview).
      let openedFilesData: { filePath: string; fileContent: string; fileName: string; mtime: number | null }[] = [];
      const openedFilePromise = invoke<string[]>('get_opened_files').then(async (filePaths) => {
        const paths = [...new Set((filePaths ?? []).filter(Boolean))];
        if (paths.length === 0) return;

        const [loadedFiles, mtimeResult] = await Promise.all([
          Promise.all(paths.map(async (filePath) => ({
            filePath,
            fileContent: await loadFile(filePath),
            fileName: getFileNameFromPath(filePath),
          }))),
          invoke('get_files_mtime', { paths }).catch(() => []) as Promise<[string, number][]>,
        ]);

        const mtimeByPath = new Map((mtimeResult as [string, number][]).map(([p, m]) => [p, m]));
        openedFilesData = loadedFiles.map(file => ({
          ...file,
          mtime: mtimeByPath.get(file.filePath) ?? null,
        }));

        // Auto-open of a large file (double-click an .md → launches Moraya
        // with that path). The editor's parse blocks the JS thread for
        // tens of seconds on multi-MB files. `editorLoadingStore` would
        // normally light up at the start of `syncContent` — but on cold
        // start the editor is still initializing while we sit here, so
        // the user sees a blank window for the early part of the freeze.
        // Surface the indicator as soon as we know there's a big file
        // queued; size is taken from the active (last) file since that's
        // what becomes visible.
        const active = openedFilesData[openedFilesData.length - 1];
        editorLoadingStore.startIfLarge(active.fileContent.length);
      }).catch(() => {});

      Promise.all([initSettingsStore(), initAIStore(), initMCPStore(), filesStore.loadPersistedPrefs(), openedFilePromise])
        .then(async () => {
          // MCP restoration: container manager FIRST, then the general pass.
          // initContainerManager() loads saved dynamic services and connects
          // them itself; running both concurrently would race on
          // `connectServer(id)` and double-spawn stdio processes (the second
          // one orphans the first, hanging future tool calls — which is why
          // saved MCPs worked on install but broke after restart).
          // `connectAllServers` now skips already-connected ids, so this
          // ordering keeps saved services healthy on every launch.
          try {
            await initContainerManager();
          } catch (e) {
            console.warn('[Startup] initContainerManager failed:', e);
          }
          try {
            await connectAllServers();
          } catch (e) {
            console.warn('[Startup] connectAllServers failed:', e);
          }

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

          // Check if file(s) were passed via OS file association on startup.
          // Content is loaded in parallel (see openedFilePromise above);
          // sidebar adjustment needs knowledgeBases to be loaded (which happens
          // in this .then), so we finalize here. The first path replaces the
          // initial empty tab; any additional paths open as new tabs. The
          // LAST file becomes active (matches macOS multi-select expectation).
          if (openedFilesData.length > 0) {
            const [firstFile, ...additionalFiles] = openedFilesData;
            tabsStore.initWithContent(firstFile.fileContent, firstFile.filePath, firstFile.fileName);
            if (firstFile.mtime !== null) {
              const state = tabsStore.getState();
              tabsStore.updateTabMtime(state.activeTabId, firstFile.mtime);
            }

            let activeFile = firstFile;
            for (const file of additionalFiles) {
              tabsStore.openFileTab(
                file.filePath, file.fileName, file.fileContent, file.mtime, true,
              );
              activeFile = file;
            }

            const { filePath, fileContent, fileName } = activeFile;
            content = fileContent;
            currentFileName = fileName;
            editorStore.batchRestore({
              filePath, content: fileContent, isDirty: false, cursorOffset: 0, scrollFraction: 0,
            });
            replaceContentAndScrollToTop(fileContent);
            resetWorkflowState();
            adjustSidebarForFile(filePath);
          }

          // Cold-start hydration gate: the OS-handed file (if any) has now
          // been applied. If no file was handed in, this just flips on
          // store-load completion, which is the natural splash dismiss
          // point for a "new empty doc" launch. The companion gate
          // (`editorReadyForSplash`) is flipped by `handleEditorReady`;
          // whichever lands last fires the actual dispatch.
          requestAnimationFrame(() => {
            coldStartHydrated = true;
            tryDispatchAppReady();
            // Source-mode / image-preview cold-starts don't mount <Editor>
            // and therefore never fire handleEditorReady. Give the visual
            // path 1.2 s to report in; after that we uncover the app
            // ourselves rather than letting the user wait for the 8 s
            // splash safety net.
            setTimeout(() => {
              if (!appReadyDispatched) forceDispatchAppReady();
            }, 1200);
          });

          // Register KB sync intervals (mode=interval) for all bound KBs
          if (settings.kbSyncEnabled !== false) {
            for (const kb of filesState.knowledgeBases) {
              const binding = kb.picoraBinding;
              if (!binding) continue;
              const target = settings.imageHostTargets.find(t => t.id === binding.picoraTargetId);
              if (!target) continue;
              if (binding.strategy.mode === 'on-startup-and-close') {
                // Run once at startup
                runSync(binding, kb, target, false).catch(() => {});
              } else if (binding.strategy.mode === 'interval') {
                registerKbInterval(binding, kb, target, (report) => {
                  filesStore.updateKbSyncReport(kb.id, {
                    lastSyncAt: new Date().toISOString(),
                    lastSyncReport: report,
                    lastSyncError: null,
                  });
                });
              }
            }
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
        .catch(() => {
          // Init pipeline blew up. We still want the user to see whatever
          // chrome rendered behind the splash — better a half-broken UI
          // they can see than a spinner that hides the breakage.
          forceDispatchAppReady();
        });

      setupAutoSave();

      // v0.68.0: KB sync trash auto-purge — once shortly after startup + every 24h.
      // Deferred so a deep trash tree (recursive walk + remove_dir_all) doesn't
      // block initial render or compete with file-tree load / editor mount.
      const purgeTrashOnce = async () => {
        try {
          const { purgeTrash } = await import('$lib/services/kb-sync/trash');
          await purgeTrash({ olderThanDays: 7 });
        } catch {
          // Trash root may not exist yet; ignore.
        }
      };
      setTimeout(() => { void purgeTrashOnce(); }, 5000);
      trashPurgeTimer = setInterval(purgeTrashOnce, 24 * 60 * 60 * 1000);

      // v0.41.5 (idempotent-floating-bumblebee): push the current shortcut
      // overrides + defaults to the native menu so the menu hints AND
      // accelerators match the user's settings. Defer so it doesn't compete
      // with first-paint and i18n menu label sync.
      setTimeout(async () => {
        try {
          const { pushOverridesToMenu } = await import('$lib/services/menu-sync');
          const overrides = settingsStore.getState().shortcutOverrides ?? {};
          const result = await pushOverridesToMenu(overrides);
          if (result.failed.length > 0) {
            console.warn('[menu-sync] some accelerators failed to apply:', result.failed);
          }
        } catch (e) {
          console.error('[menu-sync] startup sync failed:', e);
        }
      }, 200);

      // v0.69.0: one-shot migration of any plaintext Picora API keys into
      // the OS keychain. Idempotent — targets already flagged are skipped.
      void (async () => {
        try {
          const { migratePicoraKeysToKeychain } = await import('$lib/services/picora/credentials');
          const targets = settingsStore.getState().imageHostTargets ?? [];
          const picoraTargets = targets.filter(t => t.provider === 'picora');
          if (picoraTargets.length === 0) return;
          const { report, migratedIds } = await migratePicoraKeysToKeychain(picoraTargets);
          if (migratedIds.length > 0) {
            const updated = targets.map(t =>
              migratedIds.includes(t.id)
                ? { ...t, picoraApiKey: '', picoraKeyMigratedV069: true }
                : t
            );
            settingsStore.update({ imageHostTargets: JSON.parse(JSON.stringify(updated)) });
            showToast(
              $t('image_host.picora_key_migrated_toast', { count: String(report.migrated) }),
              'success',
            );
          }
          if (report.errors.length > 0) {
            console.warn('[v0.69] Picora key migration errors:', report.errors);
          }
        } catch (e) {
          console.warn('[v0.69] Picora key migration skipped:', e);
        }
      })();
    } else {
      // Non-Tauri (browser dev preview): no Promise.all init runs, so the
      // splash would sit on its 8 s safety timer. Force-dispatch so a
      // `pnpm dev` page boots clean — we don't have an opened file to
      // wait for here and the editor's ready signal is the same as the
      // Tauri path.
      requestAnimationFrame(() => forceDispatchAppReady());
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

    /**
     * Open an embedded legal document (Help → Terms of Service / Privacy
     * Policy) in the editor. Documents ship in English (authoritative) and
     * Simplified Chinese; the zh-CN copy is served for the Chinese locales,
     * every other locale gets English — matching the languages maintained in
     * the legal master (moraya-site/src/content/legal/).
     */
    async function openLegalDocument(doc: 'terms-of-service' | 'privacy-policy') {
      const loc = get(locale);
      const suffix = loc === 'zh-CN' || loc === 'zh-Hant' ? '.zh-CN' : '';
      try {
        const docContent = await invoke<string>('read_resource_file', { name: `${doc}${suffix}.md` });
        content = docContent;
        editorStore.setContent(docContent);
        syncVisualEditor(content);
      } catch {
        // Resource not found
      }
    }

    if (isTauri) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const menuHandlers: Record<string, (payload?: any) => void> = {
        // File
        'menu:file_new': () => handleNewFile(),
        'menu:file_new_typst': () => handleNewTypstFile(),
        'menu:file_convert_typst': () => handleConvertFlavor(),
        'menu:file_new_window': () => isIPadOS ? handleNewFile() : invoke('create_new_window').catch(e => { console.error('[NewWindow] create_new_window failed:', e); }),
        'menu:file_open': () => handleOpenFile(),
        'menu:file_save': () => handleSave(),
        'menu:file_save_as': () => handleSave(true),
        // Pass `getCurrentContent` as a function (not its return value) so the
        // save dialog can appear immediately. Markdown serialization for huge
        // docs takes seconds-to-minutes; calling it eagerly here would block
        // the main thread and delay the dialog by that long.
        'menu:file_export_html': () => handleExport('html'),
        'menu:file_export_pdf': () => handleExport('pdf'),
        'menu:file_export_typst_pdf': () => handleExportTypstPdf(),
        'menu:file_export_image': () => handleExport('image'),
        'menu:file_export_doc': () => handleExport('doc'),
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
        // Select All: context-aware (Typst source vs code block vs doc vs source textarea)
        'menu:edit_select_all': () => {
          // A Typst tab renders its own textarea (`.typst-source-input`), which
          // the `.source-textarea` query below never matches — so route it first.
          if (activeTypstTab) { typstEditorRef?.selectAll(); return; }
          if (editorMode === 'source' || (editorMode === 'split' && isSourcePaneFocused())) {
            // Source mode: select all textarea content
            const ta = document.querySelector('.source-textarea') as HTMLTextAreaElement | null;
            if (ta) { ta.focus(); ta.select(); }
          } else {
            // Visual mode: code block local select or whole-doc select
            const view = morayaEditor?.view;
            if (!view) return;
            view.focus();
            const resolvedFrom = view.state.selection.$from;
            for (let d = resolvedFrom.depth; d > 0; d--) {
              if (resolvedFrom.node(d).type.name === 'code_block') {
                const tr = view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, resolvedFrom.start(d), resolvedFrom.end(d))
                );
                view.dispatch(tr);
                return;
              }
            }
            // Whole-doc AllSelection. On macOS the Cmd+A menu accelerator ALSO
            // mutates the native DOM selection; ProseMirror's DOM observer can
            // re-sync a tick later and COLLAPSE our AllSelection, so it never
            // visibly selects. Flush pending DOM mutations, assert AllSelection,
            // then re-assert on the next frame to win that race.
            const selectWholeDoc = () => {
              const v = morayaEditor?.view;
              if (!v) return;
              try { (v as unknown as { domObserver?: { flush?: () => void } }).domObserver?.flush?.(); } catch { /* internal API */ }
              v.dispatch(v.state.tr.setSelection(new AllSelection(v.state.doc)));
            };
            selectWholeDoc();
            requestAnimationFrame(selectWholeDoc);
          }
        },
        // Edit — search
        'menu:edit_find': () => { showSearch = true; },
        'menu:edit_replace': () => { showSearch = true; showReplace = true; },
        // Paragraph
        'menu:para_h1': () => runSharedAction('h1'),
        'menu:para_h2': () => runSharedAction('h2'),
        'menu:para_h3': () => runSharedAction('h3'),
        'menu:para_h4': () => runSharedAction('h4'),
        'menu:para_h5': () => runSharedAction('h5'),
        'menu:para_h6': () => runSharedAction('h6'),
        'menu:para_table': () => runSharedAction('table'),
        'menu:para_code_block': () => runSharedAction('codeBlock'),
        'menu:para_math_block': () => runSharedAction('mathBlock'),
        'menu:para_quote': () => runSharedAction('quote'),
        'menu:para_bullet_list': () => runSharedAction('bulletList'),
        'menu:para_ordered_list': () => runSharedAction('orderedList'),
        'menu:para_task_list': () => runCmd(wrapInTaskList),

        'menu:para_hr': () => runSharedAction('horizontalRule'),
        // Format
        'menu:fmt_bold': () => runSharedAction('bold'),
        'menu:fmt_italic': () => runSharedAction('italic'),
        'menu:fmt_strikethrough': () => runSharedAction('strike'),
        'menu:fmt_code': () => runSharedAction('inlineCode'),
        'menu:fmt_link': () => runSharedAction('link'),
        'menu:fmt_image': () => { showImageDialog = true; },
        'menu:insert_cloud_image': () => { cloudPickerState = { kind: 'image', pos: null }; },
        'menu:insert_cloud_audio': () => { cloudPickerState = { kind: 'audio', pos: null }; },
        'menu:insert_cloud_video': () => { cloudPickerState = { kind: 'video', pos: null }; },
        // View — editor modes. Two-axis model:
        //   • Visual/Source is one mutex axis (the "base" mode)
        //   • Split is independent (the "layout" axis)
        // The native accelerator (Cmd+/) is owned by the Visual Mode
        // CheckMenuItem, so this handler MUST implement the TOGGLE
        // behaviour the user asked for — pressing Cmd+/ flips
        // visual ↔ source regardless of which side they're on. A
        // user mouse-click on the item routes here too; we lean on
        // the fact that the checked item shows current state, so
        // clicking it semantically reads as "switch off this one /
        // switch to the other". Both items therefore share the same
        // toggle handler; the menu sync $effect re-projects the
        // correct checkmark afterwards.
        'menu:view_mode_visual': () => {
          const newBase: 'visual' | 'source' = lastSingleMode === 'visual' ? 'source' : 'visual';
          editorStore.setLastSingleMode(newBase);
          if (editorMode !== 'split') {
            editorMode = newBase;
            editorStore.setEditorMode(newBase);
          }
        },
        'menu:view_mode_source': () => {
          // Source item has no accelerator (Cmd+/ is on Visual), but a
          // mouse click on Source should still flip the base — the
          // mutex semantics are about the PAIR, not the individual item.
          const newBase: 'visual' | 'source' = lastSingleMode === 'visual' ? 'source' : 'visual';
          editorStore.setLastSingleMode(newBase);
          if (editorMode !== 'split') {
            editorMode = newBase;
            editorStore.setEditorMode(newBase);
          }
        },
        'menu:view_mode_split': () => {
          // Cmd+Shift+/ or click — toggle the layout axis. Exit always
          // returns to lastSingleMode (NOT hardcoded visual) so a user
          // who entered split from source comes back to source.
          const next: EditorMode = editorMode === 'split' ? lastSingleMode : 'split';
          editorMode = next;
          editorStore.setEditorMode(next);
        },
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
        'menu:help_terms': () => openLegalDocument('terms-of-service'),
        'menu:help_privacy': () => openLegalDocument('privacy-policy'),
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
        const message = $t('ai.prompts.mcp_tool_prompt', { toolName: tool.name, serverName: server.serverName });
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

      // Helper: load a file by path and open in a tab.
      // Used for both OS file-association events and any programmatic open.
      // Bumps fileSelectSerial so a stale in-flight sidebar/menu-open
      // operation can't land on top of this open (Windows path: a double-
      // click that arrives as an `open-file` event mid-pickup of an earlier
      // file would otherwise interleave the two flows and leave the editor
      // in a wedged state).
      async function openFileByPath(filePath: string) {
        const mySerial = ++fileSelectSerial;
        // Sync current tab so its editor state is captured before switching.
        tabsStore.syncFromEditor();
        const fileContent = await loadFile(filePath);
        if (mySerial !== fileSelectSerial) return;
        const fileName = getFileNameFromPath(filePath);
        let mtime: number | null = null;
        try {
          const result = await invoke('get_files_mtime', { paths: [filePath] }) as [string, number][];
          if (result.length > 0) mtime = result[0][1];
        } catch { /* ignore */ }
        if (mySerial !== fileSelectSerial) return;
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
        flavor?: 'markdown' | 'typst' | null;
      } | null>('get_pending_tab').then(async (tabData) => {
        if (!tabData) return;
        content = tabData.content;
        // Fall back to extension detection when the payload predates `flavor`.
        const flavor = tabData.flavor ?? (tabData.file_name && isTypstFile(tabData.file_name) ? 'typst' : 'markdown');
        tabsStore.initWithContent(tabData.content, tabData.file_path, tabData.file_name, flavor);
        editorStore.batchRestore({
          filePath: tabData.file_path,
          content: tabData.content,
          isDirty: tabData.is_dirty,
          cursorOffset: tabData.cursor_offset,
          scrollFraction: tabData.scroll_fraction,
        });
        currentFileName = tabData.file_name;
        // A Typst tab mounts TypstEditor, not ProseMirror — the markdown
        // replace pipeline would be a no-op at best.
        if (flavor !== 'typst') await replaceContentAndScrollToTop(tabData.content);
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
        flavor?: 'markdown' | 'typst' | null;
      } }>('tab-transfer', async (event) => {
        const td = event.payload.tabData;
        const insertIdx = externalDropIndex >= 0 ? externalDropIndex : tabs.length;
        externalDropIndex = -1;
        // Sync current visual editor content to editorStore before insertTabAt calls syncFromEditor
        // (in visual-only mode, editorStore.content is stale)
        const freshContent = getCurrentContent();
        editorStore.setContent(freshContent);
        tabsStore.insertTabAt(
          insertIdx, td.file_path, td.file_name, td.content, td.is_dirty, td.last_mtime,
          // Same reason as the detach payload: an unsaved Typst document has no
          // `.typ` path for the receiver to infer the flavor from.
          td.flavor ?? undefined,
        );
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
      if (trashPurgeTimer) clearInterval(trashPurgeTimer);
      menuUnlisteners.forEach(unlisten => unlisten());
      openFileUnlisten?.();
      dragDropUnlisten?.();
      tabTransferUnlisten?.();
      tabDragHoverUnlisten?.();
      tabDragEndUnlisten?.();
      focusUnlisten?.();
      vvUnlisten?.();
      desktopResizeUnlisten?.();
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
      <Sidebar
        onFileSelect={handleFileSelect}
        onRename={handleFileRename}
        onOpenKBManager={() => showKBManager = true}
        onOpenSettings={(tab) => { settingsInitialTab = tab as any; showSettings = true; }}
        currentFileLock={currentFileLock}
        selfName={selfName}
        onForceUnlock={async () => {
          const edState = editorStore.getState();
          const curPath = edState.currentFilePath;
          if (!curPath) return;
          const kb = filesStore.getActiveKnowledgeBase?.();
          if (!kb?.git) return;
          const rp = curPath.startsWith(kb.path + '/') ? curPath.slice(kb.path.length + 1) : curPath;
          const { forceUnlock } = await import('$lib/services/review');
          await forceUnlock(kb.path, rp, kb);
          currentFileLock = null;
        }}
        onViewReadonly={() => { /* treat as read-only view */ }}
        onNotify={showToast}
      />
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
      {:else if activeTypstTab}
        <!-- Typst authoring: source + live compiled preview (mutually exclusive
             with the markdown ProseMirror editor). -->
        <TypstEditor bind:this={typstEditorRef} bind:content {editorMode} readOnly={editorReadOnly} onContentChange={handleTypstContentChange} />
      {:else if editorMode === 'visual'}
        <Editor bind:this={visualEditorRef} bind:content {showOutline} {outlineWidth} readOnly={editorReadOnly} skipDestroyFlush={activeTypstTab !== null} onEditorReady={handleEditorReady} onNotify={showToast} onOutlineWidthChange={(w) => settingsStore.update({ outlineWidth: w })} onWorkflowSEO={handleWorkflowSEO} onWorkflowImageGen={handleWorkflowImageGen} onWorkflowPublish={handleWorkflowPublish} onForceShowAIPanel={() => { showAIPanel = true; }} onAddReview={handleAddReview} onInsertCloudImage={(pos) => { cloudPickerState = { kind: 'image', pos }; }} onInsertCloudAudio={(pos) => { cloudPickerState = { kind: 'audio', pos }; }} onInsertCloudVideo={(pos) => { cloudPickerState = { kind: 'video', pos }; }} />
      {:else if editorMode === 'source'}
        <SourceEditor bind:this={sourceEditorRef} bind:content {showOutline} {outlineWidth} {showBlame} {blameData} readOnly={editorReadOnly} onContentChange={handleContentChange} onOutlineWidthChange={(w) => settingsStore.update({ outlineWidth: w })} />
      {:else if editorMode === 'split'}
        <div class="split-container">
          <div class="split-source" bind:this={splitSourceEl}>
            <SourceEditor bind:this={splitSourceRef} bind:content readOnly={editorReadOnly} onContentChange={handleContentChange} hideScrollbar />
          </div>
          <div class="split-visual" bind:this={splitVisualEl}>
            <Editor bind:this={splitVisualRef} bind:content readOnly={editorReadOnly} skipDestroyFlush={activeTypstTab !== null} onEditorReady={handleEditorReady} onContentChange={handleContentChange} onNotify={showToast} onWorkflowSEO={handleWorkflowSEO} onWorkflowImageGen={handleWorkflowImageGen} onWorkflowPublish={handleWorkflowPublish} onCursorLineChange={(line) => splitSourceRef?.setHighlightLine(line)} onForceShowAIPanel={() => { showAIPanel = true; }} />
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

    {#if showReviewPanel}
      {#await import('$lib/components/ReviewPanel.svelte') then { default: ReviewPanelComp }}
        <div class="review-panel-outer">
          <div class="review-panel-header">
            <span class="review-panel-title">{$t('review.panel_title')}</span>
            <button class="review-panel-close" onclick={() => { showReviewPanel = false; }} aria-label="Close">✕</button>
          </div>
          <ReviewPanelComp
            bind:this={reviewPanelRef}
            kb={filesStore.getActiveKnowledgeBase?.() ?? null}
            {editorMode}
            onJumpToReview={handleJumpToReview}
            onOpenGitBind={() => showKBManager = true}
            onShowAIPanel={() => { showAIPanel = true; }}
          />
        </div>
      {/await}
    {/if}

    <!-- v0.32.0: History Panel -->
    {#if showHistoryPanel}
      {#await import('$lib/components/HistoryPanel.svelte') then { default: HistoryPanelComp }}
        <div class="review-panel-outer">
          <div class="review-panel-header">
            <span class="review-panel-title">{$t('history.tab_label')}</span>
            <button class="review-panel-close" onclick={() => { showHistoryPanel = false; }} aria-label="Close">✕</button>
          </div>
          <HistoryPanelComp
            kb={filesStore.getActiveKnowledgeBase?.() ?? null}
            filePath={editorStore.getState().currentFilePath}
            {editorMode}
            {showBlame}
            onOpenDiff={(leftHash, rightHash) => {
              // v0.32.1 §F2: dirty confirmation before entering DiffView
              if (editorStore.getState().isDirty) {
                const proceed = confirm($t('history.dirty_confirm'));
                if (!proceed) return;
              }
              // v0.32.1 §F2: Visual → Source switch (DiffView is line-based)
              if (editorMode === 'visual') {
                prevEditorMode = editorMode;
                editorMode = 'source';
                editorStore.setEditorMode('source');
              }
              diffViewState = { leftHash, rightHash };
            }}
            onToggleBlame={async () => {
              showBlame = !showBlame;
              if (showBlame) {
                const kb = filesStore.getActiveKnowledgeBase?.() ?? null;
                const fp = editorStore.getState().currentFilePath;
                if (kb && fp && fp.startsWith(kb.path)) {
                  const rel = fp.slice(kb.path.length).replace(/^\//, '');
                  try {
                    const { gitBlame } = await import('$lib/services/git');
                    blameData = await gitBlame(kb.path, rel);
                  } catch {
                    blameData = [];
                  }
                }
              } else {
                blameData = [];
              }
            }}
            onOpenGitBind={() => showKBManager = true}
          />
        </div>
      {/await}
    {/if}

    <!-- v0.32.0: Diff View overlay -->
    {#if diffViewState}
      {@const kb = filesStore.getActiveKnowledgeBase?.() ?? null}
      {@const fp = editorStore.getState().currentFilePath}
      {#if kb && fp && fp.startsWith(kb.path)}
        {#await import('$lib/components/DiffView.svelte') then { default: DiffViewComp }}
          <DiffViewComp
            kbPath={kb.path}
            relPath={fp.slice(kb.path.length).replace(/^\//, '')}
            leftHash={diffViewState.leftHash}
            rightHash={diffViewState.rightHash}
            currentContent={content}
            onClose={() => {
              diffViewState = null;
              // v0.32.1 §F2: restore prior editor mode (only if we forced visual→source)
              if (prevEditorMode && prevEditorMode !== editorMode) {
                editorMode = prevEditorMode;
                editorStore.setEditorMode(prevEditorMode);
                prevEditorMode = null;
              }
            }}
          />
        {/await}
      {/if}
    {/if}
  </div>

  {#if showTouchToolbar && editorMode !== 'source'}
    <TouchToolbar onCommand={handleTouchCommand} />
  {/if}

  <StatusBar
    onShowUpdateDialog={() => showUpdateDialog = true}
    onToggleAI={() => showAIPanel = !showAIPanel}
    onModeChange={(mode) => { editorMode = mode; editorStore.setEditorMode(mode); }}
    onGitSync={gitBound ? handleGitSync : undefined}
    onShowConflicts={() => { conflictKbId = filesStore.getState().activeKnowledgeBaseId; }}
    onToggleVersionHistory={toggleVersionHistory}
    {versionHistoryAvailable}
    currentMode={editorMode}
    docFlavor={activeTypstTab ? 'typst' : 'markdown'}
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

{#if conflictKbId}
  {@const conflictKb = filesStore.getState().knowledgeBases.find(k => k.id === conflictKbId)}
  {#if conflictKb?.picoraBinding}
    {#await import('$lib/components/KbSyncConflictPanel.svelte') then { default: KbSyncConflictPanel }}
      <KbSyncConflictPanel
        kb={conflictKb}
        binding={conflictKb.picoraBinding}
        conflicts={kbSyncStates.get(conflictKbId)?.pendingConflicts ?? []}
        onClose={() => { conflictKbId = null; }}
      />
    {/await}
  {/if}
{/if}

{#if showVersionHistory}
  {@const vhFilePath = editorStore.getState().currentFilePath}
  {#if vhFilePath}
    {#await import('$lib/components/VersionHistorySheet.svelte') then { default: VersionHistorySheet }}
      <VersionHistorySheet
        filePath={vhFilePath}
        fileName={getFileNameFromPath(vhFilePath)}
        onClose={() => { showVersionHistory = false; }}
        onRestored={handleVersionRestored}
        onOpenVersion={handleOpenVersion}
      />
    {/await}
  {/if}
{/if}

{#if showImageDialog}
  {#await import('$lib/components/ImageInsertDialog.svelte') then { default: ImageInsertDialog }}
    <ImageInsertDialog
      onInsert={handleInsertImage}
      onClose={() => showImageDialog = false}
    />
  {/await}
{/if}

{#if cloudPickerState?.kind === 'image'}
  {#await import('$lib/components/cloud-resource/CloudImagePicker.svelte') then { default: CloudImagePicker }}
    <CloudImagePicker
      targetPos={cloudPickerState.pos ?? undefined}
      onInsert={handleCloudInsert}
      onClose={() => { cloudPickerState = null; }}
    />
  {/await}
{:else if cloudPickerState?.kind === 'audio'}
  {#await import('$lib/components/cloud-resource/CloudAudioPicker.svelte') then { default: CloudAudioPicker }}
    <CloudAudioPicker
      targetPos={cloudPickerState.pos ?? undefined}
      onInsert={handleCloudInsert}
      onClose={() => { cloudPickerState = null; }}
    />
  {/await}
{:else if cloudPickerState?.kind === 'video'}
  {#await import('$lib/components/cloud-resource/CloudVideoPicker.svelte') then { default: CloudVideoPicker }}
    <CloudVideoPicker
      targetPos={cloudPickerState.pos ?? undefined}
      onInsert={handleCloudInsert}
      onClose={() => { cloudPickerState = null; }}
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

{#if showPromptPalette}
  {#await import('$lib/components/PromptPalette.svelte') then { default: PromptPalette }}
    <PromptPalette
      onClose={() => showPromptPalette = false}
      onInsertToEditor={(text) => runCmd(insertTextAtCursor(text))}
      onToast={(msg) => showToast(msg, 'success')}
      activeFilePath={editorStore.getState().currentFilePath}
    />
  {/await}
{/if}

<!-- Always mounted: listens for moraya:// deep-link payloads + manual-import events. -->
{#await import('$lib/components/PicoraImportDialog.svelte') then { default: PicoraImportDialog }}
  <PicoraImportDialog onToast={showToast} />
{/await}

{#if publishProgress.length > 0}
  <div class="publish-progress">
    <div class="progress-title">{$t('publish.progress_title')}</div>
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
            {$t('publish.progress_publishing')}
          {:else if item.status === 'rss'}
            {$t('publish.progress_rss')}
          {:else if item.status === 'done'}
            {$t('publish.progress_done')}
          {:else}
            {item.message || $t('publish.progress_failed')}
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

  .review-panel-outer {
    width: 320px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color);
    background: var(--bg-primary);
    overflow: hidden;
  }

  .review-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-color);
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    flex-shrink: 0;
  }

  :global(.platform-macos) .review-panel-outer {
    padding-top: 28px;
  }

  .review-panel-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .review-panel-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    padding: 2px 4px;
    border-radius: 3px;
    line-height: 1;
  }
  .review-panel-close:hover { color: var(--text-primary); background: var(--bg-hover); }

  :global(.platform-macos) .app-body > :global(.ai-panel) {
    padding-top: 28px;
  }

  .app-body {
    display: flex;
    flex: 1;
    /* Flex items default to `min-height: auto`, which means they refuse to
       shrink below their content's intrinsic height. With a tiny doc that
       doesn't matter, but once a multi-MB markdown file is loaded the
       editor's intrinsic height balloons and `.app-body` stops shrinking
       on window resize — the trailing `.statusbar` then gets pushed past
       `.app-container`'s bottom edge and clipped by its `overflow: hidden`.
       Setting `min-height: 0` lets flex distribute height correctly
       regardless of content size, so the StatusBar always hugs the
       window's bottom edge. */
    min-height: 0;
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

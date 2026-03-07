/**
 * CodeBlock NodeView — adds a toolbar with language label, language picker, and copy button.
 *
 * Uses Milkdown $view to replace the default <pre> rendering for code_block nodes.
 * Works alongside the highlight.ts decoration plugin (which still applies hljs classes
 * to the inner <code> contentDOM).
 */

import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import type { renderMermaid as RenderFn, updateMermaidTheme as UpdateThemeFn } from './mermaid-renderer';
import { RENDERER_PLUGINS } from '$lib/services/plugin/renderer-registry';
import { loadRendererPlugin } from '$lib/services/plugin/renderer-loader';
import rendererVersions from '$lib/services/plugin/renderer-versions.json';

function getRendererCdnUrl(npmPackage: string, cdnUrl: string): string {
  const ver = (rendererVersions as Record<string, string>)[npmPackage] ?? 'latest';
  return cdnUrl.replaceAll('{version}', ver);
}

function findRendererPlugin(lang: string) {
  return RENDERER_PLUGINS.find((p) => p.languages.includes(lang));
}

// ── Mermaid lazy-load wrapper ─────────────────────

type MermaidApi = { renderMermaid: typeof RenderFn; updateMermaidTheme: typeof UpdateThemeFn };
let mermaidApi: MermaidApi | null = null;
let mermaidLoading: Promise<MermaidApi | null> | null = null;

function loadMermaidApi() {
  if (mermaidApi) return Promise.resolve(mermaidApi);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = import('./mermaid-renderer').then(mod => {
    mermaidApi = mod;
    return mermaidApi;
  });
  return mermaidLoading;
}

// Theme change listener: re-render all mermaid previews when theme switches
let themeObserverInstalled = false;
const mermaidReRenderCallbacks = new Set<() => void>();

function installThemeObserver() {
  if (themeObserverInstalled) return;
  themeObserverInstalled = true;
  const observer = new MutationObserver(() => {
    if (mermaidApi) mermaidApi.updateMermaidTheme();
    for (const cb of mermaidReRenderCallbacks) cb();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

// ── Language registry ─────────────────────────────

interface LanguageEntry {
  id: string;       // primary id used in node.attrs.language
  label: string;    // display name
  aliases: string[]; // searchable aliases
}

const POPULAR_LANGUAGES: LanguageEntry[] = [
  { id: 'javascript', label: 'JavaScript', aliases: ['js'] },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts'] },
  { id: 'python', label: 'Python', aliases: ['py'] },
  { id: 'java', label: 'Java', aliases: [] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'c', label: 'C', aliases: [] },
  { id: 'cpp', label: 'C++', aliases: ['c++'] },
  { id: 'ruby', label: 'Ruby', aliases: ['rb'] },
  { id: 'php', label: 'PHP', aliases: [] },
  { id: 'swift', label: 'Swift', aliases: [] },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt'] },
  { id: 'sql', label: 'SQL', aliases: [] },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'shell'] },
  { id: 'json', label: 'JSON', aliases: [] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
  { id: 'html', label: 'HTML', aliases: ['xml'] },
  { id: 'css', label: 'CSS', aliases: [] },
  { id: 'markdown', label: 'Markdown', aliases: ['md'] },
  // AI-editor first-class labels
  { id: 'text', label: 'Plain Text', aliases: ['plaintext', 'txt'] },
  { id: 'prompt', label: 'Prompt', aliases: ['image-prompts', 'image-prompt'] },
  { id: 'system', label: 'System Prompt', aliases: ['system-prompt'] },
];

// Renderer plugin languages — shown in a separate "Renderer Plugins" group
const RENDERER_PLUGIN_LANGUAGES: LanguageEntry[] = RENDERER_PLUGINS.flatMap((p) =>
  p.languages.map((lang, i) => ({
    id: lang,
    label: i === 0 ? p.name : `${p.name} (${lang})`,
    aliases: i === 0 ? p.languages.slice(1) : [],
  }))
);

const ALL_LANGUAGES: LanguageEntry[] = [
  ...POPULAR_LANGUAGES,
  { id: 'scss', label: 'SCSS', aliases: [] },
  { id: 'lua', label: 'Lua', aliases: [] },
  { id: 'diff', label: 'Diff', aliases: [] },
  { id: 'mermaid', label: 'Mermaid', aliases: [] },
  ...RENDERER_PLUGIN_LANGUAGES,
].sort((a, b) => a.label.localeCompare(b.label));

const RENDERER_LANG_IDS = new Set(RENDERER_PLUGINS.flatMap((p) => p.languages));

const POPULAR_IDS = new Set(POPULAR_LANGUAGES.map(l => l.id));

function findLanguageLabel(langId: string): string {
  if (!langId) return 'text';
  const entry = ALL_LANGUAGES.find(
    l => l.id === langId || l.aliases.includes(langId),
  );
  return entry ? entry.label : langId;
}

// ── Auto-detect language via highlight.js ─────────

let hljsAutoDetect: ((code: string) => string | null) | null = null;

// Lazy-load hljs for auto-detection (reuses the already-loaded highlight plugin)
async function getAutoDetect(): Promise<(code: string) => string | null> {
  if (hljsAutoDetect) return hljsAutoDetect;
  try {
    const hljs = (await import('highlight.js/lib/core')).default;
    hljsAutoDetect = (code: string) => {
      if (!code.trim() || code.length < 10) return null;
      try {
        const result = hljs.highlightAuto(code);
        // Only suggest if confidence is reasonable (relevance > 5)
        if (result.language && result.relevance > 5) {
          return result.language;
        }
      } catch { /* ignore */ }
      return null;
    };
  } catch {
    hljsAutoDetect = () => null;
  }
  return hljsAutoDetect;
}

// ── Language Picker ───────────────────────────────

function createLanguagePicker(
  container: HTMLElement,
  anchor: HTMLElement,
  currentLang: string,
  codeContent: string,
  onSelect: (lang: string) => void,
  onDismiss?: () => void,
): { destroy: () => void } {
  const picker = document.createElement('div');
  picker.className = 'code-lang-picker';
  picker.setAttribute('contenteditable', 'false');

  // Search input
  const searchWrap = document.createElement('div');
  searchWrap.className = 'code-lang-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'code-lang-search-input';
  searchInput.placeholder = 'Search language...';
  searchWrap.appendChild(searchInput);
  picker.appendChild(searchWrap);

  // Options list
  const listEl = document.createElement('div');
  listEl.className = 'code-lang-list';
  picker.appendChild(listEl);

  // Auto-detected suggestion
  let detectedLang: string | null = null;

  function renderList(filter: string) {
    listEl.innerHTML = '';
    const lowerFilter = filter.toLowerCase();

    const matchesFilter = (entry: LanguageEntry) => {
      if (!lowerFilter) return true;
      return (
        entry.id.includes(lowerFilter) ||
        entry.label.toLowerCase().includes(lowerFilter) ||
        entry.aliases.some(a => a.includes(lowerFilter))
      );
    };

    // Show auto-detected suggestion at top
    if (detectedLang && !lowerFilter && detectedLang !== currentLang) {
      const label = findLanguageLabel(detectedLang);
      const suggestEl = document.createElement('div');
      suggestEl.className = 'code-lang-suggestion';
      suggestEl.innerHTML = `<span class="suggestion-icon">✦</span> ${label} <span class="suggestion-hint">detected</span>`;
      suggestEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect(detectedLang!);
        destroy();
      });
      listEl.appendChild(suggestEl);

      const divider = document.createElement('div');
      divider.className = 'code-lang-divider';
      listEl.appendChild(divider);
    }

    // Popular group
    const popularMatches = POPULAR_LANGUAGES.filter(matchesFilter);
    if (popularMatches.length > 0 && !lowerFilter) {
      const groupLabel = document.createElement('div');
      groupLabel.className = 'code-lang-group-label';
      groupLabel.textContent = 'Popular';
      listEl.appendChild(groupLabel);

      for (const lang of popularMatches) {
        listEl.appendChild(createOption(lang));
      }

      // Divider + All (excluding popular and renderer plugins)
      const rendererIds = new Set(RENDERER_PLUGIN_LANGUAGES.map(l => l.id));
      const others = ALL_LANGUAGES.filter(
        l => !POPULAR_IDS.has(l.id) && !rendererIds.has(l.id) && matchesFilter(l),
      );
      if (others.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'code-lang-divider';
        listEl.appendChild(divider);

        const allLabel = document.createElement('div');
        allLabel.className = 'code-lang-group-label';
        allLabel.textContent = 'All';
        listEl.appendChild(allLabel);
        for (const lang of others) {
          listEl.appendChild(createOption(lang));
        }
      }

      // Renderer plugins group
      const rendererMatches = RENDERER_PLUGIN_LANGUAGES.filter(matchesFilter);
      if (rendererMatches.length > 0) {
        const divider2 = document.createElement('div');
        divider2.className = 'code-lang-divider';
        listEl.appendChild(divider2);

        const rendererLabel = document.createElement('div');
        rendererLabel.className = 'code-lang-group-label';
        rendererLabel.textContent = 'Renderer Plugins';
        listEl.appendChild(rendererLabel);
        for (const lang of rendererMatches) {
          listEl.appendChild(createOption(lang));
        }
      }
    } else {
      // Filtered view — flat list
      const matches = ALL_LANGUAGES.filter(matchesFilter);
      for (const lang of matches) {
        listEl.appendChild(createOption(lang));
      }
      if (matches.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'code-lang-empty';
        empty.textContent = 'No matches';
        listEl.appendChild(empty);
      }
    }
  }

  function createOption(lang: LanguageEntry): HTMLElement {
    const option = document.createElement('div');
    option.className = 'code-lang-option';
    if (lang.id === currentLang) option.classList.add('selected');
    option.textContent = lang.label;
    option.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(lang.id);
      destroy();
    });
    return option;
  }

  renderList('');

  searchInput.addEventListener('input', () => {
    renderList(searchInput.value);
  });

  // Prevent keyboard events from reaching ProseMirror
  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      destroy();
    }
  });

  // Append inside the wrapper (not document.body) to avoid WKWebView clipping
  // from body { overflow: hidden }. position:fixed still works relative to the
  // viewport since no ancestor has transform/perspective/filter.
  container.appendChild(picker);
  positionPicker();

  function positionPicker() {
    const rect = anchor.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.top = `${rect.bottom + 2}px`;
    picker.style.left = `${rect.left}px`;
  }

  // Focus search
  requestAnimationFrame(() => searchInput.focus());

  // Run auto-detection in background
  getAutoDetect().then(detect => {
    detectedLang = detect(codeContent);
    if (detectedLang && !searchInput.value) {
      renderList('');
    }
  });

  // Close on outside click or Escape
  function handleOutsideClick(e: MouseEvent) {
    if (!picker.contains(e.target as Node) && !anchor.contains(e.target as Node)) {
      destroy();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      destroy();
    }
  }

  // Use setTimeout to avoid the same click that opens the picker from closing it
  setTimeout(() => {
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeydown, true);
  }, 0);

  function destroy() {
    document.removeEventListener('mousedown', handleOutsideClick);
    document.removeEventListener('keydown', handleKeydown, true);
    picker.remove();
    onDismiss?.();
  }

  return { destroy };
}

// ── Text escape helper ────────────────────────────

function escapeText(str: string): string {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Copy button helper ────────────────────────────

function handleCopy(btn: HTMLButtonElement, codeEl: HTMLElement) {
  const text = codeEl.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied');
    btn.title = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.title = 'Copy';
    }, 1500);
  });
}

// ── NodeView Plugin ───────────────────────────────

/**
 * NodeView factory for code_block nodes.
 * Pass as `nodeViews: { code_block: createCodeBlockNodeView }` in EditorView config.
 */
export function createCodeBlockNodeView(node: PmNode, view: EditorView, getPos: () => number | undefined) {
    // ── DOM structure ──
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const toolbar = document.createElement('div');
    toolbar.className = 'code-block-toolbar';
    // Toolbar must be non-editable — it inherits contenteditable="true" from
    // ProseMirror's root, which would let the cursor enter the toolbar text
    // and break content editing (ProseMirror can't map toolbar positions).
    toolbar.setAttribute('contenteditable', 'false');

    // Language label
    const langLabel = document.createElement('span');
    langLabel.className = 'code-lang-label';
    langLabel.textContent = findLanguageLabel(node.attrs.language || '');
    langLabel.title = 'Change language';

    // Mermaid toggle button (inserted before copy button)
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'mermaid-toggle-btn';
    toggleBtn.type = 'button';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy-btn';
    copyBtn.title = 'Copy';
    copyBtn.type = 'button';
    copyBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
      '<path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>' +
      '</svg>' +
      '<svg class="check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 6L9 17l-5-5"/>' +
      '</svg>';

    // Toolbar right-side group: toggleBtn + copyBtn
    const toolbarRight = document.createElement('div');
    toolbarRight.className = 'code-toolbar-right';
    toolbarRight.appendChild(toggleBtn);
    toolbarRight.appendChild(copyBtn);

    toolbar.appendChild(langLabel);
    toolbar.appendChild(toolbarRight);

    const pre = document.createElement('pre');
    pre.className = 'code-block-pre';
    const code = document.createElement('code');
    code.className = 'code-block-code';
    pre.appendChild(code);

    // Mermaid preview container
    const mermaidPreview = document.createElement('div');
    mermaidPreview.className = 'mermaid-preview';
    mermaidPreview.setAttribute('contenteditable', 'false');
    mermaidPreview.style.display = 'none';

    // Renderer plugin preview container
    const rendererPreview = document.createElement('div');
    rendererPreview.className = 'renderer-preview';
    rendererPreview.setAttribute('contenteditable', 'false');
    rendererPreview.style.display = 'none';

    wrapper.appendChild(toolbar);
    wrapper.appendChild(pre);
    wrapper.appendChild(mermaidPreview);
    wrapper.appendChild(rendererPreview);

    // ── Mermaid state ──
    let isEditing = false;
    let isMermaid = (node.attrs.language === 'mermaid');
    let lastRenderedCode = '';
    let renderTimer: ReturnType<typeof setTimeout> | null = null;

    // ── Renderer plugin state ──
    let isRenderer = RENDERER_LANG_IDS.has(node.attrs.language || '');
    let rendererEditing = false;
    let lastRendererCode = '';
    let rendererTimer: ReturnType<typeof setTimeout> | null = null;

    function syncMermaidMode() {
      const showPreview = isMermaid && !isEditing;
      pre.style.display = (showPreview || (isRenderer && !rendererEditing)) ? 'none' : '';
      mermaidPreview.style.display = showPreview ? 'flex' : 'none';
      // CSS default is display:none; must set inline to override
      toggleBtn.style.display = (isMermaid || isRenderer) ? 'inline-flex' : 'none';
      wrapper.classList.toggle('mermaid-preview-mode', showPreview);
      if (isMermaid) {
        toggleBtn.textContent = isEditing ? '👁 Preview' : '✏️ Edit';
        if (showPreview) triggerMermaidRender();
      }
    }

    function triggerMermaidRender() {
      const codeText = code.textContent || '';
      if (!codeText.trim()) {
        mermaidPreview.innerHTML = '<div class="mermaid-empty">Empty diagram</div>';
        lastRenderedCode = '';
        return;
      }
      if (codeText === lastRenderedCode) return;
      lastRenderedCode = codeText;

      // Debounce rapid re-renders
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = setTimeout(async () => {
        mermaidPreview.innerHTML = '<div class="mermaid-loading"><div class="mermaid-spinner"></div>Loading diagram...</div>';
        try {
          const api = await loadMermaidApi();
          if (!api) return;
          const result = await api.renderMermaid(codeText);
          // Guard: content may have changed during async render
          if (code.textContent !== codeText) return;
          if ('svg' in result) {
            mermaidPreview.innerHTML = result.svg;
          } else {
            mermaidPreview.innerHTML = `<div class="mermaid-error">${escapeText(result.error)}</div>`;
          }
        } catch {
          mermaidPreview.innerHTML = '<div class="mermaid-error">Render failed</div>';
        }
      }, 150);
    }

    // ── Renderer plugin sync ──────────────────────────

    function syncRendererMode() {
      const showPreview = isRenderer && !rendererEditing;
      pre.style.display = (showPreview || (isMermaid && !isEditing)) ? 'none' : '';
      rendererPreview.style.display = showPreview ? 'block' : 'none';
      toggleBtn.style.display = (isMermaid || isRenderer) ? 'inline-flex' : 'none';
      wrapper.classList.toggle('renderer-preview-mode', showPreview);
      if (isRenderer) {
        toggleBtn.textContent = rendererEditing ? '👁 Preview' : '✏️ Edit';
        if (showPreview) triggerRendererRender();
      }
    }

    function triggerRendererRender() {
      const source = code.textContent || '';
      const lang = node.attrs.language || '';
      const plugin = findRendererPlugin(lang);
      if (!plugin) return;

      if (!source.trim()) {
        rendererPreview.innerHTML = '<div class="renderer-empty">Empty block</div>';
        lastRendererCode = '';
        return;
      }
      if (source === lastRendererCode) return;
      lastRendererCode = source;

      if (rendererTimer) clearTimeout(rendererTimer);
      rendererTimer = setTimeout(async () => {
        rendererPreview.innerHTML = '<div class="renderer-loading"><div class="renderer-spinner"></div>Rendering...</div>';
        const cdnUrl = getRendererCdnUrl(plugin.npmPackage, plugin.cdnUrl);
        const result = await loadRendererPlugin(plugin, cdnUrl);
        // Guard: source may have changed during async load
        if (code.textContent !== source) return;
        if (result.status === 'ready' && result.module) {
          rendererPreview.innerHTML = '';
          try {
            await plugin.render(rendererPreview, source, result.module);
          } catch (e) {
            rendererPreview.innerHTML = `<div class="renderer-error">${escapeText(String(e))}</div>`;
          }
        } else {
          rendererPreview.innerHTML = `<div class="renderer-error">${escapeText(result.error ?? 'Load failed')}</div>`;
        }
      }, 150);
    }

    // Theme change: re-render this block
    function onThemeChange() {
      if (isMermaid && !isEditing) {
        lastRenderedCode = ''; // force re-render
        triggerMermaidRender();
      }
    }

    // Re-render when a renderer plugin finishes downloading for the first time.
    // Without this, NodeViews created before a plugin was enabled would never
    // re-trigger because lastRendererCode is already set to the current source.
    function onPluginReady(event: Event) {
      const { pluginId } = (event as CustomEvent<{ pluginId: string }>).detail;
      const plugin = findRendererPlugin(node.attrs.language || '');
      if (plugin && plugin.id === pluginId && isRenderer && !rendererEditing) {
        lastRendererCode = ''; // force re-render
        triggerRendererRender();
      }
    }
    window.addEventListener('renderer-plugin-ready', onPluginReady);

    if (isMermaid) {
      installThemeObserver();
      mermaidReRenderCallbacks.add(onThemeChange);
      // Defer: ProseMirror populates contentDOM AFTER NodeView factory returns,
      // so code.textContent is empty here. Wait one frame for content to arrive.
      requestAnimationFrame(() => syncMermaidMode());
    } else if (isRenderer) {
      // Hide pre and show toggle button immediately (don't wait for rAF),
      // then re-trigger after content arrives (ProseMirror fills contentDOM after factory returns).
      syncRendererMode();
      requestAnimationFrame(() => syncRendererMode());
    } else {
      syncMermaidMode();
    }

    // ── Language picker ──
    let activePicker: { destroy: () => void } | null = null;

    // Use mousedown (not click): fires immediately before browser selection changes.
    // stopEvent() on the NodeView prevents ProseMirror from intercepting toolbar events.
    // preventDefault() stops the browser from moving selection into contenteditable="false".
    langLabel.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (activePicker) {
        activePicker.destroy();
        activePicker = null;
        wrapper.classList.remove('picker-open');
        return;
      }

      const currentLang = node.attrs.language || '';
      const codeContent = code.textContent || '';
      wrapper.classList.add('picker-open');
      activePicker = createLanguagePicker(wrapper, langLabel, currentLang, codeContent, (newLang) => {
        activePicker = null;
        wrapper.classList.remove('picker-open');
        const pos = getPos();
        if (pos === undefined) return;
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            language: newLang,
          }),
        );
        view.focus();
      }, () => {
        // onDismiss: picker closed via outside click or Escape
        activePicker = null;
        wrapper.classList.remove('picker-open');
      });
    });

    // ── Mermaid / Renderer toggle button ──
    toggleBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isMermaid) {
        isEditing = !isEditing;
        syncMermaidMode();
      } else if (isRenderer) {
        rendererEditing = !rendererEditing;
        syncRendererMode();
      }
      if (isEditing || rendererEditing) view.focus();
    });

    // Click SVG preview → enter edit mode
    mermaidPreview.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isEditing = true;
      syncMermaidMode();
      view.focus();
    });

    // ── Copy button ──
    copyBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleCopy(copyBtn, code);
    });

    return {
      dom: wrapper,
      contentDOM: code,

      // Prevent ProseMirror from handling events on toolbar and picker elements
      stopEvent(event: Event) {
        const target = event.target as Node;
        return !code.contains(target) && wrapper.contains(target) && target !== code;
      },

      // Ignore DOM mutations outside contentDOM (toolbar, picker, wrapper class changes).
      // Without this, ProseMirror's MutationObserver would re-parse the node when the
      // picker is appended/removed, destroying it immediately.
      ignoreMutation(mutation: { target: Node }) {
        return !code.contains(mutation.target);
      },

      update(updatedNode: PmNode) {
        if (updatedNode.type.name !== 'code_block') return false;
        node = updatedNode;
        langLabel.textContent = findLanguageLabel(updatedNode.attrs.language || '');

        // Mermaid detection & mode sync
        const wasMermaid = isMermaid;
        isMermaid = (updatedNode.attrs.language === 'mermaid');
        if (isMermaid !== wasMermaid) {
          isEditing = false;
          if (isMermaid) {
            installThemeObserver();
            mermaidReRenderCallbacks.add(onThemeChange);
          } else {
            mermaidReRenderCallbacks.delete(onThemeChange);
          }
        }

        // Renderer plugin detection & mode sync
        const wasRenderer = isRenderer;
        isRenderer = RENDERER_LANG_IDS.has(updatedNode.attrs.language || '');
        if (isRenderer !== wasRenderer) {
          rendererEditing = false;
          lastRendererCode = '';
          rendererPreview.innerHTML = '';
        }

        if (isRenderer) {
          syncRendererMode();
        } else {
          rendererPreview.style.display = 'none';
          syncMermaidMode();
        }
        return true;
      },

      selectNode() {
        wrapper.classList.add('ProseMirror-selectednode');
      },

      deselectNode() {
        wrapper.classList.remove('ProseMirror-selectednode');
      },

      destroy() {
        if (activePicker) {
          activePicker.destroy();
          activePicker = null;
        }
        if (renderTimer) clearTimeout(renderTimer);
        if (rendererTimer) clearTimeout(rendererTimer);
        mermaidReRenderCallbacks.delete(onThemeChange);
        window.removeEventListener('renderer-plugin-ready', onPluginReady);
      },
    };
}

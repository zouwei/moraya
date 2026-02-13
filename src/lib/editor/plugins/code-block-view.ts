/**
 * CodeBlock NodeView — adds a toolbar with language label, language picker, and copy button.
 *
 * Uses Milkdown $view to replace the default <pre> rendering for code_block nodes.
 * Works alongside the highlight.ts decoration plugin (which still applies hljs classes
 * to the inner <code> contentDOM).
 */

import { $view } from '@milkdown/utils';
import { codeBlockSchema } from '@milkdown/preset-commonmark';

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
];

const ALL_LANGUAGES: LanguageEntry[] = [
  ...POPULAR_LANGUAGES,
  { id: 'scss', label: 'SCSS', aliases: [] },
  { id: 'lua', label: 'Lua', aliases: [] },
  { id: 'diff', label: 'Diff', aliases: [] },
  { id: 'text', label: 'Plain Text', aliases: ['plaintext', 'txt'] },
  { id: 'mermaid', label: 'Mermaid', aliases: [] },
].sort((a, b) => a.label.localeCompare(b.label));

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

      // Divider + All (excluding popular)
      const others = ALL_LANGUAGES.filter(
        l => !POPULAR_IDS.has(l.id) && matchesFilter(l),
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

export const codeBlockViewPlugin = $view(codeBlockSchema.node, () => {
  return (node, view, getPos) => {
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

    toolbar.appendChild(langLabel);
    toolbar.appendChild(copyBtn);

    const pre = document.createElement('pre');
    pre.className = 'code-block-pre';
    const code = document.createElement('code');
    code.className = 'code-block-code';
    pre.appendChild(code);

    wrapper.appendChild(toolbar);
    wrapper.appendChild(pre);

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
            language: newLang === 'text' ? '' : newLang,
          }),
        );
        view.focus();
      }, () => {
        // onDismiss: picker closed via outside click or Escape
        activePicker = null;
        wrapper.classList.remove('picker-open');
      });
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

      update(updatedNode) {
        if (updatedNode.type.name !== 'code_block') return false;
        // Sync current node reference for language picker
        node = updatedNode;
        langLabel.textContent = findLanguageLabel(updatedNode.attrs.language || '');
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
      },
    };
  };
});

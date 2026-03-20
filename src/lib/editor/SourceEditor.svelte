<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { settingsStore } from '../stores/settings-store';
  import { editorStore } from '../stores/editor-store';
  import OutlinePanel, { type OutlineHeading } from '$lib/components/OutlinePanel.svelte';

  let {
    content = $bindable(''),
    hideScrollbar = false,
    showOutline = false,
    outlineWidth = 200,
    onContentChange,
    onOutlineWidthChange,
  }: {
    content?: string;
    hideScrollbar?: boolean;
    showOutline?: boolean;
    outlineWidth?: number;
    onContentChange?: (content: string) => void;
    onOutlineWidthChange?: (width: number) => void;
  } = $props();

  let showLineNumbers = $state(false);
  let tabSize = $state(4);
  let editorLineWidth = $state(800);
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let ghostEl: HTMLDivElement | undefined = $state();

  const unsubSettings = settingsStore.subscribe(state => {
    showLineNumbers = state.showLineNumbers;
    tabSize = state.editorTabSize;
    editorLineWidth = state.editorLineWidth;
  });

  // ── Outline ──
  let outlineHeadings = $state<OutlineHeading[]>([]);
  let activeHeadingId = $state<string | null>(null);
  let outlineTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollRafOutline: number | undefined;

  /** Build a map from heading id → line index for quick lookup */
  function extractHeadingsFromMarkdown() {
    const heads: OutlineHeading[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        heads.push({ id: `h-${i}`, level: m[1].length, text: m[2].replace(/\s*#+\s*$/, '') });
      }
    }
    outlineHeadings = heads;
  }

  /** Estimate single-line height from scrollHeight / totalLines */
  function getLineHeight(outer: HTMLElement): number {
    const totalLines = content.split('\n').length;
    return totalLines > 0 ? outer.scrollHeight / totalLines : 20;
  }

  function updateActiveHeadingSource() {
    if (outlineHeadings.length === 0 || !textareaEl) { activeHeadingId = null; return; }
    const outer = textareaEl.closest('.source-editor-outer') as HTMLElement | null;
    if (!outer) return;
    const lineH = getLineHeight(outer);
    // The line at the top of the visible area
    const visibleLine = Math.floor(outer.scrollTop / lineH);
    let lastId: string | null = null;
    for (const h of outlineHeadings) {
      const line = parseInt(h.id.slice(2));
      if (line <= visibleLine) lastId = h.id;
      else break;
    }
    activeHeadingId = lastId ?? outlineHeadings[0]?.id ?? null;
  }

  function handleOutlineSelectSource(h: OutlineHeading) {
    if (!textareaEl) return;
    const outer = textareaEl.closest('.source-editor-outer') as HTMLElement | null;
    if (!outer) return;
    const line = parseInt(h.id.slice(2));
    const lineH = getLineHeight(outer);
    outer.scrollTo({ top: Math.round(line * lineH), behavior: 'smooth' });
  }

  // ── Line numbers with per-line height matching ──
  // When lines wrap, each line number must match the rendered height of the
  // corresponding text line. We measure via a temporary off-screen element
  // that mirrors the textarea's font/width/wrapping.
  let lineHeights = $state<number[]>([]);
  let lineHeightRaf: number | null = null;

  function computeLineHeights() {
    if (!showLineNumbers || !textareaEl) { lineHeights = []; return; }
    if (lineHeightRaf !== null) cancelAnimationFrame(lineHeightRaf);
    lineHeightRaf = requestAnimationFrame(() => {
      lineHeightRaf = null;
      if (!textareaEl) return;
      const lines = content.split('\n');
      const measure = document.createElement('div');
      const cs = getComputedStyle(textareaEl);
      measure.style.font = cs.font;
      measure.style.lineHeight = cs.lineHeight;
      measure.style.letterSpacing = cs.letterSpacing;
      measure.style.tabSize = cs.tabSize;
      measure.style.whiteSpace = 'pre-wrap';
      measure.style.wordWrap = 'break-word';
      measure.style.overflowWrap = 'break-word';
      measure.style.width = textareaEl.clientWidth + 'px';
      measure.style.visibility = 'hidden';
      measure.style.position = 'absolute';
      measure.style.top = '0';
      measure.style.left = '-9999px';

      const divs: HTMLDivElement[] = [];
      for (const line of lines) {
        const d = document.createElement('div');
        d.textContent = line || '\u00A0';
        divs.push(d);
        measure.appendChild(d);
      }
      document.body.appendChild(measure);
      const heights = divs.map(d => d.offsetHeight);
      document.body.removeChild(measure);
      lineHeights = heights;
    });
  }

  // ── Ghost div sync (decoupled from Svelte reactivity) ──
  // The ghost div mirrors textarea content for CSS grid auto-sizing.
  // Instead of using a reactive Svelte expression (which replaces the entire
  // text node on every keystroke), we update the ghost div directly via DOM
  // manipulation, throttled by requestAnimationFrame to batch rapid changes.
  let ghostRaf: number | null = null;

  function syncGhost() {
    if (!ghostEl) return;
    if (ghostRaf !== null) return; // already scheduled
    ghostRaf = requestAnimationFrame(() => {
      if (ghostEl) ghostEl.textContent = content + '\n';
      ghostRaf = null;
    });
  }

  // Sync ghost on mount and whenever content changes from outside (e.g. search-replace)
  $effect(() => {
    // Read `content` to establish dependency
    void content;
    syncGhost();
    computeLineHeights();
  });

  // Debounce store updates to avoid multiple synchronous subscriber cascades per keystroke.
  let storeTimer: ReturnType<typeof setTimeout> | null = null;

  function handleInput() {
    // content is already updated by Svelte's bind:value — no manual assignment needed.
    onContentChange?.(content);
    // Debounce the store update (triggers all subscribers synchronously).
    // Uses batched setDirtyContent to avoid two separate subscriber cascades.
    if (storeTimer !== null) clearTimeout(storeTimer);
    storeTimer = setTimeout(() => {
      editorStore.setDirtyContent(true, content);
      storeTimer = null;
    }, 50);
    // Debounced outline update (skipped when outline is hidden)
    if (showOutline) {
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(extractHeadingsFromMarkdown, 300);
    }
  }

  /** Normalize smart/curly quotes to straight quotes. */
  function straightenQuotes(text: string): string {
    return text
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
  }

  // Track newline insertion to suppress auto-inserted quotes (macOS text system artifact).
  let justInsertedNewline = false;
  let newlineTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Prevent macOS/WebKit smart quote substitution and auto-inserted quotes after Enter.
   */
  function handleBeforeInput(event: InputEvent) {
    // Track newline insertions
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
      justInsertedNewline = true;
      clearTimeout(newlineTimer);
      newlineTimer = setTimeout(() => { justInsertedNewline = false; }, 100);
      return;
    }

    // Block all insertReplacementText events (macOS autocorrect/smart quotes/
    // text substitution). In source mode, editing raw markdown/HTML, these
    // automatic replacements corrupt attribute values (e.g. title="width=2"0""%")
    // because the replacement range doesn't match selectionStart/End in textarea.
    // Spell check highlights (red underlines) still work — only auto-replacement
    // is blocked.
    if (event.inputType === 'insertReplacementText') {
      event.preventDefault();
      return;
    }

    if (event.inputType !== 'insertText') return;
    const data = event.data;
    if (!data) return;

    // Suppress auto-inserted quote right after Enter (macOS text system artifact:
    // pressing Enter after ..."title") auto-inserts a stray " on the new line)
    if (justInsertedNewline && data === '"') {
      event.preventDefault();
      justInsertedNewline = false;
      return;
    }
    justInsertedNewline = false;

    // Normalize smart/curly quotes to straight quotes (e.g. from CJK IME)
    const normalized = straightenQuotes(data);
    if (normalized !== data) {
      event.preventDefault();
      const textarea = event.target as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      content = content.substring(0, start) + normalized + content.substring(end);
      requestAnimationFrame(() => {
        const newPos = start + normalized.length;
        textarea.selectionStart = textarea.selectionEnd = newPos;
      });
    }
  }

  /**
   * Normalize smart quotes in pasted text (from external sources).
   */
  function handlePaste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    const normalized = straightenQuotes(text);
    if (normalized === text) return; // No smart quotes — let default paste proceed
    event.preventDefault();
    const textarea = event.target as HTMLTextAreaElement;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    content = content.substring(0, start) + normalized + content.substring(end);
    requestAnimationFrame(() => {
      const newPos = start + normalized.length;
      textarea.selectionStart = textarea.selectionEnd = newPos;
    });
    handleInput();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Tab') {
      event.preventDefault();
      const textarea = event.target as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const spaces = ' '.repeat(tabSize);
      content = content.substring(0, start) + spaces + content.substring(end);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + tabSize;
      });
    }
  }

  // Recompute line heights when textarea width changes (window resize, sidebar toggle)
  let resizeObserver: ResizeObserver | null = null;

  onMount(() => {
    // Initialize ghost div content synchronously on mount
    if (ghostEl) ghostEl.textContent = content + '\n';
    if (showOutline) extractHeadingsFromMarkdown();

    if (textareaEl) {
      resizeObserver = new ResizeObserver(() => computeLineHeights());
      resizeObserver.observe(textareaEl);
      // Disable macOS smart quotes/dashes in the source editor textarea
      textareaEl.setAttribute('autocorrect', 'off');
      textareaEl.setAttribute('autocapitalize', 'off');
      const { cursorOffset: offset, scrollFraction } = editorStore.getState();
      const clamped = Math.min(offset, content.length);
      textareaEl.selectionStart = clamped;
      textareaEl.selectionEnd = clamped;
      // preventScroll avoids the browser auto-scrolling to the caret position,
      // which uses the imprecise cursor offset and causes a jarring jump.
      textareaEl.focus({ preventScroll: true });

      const outer = textareaEl.closest('.source-editor-outer') as HTMLElement | null;
      if (offset === 0 && scrollFraction === 0) {
        // Scroll to top for new files
        if (outer) outer.scrollTop = 0;
      } else if (outer) {
        // Restore scroll position using saved fraction (more reliable than cursor offset).
        // Use rAF to ensure the ghost div has been laid out so scrollHeight is accurate.
        requestAnimationFrame(() => {
          const maxScroll = outer.scrollHeight - outer.clientHeight;
          if (maxScroll > 0) {
            outer.scrollTop = Math.round(scrollFraction * maxScroll);
          }
        });
      }
    }
  });

  onDestroy(() => {
    if (textareaEl) {
      editorStore.setCursorOffset(textareaEl.selectionStart);
      // Save scroll fraction for cross-mode restore
      const outer = textareaEl.closest('.source-editor-outer') as HTMLElement | null;
      if (outer && outer.scrollHeight > outer.clientHeight) {
        const maxScroll = outer.scrollHeight - outer.clientHeight;
        editorStore.setScrollFraction(maxScroll > 0 ? outer.scrollTop / maxScroll : 0);
      }
    }
    if (storeTimer !== null) {
      clearTimeout(storeTimer);
      // Flush pending content to store before unmount
      editorStore.setContent(content);
    }
    if (ghostRaf !== null) {
      cancelAnimationFrame(ghostRaf);
    }
    if (lineHeightRaf !== null) {
      cancelAnimationFrame(lineHeightRaf);
    }
    resizeObserver?.disconnect();
    if (outlineTimer) clearTimeout(outlineTimer);
    if (scrollRafOutline) cancelAnimationFrame(scrollRafOutline);
    clearTimeout(newlineTimer);
    unsubSettings();
  });

  // ── Search / Replace ──────────────────────────────────

  interface MatchPos { from: number; to: number }
  let searchMatches: MatchPos[] = [];
  let searchIndex = -1;
  let cachedLineHeight: number | undefined;
  let lastSearchRegex = false;
  let lastSearchPattern = '';
  let lastSearchCS = false;

  const MAX_MATCHES = 10000;

  export function searchText(text: string, cs: boolean, useRegex: boolean = false): number | { error: string } {
    searchMatches = [];
    searchIndex = -1;
    lastSearchRegex = useRegex;
    lastSearchPattern = text;
    lastSearchCS = cs;
    if (!text) return 0;

    // Read content from textarea if available (defensive against Svelte reactivity edge cases)
    const searchContent = textareaEl?.value ?? content;

    if (useRegex) {
      let regex: RegExp;
      try {
        regex = new RegExp(text, cs ? 'gm' : 'gim');
      } catch (e) {
        return { error: (e as Error).message };
      }
      let m: RegExpExecArray | null;
      while ((m = regex.exec(searchContent)) !== null) {
        if (m[0].length === 0) { regex.lastIndex++; continue; }
        searchMatches.push({ from: m.index, to: m.index + m[0].length });
        if (searchMatches.length >= MAX_MATCHES) break;
      }
    } else {
      const haystack = cs ? searchContent : searchContent.toLowerCase();
      const needle = cs ? text : text.toLowerCase();
      let idx = 0;
      while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        searchMatches.push({ from: idx, to: idx + needle.length });
        idx += needle.length;
        if (searchMatches.length >= MAX_MATCHES) break;
      }
    }

    if (searchMatches.length > 0) {
      searchIndex = 0;
      selectMatch(0, true); // skipFocus: don't steal focus from search bar
    }
    return searchMatches.length;
  }

  export function searchFindNext(): { current: number; total: number } {
    if (searchMatches.length === 0) return { current: 0, total: 0 };
    searchIndex = (searchIndex + 1) % searchMatches.length;
    selectMatch(searchIndex);
    return { current: searchIndex + 1, total: searchMatches.length };
  }

  export function searchFindPrev(): { current: number; total: number } {
    if (searchMatches.length === 0) return { current: 0, total: 0 };
    searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
    selectMatch(searchIndex);
    return { current: searchIndex + 1, total: searchMatches.length };
  }

  export function searchReplaceCurrent(replaceWith: string) {
    if (searchIndex < 0 || searchIndex >= searchMatches.length) return;
    const match = searchMatches[searchIndex];

    let replacement = replaceWith;
    if (lastSearchRegex && lastSearchPattern) {
      try {
        const regex = new RegExp(lastSearchPattern, lastSearchCS ? '' : 'i');
        const matchedText = content.substring(match.from, match.to);
        replacement = matchedText.replace(regex, replaceWith);
      } catch {
        // Fall through to literal replacement
      }
    }

    content = content.substring(0, match.from) + replacement + content.substring(match.to);
    editorStore.setDirty(true);
    editorStore.setContent(content);
  }

  export function searchReplaceAll(searchStr: string, replaceWith: string, cs: boolean, useRegex: boolean = false): number {
    if (!searchStr) return 0;
    const matches = searchMatches.length > 0 ? searchMatches : (() => {
      searchText(searchStr, cs, useRegex);
      return searchMatches;
    })();
    if (matches.length === 0) return 0;
    const count = matches.length;

    if (useRegex) {
      try {
        const regex = new RegExp(searchStr, cs ? '' : 'i');
        for (let i = matches.length - 1; i >= 0; i--) {
          const matchedText = content.substring(matches[i].from, matches[i].to);
          const replacement = matchedText.replace(regex, replaceWith);
          content = content.substring(0, matches[i].from) + replacement + content.substring(matches[i].to);
        }
      } catch {
        for (let i = matches.length - 1; i >= 0; i--) {
          content = content.substring(0, matches[i].from) + replaceWith + content.substring(matches[i].to);
        }
      }
    } else {
      for (let i = matches.length - 1; i >= 0; i--) {
        content = content.substring(0, matches[i].from) + replaceWith + content.substring(matches[i].to);
      }
    }

    editorStore.setDirty(true);
    editorStore.setContent(content);
    clearSearch();
    return count;
  }

  export function clearSearch() {
    searchMatches = [];
    searchIndex = -1;
  }

  function selectMatch(idx: number, skipFocus = false) {
    if (!textareaEl || idx < 0 || idx >= searchMatches.length) return;
    const match = searchMatches[idx];
    if (!skipFocus) textareaEl.focus();
    textareaEl.setSelectionRange(match.from, match.to);
    // Scroll outer container to show selection
    const linesBefore = content.substring(0, match.from).split('\n').length;
    if (!cachedLineHeight && textareaEl) {
      cachedLineHeight = parseFloat(getComputedStyle(textareaEl).lineHeight) || 24;
    }
    const lineHeight = cachedLineHeight || 24;
    const scrollTarget = (linesBefore - 3) * lineHeight;
    const outer = textareaEl.closest('.source-editor-outer') as HTMLElement | null;
    if (outer) {
      outer.scrollTop = Math.max(0, scrollTarget);
    }
  }
</script>

<div class="source-editor-outer" class:hide-scrollbar={hideScrollbar} class:has-outline={showOutline} onscroll={() => {
  if (!showOutline) return;
  if (scrollRafOutline) return;
  scrollRafOutline = requestAnimationFrame(() => {
    scrollRafOutline = undefined;
    updateActiveHeadingSource();
  });
}}>
  {#if showOutline}
    <OutlinePanel headings={outlineHeadings} activeId={activeHeadingId} width={outlineWidth} onSelect={handleOutlineSelectSource} onWidthChange={onOutlineWidthChange} />
  {/if}
  <div class="source-editor-inner" style="max-width: {showOutline ? `${editorLineWidth + outlineWidth}px` : `${editorLineWidth}px`}">
    {#if showLineNumbers}
      <div class="line-numbers">
        {#each lineHeights as h, i}
          <span class="line-number" style={h ? `height:${h}px` : ''}>{i + 1}</span>
        {/each}
      </div>
    {/if}
    <div class="textarea-grow" style="tab-size: {tabSize}">
      <div bind:this={ghostEl} class="textarea-ghost" aria-hidden="true"></div>
      <textarea
        bind:this={textareaEl}
        class="source-textarea"
        bind:value={content}
        oninput={handleInput}
        onbeforeinput={handleBeforeInput}
        onpaste={handlePaste}
        onkeydown={handleKeydown}
        spellcheck="true"
      ></textarea>
    </div>
  </div>
</div>

<style>
  .source-editor-outer {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    min-width: 0;
    /* Horizontal padding scales with actual pane width (% is relative to
       containing block), so it shrinks automatically when the editor pane
       is narrowed by sidebar + AI panel. */
    padding: 2rem clamp(1rem, 4%, 3rem);
    background: var(--bg-primary);
  }

  .source-editor-outer.has-outline {
    display: flex;
    align-items: flex-start;
    gap: 0;
    padding-left: clamp(0.5rem, 2%, 1.5rem);
  }

  .has-outline .source-editor-inner {
    flex: 1;
    min-width: 0;
    margin: 0;
  }

  .source-editor-outer.hide-scrollbar {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .source-editor-outer.hide-scrollbar::-webkit-scrollbar {
    display: none;
  }

  .source-editor-inner {
    width: 100%;
    margin: 0 auto;
    min-height: 100%;
    display: flex;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .line-numbers {
    display: flex;
    flex-direction: column;
    padding: 0 0.75rem 0 0;
    text-align: right;
    user-select: none;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    font-size: var(--font-size-sm);
    line-height: 1.6;
    color: var(--text-muted);
    border-right: 1px solid var(--border-light);
    margin-right: 0.75rem;
  }

  .line-number {
    display: block;
    min-width: 2rem;
  }

  /* CSS grid ghost technique: the ghost div mirrors the content to
     determine the cell height; the textarea overlays it on the same
     grid cell.  No JavaScript autoResize needed — the browser handles
     layout natively (batched, async) instead of forced sync reflow. */
  .textarea-grow {
    flex: 1;
    display: grid;
    /* Force grid column to respect container width instead of expanding to fit content.
       Without this, long lines (URLs etc.) push the column wider than the container,
       causing overflow instead of wrapping. */
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    overflow: hidden;
  }

  .textarea-ghost,
  .source-textarea {
    grid-area: 1 / 1;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    font-size: var(--font-size-sm);
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    padding: 0;
    border: none;
    margin: 0;
  }

  .textarea-ghost {
    visibility: hidden;
    pointer-events: none;
  }

  .source-textarea {
    width: 100%;
    resize: none;
    outline: none;
    background: transparent;
    color: var(--text-primary);
    overflow: hidden;
  }

  .source-textarea::placeholder {
    color: var(--text-muted);
  }
</style>

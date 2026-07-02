<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { settingsStore } from '../stores/settings-store';
  import { editorStore } from '../stores/editor-store';
  import OutlinePanel, { type OutlineHeading } from '$lib/components/OutlinePanel.svelte';
  import katex from 'katex';

  let {
    content = $bindable(''),
    hideScrollbar = false,
    showOutline = false,
    outlineWidth = 200,
    showBlame = false,
    blameData = [],
    onContentChange,
    onOutlineWidthChange,
  }: {
    content?: string;
    hideScrollbar?: boolean;
    showOutline?: boolean;
    outlineWidth?: number;
    /** v0.32.0: when true, renders blame gutter overlay (left of textarea) */
    showBlame?: boolean;
    /** v0.32.0: per-line blame data (1-based, indexed by line number) */
    blameData?: import('$lib/services/git').GitBlameEntry[];
    onContentChange?: (content: string) => void;
    onOutlineWidthChange?: (width: number) => void;
  } = $props();

  let showLineNumbers = $state(false);
  let tabSize = $state(4);

  /** v0.32.1 §F4: blame gutter time-based color gradient. */
  function blameColorForAge(unixSec: number): string {
    if (!unixSec) return '#a5d6ff';
    const ageDays = (Date.now() / 1000 - unixSec) / 86400;
    if (ageDays <= 7) return '#1f6feb';
    if (ageDays <= 30) return '#58a6ff';
    if (ageDays <= 90) return '#79c0ff';
    return '#a5d6ff';
  }
  let editorLineWidth = $state(800);
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let ghostEl: HTMLDivElement | undefined = $state();

  const unsubSettings = settingsStore.subscribe(state => {
    showLineNumbers = state.showLineNumbers;
    tabSize = state.editorTabSize;
    editorLineWidth = state.editorLineWidth;
  });

  // ── Scroll container height (for OutlinePanel) ──
  let outerHeight = $state(0);

  // ── Outline ──
  let outlineHeadings = $state<OutlineHeading[]>([]);
  let activeHeadingId = $state<string | null>(null);
  let outlineTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollRafOutline: number | undefined;

  /** Build a map from heading id → line index for quick lookup */
  /** Render inline $...$ math in heading text to KaTeX HTML */
  function renderHeadingHtml(text: string): string {
    if (!text.includes('$')) return '';
    const parts = text.split(/(\$[^$]+\$)/g);
    let hasMath = false;
    const html = parts.map(p => {
      if (p.startsWith('$') && p.endsWith('$') && p.length > 2) {
        hasMath = true;
        const tex = p.slice(1, -1);
        try { return katex.renderToString(tex, { throwOnError: false }); }
        catch { return tex; }
      }
      return p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }).join('');
    return hasMath ? html : '';
  }

  function extractHeadingsFromMarkdown() {
    const heads: OutlineHeading[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        const text = m[2].replace(/\s*#+\s*$/, '');
        const html = renderHeadingHtml(text);
        heads.push({ id: `h-${i}`, level: m[1].length, text, ...(html ? { html } : {}) });
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

  // ── Current line highlight + custom caret ──
  let currentLineIndex = $state<number>(0);
  let currentLineTop = $state<number>(0);
  let currentLineHeight = $state<number>(0);
  // Custom caret (replaces native caret to ensure consistent height on all lines)
  let caretX = $state<number>(0);
  let caretY = $state<number>(0);
  let caretH = $state<number>(25);
  let showCustomCaret = $state(false);
  let caretKey = $state(0); // increment to restart blink animation
  let selectionChangeCleanup: (() => void) | null = null;

  /** Build per-line <div> elements in a DocumentFragment for the ghost div. */
  function buildGhostChildren(text: string): DocumentFragment {
    const lines = text.split('\n');
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const d = document.createElement('div');
      d.textContent = line || '\u00A0';
      frag.appendChild(d);
    }
    // Trailing empty div to match old content + '\n' behavior
    const trailing = document.createElement('div');
    trailing.textContent = '\u00A0';
    frag.appendChild(trailing);
    return frag;
  }

  /** Read line heights from ghost div children (for line numbers). */
  function readLineHeightsFromGhost() {
    if (!ghostEl || !ghostEl.children.length) { lineHeights = []; return; }
    const heights: number[] = [];
    // Exclude the trailing extra div
    const count = ghostEl.children.length - 1;
    for (let i = 0; i < count; i++) {
      heights.push((ghostEl.children[i] as HTMLElement).offsetHeight);
    }
    lineHeights = heights;
  }

  // ── Ghost div sync (decoupled from Svelte reactivity) ──
  // The ghost div mirrors textarea content for CSS grid auto-sizing.
  // Uses per-line <div> elements so we can read offsetTop/offsetHeight
  // for accurate current-line highlight positioning.
  let ghostRaf: number | null = null;

  function syncGhost() {
    if (!ghostEl) return;
    if (ghostRaf !== null) return; // already scheduled
    ghostRaf = requestAnimationFrame(() => {
      if (!ghostEl) return;
      ghostEl.replaceChildren(buildGhostChildren(content));
      ghostRaf = null;
      // DOM is now updated — read real positions
      readLineHeightsFromGhost();
      updateCurrentLine();
    });
  }

  // Sync ghost on mount and whenever content changes from outside (e.g. search-replace)
  // syncGhost() now handles both line heights and current line highlight.
  $effect(() => {
    // Read `content` to establish dependency
    void content;
    syncGhost();
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

  /** Set highlight line from external source (e.g. visual editor in split mode).
   *  Only updates the line highlight background, not the custom caret. */
  export function setHighlightLine(lineIndex: number) {
    if (!ghostEl || !ghostEl.children.length) return;
    if (lineIndex < 0 || lineIndex >= ghostEl.children.length - 1) return;
    currentLineIndex = lineIndex;
    const lineDiv = ghostEl.children[lineIndex] as HTMLElement | undefined;
    if (lineDiv) {
      currentLineTop = lineDiv.offsetTop;
      currentLineHeight = lineDiv.offsetHeight;
    }
  }

  /** Update current line highlight + custom caret position from ghost div DOM. */
  function updateCurrentLine() {
    if (!textareaEl || !ghostEl || !ghostEl.children.length) return;
    const cursorPos = textareaEl.selectionStart;
    const selEnd = textareaEl.selectionEnd;
    const beforeCursor = content.substring(0, cursorPos);
    const lineIndex = beforeCursor.split('\n').length - 1;

    currentLineIndex = lineIndex;

    // Read actual rendered position from ghost div children
    const lineDiv = ghostEl.children[lineIndex] as HTMLElement | undefined;
    if (lineDiv) {
      currentLineTop = lineDiv.offsetTop;
      currentLineHeight = lineDiv.offsetHeight;
    }

    // Hide custom caret when there is a selection or textarea is not focused
    if (cursorPos !== selEnd || document.activeElement !== textareaEl) {
      showCustomCaret = false;
      return;
    }
    showCustomCaret = true;

    // Measure caret X/Y by inserting a marker span in the ghost line div
    if (!lineDiv) return;
    const lineStartPos = beforeCursor.lastIndexOf('\n') + 1;
    const colOffset = cursorPos - lineStartPos;
    const lineText = lineDiv.textContent || '';
    const beforeText = lineText.substring(0, colOffset);
    const afterText = lineText.substring(colOffset);

    // Build: textNode + marker + textNode
    const marker = document.createElement('span');
    const frag = document.createDocumentFragment();
    if (beforeText) frag.appendChild(document.createTextNode(beforeText));
    frag.appendChild(marker);
    frag.appendChild(document.createTextNode(afterText || '\u00A0'));

    lineDiv.textContent = '';
    lineDiv.appendChild(frag);

    // X/Y from marker: marker.offsetTop reflects its actual visual row after soft-wrap,
    // so long lines (URLs etc.) that wrap to multiple rows render the caret on the
    // correct wrapped row instead of always at the top of the logical line.
    caretX = marker.offsetLeft;
    caretY = marker.offsetTop;
    caretH = 25; // fixed = line-height, consistent on all lines

    // Restore original line content
    lineDiv.textContent = lineText || '\u00A0';

    // Restart blink animation
    caretKey++;
  }

  function handleKeydown(event: KeyboardEvent) {
    const textarea = event.target as HTMLTextAreaElement;

    // Shift+Enter: insert hard break (two spaces + newline)
    if (event.shiftKey && event.key === 'Enter') {
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const hardbreak = '  \n';
      content = content.substring(0, start) + hardbreak + content.substring(end);
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + hardbreak.length;
      });
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
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
    // Initialize ghost div with per-line structure synchronously on mount
    if (ghostEl) ghostEl.replaceChildren(buildGhostChildren(content));
    if (showOutline) extractHeadingsFromMarkdown();

    if (textareaEl) {
      resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          readLineHeightsFromGhost();
          updateCurrentLine();
        });
      });
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
      // Initialize current line highlight and line heights from ghost DOM
      requestAnimationFrame(() => {
        readLineHeightsFromGhost();
        updateCurrentLine();
      });

      // Listen for selectionchange to track ALL cursor movement
      // (arrow keys, click, shift+arrow, home/end, etc.)
      const handleSelectionChange = () => {
        if (document.activeElement === textareaEl) {
          updateCurrentLine();
        } else {
          showCustomCaret = false;
        }
      };
      document.addEventListener('selectionchange', handleSelectionChange);
      selectionChangeCleanup = () => document.removeEventListener('selectionchange', handleSelectionChange);

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
    resizeObserver?.disconnect();
    selectionChangeCleanup?.();
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

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="source-editor-outer" role="region" aria-label="Source editor" class:hide-scrollbar={hideScrollbar} class:has-outline={showOutline} bind:clientHeight={outerHeight} onclick={(e) => {
  // Click on empty area below content → refocus textarea (prevent losing focus)
  const target = e.target as HTMLElement;
  if (target.closest('.source-textarea') || target.closest('.outline-wrapper') || target.closest('.resize-handle')) return;
  textareaEl?.focus();
}} onscroll={() => {
  if (!showOutline) return;
  if (scrollRafOutline) return;
  scrollRafOutline = requestAnimationFrame(() => {
    scrollRafOutline = undefined;
    updateActiveHeadingSource();
  });
}}>
  <div class="source-editor-inner" style="max-width: {showOutline ? `${editorLineWidth + outlineWidth}px` : `${editorLineWidth}px`}">
    {#if showOutline}
      <OutlinePanel headings={outlineHeadings} activeId={activeHeadingId} width={outlineWidth} containerHeight={outerHeight} onSelect={handleOutlineSelectSource} onWidthChange={onOutlineWidthChange} />
    {/if}
    {#if showLineNumbers}
      <div class="line-numbers">
        {#each lineHeights as h, i}
          <span class="line-number" style={h ? `height:${h}px` : ''}>{i + 1}</span>
        {/each}
      </div>
    {/if}
    {#if showBlame}
      <div class="blame-gutter" aria-hidden="true">
        {#each lineHeights as h, i}
          {@const entry = blameData[i] /* 0-based to match lineHeights */}
          {#if entry}
            <div class="blame-line" class:uncommitted={entry.uncommitted} style="{h ? `height:${h}px;` : ''}{entry.uncommitted ? '' : `color:${blameColorForAge(entry.author_time)};`}">
              <span class="bl-hash">{entry.short_hash}</span>
              <span class="bl-author">· {entry.uncommitted ? '—' : entry.author}</span>
            </div>
          {:else}
            <div class="blame-line empty" style={h ? `height:${h}px` : ''}></div>
          {/if}
        {/each}
      </div>
    {/if}
    <div class="textarea-grow" style="tab-size: {tabSize}">
      <div bind:this={ghostEl} class="textarea-ghost" aria-hidden="true"></div>
      <div class="current-line-highlight" style="top: {currentLineTop}px; height: {currentLineHeight}px;" aria-hidden="true"></div>
      {#if showCustomCaret}
        {#key caretKey}
          <div class="custom-caret" style="left: {caretX}px; top: {caretY}px; height: {caretH}px;" aria-hidden="true"></div>
        {/key}
      {/if}
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
  }

  .has-outline .source-editor-inner {
    align-items: flex-start;
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
    min-height: 0;
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
    line-height: 25px;
    color: var(--text-muted);
    border-right: 1px solid var(--border-light);
    margin-right: 0.75rem;
  }

  .line-number {
    display: block;
    min-width: 2rem;
  }

  /* v0.32.0 blame gutter */
  .blame-gutter {
    display: flex;
    flex-direction: column;
    width: 120px;
    flex-shrink: 0;
    padding: 0 8px 0 4px;
    text-align: left;
    user-select: none;
    pointer-events: none;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    font-size: 11px;
    line-height: 25px;
    color: var(--text-muted, var(--color-text-muted));
    border-right: 1px solid var(--border-light, var(--color-border));
    margin-right: 0.5rem;
    overflow: hidden;
  }
  .blame-line {
    display: flex;
    gap: 4px;
    align-items: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #1f6feb;
  }
  .blame-line.uncommitted {
    color: #6e7681;
    font-style: italic;
  }
  .blame-line.empty {}
  .bl-hash {
    font-weight: 600;
    flex-shrink: 0;
  }
  .bl-author {
    overflow: hidden;
    text-overflow: ellipsis;
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
    position: relative;
  }

  .textarea-ghost,
  .source-textarea {
    grid-area: 1 / 1;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    font-size: 15px;
    line-height: 25px;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-wrap: break-word;
    padding: 0;
    border: none;
    margin: 0;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  .textarea-ghost {
    visibility: hidden;
    pointer-events: none;
  }

  .current-line-highlight {
    position: absolute;
    left: 0;
    right: 0;
    width: 100%;
    background: rgba(128, 128, 128, 0.15);
    pointer-events: none;
  }

  .custom-caret {
    position: absolute;
    width: 2px;
    background: #0066cc;
    pointer-events: none;
    animation: source-caret-blink 1s step-end infinite;
  }

  @keyframes source-caret-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .source-textarea {
    width: 100%;
    resize: none;
    outline: none;
    background: transparent;
    color: var(--text-primary);
    overflow: hidden;
    vertical-align: top;
    /* Hide native caret — replaced by .custom-caret for consistent height */
    caret-color: transparent;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    box-sizing: border-box;
  }

  .source-textarea::placeholder {
    color: var(--text-muted);
  }
</style>

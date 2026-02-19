<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { settingsStore } from '../stores/settings-store';
  import { editorStore } from '../stores/editor-store';

  let {
    content = $bindable(''),
    hideScrollbar = false,
    onContentChange,
  }: {
    content?: string;
    hideScrollbar?: boolean;
    onContentChange?: (content: string) => void;
  } = $props();

  let showLineNumbers = $state(false);
  let tabSize = $state(4);
  let editorLineWidth = $state(800);
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  settingsStore.subscribe(state => {
    showLineNumbers = state.showLineNumbers;
    tabSize = state.editorTabSize;
    editorLineWidth = state.editorLineWidth;
  });

  // Only compute line count when line numbers are visible
  let lineCount = $derived(showLineNumbers ? countNewlines(content) : 0);

  /** Count newlines without allocating an array (O(n) scan) */
  function countNewlines(s: string): number {
    let count = 1;
    let idx = -1;
    while ((idx = s.indexOf('\n', idx + 1)) !== -1) count++;
    return count;
  }

  function handleInput(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    const cursorStart = textarea.selectionStart;
    const cursorEnd = textarea.selectionEnd;
    content = textarea.value;
    onContentChange?.(content);
    editorStore.setDirty(true);
    editorStore.setContent(content);
    // Restore cursor after Svelte re-renders the value={content} binding,
    // which can reset cursor position (especially on paste).
    tick().then(() => {
      if (textareaEl) {
        textareaEl.selectionStart = cursorStart;
        textareaEl.selectionEnd = cursorEnd;
      }
    });
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

  onMount(() => {
    if (textareaEl) {
      const offset = editorStore.getState().cursorOffset;
      const clamped = Math.min(offset, content.length);
      textareaEl.selectionStart = clamped;
      textareaEl.selectionEnd = clamped;
      textareaEl.focus();

      // Scroll to top for new files (cursorOffset === 0)
      if (offset === 0) {
        const outer = textareaEl.closest('.source-editor-outer') as HTMLElement | null;
        if (outer) outer.scrollTop = 0;
      }
    }
  });

  onDestroy(() => {
    if (textareaEl) {
      editorStore.setCursorOffset(textareaEl.selectionStart);
    }
  });

  // ── Search / Replace ──────────────────────────────────

  interface MatchPos { from: number; to: number }
  let searchMatches: MatchPos[] = [];
  let searchIndex = -1;
  let cachedLineHeight: number | undefined;

  export function searchText(text: string, cs: boolean): number {
    searchMatches = [];
    searchIndex = -1;
    if (!text) return 0;
    const haystack = cs ? content : content.toLowerCase();
    const needle = cs ? text : text.toLowerCase();
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
      searchMatches.push({ from: idx, to: idx + needle.length });
      idx += needle.length;
    }
    if (searchMatches.length > 0) {
      searchIndex = 0;
      selectMatch(0);
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
    content = content.substring(0, match.from) + replaceWith + content.substring(match.to);
    editorStore.setDirty(true);
    editorStore.setContent(content);
  }

  export function searchReplaceAll(searchStr: string, replaceWith: string, cs: boolean): number {
    if (!searchStr) return 0;
    const matches = searchMatches.length > 0 ? searchMatches : (() => {
      // Rebuild matches if needed
      searchText(searchStr, cs);
      return searchMatches;
    })();
    if (matches.length === 0) return 0;
    const count = matches.length;
    // Replace from end to start to preserve positions
    for (let i = matches.length - 1; i >= 0; i--) {
      content = content.substring(0, matches[i].from) + replaceWith + content.substring(matches[i].to);
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

  function selectMatch(idx: number) {
    if (!textareaEl || idx < 0 || idx >= searchMatches.length) return;
    const match = searchMatches[idx];
    textareaEl.focus();
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

<div class="source-editor-outer" class:hide-scrollbar={hideScrollbar}>
  <div class="source-editor-inner" style="max-width: min({editorLineWidth}px, 100%)">
    {#if showLineNumbers}
      <div class="line-numbers">
        {#each Array(lineCount) as _, i}
          <span class="line-number">{i + 1}</span>
        {/each}
      </div>
    {/if}
    <div class="textarea-grow" style="tab-size: {tabSize}">
      <div class="textarea-ghost" aria-hidden="true">{content + '\n'}</div>
      <textarea
        bind:this={textareaEl}
        class="source-textarea"
        value={content}
        oninput={handleInput}
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
    padding: 2rem 3rem;
    background: var(--bg-primary);
  }

  .source-editor-outer.hide-scrollbar {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .source-editor-outer.hide-scrollbar::-webkit-scrollbar {
    display: none;
  }

  /* Reduce padding when viewport is narrow (e.g., AI panel open) */
  @media (max-width: 900px) {
    .source-editor-outer {
      padding: 1.5rem 1.5rem;
    }
  }

  @media (max-width: 600px) {
    .source-editor-outer {
      padding: 1rem 1rem;
    }
  }

  .source-editor-inner {
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
    min-width: 0;
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

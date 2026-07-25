import { writable, derived, get } from 'svelte/store';

export type EditorMode = 'visual' | 'source' | 'split';

interface EditorState {
  currentFilePath: string | null;
  isDirty: boolean;
  isFocused: boolean;
  content: string;
  wordCount: number;
  charCount: number;
  editorMode: EditorMode;
  /**
   * The most recently active "single" editor mode ('visual' or 'source').
   * In the user's mental model, Visual ↔ Source is one mutually-exclusive
   * axis ("base mode") and single ↔ split is a separate axis ("layout").
   * The rendered `editorMode` collapses both into one enum, so we track
   * the base mode here so that:
   *   - Cmd+Shift+/ exiting split can restore the user's prior base
   *     (i.e. coming out of split returns to source if that's what they
   *     were in before entering split, not always to visual)
   *   - Cmd+/ while inside split can flip the base without disturbing
   *     the split layout — the next exit-split will land on the new base
   *   - The native menu can keep one of Visual/Source checked at all
   *     times, with Split as an independent checkmark layered on top
   */
  lastSingleMode: 'visual' | 'source';
  /** Cursor position as character offset in the markdown string (for cross-mode restore) */
  cursorOffset: number;
  /** Scroll position as fraction (0-1) of scrollHeight for cross-mode restore */
  scrollFraction: number;
}

// requestIdleCallback with fallback for older WebKit
const scheduleIdle = typeof requestIdleCallback === 'function'
  ? requestIdleCallback
  : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
const cancelIdle = typeof cancelIdleCallback === 'function'
  ? cancelIdleCallback
  : (id: number) => clearTimeout(id);

function createEditorStore() {
  const { subscribe, set, update } = writable<EditorState>({
    currentFilePath: null,
    isDirty: false,
    isFocused: false,
    content: '',
    wordCount: 0,
    charCount: 0,
    editorMode: 'visual',
    lastSingleMode: 'visual',
    cursorOffset: 0,
    scrollFraction: 0,
  });

  function countWords(text: string): number {
    // Handle both CJK and Latin text
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const latinWords = text
      .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, '')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 0).length;
    return cjkChars + latinWords;
  }

  // Deferred word count: runs in idle frame to avoid blocking editor transactions
  let wordCountTimer: number | null = null;

  function scheduleWordCount(text: string) {
    if (wordCountTimer !== null) {
      cancelIdle(wordCountTimer);
    }
    wordCountTimer = scheduleIdle(() => {
      const wc = countWords(text);
      const cc = text.length;
      // Only create a new state object (and trigger subscribers) when counts
      // actually changed. This prevents a subscriber cascade on every idle
      // callback when the user hasn't changed the document length.
      update(state =>
        state.wordCount === wc && state.charCount === cc
          ? state
          : { ...state, wordCount: wc, charCount: cc }
      );
      wordCountTimer = null;
    });
  }

  return {
    subscribe,
    setContent(content: string) {
      update(state => ({ ...state, content }));
      scheduleWordCount(content);
    },
    /** Batch setDirty + setContent in a single store update to avoid
     *  triggering all subscribers twice (one synchronous cascade per update). */
    setDirtyContent(isDirty: boolean, content: string) {
      update(state => ({ ...state, isDirty, content }));
      scheduleWordCount(content);
    },
    setDirty(isDirty: boolean) {
      update(state => ({ ...state, isDirty }));
    },
    /** Mark the document as dirty without updating content.
     *  Only triggers subscribers on the false→true transition;
     *  subsequent calls while already dirty are no-ops. */
    markDirty() {
      update(state => state.isDirty ? state : { ...state, isDirty: true });
    },
    /** Schedule word count from plain text (doc.textContent).
     *  Avoids the cost of full markdown serialization. */
    scheduleWordCountFromText(text: string) {
      scheduleWordCount(text);
    },
    setFocused(isFocused: boolean) {
      update(state => state.isFocused === isFocused ? state : { ...state, isFocused });
    },
    setCurrentFile(path: string | null) {
      update(state => ({ ...state, currentFilePath: path, isDirty: false }));
    },
    /** Update only the file path without touching isDirty — used after rename. */
    updateFilePath(newPath: string) {
      update(state => ({ ...state, currentFilePath: newPath }));
    },
    /** Batch-restore multiple fields in a single store update (1 subscriber notification
     *  instead of 5 separate set*() calls). Used by tab switching. */
    batchRestore(data: {
      filePath: string | null;
      content: string;
      isDirty: boolean;
      cursorOffset: number;
      scrollFraction: number;
    }) {
      update(state => ({
        ...state,
        currentFilePath: data.filePath,
        content: data.content,
        isDirty: data.isDirty,
        cursorOffset: data.cursorOffset,
        scrollFraction: data.scrollFraction,
      }));
      scheduleWordCount(data.content);
    },
    toggleEditorMode() {
      update(state => {
        const next: EditorMode = state.editorMode === 'visual' ? 'source' : 'visual';
        return { ...state, editorMode: next, lastSingleMode: next };
      });
    },
    setEditorMode(mode: EditorMode) {
      update(state => {
        if (state.editorMode === mode) return state;
        // Keep lastSingleMode in lockstep whenever we land on a single
        // mode, so subsequent split-toggles restore the right base.
        // Entering 'split' preserves whatever lastSingleMode already was.
        const lastSingleMode: 'visual' | 'source' =
          mode === 'visual' || mode === 'source' ? mode : state.lastSingleMode;
        return { ...state, editorMode: mode, lastSingleMode };
      });
    },
    /**
     * Set the base ('visual' | 'source') without disturbing `editorMode`.
     * Used by Cmd+/ while in split layout, where flipping the base should
     * NOT collapse the split — it just records what the next exit-split
     * will restore to, and lets the native menu Visual/Source check
     * track the user's preference.
     */
    setLastSingleMode(mode: 'visual' | 'source') {
      update(state => state.lastSingleMode === mode ? state : { ...state, lastSingleMode: mode });
    },
    setCursorOffset(offset: number) {
      update(state => state.cursorOffset === offset ? state : { ...state, cursorOffset: offset });
    },
    setScrollFraction(fraction: number) {
      update(state => state.scrollFraction === fraction ? state : { ...state, scrollFraction: fraction });
    },
    /** Batch content flush + cursor/scroll save in a single store update.
     *  Used by Editor.svelte onDestroy to prevent 3 separate subscriber notifications. */
    batchFlush(data: { content: string; cursorOffset: number; scrollFraction: number }) {
      update(state => ({
        ...state,
        content: data.content,
        cursorOffset: data.cursorOffset,
        scrollFraction: data.scrollFraction,
      }));
      scheduleWordCount(data.content);
    },
    reset() {
      set({
        currentFilePath: null,
        isDirty: false,
        isFocused: false,
        content: '',
        wordCount: 0,
        charCount: 0,
        editorMode: 'visual',
        lastSingleMode: 'visual',
        cursorOffset: 0,
        scrollFraction: 0,
      });
    },
    getState() {
      return get({ subscribe });
    },
  };
}

export const editorStore = createEditorStore();

/**
 * Global "a non-markdown document is taking over" latch.
 *
 * When the app switches to a Typst tab, the outgoing markdown Editor unmounts.
 * Its `onDestroy` flush serializes the ProseMirror doc back through the
 * `content` binding — which would overwrite the incoming Typst document. A
 * prop can't reliably suppress that: Svelte does not guarantee a prop update
 * reaches a component that is being destroyed in the same flush. This latch is
 * read directly at flush time instead, so it is immune to prop timing.
 */
let markdownFlushSuppressed = false;

export function suppressMarkdownFlush(on: boolean): void {
  markdownFlushSuppressed = on;
}

export function isMarkdownFlushSuppressed(): boolean {
  return markdownFlushSuppressed;
}

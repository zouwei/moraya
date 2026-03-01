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
      update(state => ({
        ...state,
        editorMode: state.editorMode === 'visual' ? 'source' : 'visual',
      }));
    },
    setEditorMode(mode: EditorMode) {
      update(state => state.editorMode === mode ? state : { ...state, editorMode: mode });
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

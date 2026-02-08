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
      update(state => ({
        ...state,
        wordCount: wc,
        charCount: text.length,
      }));
      wordCountTimer = null;
    });
  }

  return {
    subscribe,
    setContent(content: string) {
      update(state => ({ ...state, content }));
      scheduleWordCount(content);
    },
    setDirty(isDirty: boolean) {
      update(state => ({ ...state, isDirty }));
    },
    setFocused(isFocused: boolean) {
      update(state => ({ ...state, isFocused }));
    },
    setCurrentFile(path: string | null) {
      update(state => ({ ...state, currentFilePath: path, isDirty: false }));
    },
    toggleEditorMode() {
      update(state => ({
        ...state,
        editorMode: state.editorMode === 'visual' ? 'source' : 'visual',
      }));
    },
    setEditorMode(mode: EditorMode) {
      update(state => ({ ...state, editorMode: mode }));
    },
    setCursorOffset(offset: number) {
      update(state => ({ ...state, cursorOffset: offset }));
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
      });
    },
    getState() {
      return get({ subscribe });
    },
  };
}

export const editorStore = createEditorStore();

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
}

function createEditorStore() {
  const { subscribe, set, update } = writable<EditorState>({
    currentFilePath: null,
    isDirty: false,
    isFocused: false,
    content: '',
    wordCount: 0,
    charCount: 0,
    editorMode: 'visual',
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

  return {
    subscribe,
    setContent(content: string) {
      update(state => ({
        ...state,
        content,
        wordCount: countWords(content),
        charCount: content.length,
      }));
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
    reset() {
      set({
        currentFilePath: null,
        isDirty: false,
        isFocused: false,
        content: '',
        wordCount: 0,
        charCount: 0,
        editorMode: 'visual',
      });
    },
    getState() {
      return get({ subscribe });
    },
  };
}

export const editorStore = createEditorStore();

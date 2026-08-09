import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { tabsStore } from './tabs-store';
import { editorStore } from './editor-store';

/**
 * Regression cover for silent edit loss on tab switch.
 *
 * The visual-only editor does NOT serialize markdown per keystroke — `<Editor>`
 * is mounted without `onContentChange`, so it takes the `onDocChanged` branch
 * that only marks the document dirty. The real text lives in the ProseMirror
 * doc and is produced on demand by `getFullMarkdown()`; `editorStore.content`
 * still holds whatever was last loaded.
 *
 * `syncFromEditor()` copies `editorStore.content` into the active tab, so
 * anything that switches, closes or reorders a tab used to write the PRE-EDIT
 * text into it. Switching back then loaded that stale text into the editor, and
 * the next save — autosave included — wrote it over the file. The user saw a
 * document revert to an older version overnight, with the edits recoverable
 * only from version history (which snapshots the correct text at save time).
 *
 * The fix gives the store a content provider so it reads the live document
 * instead of the stale mirror.
 */

/** Stands in for the ProseMirror document — what `getCurrentContent()` returns. */
let liveDocument = '';

function loadFileIntoEditor(path: string, text: string) {
  liveDocument = text;
  editorStore.batchRestore({
    filePath: path,
    content: text,
    isDirty: false,
    cursorOffset: 0,
    scrollFraction: 0,
  });
}

/** Typing in visual mode: the doc changes, the store only learns it is dirty. */
function typeInVisualMode(text: string) {
  liveDocument = text;
  editorStore.setDirty(true);
}

beforeEach(() => {
  liveDocument = '';
  tabsStore.setContentProvider(() => liveDocument);
});

/** Open a fresh markdown tab and make it the active, loaded document. */
function openDoc(path: string, text: string): string {
  const id = tabsStore.openFileTab(path, path.split('/').pop()!, text);
  loadFileIntoEditor(path, text);
  return id;
}

describe('tab switching with an unserialized visual editor', () => {
  it('keeps edits made in visual mode when switching away and back', () => {
    const first = openDoc('/notes/a.md', 'original');

    typeInVisualMode('original\n\nedited last night');

    const second = tabsStore.addTab();
    tabsStore.switchTab(second);
    tabsStore.switchTab(first);

    expect(editorStore.getState().content).toBe('original\n\nedited last night');
    expect(get(tabsStore).tabs.find(t => t.id === first)?.content).toBe(
      'original\n\nedited last night',
    );
  });

  it('keeps edits made after the last save', () => {
    // The reported sequence exactly: edit, save, keep editing, switch tabs.
    // saveFile() clears the dirty flag without refreshing editorStore.content,
    // so the mirror stayed at the pre-edit text even for a saved document.
    const first = openDoc('/notes/b.md', 'original');

    typeInVisualMode('saved version');
    editorStore.setDirty(false); // what saveFile() does after a successful write

    const second = tabsStore.addTab();
    tabsStore.switchTab(second);
    tabsStore.switchTab(first);

    expect(editorStore.getState().content).toBe('saved version');
  });

  it('carries the live document into a tab that is closed', () => {
    // closeTab syncs too; a stale sync here loses the edits from the tab that
    // becomes active next.
    const first = openDoc('/notes/c.md', 'original');
    typeInVisualMode('edited');

    const second = tabsStore.addTab();
    tabsStore.switchTab(second);

    expect(get(tabsStore).tabs.find(t => t.id === first)?.content).toBe('edited');
  });

  it('does not absorb the live document into a read-only version preview', () => {
    // Preview tabs show a historical snapshot; letting the provider write into
    // them would corrupt the very thing the user restores from.
    const first = openDoc('/notes/d.md', 'original');
    const preview = tabsStore.openReadOnlyTab('/notes/d.md#v1', 'd.md@v1', 'historical snapshot');
    tabsStore.switchTab(preview);

    liveDocument = 'something else entirely';
    tabsStore.switchTab(first);

    expect(get(tabsStore).tabs.find(t => t.id === preview)?.content).toBe(
      'historical snapshot',
    );
  });

  it('falls back to the store when no provider is registered', () => {
    // Other windows / tests construct the store without an editor.
    tabsStore.setContentProvider(null);
    const first = openDoc('/notes/e.md', 'from store');
    const second = tabsStore.addTab();
    tabsStore.switchTab(second);

    expect(get(tabsStore).tabs.find(t => t.id === first)?.content).toBe('from store');
  });
});

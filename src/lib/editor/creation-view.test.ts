import { describe, it, expect } from 'vitest';
import { chromeFor, applyView, allowsEditorMode, CREATION_VIEWS } from './creation-view';
import type { EditorMode } from '$lib/stores/editor-store';

const MODES: EditorMode[] = ['visual', 'source', 'split'];

describe('chromeFor', () => {
  it('leaves the standard view doing nothing at all', () => {
    expect(chromeFor('standard')).toEqual({
      readOnly: false,
      linksOpenOnClick: false,
      editingAffordances: true,
      focusHighlight: false,
      masksSidebar: false,
      masksAIPanel: false,
    });
  });

  it('makes reading read-only with plain-click links and no editing controls', () => {
    const c = chromeFor('reading');
    expect(c.readOnly).toBe(true);
    expect(c.linksOpenOnClick).toBe(true);
    expect(c.editingAffordances).toBe(false);
  });

  it('keeps the navigation surfaces in reading', () => {
    // Issue #88 asked to view AND navigate. Hiding the outline's host or the
    // file tree would remove the half of the request this view exists for.
    const c = chromeFor('reading');
    expect(c.masksSidebar).toBe(false);
    expect(c.masksAIPanel).toBe(false);
  });

  it('keeps writing fully editable — it only quiets the surroundings', () => {
    const c = chromeFor('writing');
    expect(c.readOnly).toBe(false);
    expect(c.editingAffordances).toBe(true);
    expect(c.focusHighlight).toBe(true);
    expect(c.masksSidebar).toBe(true);
    expect(c.masksAIPanel).toBe(true);
  });

  it('turns each exclusive trait on for exactly one view', () => {
    expect(CREATION_VIEWS.filter((v) => chromeFor(v).focusHighlight)).toEqual(['writing']);
    expect(CREATION_VIEWS.filter((v) => chromeFor(v).readOnly)).toEqual(['reading']);
    expect(CREATION_VIEWS.filter((v) => chromeFor(v).linksOpenOnClick)).toEqual(['reading']);
  });
});

describe('applyView', () => {
  it('pins the rendered surface for reading', () => {
    expect(applyView('reading', 'source', null).mode).toBe('visual');
    expect(applyView('reading', 'split', null).mode).toBe('visual');
  });

  it('remembers the surface reading replaced', () => {
    expect(applyView('reading', 'source', null).stash).toBe('source');
  });

  it('restores that surface on the way back to standard', () => {
    const entered = applyView('reading', 'split', null);
    const left = applyView('standard', entered.mode, entered.stash);
    expect(left.mode).toBe('split');
    expect(left.stash).toBeNull();
  });

  it('does not pin a surface for writing', () => {
    for (const mode of MODES) expect(applyView('writing', mode, null).mode).toBe(mode);
  });

  it('carries a stash through writing on the way back', () => {
    // standard(source) → reading → writing → standard must land on source,
    // not on the visual surface reading pinned.
    const r = applyView('reading', 'source', null);
    const w = applyView('writing', r.mode, r.stash);
    expect(w.stash).toBe('source');
    const back = applyView('standard', w.mode, w.stash);
    expect(back.mode).toBe('source');
    expect(back.stash).toBeNull();
  });

  it('keeps the ORIGINAL surface when reading is re-entered', () => {
    const once = applyView('reading', 'source', null);
    const twice = applyView('reading', once.mode, once.stash);
    expect(twice.stash).toBe('source');
    expect(applyView('standard', twice.mode, twice.stash).mode).toBe('source');
  });

  it('is a no-op reaching standard with nothing stashed', () => {
    // Fresh launch: standard must not reset the surface the user is on.
    for (const mode of MODES) {
      const { mode: next, stash } = applyView('standard', mode, null);
      expect(next).toBe(mode);
      expect(stash).toBeNull();
    }
  });

  it('leaves a writing-only session free to switch surfaces', () => {
    // No stash was ever taken, so writing must not drag the user back to an
    // earlier surface when they pick a new one inside the view.
    const w = applyView('writing', 'visual', null);
    expect(w.stash).toBeNull();
    expect(applyView('writing', 'source', w.stash).mode).toBe('source');
  });
});

describe('allowsEditorMode', () => {
  it('only restricts reading, and only to the rendered surface', () => {
    expect(allowsEditorMode('reading', 'visual')).toBe(true);
    expect(allowsEditorMode('reading', 'source')).toBe(false);
    expect(allowsEditorMode('reading', 'split')).toBe(false);
    for (const mode of MODES) {
      expect(allowsEditorMode('standard', mode)).toBe(true);
      expect(allowsEditorMode('writing', mode)).toBe(true);
    }
  });
});

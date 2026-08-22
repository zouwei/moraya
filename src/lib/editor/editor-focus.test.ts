import { describe, it, expect } from 'vitest';
import { editorHoldsCaret } from './editor-focus';

/** Minimal stand-ins — the function only reads tagName / isContentEditable. */
function el(tag: string, contentEditable = false): Element {
  return { tagName: tag, isContentEditable: contentEditable, contains: () => false } as unknown as Element;
}

describe('editorHoldsCaret', () => {
  const dom = {
    contains: (n: Element) => n === child,
  } as unknown as HTMLElement;
  const child = el('SPAN');

  it('is false without an editor', () => {
    expect(editorHoldsCaret(null, el('DIV'))).toBe(false);
  });

  it('holds when focus is the editor itself or inside it', () => {
    expect(editorHoldsCaret(dom, dom as unknown as Element)).toBe(true);
    expect(editorHoldsCaret(dom, child)).toBe(true);
  });

  it('holds when nothing has focus', () => {
    expect(editorHoldsCaret(dom, null)).toBe(true);
    expect(editorHoldsCaret(dom, el('BODY'))).toBe(true);
  });

  it('holds when focus sits on a plain container', () => {
    // The case that broke the buttons: a click in the document leaves focus
    // on an ancestor div, but the caret is still in the text.
    expect(editorHoldsCaret(dom, el('DIV'))).toBe(true);
    expect(editorHoldsCaret(dom, el('BUTTON'))).toBe(true);
  });

  it('stands down for another text surface', () => {
    expect(editorHoldsCaret(dom, el('INPUT'))).toBe(false);
    expect(editorHoldsCaret(dom, el('TEXTAREA'))).toBe(false);
    expect(editorHoldsCaret(dom, el('SELECT'))).toBe(false);
    expect(editorHoldsCaret(dom, el('DIV', true))).toBe(false);
  });
});

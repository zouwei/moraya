/**
 * "Is the editor still the surface the user is writing in?"
 *
 * The block buttons anchor to the caret, so they need to know whether that
 * caret is still the live one. The obvious test — ProseMirror's own
 * `view.hasFocus()` — turns out to be too strict: clicking in the document
 * can leave DOM focus on an ancestor container rather than on the
 * contenteditable itself (observed in the web build, where the caret is still
 * visibly in the text and typing still works). Gating on it makes the buttons
 * vanish at exactly the moment the user has just clicked the block they want
 * to act on.
 *
 * So the rule is inverted: the editor stays "current" unless some OTHER text
 * surface has taken over. A focused input, textarea, or contenteditable means
 * the caret the user is watching is over there — an AI chat box, a rename
 * field, the source pane — and the block buttons should stand down. Focus on
 * anything else (a container div, a button, `<body>`, nothing at all) leaves
 * the document's caret as the only one in play.
 */
export function editorHoldsCaret(
  editorDom: HTMLElement | null | undefined,
  activeElement: Element | null,
): boolean {
  if (!editorDom) return false;
  // `<body>` is what the browser falls back to when nothing is focused, so it
  // counts as "nobody took it". Compared by tag rather than against
  // `document.body` so this stays a pure function of its arguments — the unit
  // tests run without a DOM.
  if (!activeElement || activeElement.tagName === 'BODY') return true;
  if (activeElement === editorDom || editorDom.contains(activeElement)) return true;
  const tag = activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  return !(activeElement as HTMLElement).isContentEditable;
}

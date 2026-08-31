/**
 * Creation views — the "what am I doing right now" axis.
 *
 * Orthogonal to the editing surface (`EditorMode`: visual / source / split),
 * which answers "what am I looking at". The two compose: writing works on
 * either surface, and only reading pins one, because reading raw markdown
 * read-only serves nobody.
 *
 *   standard  the editor as it has always been
 *   reading   read-only, links open on a plain click, editing affordances gone
 *   writing   immersive: surrounding panels masked, everything but the current
 *             block dimmed
 *
 * Reading exists because of issue #88: links ARE openable today, but only with
 * Cmd/Ctrl held, and the reporter spent long enough looking to conclude the
 * feature was missing. A view where a plain click just works removes the
 * modifier from the equation instead of documenting it better.
 *
 * Panels are MASKED, never switched off: a view hides the sidebar by rendering
 * without it, and `settings.showSidebar` is not touched. Mutating the stored
 * preference would mean an exit that never runs — a crash, a force quit —
 * silently rewrites what the user had chosen. Masking cannot lose anything,
 * because it never wrote anything.
 */

import type { EditorMode } from '$lib/stores/editor-store';

export type CreationView = 'standard' | 'reading' | 'writing';

export const CREATION_VIEWS: CreationView[] = ['standard', 'reading', 'writing'];

export interface ViewChrome {
  /** No caret, no edits — ProseMirror `editable: false`. */
  readOnly: boolean;
  /** A plain click opens a link; no modifier required. */
  linksOpenOnClick: boolean;
  /** Gutter buttons, width handle, table/image toolbars. */
  editingAffordances: boolean;
  /** Dim every top-level block except the one holding the caret. */
  focusHighlight: boolean;
  /** Render without the file sidebar (the setting is left alone). */
  masksSidebar: boolean;
  /** Render without the AI chat panel (the setting is left alone). */
  masksAIPanel: boolean;
}

const CHROME: Record<CreationView, ViewChrome> = {
  standard: {
    readOnly: false,
    linksOpenOnClick: false,
    editingAffordances: true,
    focusHighlight: false,
    masksSidebar: false,
    masksAIPanel: false,
  },
  reading: {
    readOnly: true,
    linksOpenOnClick: true,
    editingAffordances: false,
    focusHighlight: false,
    // Deliberately keeps both. The reporter asked to "view and NAVIGATE", and
    // the outline plus the file tree are how you navigate; taking them away in
    // the name of immersion would remove the half of the request that reading
    // view exists to serve.
    masksSidebar: false,
    masksAIPanel: false,
  },
  writing: {
    // Writing is still writing: everything stays editable. Only the
    // surroundings go quiet.
    readOnly: false,
    linksOpenOnClick: false,
    editingAffordances: true,
    focusHighlight: true,
    masksSidebar: true,
    masksAIPanel: true,
  },
};

export function chromeFor(view: CreationView): ViewChrome {
  return CHROME[view];
}

/**
 * The editing surface a view should show, and what to restore on the way out.
 *
 * Only `editorMode` needs remembering — panels are masked rather than changed,
 * so they have nothing to restore. `stash` holds the mode from before the FIRST
 * pinning view was entered, so standard → reading → writing → standard lands
 * back on the original surface rather than on whatever reading pinned.
 */
export function applyView(
  to: CreationView,
  liveMode: EditorMode,
  stashed: EditorMode | null,
): { mode: EditorMode; stash: EditorMode | null } {
  if (to === 'reading') {
    // Source and split stay visible in the switcher but disabled, so the
    // reason they cannot be picked is on screen rather than inferred.
    return { mode: 'visual', stash: stashed ?? liveMode };
  }
  // Writing does not pin a surface, but it must not drop a stash reading left
  // behind — the user may pass through it on the way back to standard.
  if (to === 'writing') {
    return { mode: stashed ?? liveMode, stash: stashed };
  }
  return { mode: stashed ?? liveMode, stash: null };
}

/**
 * Whether an editing surface can be chosen while `view` is active.
 * Only reading restricts it, and only to 'visual'.
 */
export function allowsEditorMode(view: CreationView, mode: EditorMode): boolean {
  return view !== 'reading' || mode === 'visual';
}

/**
 * Shell-style ↑/↓ recall for the AI chat input.
 *
 * Kept byte-identical to moraya-web's src/lib/ai/input-history.ts — the
 * behaviour must not diverge between desktop and web. A natural home is
 * @moraya/core once this stabilises.
 *
 * Pure on purpose: all the ways this goes wrong are index arithmetic — walking
 * past the oldest entry, losing the half-typed draft when you come back down,
 * or starting from the wrong end after a send. Keeping it out of the component
 * makes those cases directly testable.
 *
 * Model: `index === NOT_BROWSING` means the user is editing a fresh draft.
 * The first ↑ stashes that draft and jumps to the newest sent message; ↓ walks
 * back toward it and finally restores it.
 */

export const NOT_BROWSING = -1

export interface HistoryState {
  /** Position in `history`, or {@link NOT_BROWSING}. */
  index: number
  /** The unsent draft stashed when browsing began. */
  draft: string
}

export interface RecallResult {
  /** Whether the key should be swallowed (i.e. not left to the textarea). */
  consumed: boolean
  state: HistoryState
  /** New input value; absent when nothing should change. */
  text?: string
}

export const initialHistoryState: HistoryState = { index: NOT_BROWSING, draft: '' }

/**
 * Compute the next input value for one ↑ (`up`) or ↓ press.
 *
 * `current` is the live input, stashed as the draft on the first ↑.
 */
export function recall(
  history: readonly string[],
  state: HistoryState,
  current: string,
  up: boolean,
): RecallResult {
  if (history.length === 0) return { consumed: false, state }

  if (state.index === NOT_BROWSING) {
    // ↓ from a fresh draft: there is nothing newer to go to, so let the
    // textarea have the key (caret motion) rather than swallowing it.
    if (!up) return { consumed: false, state }
    const index = history.length - 1
    return { consumed: true, state: { index, draft: current }, text: history[index] }
  }

  const next = state.index + (up ? -1 : 1)

  // Past the oldest: hold position. Swallowed deliberately — wrapping around to
  // the newest would make a long history impossible to walk predictably.
  if (next < 0) return { consumed: true, state }

  // Past the newest: back to the draft the user was typing.
  if (next >= history.length) {
    return { consumed: true, state: { index: NOT_BROWSING, draft: '' }, text: state.draft }
  }

  return { consumed: true, state: { ...state, index: next }, text: history[next] }
}

/**
 * Whether the caret is on the first (`up`) or last line of a textarea.
 *
 * Only then may ↑/↓ be repurposed — otherwise the arrows could never move
 * within a multi-line draft, which is the textarea's own job. An active
 * selection is never hijacked.
 */
export function caretAtEdge(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  up: boolean,
): boolean {
  if (selectionStart !== selectionEnd) return false
  return up
    ? value.lastIndexOf('\n', selectionStart - 1) === -1
    : value.indexOf('\n', selectionStart) === -1
}

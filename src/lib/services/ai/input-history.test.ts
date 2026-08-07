import { describe, it, expect } from 'vitest'
import { recall, caretAtEdge, initialHistoryState, NOT_BROWSING } from './input-history'

const HIST = ['first', 'second', 'third'] // oldest → newest

describe('recall', () => {
  it('does nothing when there is no history', () => {
    const r = recall([], initialHistoryState, 'draft', true)
    expect(r.consumed).toBe(false)
    expect(r.text).toBeUndefined()
  })

  it('first ↑ jumps to the NEWEST message', () => {
    const r = recall(HIST, initialHistoryState, '', true)
    expect(r.text).toBe('third')
    expect(r.state.index).toBe(2)
  })

  it('successive ↑ walks backwards through the history', () => {
    let s = initialHistoryState
    let r = recall(HIST, s, '', true)
    ;({ state: s } = r)
    r = recall(HIST, s, '', true)
    expect(r.text).toBe('second')
    ;({ state: s } = r)
    r = recall(HIST, s, '', true)
    expect(r.text).toBe('first')
  })

  it('holds at the oldest entry instead of wrapping to the newest', () => {
    // Wrapping would make a long history impossible to walk predictably.
    let s: typeof initialHistoryState = { index: 0, draft: '' }
    const r = recall(HIST, s, '', true)
    expect(r.consumed).toBe(true)
    expect(r.text).toBeUndefined()
    expect(r.state.index).toBe(0)
  })

  it('stashes the unsent draft and restores it on the way back down', () => {
    // The whole reason ↓ exists: getting back what you were typing.
    let r = recall(HIST, initialHistoryState, 'half-typed thought', true)
    expect(r.state.draft).toBe('half-typed thought')
    expect(r.text).toBe('third')

    r = recall(HIST, r.state, 'third', false)
    expect(r.text).toBe('half-typed thought')
    expect(r.state.index).toBe(NOT_BROWSING)
  })

  it('restores an EMPTY draft when nothing was typed before browsing', () => {
    let r = recall(HIST, initialHistoryState, '', true)
    r = recall(HIST, r.state, 'third', false)
    expect(r.text).toBe('')
    expect(r.state.index).toBe(NOT_BROWSING)
  })

  it('leaves ↓ to the textarea when not browsing', () => {
    // Swallowing it would break caret motion in a multi-line draft.
    const r = recall(HIST, initialHistoryState, 'draft', false)
    expect(r.consumed).toBe(false)
    expect(r.text).toBeUndefined()
  })

  it('walks back up after coming down to the draft', () => {
    let r = recall(HIST, initialHistoryState, 'd', true) // → third
    r = recall(HIST, r.state, 'third', false) // → draft
    r = recall(HIST, r.state, 'd', true) // → third again
    expect(r.text).toBe('third')
    expect(r.state.index).toBe(2)
  })

  it('handles a single-entry history', () => {
    let r = recall(['only'], initialHistoryState, 'd', true)
    expect(r.text).toBe('only')
    r = recall(['only'], r.state, 'only', true)
    expect(r.text).toBeUndefined() // held at oldest
    r = recall(['only'], r.state, 'only', false)
    expect(r.text).toBe('d') // back to the draft
  })
})

describe('caretAtEdge', () => {
  it('is true on a single-line value', () => {
    expect(caretAtEdge('hello', 2, 2, true)).toBe(true)
    expect(caretAtEdge('hello', 2, 2, false)).toBe(true)
  })

  it('is false when the caret is below the first line (↑)', () => {
    const v = 'one\ntwo'
    expect(caretAtEdge(v, 5, 5, true)).toBe(false)
  })

  it('is true on the first line of a multi-line value (↑)', () => {
    expect(caretAtEdge('one\ntwo', 1, 1, true)).toBe(true)
  })

  it('is false when the caret is above the last line (↓)', () => {
    expect(caretAtEdge('one\ntwo', 1, 1, false)).toBe(false)
  })

  it('is true on the last line of a multi-line value (↓)', () => {
    expect(caretAtEdge('one\ntwo', 5, 5, false)).toBe(true)
  })

  it('never hijacks an active selection', () => {
    expect(caretAtEdge('hello', 0, 3, true)).toBe(false)
    expect(caretAtEdge('hello', 0, 3, false)).toBe(false)
  })
})

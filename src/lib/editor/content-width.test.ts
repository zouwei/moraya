import { describe, it, expect } from 'vitest';
import {
  resizeWidth,
  LINE_WIDTH_MIN,
  LINE_WIDTH_MAX,
  LINE_WIDTH_STEP,
  OUTLINE_MIN_WIDTH,
  OUTLINE_MAX_WIDTH,
} from './content-width';

const LINE = { min: LINE_WIDTH_MIN, max: LINE_WIDTH_MAX, step: LINE_WIDTH_STEP, gain: 2 };
const OUTLINE = { min: OUTLINE_MIN_WIDTH, max: OUTLINE_MAX_WIDTH, gain: 2, leading: true };

describe('resizeWidth — trailing edge of a centred box', () => {
  it('applies twice the pointer delta so the edge stays under the cursor', () => {
    // Dragging right by 60px must move the right edge by 60px, which needs
    // 120px of extra width because the box is centred.
    expect(resizeWidth(800, 60, LINE)).toBe(920);
  });

  it('narrows when dragged left', () => {
    expect(resizeWidth(1000, -60, LINE)).toBe(880);
  });

  it('clamps at both ends of the settings range', () => {
    expect(resizeWidth(1500, 500, LINE)).toBe(LINE_WIDTH_MAX);
    expect(resizeWidth(700, -500, LINE)).toBe(LINE_WIDTH_MIN);
  });

  it('snaps to the step', () => {
    expect(resizeWidth(800, 7, LINE)).toBe(810); // 800 + 14 → 814 → 810
    expect(resizeWidth(800, 8, LINE)).toBe(820); // 800 + 16 → 816 → 820
  });

  it('is derived from the drag origin, not accumulated', () => {
    // Two reads of the same drag must agree, and a return to the origin must
    // restore the starting width exactly — the property that keeps the column
    // pinned to the cursor when a move event is dropped.
    expect(resizeWidth(800, 40, LINE)).toBe(resizeWidth(800, 40, LINE));
    expect(resizeWidth(800, 0, LINE)).toBe(800);
  });

  it('recovers cleanly after being clamped', () => {
    // Drag far past the maximum, then back: the width follows the pointer
    // again as soon as the derived value re-enters the range, with no
    // hysteresis from the excursion.
    expect(resizeWidth(1500, 400, LINE)).toBe(LINE_WIDTH_MAX);
    expect(resizeWidth(1500, 30, LINE)).toBe(1560);
  });
});

describe('resizeWidth — leading edge (outline panel)', () => {
  it('grows when dragged left, like a window border', () => {
    expect(resizeWidth(260, -40, OUTLINE)).toBe(340);
  });

  it('shrinks when dragged right', () => {
    expect(resizeWidth(260, 40, OUTLINE)).toBe(180);
  });

  it('clamps to the outline bounds', () => {
    expect(resizeWidth(400, -400, OUTLINE)).toBe(OUTLINE_MAX_WIDTH);
    expect(resizeWidth(200, 400, OUTLINE)).toBe(OUTLINE_MIN_WIDTH);
  });
});

describe('resizeWidth — direction', () => {
  it('defaults to gain 1 and no snapping for a left-aligned box', () => {
    expect(resizeWidth(200, 33, { min: 0, max: 999 })).toBe(233);
  });

  it('flips physical direction in RTL', () => {
    const ltr = { min: 0, max: 999, gain: 1 };
    const rtl = { ...ltr, rtl: true };
    expect(resizeWidth(200, 30, ltr)).toBe(230);
    expect(resizeWidth(200, 30, rtl)).toBe(170);
  });

  it('flips the leading edge in RTL too', () => {
    // In RTL the leading edge is the RIGHT one, so dragging right grows it.
    expect(resizeWidth(200, 30, { min: 0, max: 999, leading: true, rtl: true })).toBe(230);
  });
});

import { describe, it, expect } from 'vitest';
import { cumulativeLineOffsets, lineOffsetAt } from './line-metrics';

describe('cumulativeLineOffsets', () => {
  it('starts at zero and ends at the total height', () => {
    const offsets = cumulativeLineOffsets([24, 24, 24]);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(72);
  });

  it('is one longer than the input', () => {
    expect(cumulativeLineOffsets([10, 20]).length).toBe(3);
  });

  it('carries the extra height of a wrapped line', () => {
    // The whole point: line 1 wraps to three rows, so line 2 starts 72px down,
    // not 48px as `index * lineHeight` would say.
    const offsets = cumulativeLineOffsets([24, 72, 24]);
    expect(offsets[2]).toBe(96);
    expect(offsets[2]).not.toBe(2 * 24);
  });

  it('handles an empty document', () => {
    expect(cumulativeLineOffsets([])).toEqual([0]);
  });
});

describe('lineOffsetAt', () => {
  const offsets = cumulativeLineOffsets([24, 72, 24]); // [0, 24, 96, 120]

  it('reads a measured line', () => {
    expect(lineOffsetAt(offsets, 2, 24)).toBe(96);
  });

  it('clamps past the last line', () => {
    // Anchors infer how many source lines a rendered block spans, so the
    // estimate can run past the real line count.
    expect(lineOffsetAt(offsets, 999, 24)).toBe(120);
  });

  it('clamps a negative line', () => {
    expect(lineOffsetAt(offsets, -3, 24)).toBe(0);
  });

  it('falls back to the uniform estimate before the ghost is measured', () => {
    expect(lineOffsetAt(null, 5, 24)).toBe(120);
    expect(lineOffsetAt([], 5, 24)).toBe(120);
  });
});

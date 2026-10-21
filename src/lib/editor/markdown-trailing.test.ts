import { describe, it, expect } from 'vitest';
import { trailingBlankParagraphCount, TRAILING_BLANK_CAP } from './markdown-trailing';

describe('trailingBlankParagraphCount', () => {
  it('is 0 with no trailing newline', () => {
    expect(trailingBlankParagraphCount('Hello')).toBe(0);
  });

  it('is 0 for a lone final newline (external files)', () => {
    expect(trailingBlankParagraphCount('Hello\n')).toBe(0);
    expect(trailingBlankParagraphCount('Title\n\nBody\n')).toBe(0);
  });

  it('inverts the serializer mapping N = trailingNewlines - 1', () => {
    // 1 empty paragraph → "text\n\n"
    expect(trailingBlankParagraphCount('Hello\n\n')).toBe(1);
    // 2 → "text\n\n\n"
    expect(trailingBlankParagraphCount('Hello\n\n\n')).toBe(2);
    // 3 → "text\n\n\n\n"
    expect(trailingBlankParagraphCount('Hello\n\n\n\n')).toBe(3);
  });

  it('counts whitespace-only trailing lines (Shift+Enter hard breaks) as blank', () => {
    // "text" + 3 × Shift+Enter in source mode → "text  \n  \n  \n"
    expect(trailingBlankParagraphCount('text  \n  \n  \n')).toBe(2);
    expect(trailingBlankParagraphCount('text\n  \n\t\n')).toBe(2);
    // Trailing spaces on the last text line alone are not a blank line.
    expect(trailingBlankParagraphCount('text  ')).toBe(0);
    expect(trailingBlankParagraphCount('text  \n')).toBe(0);
  });

  it('caps pathological input', () => {
    expect(trailingBlankParagraphCount('x' + '\n'.repeat(10000))).toBe(TRAILING_BLANK_CAP);
  });

  it('handles empty string', () => {
    expect(trailingBlankParagraphCount('')).toBe(0);
  });
});

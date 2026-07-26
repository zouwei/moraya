import { describe, it, expect } from 'vitest';
import { sanitizeMessage } from '../../../scripts/release-message.mjs';

describe('sanitizeMessage', () => {
  it('drops model preamble before the conventional-commit subject', () => {
    // This exact failure shipped into the real v0.45.0 commit.
    const raw = [
      'Good, matches the expected commit style. Now drafting the final message.',
      '',
      'chore(release): v0.45.0 — native Typst editing',
      '',
      '- editor: add a dedicated Typst editor',
    ].join('\n');
    expect(sanitizeMessage(raw)).toBe(
      'chore(release): v0.45.0 — native Typst editing\n\n- editor: add a dedicated Typst editor',
    );
  });

  it('leaves a clean message untouched', () => {
    const raw = 'feat: add Typst export\n\n- exports via the real compiler';
    expect(sanitizeMessage(raw)).toBe(raw);
  });

  it('strips surrounding code fences', () => {
    expect(sanitizeMessage('```\nfix: blank preview\n```')).toBe('fix: blank preview');
    expect(sanitizeMessage('```text\nfix: blank preview\n```')).toBe('fix: blank preview');
  });

  it('recognizes scoped, breaking and all standard commit types', () => {
    for (const subject of [
      'feat(editor)!: drop legacy mode',
      'fix(rust): guard the flush',
      'docs: refresh README',
      'perf(core): cache parses',
      'revert: undo the flush latch',
    ]) {
      expect(sanitizeMessage(`chatter\n\n${subject}\n\nbody`)).toBe(`${subject}\n\nbody`);
    }
  });

  it('keeps the message as-is when no subject line matches', () => {
    // Better to publish an unconventional message than an empty changelog.
    const raw = 'Release notes without a conventional subject.';
    expect(sanitizeMessage(raw)).toBe(raw);
  });

  it('does not truncate at a subject-like word inside the body', () => {
    const raw = 'chore: release v1\n\n- the fix: applies everywhere';
    expect(sanitizeMessage(raw)).toBe(raw);
  });

  it('handles empty / nullish input', () => {
    expect(sanitizeMessage('')).toBe('');
    expect(sanitizeMessage(null)).toBe('');
    expect(sanitizeMessage(undefined)).toBe('');
  });
});

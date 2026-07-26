import { describe, it, expect } from 'vitest';
import {
  sanitizeMessage,
  parseCommitSubjects,
  summarizeCommits,
} from '../../../scripts/release-message.mjs';

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

describe('parseCommitSubjects', () => {
  it('parses type, scope and summary from `git log -- "- %s"` output', () => {
    const [c] = parseCommitSubjects('- feat(editor): align menus across formats');
    expect(c).toMatchObject({ type: 'feat', scope: 'editor', summary: 'align menus across formats' });
  });

  it('tolerates a missing scope and a missing leading dash', () => {
    const [c] = parseCommitSubjects('fix: stop the blank PDF export');
    expect(c).toMatchObject({ type: 'fix', scope: null, summary: 'stop the blank PDF export' });
  });

  it('keeps non-conventional subjects with a null type', () => {
    const [c] = parseCommitSubjects('- tweak some things');
    expect(c).toMatchObject({ type: null, summary: 'tweak some things' });
  });

  it('drops the release bookkeeping commits', () => {
    const out = parseCommitSubjects([
      '- chore: release v0.45.1',
      '- chore(release): v1.2.3 — something',
      '- feat: real work',
    ].join('\n'));
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe('real work');
  });

  it('keeps a release-scoped chore that is not a version bump', () => {
    const out = parseCommitSubjects('- chore(release): curate GitHub release notes');
    expect(out).toHaveLength(1);
    expect(out[0].scope).toBe('release');
  });

  it('returns an empty array for blank input', () => {
    expect(parseCommitSubjects('')).toEqual([]);
    expect(parseCommitSubjects(null)).toEqual([]);
  });
});

describe('summarizeCommits', () => {
  const commits = [
    '- chore: release v0.46.0',
    '- feat(editor): align menus + shortcuts across Markdown and Typst',
    '- fix(export): paginate A4 PDF instead of one tall page',
    '- docs: note the Typst shortcut groups',
  ].join('\n');

  it('leads with the headline feature and counts the rest', () => {
    const out = summarizeCommits(commits, { version: '0.46.0', lastTag: 'v0.45.1' })!;
    expect(out.split('\n')[0]).toBe(
      'chore(release): v0.46.0 — editor: align menus + shortcuts across Markdown and Typst (+2 more)',
    );
  });

  it('groups bullets by type with Features first', () => {
    const out = summarizeCommits(commits, { version: '0.46.0' })!;
    expect(out.indexOf('### Features')).toBeLessThan(out.indexOf('### Fixes'));
    expect(out.indexOf('### Fixes')).toBeLessThan(out.indexOf('### Docs'));
    expect(out).toContain('- **export**: paginate A4 PDF instead of one tall page');
  });

  it('reports the range and excludes the release chore from the count', () => {
    const out = summarizeCommits(commits, { version: '0.46.0', lastTag: 'v0.45.1' })!;
    expect(out).toContain('3 change(s) since v0.45.1.');
    expect(out).not.toContain('release v0.46.0\n');
  });

  it('omits the "(+n more)" suffix for a single change', () => {
    const out = summarizeCommits('- fix: one thing', { version: '1.0.1' })!;
    expect(out.split('\n')[0]).toBe('chore(release): v1.0.1 — one thing');
  });

  it('returns null when there is nothing worth reporting, so the caller can fall back', () => {
    expect(summarizeCommits('', { version: '1.0.0' })).toBeNull();
    expect(summarizeCommits('- chore: release v1.0.0', { version: '1.0.0' })).toBeNull();
  });

  it('produces a message the release workflow will accept (conventional subject)', () => {
    // .github/workflows/release.yml keeps only from the first conventional
    // subject onward; a non-conventional first line would be dropped entirely.
    const out = summarizeCommits('- feat: thing', { version: '2.0.0' });
    expect(out).toMatch(/^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\(.+?\))?!?:/);
  });
});

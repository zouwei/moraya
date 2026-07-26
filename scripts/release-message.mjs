/**
 * Release-message sanitation.
 *
 * `scripts/summarize-release.mjs` drafts the release commit message by handing
 * the diff to Claude. Even with an explicit "output ONLY the commit message"
 * instruction, a model may prepend a line of reasoning — one such line
 * ("Good, matches the expected commit style…") shipped into the real v0.45.0
 * commit and would have leaked into the published GitHub release notes.
 *
 * Plain `.mjs` so `summarize-release.mjs` can import it directly under Node;
 * its unit test lives at `src/lib/utils/release-message.test.ts` because the
 * vitest config only collects `src/**`.
 */

/** Conventional-Commits subject line, e.g. `chore(release): v1.2.3 — …`. */
const SUBJECT_RE =
  /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\(.+?\))?!?:/;

/**
 * Strip anything the model wrapped around the commit message: surrounding code
 * fences, and any preamble before the first Conventional-Commits subject line.
 *
 * When no subject line matches, the input is returned unchanged — publishing an
 * unconventional message beats publishing an empty changelog.
 */
/**
 * @param {unknown} raw Raw model output.
 * @returns {string} The commit message with wrapper text removed.
 */
export function sanitizeMessage(raw) {
  let text = String(raw ?? '')
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  const lines = text.split('\n');
  const start = lines.findIndex((l) => SUBJECT_RE.test(l.trim()));
  if (start > 0) text = lines.slice(start).join('\n').trim();

  return text;
}

// ── Commit-driven summary (mechanical fallback) ───────────────────────────────

/** Order sections by what a reader cares about first. */
const TYPE_ORDER = [
  'feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'style', 'revert', 'chore',
];

/** Section headings per Conventional-Commits type. */
/** @type {Record<string, string>} */
const TYPE_HEADINGS = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Refactors',
  docs: 'Docs',
  test: 'Tests',
  build: 'Build',
  ci: 'CI',
  style: 'Style',
  revert: 'Reverts',
  chore: 'Chores',
};

/**
 * A release/version-bump chore carries no product information for readers.
 * @param {string} subject
 */
function isReleaseChore(subject) {
  return /^chore(\(release\))?!?:\s*(release\s+)?v?\d+\.\d+\.\d+/i.test(subject)
    || /^chore(\(release\))?!?:\s*v?\d+\.\d+\.\d+/i.test(subject);
}

/**
 * Parse `git log --pretty=format:"- %s"` output into structured commits.
 *
 * Accepts lines with or without the leading `- `, tolerates non-conventional
 * subjects (type `null`), and drops release/version-bump chores so a release
 * never lists its own bookkeeping.
 *
 * @param {unknown} raw Raw `git log` output.
 * @returns {Array<{type: string|null, scope: string|null, summary: string, subject: string}>}
 */
export function parseCommitSubjects(raw) {
  return String(raw ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/^-\s+/, '').trim())
    .filter(Boolean)
    .filter((subject) => !isReleaseChore(subject))
    .map((subject) => {
      const m = /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\((.+?)\))?!?:\s*(.+)$/
        .exec(subject);
      if (!m) return { type: null, scope: null, summary: subject, subject };
      return { type: m[1], scope: m[3] ?? null, summary: m[4].trim(), subject };
    });
}

/**
 * Build a feature-oriented release message from the commits since the last tag.
 *
 * Used when the AI draft is unavailable. Previously the fallback printed a raw
 * diffstat ("8 file(s) changed …"), which shipped into the published v0.45.1
 * release notes and told readers nothing about what the release does — while the
 * conventional-commit subjects describing exactly that were already collected.
 *
 * Returns `null` when there is nothing meaningful to report, so the caller can
 * fall back to the diffstat rather than publishing an empty changelog.
 *
 * @param {unknown} rawCommits `git log --pretty=format:"- %s"` output.
 * @param {{version: string, lastTag?: string}} opts
 * @returns {string|null}
 */
export function summarizeCommits(rawCommits, { version, lastTag } = { version: '' }) {
  const commits = parseCommitSubjects(rawCommits);
  if (commits.length === 0) return null;

  const groups = new Map();
  for (const c of commits) {
    const key = c.type ?? 'chore';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  // Headline: name the dominant area so the subject line is informative even
  // before the bullets (feat > fix > whatever came first).
  const lead = commits.find((c) => c.type === 'feat')
    ?? commits.find((c) => c.type === 'fix')
    ?? commits[0];
  const headline = lead.scope ? `${lead.scope}: ${lead.summary}` : lead.summary;
  const extra = commits.length - 1;
  const subject = extra > 0
    ? `chore(release): v${version} — ${headline} (+${extra} more)`
    : `chore(release): v${version} — ${headline}`;

  const sections = [];
  for (const type of TYPE_ORDER) {
    const list = groups.get(type);
    if (!list?.length) continue;
    sections.push(`### ${TYPE_HEADINGS[type] ?? type}`);
    for (const c of list) {
      sections.push(`- ${c.scope ? `**${c.scope}**: ` : ''}${c.summary}`);
    }
    sections.push('');
  }

  const range = lastTag ? ` since ${lastTag}` : '';
  return [
    subject,
    '',
    `${commits.length} change(s)${range}.`,
    '',
    ...sections,
  ].join('\n').trimEnd();
}

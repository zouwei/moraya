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

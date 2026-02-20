/**
 * Frontmatter extraction utility.
 *
 * Milkdown's CommonMark parser treats `---` as thematic breaks, destroying
 * YAML front matter. We strip it before Milkdown sees the markdown and
 * re-attach it on every output so the raw content is always preserved.
 */

// Require at least one non-whitespace character between the `---` fences.
// This prevents two consecutive thematic breaks (`---\n\n---\n`) from being
// mistakenly matched as empty YAML frontmatter.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\S[\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function extractFrontmatter(md: string): { frontmatter: string; body: string } {
  const match = md.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: '', body: md };
  return {
    frontmatter: match[0].endsWith('\n') ? match[0] : match[0] + '\n',
    body: md.slice(match[0].length),
  };
}

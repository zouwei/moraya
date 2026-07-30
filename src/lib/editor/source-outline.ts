/**
 * Heading extraction for the raw-markdown (source) outline.
 *
 * Source mode has no parsed document to walk, so the outline is scanned off the
 * text. A plain per-line `^#{1,6}\s` match is wrong: `#` is a comment in shell,
 * Python, YAML and more, so any code block containing one put a phantom entry in
 * the outline. Fences (and frontmatter) have to be tracked while scanning.
 *
 * Kept separate from SourceEditor.svelte so the fence rules are unit-testable.
 */

export interface SourceHeading {
  /** 0-based line index — the outline uses it to scroll and to pick the active row. */
  line: number;
  level: number;
  text: string;
}

/** An open fence: which char opened it and how long, per CommonMark. */
interface OpenFence {
  char: '`' | '~';
  length: number;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const FRONTMATTER_DELIM_RE = /^(---|\.\.\.)\s*$/;

/**
 * Extract ATX headings from markdown text, skipping fenced code blocks and
 * YAML frontmatter.
 */
export function extractSourceHeadings(content: string): SourceHeading[] {
  const lines = content.split('\n');
  const headings: SourceHeading[] = [];
  let fence: OpenFence | null = null;
  // Frontmatter only counts when `---` is the very first line of the document.
  let inFrontmatter = lines[0] !== undefined && /^---\s*$/.test(lines[0]);

  for (let i = inFrontmatter ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (inFrontmatter) {
      if (FRONTMATTER_DELIM_RE.test(line)) inFrontmatter = false;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);

    if (fence) {
      // A fence closes only on the same character, at least as long, and with
      // nothing after it — so ``` does not get closed by ~~~, and a ``` line
      // inside a ```` block stays content.
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.char &&
        fenceMatch[1]!.length >= fence.length &&
        fenceMatch[2]!.trim() === ''
      ) {
        fence = null;
      }
      continue;
    }

    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const info = fenceMatch[2]!;
      // A backtick fence's info string may not contain a backtick; that rules
      // out inline code like ``a`` being read as an opening fence.
      if (!(marker[0] === '`' && info.includes('`'))) {
        fence = { char: marker[0] as '`' | '~', length: marker.length };
        continue;
      }
    }

    const m = HEADING_RE.exec(line);
    if (m) {
      headings.push({
        line: i,
        level: m[1]!.length,
        // Drop a closing sequence of #s ("## Title ##").
        text: m[2]!.replace(/\s*#+\s*$/, ''),
      });
    }
  }

  return headings;
}

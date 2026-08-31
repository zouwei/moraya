/**
 * Where a link in the document should be sent.
 *
 * The desktop link opener hands every local path to the OS, which is right for
 * a PDF or an image and wrong for a sibling `.md`: a knowledge base whose notes
 * cross-reference each other should follow those references INSIDE Moraya.
 * Issue #88 asked to "view and jump"; jumping out of the app is not jumping.
 *
 * Pure string routing, no I/O — the caller performs the action.
 */

export type LinkTarget =
  /** A Moraya-openable document; `path` is absolute. */
  | { kind: 'document'; path: string }
  /** Anything else local, or a real URL — hand it to the OS. */
  | { kind: 'external'; href: string }
  /** Same-document heading jump; `id` has no leading '#'. */
  | { kind: 'anchor'; id: string };

/** Extensions Moraya can open in a tab of its own. */
const DOCUMENT_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.typ'];

/** `scheme:` at the start — http(s), mailto, obsidian, anything registered. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path);
}

function stripFileScheme(href: string): string {
  let path = href;
  if (path.startsWith('file:///')) path = path.slice(7);
  else if (path.startsWith('file://')) path = path.slice(5);
  else return href;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Directory of `filePath`, without the trailing separator. */
function dirOf(filePath: string): string {
  return filePath.replace(/[/\\][^/\\]*$/, '');
}

/**
 * Resolve `href` against the document it appears in.
 *
 * `currentFilePath` may be null (an unsaved document): a relative path then has
 * no anchor to resolve against, so it is handed over verbatim rather than
 * guessed at.
 */
export function resolveLinkTarget(
  href: string | null | undefined,
  currentFilePath: string | null,
): LinkTarget | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('#')) {
    const id = trimmed.slice(1);
    return id ? { kind: 'anchor', id } : null;
  }

  const unschemed = stripFileScheme(trimmed);
  // A scheme that survived stripping is a real URL (http, mailto, …). Windows
  // drive letters look like a scheme to that regex, so they are checked first.
  if (unschemed === trimmed && !isAbsolutePath(trimmed) && HAS_SCHEME.test(trimmed)) {
    return { kind: 'external', href: trimmed };
  }

  // Query strings and fragments are not part of a file name — strip them
  // before asking whether this is a document, but keep them off the path we
  // hand back too, since neither means anything to a file open.
  const [pathPart] = unschemed.split(/[?#]/, 1);
  const path = pathPart ?? unschemed;
  if (!path) return null;

  const absolute = isAbsolutePath(path)
    ? path
    : currentFilePath
      ? `${dirOf(currentFilePath)}/${path}`
      : null;

  // Relative link in an unsaved document: nothing to resolve against.
  if (absolute === null) return { kind: 'external', href: trimmed };

  const lower = absolute.toLowerCase();
  if (DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { kind: 'document', path: normalize(absolute) };
  }
  return { kind: 'external', href: normalize(absolute) };
}

/**
 * Collapse `.` and `..` segments so a link like `../notes/a.md` becomes a path
 * the file layer can match against an open tab. Separator style is preserved
 * for absolute Windows paths; everything else normalises to '/'.
 */
function normalize(path: string): string {
  const windows = /^[A-Za-z]:[/\\]/.test(path);
  const parts = path.split(/[/\\]/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') {
      // Keep a leading empty segment: it is the POSIX root.
      if (out.length === 0 && part === '') out.push('');
      continue;
    }
    if (part === '..') {
      // Never pop the root or a drive letter.
      if (out.length > 1 || (out.length === 1 && out[0] !== '' && !windows)) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  return windows ? joined : joined || '/';
}

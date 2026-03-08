/**
 * Image path utilities for knowledge base image mirror structure.
 *
 * Convention:
 *   {kbRoot}/images/{mirror-path}/{filename}
 *
 * Where mirror-path mirrors the article's relative path (without .md),
 * capped at a maximum of MAX_IMAGE_DEPTH path segments.
 *
 * Examples:
 *   article: {kbRoot}/article.md         → images/article/
 *   article: {kbRoot}/blog/post.md       → images/blog/post/
 *   article: {kbRoot}/a/b/c/d/post.md   → images/a/b/post/ (truncated)
 *
 * Unsaved article: → images/temp/
 */

/** Maximum depth (path segments) under images/ — including the article name segment. */
const MAX_IMAGE_DEPTH = 3;

/**
 * Compute the target directory for images belonging to a given article
 * within a knowledge base.
 *
 * @param articlePath  Absolute path to the article file (or null if unsaved).
 * @param kbRoot       Absolute path to the knowledge base root directory.
 * @returns            Absolute path to the image save directory (no trailing slash).
 */
export function computeImageDir(
  articlePath: string | null,
  kbRoot: string
): string {
  const base = `${kbRoot}/images`;

  if (!articlePath) {
    return `${base}/temp`;
  }

  // Normalize: remove trailing slash from kbRoot
  const root = kbRoot.replace(/\/$/, '');

  // Strip kbRoot prefix and .md suffix to get the relative article path
  const withoutRoot = articlePath.startsWith(root + '/')
    ? articlePath.slice(root.length + 1)
    : articlePath;

  const withoutExt = withoutRoot.replace(/\.md$/i, '').replace(/\.markdown$/i, '');

  // Split into path segments and filter empty segments
  const parts = withoutExt.split('/').filter(Boolean);

  if (parts.length === 0) {
    return `${base}/temp`;
  }

  // Cap at MAX_IMAGE_DEPTH segments:
  // Keep first (MAX_IMAGE_DEPTH - 1) directory segments + the article name (last segment)
  let dirParts: string[];
  if (parts.length <= MAX_IMAGE_DEPTH) {
    dirParts = parts;
  } else {
    // Take first MAX_IMAGE_DEPTH-1 dirs + the article name
    dirParts = [
      ...parts.slice(0, MAX_IMAGE_DEPTH - 1),
      parts[parts.length - 1],
    ];
  }

  return `${base}/${dirParts.join('/')}`;
}

/**
 * Compute the relative image path (relative to kbRoot) for markdown references.
 * e.g. "images/blog/post/hero.jpg"
 */
export function computeImageRelativePath(
  articlePath: string | null,
  kbRoot: string,
  filename: string
): string {
  const dir = computeImageDir(articlePath, kbRoot);
  const root = kbRoot.replace(/\/$/, '');
  const relDir = dir.startsWith(root + '/') ? dir.slice(root.length + 1) : dir;
  return `${relDir}/${filename}`;
}

/**
 * Check whether an article path belongs to the given knowledge base.
 */
export function isInsideKnowledgeBase(
  articlePath: string | null,
  kbRoot: string
): boolean {
  if (!articlePath || !kbRoot) return false;
  const root = kbRoot.replace(/\/$/, '');
  return articlePath.startsWith(root + '/') || articlePath === root;
}

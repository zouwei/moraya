/**
 * LRU cache for ProseMirror documents.
 *
 * Avoids re-parsing markdown when switching back to a previously opened file.
 * Keyed by filePath + DJB2 hash of the markdown content. Max 10 entries.
 */

import type { Node as PmNode } from 'prosemirror-model';

/** DJB2 hash — fast, good distribution for text content. */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0; // unsigned
}

function cacheKey(filePath: string, md: string): string {
  return filePath + ':' + djb2(md);
}

const MAX_ENTRIES = 10;

class DocLRUCache {
  private map = new Map<string, PmNode>();

  /** Get a cached doc. Returns undefined on miss. Moves to end (most recent) on hit. */
  get(filePath: string, md: string): PmNode | undefined {
    const key = cacheKey(filePath, md);
    const doc = this.map.get(key);
    if (doc === undefined) return undefined;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, doc);
    return doc;
  }

  /** Store a parsed doc. Evicts oldest entry if at capacity. */
  set(filePath: string, md: string, doc: PmNode): void {
    const key = cacheKey(filePath, md);
    // If already present, delete first so re-insert goes to end
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= MAX_ENTRIES) {
      // Evict oldest (first key in Map iteration order)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, doc);
  }

  /** Invalidate all entries for a given file path (e.g. after save). */
  invalidate(filePath: string): void {
    const prefix = filePath + ':';
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
      }
    }
  }

  /** Clear all cached documents. */
  clear(): void {
    this.map.clear();
  }
}

export const docCache = new DocLRUCache();

export function invalidateDocCache(filePath: string): void {
  docCache.invalidate(filePath);
}

export function clearDocCache(): void {
  docCache.clear();
}

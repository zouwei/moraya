import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  INSERT_GROUPS,
  INSERT_ITEMS,
  INLINE_ACTIONS,
  type InsertActionId,
} from './block-insert-items';

/**
 * Flattened key set from the published locale bundle — the same file the
 * i18n-coverage CI gate reads. The gate only sees keys written as literal
 * `t('…')` calls, and these live in a data table instead, so this test is
 * what stops a typo'd key from shipping as raw `menu.heading9` in the UI.
 */
function definedKeys(): Set<string> {
  const path = resolve(process.cwd(), 'node_modules/@moraya/core/dist/i18n/locales/en.json');
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const out = new Set<string>();
  (function walk(node: unknown, prefix: string) {
    if (typeof node !== 'object' || node === null) return;
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith('__')) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') out.add(key);
      else walk(v, key);
    }
  })(json, '');
  return out;
}

describe('block insert catalogue', () => {
  it('gives every row a label that exists in the locale bundle', () => {
    const defined = definedKeys();
    const missing = INSERT_ITEMS.filter((i) => !defined.has(i.labelKey)).map((i) => i.labelKey);
    expect(missing).toEqual([]);
  });

  it('has no duplicate ids', () => {
    const ids = INSERT_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every row something to render in the icon slot', () => {
    const blank = INSERT_ITEMS.filter((i) => !i.glyph && !i.svg).map((i) => i.id);
    expect(blank).toEqual([]);
  });

  it('teaches the markdown for every row except plain paragraph', () => {
    const noHint = INSERT_ITEMS.filter((i) => !i.hint).map((i) => i.id);
    expect(noHint).toEqual(['paragraph']);
  });

  it('keeps the flattened list in sync with the groups', () => {
    expect(INSERT_ITEMS.length).toBe(INSERT_GROUPS.reduce((n, g) => n + g.length, 0));
  });

  it('marks exactly the mark-applying rows as inline', () => {
    const expected: InsertActionId[] = ['link', 'bold', 'italic', 'strike', 'inlineCode'];
    expect([...INLINE_ACTIONS].sort()).toEqual([...expected].sort());
    // Every inline id must actually be a row in the menu.
    const ids = new Set(INSERT_ITEMS.map((i) => i.id));
    for (const id of INLINE_ACTIONS) expect(ids.has(id)).toBe(true);
  });
});

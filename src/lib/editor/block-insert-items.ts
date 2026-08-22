/**
 * The block-insert menu's catalogue — what the "+" button in the editor's
 * left gutter offers.
 *
 * The point of this menu is that markdown is a barrier: a writer who does not
 * know that `> ` makes a quote cannot discover it by looking at the editor.
 * So every row carries three things — an icon, a plain-language name, and the
 * markdown it produces. The last one is deliberate teaching: after picking
 * "Quote" a few times and seeing `>` in the hint column, the syntax stops
 * being a secret.
 *
 * Labels reuse the keys the app menu already ships (`menu.*`), so this menu
 * is translated everywhere the menu bar is, in all 12 locales, with no new
 * strings to keep in sync. block-insert-items.test.ts holds that line: it
 * fails if a key here is absent from the locale bundle.
 *
 * Icons are inline SVG bodies on a 16×16 grid rather than a sprite or an icon
 * font — the app has no icon system, and 16 small paths are cheaper than
 * introducing one.
 */

export type InsertActionId =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'quote'
  | 'codeBlock'
  | 'table'
  | 'mathBlock'
  | 'horizontalRule'
  | 'image'
  | 'link'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode';

export interface InsertItem {
  id: InsertActionId;
  /** i18n key for the row's label. Must exist in the locale bundle. */
  labelKey: string;
  /** The markdown this row writes, shown greyed on the right as a lesson. */
  hint: string;
  /** Short text glyph, for rows whose notation IS the icon (H1, B, I). */
  glyph?: string;
  /** Inner SVG markup on a 16×16 viewBox; strokes use currentColor. */
  svg?: string;
  /** Type styling for `glyph`. */
  glyphStyle?: 'bold' | 'italic' | 'strike' | 'mono';
}

const line = (y: number, x1 = 6, x2 = 14) =>
  `<path d="M${x1} ${y}h${x2 - x1}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
const dot = (y: number) => `<circle cx="3" cy="${y}" r="1.25" fill="currentColor"/>`;

/**
 * Rows in display order, grouped. Each inner array renders as one section
 * with a divider after it — the same visual language as EditorContextMenu.
 */
export const INSERT_GROUPS: InsertItem[][] = [
  [
    { id: 'paragraph', labelKey: 'menu.paragraph', hint: '', glyph: '¶' },
    { id: 'h1', labelKey: 'menu.heading1', hint: '#', glyph: 'H1' },
    { id: 'h2', labelKey: 'menu.heading2', hint: '##', glyph: 'H2' },
    { id: 'h3', labelKey: 'menu.heading3', hint: '###', glyph: 'H3' },
  ],
  [
    {
      id: 'bulletList',
      labelKey: 'menu.bullet_list',
      hint: '-',
      svg: dot(4) + dot(8) + dot(12) + line(4) + line(8) + line(12),
    },
    {
      id: 'orderedList',
      labelKey: 'menu.ordered_list',
      hint: '1.',
      svg:
        `<text x="0" y="6" font-size="6" fill="currentColor">1</text>` +
        `<text x="0" y="11" font-size="6" fill="currentColor">2</text>` +
        `<text x="0" y="16" font-size="6" fill="currentColor">3</text>` +
        line(4) + line(9) + line(14),
    },
    {
      id: 'taskList',
      labelKey: 'menu.task_list',
      hint: '- [ ]',
      svg:
        `<rect x="1" y="2" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>` +
        `<path d="M2.6 5.5 4.2 7 6.6 3.9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<rect x="1" y="11" width="7" height="4" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>` +
        line(5.5, 10, 15) + line(13, 10, 15),
    },
  ],
  [
    {
      id: 'quote',
      labelKey: 'menu.quote',
      hint: '>',
      svg:
        `<path d="M2 3v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` +
        line(5, 6, 14) + line(8, 6, 12) + line(11, 6, 14),
    },
    {
      id: 'codeBlock',
      labelKey: 'menu.code_block',
      hint: '```',
      svg:
        `<path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    },
    {
      id: 'table',
      labelKey: 'menu.table',
      hint: '|',
      svg:
        `<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>` +
        `<path d="M1.5 6.5h13M6.5 6.5v7" stroke="currentColor" stroke-width="1.5"/>`,
    },
    {
      id: 'mathBlock',
      labelKey: 'menu.math_block',
      hint: '$$',
      glyph: '∑',
    },
    {
      id: 'horizontalRule',
      labelKey: 'menu.horizontal_rule',
      hint: '---',
      svg: line(8, 1.5, 14.5),
    },
    {
      id: 'image',
      labelKey: 'menu.image',
      hint: '![]()',
      svg:
        `<rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>` +
        `<circle cx="5.5" cy="6.5" r="1.25" fill="currentColor"/>` +
        `<path d="M2.5 12l3.5-4 3 3 2-2 3 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
    },
  ],
  [
    {
      id: 'link',
      labelKey: 'menu.link',
      hint: '[]()',
      svg:
        `<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-1 1" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>` +
        `<path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.2 9.1a2.6 2.6 0 0 0 3.7 3.7l1-1" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>`,
    },
    { id: 'bold', labelKey: 'menu.bold', hint: '**', glyph: 'B', glyphStyle: 'bold' },
    { id: 'italic', labelKey: 'menu.italic', hint: '*', glyph: 'I', glyphStyle: 'italic' },
    { id: 'strike', labelKey: 'menu.strikethrough', hint: '~~', glyph: 'S', glyphStyle: 'strike' },
    { id: 'inlineCode', labelKey: 'menu.code', hint: '`', glyph: '<>', glyphStyle: 'mono' },
  ],
];

/** Every row, flattened — for keyboard navigation and lookups. */
export const INSERT_ITEMS: InsertItem[] = INSERT_GROUPS.flat();

/**
 * Rows that apply a mark to sample text rather than changing the block type.
 * The caller inserts a short placeholder and leaves it selected, so the user
 * types over it and the formatting sticks — an empty caret with a stored mark
 * would look like nothing happened at all.
 */
export const INLINE_ACTIONS: ReadonlySet<InsertActionId> = new Set<InsertActionId>([
  'link',
  'bold',
  'italic',
  'strike',
  'inlineCode',
]);

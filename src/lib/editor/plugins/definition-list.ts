/**
 * Definition list plugin for Milkdown.
 *
 * Adds support for the definition list syntax:
 *
 *   Term
 *   :   Definition
 *
 * Uses remark-definition-list for markdown parsing/serialization
 * and custom ProseMirror node schemas for rendering.
 */

import { $remark, $nodeSchema, $inputRule } from '@milkdown/utils';
import { remarkDefinitionList } from 'remark-definition-list';
import { wrappingInputRule } from '@milkdown/prose/inputrules';

// ── Remark plugin ──────────────────────────────────────────────

/**
 * Register the remark-definition-list plugin so that Milkdown's
 * markdown parser/serializer can handle defList / defListTerm /
 * defListDescription mdast nodes.
 */
export const defListRemarkPlugin = $remark(
  'defList',
  () => remarkDefinitionList,
);

// ── Node schemas ───────────────────────────────────────────────

/**
 * <dl> — definition list container.
 */
export const defListSchema = $nodeSchema('defList', () => ({
  content: '(defListTerm | defListDescription)+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dl' }],
  toDOM: () => ['dl', { class: 'definition-list' }, 0] as const,
  parseMarkdown: {
    match: (node: any) => node.type === 'defList',
    runner: (state: any, node: any, type: any) => {
      state.openNode(type);
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: any) => node.type.name === 'defList',
    runner: (state: any, node: any) => {
      state.openNode('defList');
      state.next(node.content);
      state.closeNode();
    },
  },
}));

/**
 * <dt> — definition term.
 */
export const defListTermSchema = $nodeSchema('defListTerm', () => ({
  content: 'inline*',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dt' }],
  toDOM: () => ['dt', 0] as const,
  parseMarkdown: {
    match: (node: any) => node.type === 'defListTerm',
    runner: (state: any, node: any, type: any) => {
      state.openNode(type);
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: any) => node.type.name === 'defListTerm',
    runner: (state: any, node: any) => {
      state.openNode('defListTerm');
      state.next(node.content);
      state.closeNode();
    },
  },
}));

/**
 * <dd> — definition description.
 */
export const defListDescriptionSchema = $nodeSchema('defListDescription', () => ({
  content: 'block+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dd' }],
  toDOM: () => ['dd', 0] as const,
  parseMarkdown: {
    match: (node: any) => node.type === 'defListDescription',
    runner: (state: any, node: any, type: any) => {
      state.openNode(type);
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: any) => node.type.name === 'defListDescription',
    runner: (state: any, node: any) => {
      state.openNode('defListDescription');
      state.next(node.content);
      state.closeNode();
    },
  },
}));

// ── Input rule ─────────────────────────────────────────────────

/**
 * Typing `:   ` (colon + 3 spaces) at the start of a line
 * wraps the current block in a definition description inside a definition list.
 */
export const defListInputRule = $inputRule((ctx) => {
  return wrappingInputRule(
    /^:\s{3}$/,
    defListDescriptionSchema.type(ctx),
  );
});

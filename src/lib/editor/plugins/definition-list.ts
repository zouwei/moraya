/**
 * Definition list input rule.
 *
 * Typing `:   ` (colon + 3 spaces) at the start of a line
 * wraps the current block in a definition description inside a definition list.
 *
 * Note: node schemas are defined in schema.ts, markdown parsing is handled
 * by markdown-it-deflist in markdown.ts.
 */

import { wrappingInputRule } from 'prosemirror-inputrules';
import type { InputRule } from 'prosemirror-inputrules';
import { schema } from '../schema';

export function createDefListInputRule(): InputRule {
  return wrappingInputRule(
    /^:\s{3}$/,
    schema.nodes.defListDescription,
  );
}

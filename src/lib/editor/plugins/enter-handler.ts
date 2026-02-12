/**
 * Enter key handler plugin for Milkdown (style).
 *
 * - Enter: split the current block into a new paragraph (no <br/>).
 * - Shift+Enter: insert a hard break (<br/>) within the same paragraph.
 *
 * Uses handleKeyDown (props-level) which has higher priority than keymaps,
 * ensuring this runs before Milkdown's built-in hardbreak keymap.
 */

import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import {
  splitBlock,
  chainCommands,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
} from '@milkdown/prose/commands';

const enterHandlerKey = new PluginKey('enter-handler');

/**
 * Milkdown plugin that intercepts Enter at the props level (higher priority than keymaps).
 */
export const enterHandlerPlugin = $prose(() => {
  const enterCommand = chainCommands(
    newlineInCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlock
  );

  return new Plugin({
    key: enterHandlerKey,
    props: {
      handleKeyDown(view, event) {
        // Only handle plain Enter (no Shift, no Cmd/Ctrl)
        if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
          return enterCommand(view.state, view.dispatch, view);
        }
        return false;
      },
    },
  });
});

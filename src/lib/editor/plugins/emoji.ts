/**
 * Lightweight emoji plugin.
 *
 * Converts emoji shortcodes like :smile: → 😄 using node-emoji.
 * Uses system native emoji rendering (no twemoji images).
 *
 * - Typing `:smile:` auto-converts to 😄 when the closing `:` is typed
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { get as getEmoji } from 'node-emoji';

const emojiPluginKey = new PluginKey('emoji');

/**
 * ProseMirror plugin that converts :shortcode: to native emoji on typing.
 */
export function createEmojiPlugin(): Plugin {
  return new Plugin({
    key: emojiPluginKey,
    props: {
      handleTextInput(view, from, to, text) {
        // Only trigger when user types ":"
        if (text !== ':') return false;

        const { state } = view;
        const $pos = state.doc.resolve(from);
        // Get text content of the current text block up to cursor
        const textBefore = $pos.parent.textBetween(
          0,
          $pos.parentOffset,
          undefined,
          '\ufffc',
        );

        // Find the last unmatched ":" before cursor
        const lastColon = textBefore.lastIndexOf(':');
        if (lastColon === -1) return false;

        // Extract potential shortcode name between the two colons
        const shortcode = textBefore.slice(lastColon + 1);

        // Validate: must be non-empty and contain only valid chars
        if (!shortcode || !/^[a-zA-Z0-9_+-]+$/.test(shortcode)) return false;

        const emoji = getEmoji(shortcode);
        if (!emoji) return false;

        // Calculate absolute positions
        // The opening ":" is at: from - (textBefore.length - lastColon)
        const openColonOffset = textBefore.length - lastColon;
        const replaceFrom = from - openColonOffset;

        // Replace `:shortcode:` (including the just-typed closing `:`) with emoji
        const tr = state.tr.replaceWith(
          replaceFrom,
          to, // `to` is where the closing ":" would be inserted
          state.schema.text(emoji),
        );
        view.dispatch(tr);
        return true;
      },
    },
  });
}

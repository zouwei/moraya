import type { EditorState, Transaction } from 'prosemirror-state';
import type { Node as ProseMirrorNode } from 'prosemirror-model';

/** Replace every matching image source in the current editor state. */
export function replaceDocumentImageUrl(
  state: EditorState,
  oldUrl: string,
  newUrl: string,
): { transaction: Transaction; count: number } {
  const matches: Array<{ pos: number; node: ProseMirrorNode; content?: string }> = [];

  state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === oldUrl) {
      matches.push({ pos, node });
    } else if (node.type.name === 'html_inline') {
      const value = node.attrs.value as string;
      if (/^<img\s/i.test(value) && value.includes(oldUrl)) {
        matches.push({ pos, node, content: value.replaceAll(oldUrl, newUrl) });
      }
    } else if (node.type.name === 'html_block') {
      const value = node.textContent;
      if (/<img\s/i.test(value) && value.includes(oldUrl)) {
        matches.push({ pos, node, content: value.replaceAll(oldUrl, newUrl) });
      }
    }
  });

  const transaction = state.tr;
  for (const { pos, node, content } of matches.reverse()) {
    if (node.type.name === 'image') {
      transaction.setNodeMarkup(pos, undefined, { ...node.attrs, src: newUrl });
    } else if (node.type.name === 'html_inline') {
      transaction.setNodeMarkup(pos, undefined, { ...node.attrs, value: content });
    } else if (content !== undefined) {
      transaction.replaceWith(pos + 1, pos + node.nodeSize - 1, state.schema.text(content));
    }
  }

  return { transaction, count: matches.length };
}

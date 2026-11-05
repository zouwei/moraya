// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createEditor } from './setup';

describe('desktop code block events', () => {
  it('forwards pre padding clicks to ProseMirror without forwarding toolbar clicks', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const editor = await createEditor({
      root,
      defaultValue: '```text\nfirst\n\n\nlast\n```',
    });

    try {
      const onMouseDown = vi.fn(() => false);
      editor.view.setProps({ handleDOMEvents: { mousedown: onMouseDown } });

      root.querySelector('.code-block-pre')!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      );
      expect(onMouseDown).toHaveBeenCalledTimes(1);

      root.querySelector('.code-block-toolbar')!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      );
      expect(onMouseDown).toHaveBeenCalledTimes(1);
    } finally {
      editor.destroy();
      root.remove();
    }
  });
});

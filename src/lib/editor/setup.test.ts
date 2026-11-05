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

  it('places a click on pre whitespace at the clicked blank code line', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const editor = await createEditor({
      root,
      defaultValue: '```text\nfirst\n\n\nlast\n```',
    });

    try {
      const pre = root.querySelector('.code-block-pre') as HTMLElement;
      pre.style.lineHeight = '24px';
      vi.spyOn(pre, 'getBoundingClientRect').mockReturnValue({
        top: 100, bottom: 220, left: 0, right: 600, width: 600, height: 120,
      } as DOMRect);

      pre.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        clientX: 400,
        clientY: 100 + 2 * 24 + 12,
      }));

      expect(editor.view.state.selection.$from.parent.type.name).toBe('code_block');
      expect(editor.view.state.selection.$from.parentOffset).toBe(7);
    } finally {
      editor.destroy();
      root.remove();
    }
  });
});

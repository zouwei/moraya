/**
 * Unified editor props plugin — merges 5 separate ProseMirror plugins into one.
 *
 * Consolidated props:
 *  - transformPastedHTML: paste language fix (copy class="language-xxx" → data-language)
 *  - handleClickOn: image click → TextSelection (prevent NodeSelection blue highlight)
 *  - handleKeyDown: macOS Cmd+A / Ctrl+A → AllSelection fix
 *  - decorations: WKWebView caret fix for empty paragraphs
 *  - view lifecycle: scroll-after-paste (scroll .editor-wrapper to cursor)
 *
 * Reducing 5 plugin instances to 1 saves ~4 apply() traversals per transaction.
 */

import { AllSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const editorPropsKey = new PluginKey('moraya-editor-props');

const isMac = typeof document !== 'undefined' &&
  document.body.classList.contains('platform-macos');

export function createEditorPropsPlugin(): Plugin {
  // scroll-after-paste state
  let pendingPaste = false;

  return new Plugin({
    key: editorPropsKey,

    props: {
      /**
       * Paste language normalization:
       * Copy class="language-xxx" from <code> to data-language on parent <pre>,
       * so parseDOM can read the language correctly.
       */
      transformPastedHTML(html) {
        if (!html.includes('language-')) return html;

        try {
          const template = document.createElement('template');
          template.innerHTML = html;
          const fragment = template.content;

          for (const pre of fragment.querySelectorAll('pre')) {
            if (pre.dataset.language) continue;
            const code = pre.querySelector('code');
            if (!code) continue;
            const match = code.className.match(/(?:language|lang)-(\S+)/);
            if (match) {
              pre.dataset.language = match[1];
            }
          }

          return template.innerHTML;
        } catch {
          return html;
        }
      },

      /**
       * Image click handler:
       * Prevent NodeSelection (blue highlight) on image click — place TextSelection after image.
       */
      handleClickOn(view, _pos, node, nodePos, event) {
        if (node.type.name !== 'image') return false;
        if (event.button !== 0) return false;

        const $pos = view.state.doc.resolve(nodePos + node.nodeSize);
        const sel = TextSelection.near($pos);
        view.dispatch(view.state.tr.setSelection(sel));
        return true;
      },

      /**
       * macOS Cmd+A / Ctrl+A fix:
       * Intercept before native menu accelerator and dispatch proper AllSelection.
       */
      handleKeyDown(view, event) {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && !event.shiftKey && !event.altKey && event.key === 'a') {
          event.preventDefault();
          const tr = view.state.tr.setSelection(new AllSelection(view.state.doc));
          view.dispatch(tr);
          return true;
        }
        return false;
      },

      /**
       * WKWebView caret fix:
       * Add 'caret-empty-para' decoration to empty paragraph under cursor on macOS.
       */
      decorations(state) {
        if (!isMac) return DecorationSet.empty;
        const { selection } = state;
        if (!selection.empty) return DecorationSet.empty;

        const { $from } = selection;
        const parent = $from.parent;
        if (parent.type.name === 'paragraph' && parent.content.size === 0) {
          const pos = $from.before();
          return DecorationSet.create(state.doc, [
            Decoration.node(pos, pos + parent.nodeSize, { class: 'caret-empty-para' }),
          ]);
        }
        return DecorationSet.empty;
      },
    },

    /**
     * Scroll-after-paste:
     * Capture-phase paste listener detects paste, then scroll on next doc update.
     */
    view(editorView) {
      function onPaste() { pendingPaste = true; }
      editorView.dom.addEventListener('paste', onPaste, true);

      return {
        update(view, prevState) {
          if (!pendingPaste || view.state.doc.eq(prevState.doc)) return;
          pendingPaste = false;
          requestAnimationFrame(() => {
            try {
              const { from } = view.state.selection;
              const coords = view.coordsAtPos(from);
              const wrapper = view.dom.closest('.editor-wrapper') as HTMLElement | null;
              if (!wrapper) return;
              const rect = wrapper.getBoundingClientRect();
              if (coords.top < rect.top || coords.bottom > rect.bottom) {
                wrapper.scrollTop += coords.top - rect.top - rect.height / 2;
              }
            } catch { /* ignore */ }
          });
        },
        destroy() {
          editorView.dom.removeEventListener('paste', onPaste, true);
        },
      };
    },
  });
}

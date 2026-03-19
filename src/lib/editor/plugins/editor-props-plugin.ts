/**
 * Unified editor props plugin — merges 5 separate ProseMirror plugins into one.
 *
 * Consolidated props:
 *  - clipboardTextParser: parse pasted plain text as Markdown (render instead of escape)
 *  - transformPastedHTML: paste language fix (copy class="language-xxx" → data-language)
 *  - handleDOMEvents.mousedown: math_block click → prevent WebKit broken selection
 *  - handleDOMEvents.keydown/keyup: toggle link-hover cursor class on Cmd/Ctrl
 *  - handleClickOn: image click → TextSelection (prevent NodeSelection blue highlight)
 *  - handleKeyDown: macOS Cmd+A / Ctrl+A → AllSelection fix
 *  - decorations: WKWebView caret fix for empty paragraphs
 *  - view lifecycle: scroll-after-paste (scroll .editor-wrapper to cursor)
 *
 * Reducing 5 plugin instances to 1 saves ~4 apply() traversals per transaction.
 */

import { Fragment, Slice } from 'prosemirror-model';
import { AllSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { editorStore } from '../../stores/editor-store';
import { isMacOS } from '../../utils/platform';
import { parseMarkdown } from '../markdown';

const editorPropsKey = new PluginKey('moraya-editor-props');

/** Detect whether a URL is a local file path (absolute or relative). */
function isLocalFilePath(href: string): boolean {
  // Absolute Unix/macOS paths
  if (href.startsWith('/')) return true;
  // Relative paths
  if (href.startsWith('./') || href.startsWith('../')) return true;
  // Windows absolute paths
  if (/^[A-Za-z]:[/\\]/.test(href)) return true;
  // file:// protocol
  if (href.startsWith('file://')) return true;
  return false;
}

/** Resolve a local path href to an absolute path for opening. */
function resolveLocalPath(href: string): string {
  // Strip file:// protocol and decode URL-encoded characters (e.g. %E7%9F%A5 → 知)
  let path = href;
  if (path.startsWith('file:///')) {
    path = path.slice(7); // file:///path → /path
    try { path = decodeURIComponent(path); } catch { /* keep as-is */ }
  } else if (path.startsWith('file://')) {
    path = path.slice(5); // file://path → //path (UNC)
    try { path = decodeURIComponent(path); } catch { /* keep as-is */ }
  }

  // Already absolute
  if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)) return path;

  // Relative path: resolve against current file's directory
  const currentFile = editorStore.getState().currentFilePath;
  if (currentFile) {
    const dir = currentFile.replace(/[/\\][^/\\]*$/, '');
    return dir + '/' + path;
  }
  return path;
}

export function createEditorPropsPlugin(): Plugin {
  // scroll-after-paste state
  let pendingPaste = false;

  return new Plugin({
    key: editorPropsKey,

    props: {
      /**
       * Parse pasted plain text as Markdown so that syntax renders
       * instead of being inserted as escaped literal text.
       */
      clipboardTextParser(text, $context, plain) {
        if (plain || $context.parent.type.spec.code) return undefined!;
        const doc = parseMarkdown(text);
        // If markdown parse produced a single empty paragraph (e.g. `[]()` → empty link
        // with no text, dropped by parser), fall back to literal text insertion.
        // This prevents the empty result from replacing/deleting the current selection.
        // Note: doc.content.size === 2 means exactly one empty paragraph wrapper.
        // Images, HRs, code blocks etc. produce size > 2 and are handled normally.
        if (doc.textContent.length === 0 && doc.content.size <= 2) return undefined!;
        const content = doc.content;
        // Single paragraph → extract inline content so it merges into current text
        if (content.childCount === 1 && content.firstChild!.type.name === 'paragraph') {
          return new Slice(content.firstChild!.content, 0, 0);
        }
        return new Slice(content, 0, 0);
      },

      /**
       * Safety net for degenerate pastes.
       *
       * Two cases handled:
       *
       * 1. Markdown link patterns with empty text or URL (e.g. `[]()`,
       *    `[](url)`, `[text]()`) — the markdown parser or HTML parser may
       *    produce an empty link that ProseMirror drops, causing the paste to
       *    insert nothing (looks like content was "deleted").  Intercept early
       *    and insert the raw text literally.
       *
       * 2. Generic empty slice — clipboard text/html produced a Slice with no
       *    text content but clipboard text/plain is non-empty.
       */
      handlePaste(view, event, slice) {
        const plain = event.clipboardData?.getData('text/plain');
        if (!plain) return false;

        // Case 1: link pattern with empty text or empty URL
        const trimmed = plain.trim();
        const linkMatch = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(trimmed);
        if (linkMatch && (!linkMatch[1] || !linkMatch[2])) {
          const textNode = view.state.schema.text(plain);
          view.dispatch(
            view.state.tr.replaceSelection(new Slice(Fragment.from(textNode), 0, 0)),
          );
          pendingPaste = true;
          return true;
        }

        // Case 2: degenerate slice (e.g. empty <a> tag from HTML clipboard)
        try {
          const sliceText = slice.content.textBetween(0, slice.content.size, '', '');
          if (sliceText.trim().length === 0 && trimmed.length > 0) {
            const textNode = view.state.schema.text(plain);
            view.dispatch(
              view.state.tr.replaceSelection(new Slice(Fragment.from(textNode), 0, 0)),
            );
            pendingPaste = true;
            return true;
          }
        } catch { /* malformed slice — fall through */ }

        return false;
      },

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
       * Intercept mousedown on math_block at the DOM level.
       *
       * Why mousedown instead of handleClickOn:
       * In WebKit (Tauri WebView), clicking on a contenteditable="false" atom
       * block causes the browser to create a broken native range selection that
       * extends to surrounding text (visible as blue overlay on paragraphs above
       * the formula). ProseMirror's handleClickOn fires too late (on click, after
       * the selection is already created), and posAtCoords often maps the click
       * to the paragraph above instead of the math_block, so handleClickOn never
       * receives node=math_block.
       *
       * By intercepting mousedown + preventDefault, we stop WebKit from creating
       * the broken selection and place a proper TextSelection ourselves.
       */
      handleDOMEvents: {
        /**
         * Safety: prevent WebView navigation on any remaining <a> clicks.
         * (Most <a> tags get expanded to literal text on mousedown, but this
         * is a fallback in case the click fires before the expand.)
         */
        click(view, event) {
          const me = event as MouseEvent;
          const target = me.target as HTMLElement | null;
          if (!target) return false;
          const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
          if (anchor) {
            me.preventDefault();
          }
          return false;
        },

        mousedown(view, event) {
          const me = event as MouseEvent;
          if (me.button !== 0) return false;
          const target = me.target as HTMLElement | null;
          if (!target) return false;

          // ── Cmd/Ctrl+click on links → open externally ──
          // Must be handled in mousedown BEFORE ProseMirror places cursor,
          // because the link-text-plugin's appendTransaction expands link
          // marks to literal text on cursor entry, removing <a> from DOM
          // before the click event fires.
          if (me.metaKey || me.ctrlKey) {
            const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
            if (anchor) {
              const href = anchor.getAttribute('href');
              if (href) {
                me.preventDefault();

                if (isLocalFilePath(href)) {
                  const resolvedPath = resolveLocalPath(href);
                  import('@tauri-apps/plugin-opener')
                    .then(({ openPath }) => openPath(resolvedPath))
                    .catch((e) => { console.warn('[opener] openPath failed:', resolvedPath, e); });
                } else {
                  import('@tauri-apps/plugin-opener')
                    .then(({ openUrl }) => openUrl(href))
                    .catch((e) => { console.warn('[opener] openUrl failed:', href, e); });
                }
                return true; // consume — don't place cursor or expand
              }
            }
          }

          // ── Math block click fix ──
          const mathBlock = target.closest('div[data-type="math_block"]');
          if (!mathBlock) return false;

          // Prevent WebKit from creating the broken range selection
          me.preventDefault();

          try {
            // Map DOM element → document position
            const pos = view.posAtDOM(mathBlock, 0);
            const $pos = view.state.doc.resolve(pos);

            // Walk up to find the math_block node and get its before-position
            let beforePos = pos;
            for (let d = $pos.depth; d > 0; d--) {
              if ($pos.node(d).type.name === 'math_block') {
                beforePos = $pos.before(d);
                break;
              }
            }
            // If posAtDOM returned a position right before the math_block
            const $before = view.state.doc.resolve(beforePos);
            if (!$before.nodeAfter || $before.nodeAfter.type.name !== 'math_block') {
              // Fallback: check if nodeAfter at original pos is math_block
              if ($pos.nodeAfter?.type.name === 'math_block') {
                beforePos = pos;
              }
            }

            const sel = TextSelection.near(view.state.doc.resolve(beforePos), -1);
            view.dispatch(view.state.tr.setSelection(sel));
          } catch { /* ignore — focus below is the fallback */ }

          view.focus();
          return true;
        },

        /**
         * Cmd/Ctrl held → add 'link-hover' class for pointer cursor on links.
         */
        keydown(view, event) {
          if (event.key === 'Meta' || event.key === 'Control') {
            view.dom.classList.add('link-hover');
          }

          // ── handleDOMEvents.keydown fires BEFORE handleKeyDown and captureKeyDown ──
          // This is the highest priority interception point within ProseMirror.
          if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            // ── Fast AllSelection / full-range deletion ──
            // On macOS, Cmd+A is handled by PredefinedMenuItem::select_all
            // (native menu accelerator) which changes the DOM selection but
            // ProseMirror's selectionchange observer may NOT have synced yet.
            // Force flush + use robust DOM Range comparison for detection.
            try { (view as any).domObserver?.flush?.(); } catch { /* internal API */ }

            const docSize = view.state.doc.content.size;
            let isAllSelected = false;

            // Check 1: ProseMirror's internal selection (post-flush, should be current)
            const sel = view.state.selection;
            if (sel instanceof AllSelection ||
              (docSize > 0 && sel.from <= 1 && sel.to >= docSize - 1)) {
              isAllSelected = true;
            }

            // Check 2: DOM Range comparison (no posAtDOM — always reliable)
            if (!isAllSelected && docSize > 0) {
              try {
                const domSel = window.getSelection();
                if (domSel && !domSel.isCollapsed && domSel.rangeCount > 0) {
                  const range = domSel.getRangeAt(0);
                  const editorRange = document.createRange();
                  editorRange.selectNodeContents(view.dom);
                  if (range.compareBoundaryPoints(Range.START_TO_START, editorRange) <= 0 &&
                    range.compareBoundaryPoints(Range.END_TO_END, editorRange) >= 0) {
                    isAllSelected = true;
                  }
                }
              } catch { /* Range API edge cases */ }
            }

            // Check 3: Text content length comparison (last resort)
            if (!isAllSelected && docSize > 0) {
              try {
                const domSel = window.getSelection();
                if (domSel && !domSel.isCollapsed) {
                  const selectedText = domSel.toString();
                  const fullText = view.dom.textContent || '';
                  if (selectedText.length > 0 && fullText.length > 0 &&
                    selectedText.length >= fullText.length * 0.9) {
                    isAllSelected = true;
                  }
                }
              } catch { /* ignore */ }
            }

            if (isAllSelected) {
              event.preventDefault();
              const emptyParagraph = view.state.schema.nodes.paragraph.create();
              const tr = view.state.tr.replaceWith(0, docSize, emptyParagraph);
              tr.setSelection(TextSelection.create(tr.doc, 1));
              tr.setMeta('full-delete', true);
              view.dispatch(tr);
              return true;
            }

            // ── WKWebView end-of-textblock Backspace fix ──
            // ProseMirror's captureKeyDown → stopNativeHorizontalDelete uses
            // view.endOfTextblock("backward") which relies on WebKit's
            // Selection.modify(). In WKWebView this can return incorrect
            // results at paragraph boundaries, causing joinBackward to merge
            // paragraphs instead of deleting the character before the cursor.
            if (event.key === 'Backspace') {
              if (sel instanceof TextSelection && sel.empty && sel.$cursor) {
                const { parent, parentOffset } = sel.$cursor;
                if (parent.isTextblock && parentOffset === parent.content.size && parentOffset > 0) {
                  const nb = sel.$cursor.nodeBefore;
                  if (nb) {
                    event.preventDefault();
                    if (nb.isText && nb.text) {
                      const code = nb.text.charCodeAt(nb.text.length - 1);
                      const delLen = (code >= 0xDC00 && code <= 0xDFFF) ? 2 : 1;
                      view.dispatch(view.state.tr.delete(sel.from - delLen, sel.from).scrollIntoView());
                    } else {
                      view.dispatch(view.state.tr.delete(sel.from - nb.nodeSize, sel.from).scrollIntoView());
                    }
                    return true;
                  }
                }
              }
            }
          }

          return false;
        },
        keyup(view, event) {
          if (event.key === 'Meta' || event.key === 'Control') {
            view.dom.classList.remove('link-hover');
          }
          return false;
        },
      },

      /**
       * click below content handler:
       * When the last node is a code_block or other non-paragraph block, and the user clicks the empty area below it,
       * append a paragraph and place the cursor there.
       */
      handleClick(view, _pos, event) {
        if (event.button !== 0) return false;
        const { doc } = view.state;
        const lastNode = doc.lastChild;
        if (!lastNode || lastNode.type.name === 'paragraph') return false;
        // Get the actual DOM element of the last block node
        const lastNodePos = doc.content.size - lastNode.nodeSize;
        const lastDOM = view.nodeDOM(lastNodePos) as HTMLElement | null;
        if (!lastDOM) return false;

        // Click is below the last block -> append a paragraph and place cursor there
        const endPos = doc.content.size;
        const paragraph = view.state.schema.nodes.paragraph.create();
        const tr = view.state.tr.insert(endPos, paragraph);
        tr.setSelection(TextSelection.create(tr.doc, endPos + 1));
        view.dispatch(tr);
        view.focus();
        return true;
      },

      /**
       * Image click handler:
       * Prevent NodeSelection (blue highlight) on image click — place TextSelection after image.
       * (math_block is handled in handleDOMEvents.mousedown above)
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
        // ── Cmd/Ctrl+A → proper AllSelection ──
        const mod = event.metaKey || event.ctrlKey;
        if (mod && !event.shiftKey && !event.altKey && event.key === 'a') {
          event.preventDefault();
          const tr = view.state.tr.setSelection(new AllSelection(view.state.doc));
          view.dispatch(tr);
          return true;
        }

        // ── Fast AllSelection / full-range deletion ──
        // ProseMirror's default AllSelection delete is very slow on large docs
        // (it builds step-by-step replacements). Replace the entire content with
        // a single empty paragraph in one transaction for instant deletion.
        if (event.key === 'Backspace' || event.key === 'Delete') {
          const sel = view.state.selection;
          const docSize = view.state.doc.content.size;
          const isAllSelected =
            sel instanceof AllSelection ||
            (docSize > 0 && sel.from <= 1 && sel.to >= docSize - 1);
          if (isAllSelected) {
            event.preventDefault();
            const emptyParagraph = view.state.schema.nodes.paragraph.create();
            const tr = view.state.tr.replaceWith(0, docSize, emptyParagraph);
            tr.setSelection(TextSelection.create(tr.doc, 1));
            tr.setMeta('full-delete', true);
            view.dispatch(tr);
            return true;
          }
        }

        return false;
      },

      /**
       * WKWebView caret fix:
       * Add 'caret-empty-para' decoration to empty paragraph under cursor on macOS.
       */
      decorations(state) {
        if (!isMacOS) return DecorationSet.empty;
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
     * Scroll-after-paste + empty-doc focus recovery.
     */
    view(editorView) {
      function onPaste() { pendingPaste = true; }
      editorView.dom.addEventListener('paste', onPaste, true);

      // Remove link-hover class when window loses focus (Cmd/Ctrl release won't fire)
      function onBlur() { editorView.dom.classList.remove('link-hover'); }
      window.addEventListener('blur', onBlur);

      return {
        update(view, prevState) {
          // ── WKWebView empty-doc focus recovery ──
          // After large deletions (select-all + delete), WKWebView may lose the
          // native caret. Re-focus the view so the fake CSS caret shows.
          if (isMacOS && view.state.doc !== prevState.doc) {
            const docSize = view.state.doc.content.size;
            const prevDocSize = prevState.doc.content.size;
            if (docSize <= 4 && prevDocSize > 4) {
              requestAnimationFrame(() => {
                try {
                  if (!view.hasFocus()) view.focus();
                } catch { /* ignore */ }
              });
            }
          }

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
          window.removeEventListener('blur', onBlur);
          editorView.dom.classList.remove('link-hover');
        },
      };
    },
  });
}

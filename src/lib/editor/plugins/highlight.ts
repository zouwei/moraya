/**
 * Syntax highlighting plugin for Milkdown code blocks using highlight.js.
 * Applies ProseMirror decorations with hljs CSS classes for language-aware coloring.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import hljs from 'highlight.js/lib/core';

// Import commonly used languages
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import go from 'highlight.js/lib/languages/go';
import ruby from 'highlight.js/lib/languages/ruby';
import php from 'highlight.js/lib/languages/php';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import lua from 'highlight.js/lib/languages/lua';
import scss from 'highlight.js/lib/languages/scss';

// Register languages
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('java', java);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('c', c);
hljs.registerLanguage('go', go);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rb', ruby);
hljs.registerLanguage('php', php);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('kt', kotlin);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('lua', lua);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('svelte', xml);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('tsx', typescript);

const highlightPluginKey = new PluginKey('syntax-highlight');

interface HljsNode {
  scope?: string;
  children?: (HljsNode | string)[];
}

/**
 * Convert a highlight.js scope string to CSS class names.
 * "keyword" → ["hljs-keyword"]
 * "title.function" → ["hljs-title", "function_"]
 */
function scopeToClasses(scope: string): string[] {
  const parts = scope.split('.');
  const classes = [`hljs-${parts[0]}`];
  for (let i = 1; i < parts.length; i++) {
    classes.push(`${parts[i]}_`);
  }
  return classes;
}

/**
 * Flatten the hljs emitter tree into a list of { text, classes } spans.
 */
function flattenHljsTree(nodes: (HljsNode | string)[], parentClasses: string[] = []): { text: string; classes: string[] }[] {
  const result: { text: string; classes: string[] }[] = [];

  for (const node of nodes) {
    if (typeof node === 'string') {
      if (node.length > 0) {
        result.push({ text: node, classes: parentClasses });
      }
    } else {
      // highlight.js v11 uses `scope` (e.g. "keyword", "title.function").
      // Dotted scopes become multiple classes: "title.function" → "hljs-title function_"
      const classes = node.scope
        ? [...parentClasses, ...scopeToClasses(node.scope)]
        : parentClasses;
      if (node.children) {
        result.push(...flattenHljsTree(node.children, classes));
      }
    }
  }

  return result;
}

// ── Per-block hljs result cache ────────────────────────────────
// Caches the relative-offset spans for each (language, code) pair so that
// switching back to a previously highlighted file skips all hljs calls.
// FIFO eviction at 100 entries.

interface CachedSpan {
  relOffset: number;
  length: number;
  classes: string;
}

const HLJS_CACHE_MAX = 100;
const hljsCache = new Map<string, CachedSpan[]>();

function hljsCacheKey(language: string, code: string): string {
  return language + '\0' + code;
}

/**
 * Build ProseMirror decorations for a highlighted code block.
 */
function getDecorations(doc: any): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    if (node.type.name !== 'code_block') return;

    const language = node.attrs.language || '';
    const code = node.textContent;

    if (!code) return;

    if (!language) return; // No language label: skip (avoid expensive highlightAuto)
    if (!hljs.getLanguage(language)) return; // Unrecognized language

    const cKey = hljsCacheKey(language, code);
    const blockStart = pos + 1; // code content starts after opening tag

    // Check per-block cache
    const cachedSpans = hljsCache.get(cKey);
    if (cachedSpans) {
      for (const span of cachedSpans) {
        const from = blockStart + span.relOffset;
        const to = from + span.length;
        if (from < to) {
          decorations.push(Decoration.inline(from, to, { class: span.classes }));
        }
      }
      return;
    }

    // Cache miss — run hljs
    let result;
    try {
      result = hljs.highlight(code, { language, ignoreIllegals: true });
    } catch {
      return;
    }

    const emitter = result as any;
    const rootNode = emitter._emitter?.rootNode ?? emitter._emitter?.root;
    if (!rootNode?.children) return;

    const spans = flattenHljsTree(rootNode.children);

    // Build relative-offset spans for caching + absolute decorations
    const toCache: CachedSpan[] = [];
    let offset = 0;

    for (const span of spans) {
      const relOffset = offset;
      const length = span.text.length;
      offset += length;

      if (span.classes.length > 0 && length > 0) {
        const classes = span.classes.join(' ');
        toCache.push({ relOffset, length, classes });
        decorations.push(
          Decoration.inline(blockStart + relOffset, blockStart + relOffset + length, { class: classes })
        );
      }
    }

    // Store in cache (FIFO eviction)
    if (hljsCache.size >= HLJS_CACHE_MAX) {
      const oldest = hljsCache.keys().next().value;
      if (oldest !== undefined) hljsCache.delete(oldest);
    }
    hljsCache.set(cKey, toCache);
  });

  return DecorationSet.create(doc, decorations);
}

/**
 * Milkdown plugin that adds syntax highlighting to code blocks.
 *
 * Highlight.js is expensive (especially `highlightAuto` which tests all
 * registered languages). Instead of re-highlighting on every ProseMirror
 * transaction (which fires on every keystroke), we:
 *  1. On doc change: cheaply map existing decorations through the transaction
 *     (adjusts positions for insertions/deletions — no hljs calls).
 *  2. After 300ms idle: run a full re-highlight and dispatch a metadata-only
 *     transaction to flush the new decorations into the view.
 */
export function createHighlightPlugin(): Plugin {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let needsRefresh = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentView: any = null;

  return new Plugin({
    key: highlightPluginKey,
    state: {
      init(_, state) {
        return getDecorations(state.doc);
      },
      apply(tr, decorationSet, _oldState, newState) {
        if (!tr.docChanged) {
          // Non-doc transaction: if a debounced refresh completed, apply it now.
          if (needsRefresh) {
            needsRefresh = false;
            return getDecorations(newState.doc);
          }
          return decorationSet;
        }

        // File switch: rebuild decorations from scratch (old decorations belong
        // to the previous document and cannot be meaningfully mapped).
        if (tr.getMeta('file-switch')) {
          if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
          return getDecorations(newState.doc);
        }

        // Map existing decorations cheaply through the transaction
        // (adjusts positions for insertions/deletions — no hljs calls).
        const mapped = decorationSet.map(tr.mapping, newState.doc);

        // Short-circuit: if the change didn't touch any code_block, skip
        // scheduling a full re-highlight. This saves the 300ms debounce +
        // hljs re-parse for ~90% of keystrokes (normal paragraph editing).
        let affectsCodeBlock = false;
        const docSize = newState.doc.content.size;
        tr.mapping.maps.forEach((stepMap) => {
          if (affectsCodeBlock) return;
          stepMap.forEach((from, to) => {
            if (affectsCodeBlock) return;
            newState.doc.nodesBetween(
              Math.max(0, from),
              Math.min(to, docSize),
              (node) => {
                if (node.type.name === 'code_block') affectsCodeBlock = true;
                return !affectsCodeBlock;
              }
            );
          });
        });

        if (!affectsCodeBlock) return mapped;

        // Schedule a full re-highlight after typing pause
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          needsRefresh = true;
          // Dispatch a metadata-only transaction to trigger apply() which
          // will detect needsRefresh and rebuild decorations from scratch.
          try {
            if (currentView && !currentView.isDestroyed) {
              currentView.dispatch(currentView.state.tr.setMeta('highlight-refresh', true));
            }
          } catch { /* view may be destroyed */ }
        }, 300);

        return mapped;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
    view(editorView) {
      currentView = editorView;
      return {
        destroy() {
          currentView = null;
          if (debounceTimer !== null) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
        },
      };
    },
  });
}

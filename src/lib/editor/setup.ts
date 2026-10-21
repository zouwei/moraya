/**
 * Moraya editor setup bridge.
 *
 * Adapts moraya's existing `EditorOptions` shape (root / defaultValue / etc.)
 * to `@moraya/core`'s `CreateEditorOptions` shape (container /
 * initialContent / mediaResolver / etc.) and injects the Tauri DI implementations.
 *
 * v0.60.0-pre §F2.5 / §F2.6: all schema / link / renderer / platform
 * dependencies are now consumer-provided, so this bridge wires up:
 *   - `tauriMediaResolver` for image / video / audio loading
 *   - `tauriLinkOpener` for Cmd+click on links
 *   - `morayaRendererRegistry` for code-block-view's WaveDrom / D2 / etc.
 *   - `Platform` derived from `editorStore.currentFilePath` + `isMacOS`
 *
 * Wires the moraya-only `review-decoration` plugin (v0.30.0+ team-collab) by
 * using core's `createEditorPlugins` to build the base array, appending
 * `createReviewDecorationPlugin()`, then constructing `EditorState` +
 * `EditorView` manually.
 */

import {
  createEditorPlugins,
  preloadEnhancementPlugins as corePreloadEnhancementPlugins,
  serializeMarkdown,
  type MorayaEditorInstance,
} from '@moraya/core'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import type { Schema } from 'prosemirror-model'

import { tauriMediaResolver } from './adapters/tauri-media-resolver'
import { tauriLinkOpener } from './adapters/tauri-link-opener'
import { morayaRendererRegistry } from './adapters/moraya-renderer-registry'
import { editorStore } from '../stores/editor-store'
import { isMacOS } from '../utils/platform'
import { schema } from './schema'
// The bridged parser (not core's) — it re-attaches the trailing blank lines
// that markdown parsing drops. Using core's here lost every blank line a user
// added at the end in source mode as soon as the visual editor remounted.
import { parseMarkdown } from './markdown'
import { createReviewDecorationPlugin } from './plugins/review-decoration'
import { createMarkdownSourcePastePlugin } from './plugins/markdown-source-paste'

// ── Public types (legacy moraya shape, kept for zero-modification call sites) ──

export interface MorayaEditor extends MorayaEditorInstance {}

export interface EditorOptions {
  root: HTMLElement
  defaultValue?: string
  /** Lightweight dirty notification with plain text content for word count. No markdown serialization. */
  onDocChanged?: (textContent: string) => void
  /** Full markdown serialization callback. Used in split mode for SourceEditor sync. */
  onChange?: (markdown: string) => void
  /** Debounce interval (ms) for the lazy-change plugin. Default 500ms. Split mode uses 150ms. */
  changeDebounceMs?: number
  onFocus?: () => void
  onBlur?: () => void
  /** Initial editability. When false, the view mounts non-editable (read-only
   *  version preview). Runtime toggling is done via view.setProps. Default true. */
  editable?: boolean
}

// ── Platform DI: derived from moraya's editor-store + utils/platform ──

const platform = {
  getCurrentFilePath: (): string | null => editorStore.getState().currentFilePath ?? null,
  isMacOS,
}

// ── Tier 1 preload (warming the cache) ──

/**
 * Preload Tier 1 plugins (highlight + emoji + code-block-view).
 * Can be called early in `+page.svelte` `onMount` to avoid latency on
 * first editor mount.
 */
export function preloadEnhancementPlugins(): Promise<unknown> {
  return corePreloadEnhancementPlugins(schema as Schema, morayaRendererRegistry)
}

// ── createEditor adapter ──

export async function createEditor(options: EditorOptions): Promise<MorayaEditor> {
  const t0 = performance.now()

  const baseOpts = {
    mediaResolver: tauriMediaResolver,
    linkOpener: tauriLinkOpener,
    rendererRegistry: morayaRendererRegistry,
    platform,
    ...(options.onDocChanged ? { onDocChanged: options.onDocChanged } : {}),
    ...(options.onChange ? { onChange: options.onChange } : {}),
    ...(options.changeDebounceMs !== undefined ? { changeDebounceMs: options.changeDebounceMs } : {}),
  }

  // Build core's plugin array, then append moraya-only review-decoration.
  // (Cannot use coreCreateEditor directly because it doesn't accept extra plugins.)
  const corePlugins = await createEditorPlugins(baseOpts, schema as Schema)
  // Prepend the markdown-source paste plugin so its handlePaste runs BEFORE
  // core's editor-props plugin — it renders pasted markdown source even when a
  // text/html flavor is present (which would otherwise bypass core's
  // clipboardTextParser). See markdown-source-paste.ts.
  const plugins = [createMarkdownSourcePastePlugin(), ...corePlugins, createReviewDecorationPlugin()]

  // Tier 1 nodeViews — code_block NodeView (toolbar / picker / mermaid / renderer).
  // Re-call preloadEnhancementPlugins; cache hit returns instantly.
  const tier1 = await corePreloadEnhancementPlugins(schema as Schema, morayaRendererRegistry)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeViews: Record<string, any> = {}
  if (tier1.codeBlockView) {
    nodeViews.code_block = tier1.codeBlockView
  }
  // Typora-style in-place math editing (core v0.6.0): click a formula → LaTeX
  // source opens in the document flow (block: source line above live preview;
  // inline: source replaces the rendered formula); blur commits, Escape
  // reverts. Factories come from core's preloadEnhancementPlugins (tier1).
  if (tier1.mathBlockView) {
    nodeViews.math_block = tier1.mathBlockView
  }
  if (tier1.mathInlineView) {
    nodeViews.math_inline = tier1.mathInlineView
  }

  const initialDoc = options.defaultValue
    ? parseMarkdown(options.defaultValue)
    : (schema as Schema).topNodeType.createAndFill()!

  const state = EditorState.create({ schema: schema as Schema, doc: initialDoc, plugins })
  const initialEditable = options.editable !== false
  const view = new EditorView(options.root, {
    state,
    nodeViews,
    editable: () => initialEditable,
    attributes: {
      class: 'moraya-editor',
      spellcheck: 'true',
    },
  })

  // Focus / blur listeners
  if (options.onFocus || options.onBlur) {
    const editorDom = options.root.querySelector('.ProseMirror')
    if (editorDom) {
      if (options.onFocus) editorDom.addEventListener('focus', options.onFocus)
      if (options.onBlur) editorDom.addEventListener('blur', options.onBlur)
    }
  }

  console.log(`[Editor] createEditor (bridged): ${(performance.now() - t0).toFixed(1)}ms (plugins: ${plugins.length}, nodeViews: ${Object.keys(nodeViews).join(',')})`)

  const editor: MorayaEditor = {
    view,
    getMarkdown() {
      return serializeMarkdown(view.state.doc)
    },
    setContent(md: string) {
      const newDoc = parseMarkdown(md)
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content)
      view.dispatch(tr)
    },
    destroy() {
      view.destroy()
    },
  }

  return editor
}

// ── Re-export getMarkdown alias from bridged markdown.ts ──

export { serializeMarkdown as getMarkdown } from './markdown'

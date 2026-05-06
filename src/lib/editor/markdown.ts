/**
 * Moraya markdown bridge.
 *
 * Wraps `@moraya/markdown-core`'s parser/serializer with the bridged
 * consumer schema as default, so moraya call sites that don't pass an
 * explicit schema get docs whose `node.type` / `mark.type` references
 * match the bridged schema (TauriMediaResolver injection).
 *
 * Without this default-binding, docs returned to moraya's editor would
 * carry NodeType identities from core's internal `defaultSchema`, which
 * are different references from the bridged schema's NodeTypes — leading
 * to broken `toggleMark` / `setBlockType` behavior because ProseMirror
 * compares by type identity.
 */

import {
  parseMarkdown as coreParseMarkdown,
  parseMarkdownAsync as coreParseMarkdownAsync,
  serializeMarkdown as coreSerializeMarkdown,
} from '@moraya/markdown-core'
import type { Node as PmNode } from 'prosemirror-model'
import { schema } from './schema'

/** Parse markdown to ProseMirror doc bound to moraya's bridged schema. Never throws (§4.5). */
export function parseMarkdown(markdown: string): PmNode {
  return coreParseMarkdown(markdown, schema)
}

/** Async variant with 50KB threshold for setTimeout(0) yield. Never rejects (§4.5). */
export function parseMarkdownAsync(markdown: string): Promise<PmNode> {
  return coreParseMarkdownAsync(markdown, schema)
}

/** Serialize a ProseMirror doc back to markdown. Never throws (§4.5). */
export function serializeMarkdown(doc: PmNode): string {
  return coreSerializeMarkdown(doc)
}

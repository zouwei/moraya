/**
 * Moraya schema bridge.
 *
 * Calls `createSchema()` from `@moraya/core` with Tauri-specific DI
 * (`tauriMediaResolver`) and re-exports the resulting `schema` singleton plus
 * the module-level `setDocumentBaseDir` so existing call sites
 * (`import { schema } from './schema'`) compile without modification.
 *
 * v0.60.0-pre §F2.5: schema must be built from a host-agnostic factory; all
 * Tauri IPC calls (`read_file_binary`, `plugin-http`) are now routed through
 * the injected MediaResolver instead of being hard-coded inside the schema.
 */

import { Schema } from 'prosemirror-model'
import { createSchema, setDocumentBaseDir, getDocumentBaseDir } from '@moraya/core'
import { tauriMediaResolver } from './adapters/tauri-media-resolver'
import { tauriLinkOpener } from './adapters/tauri-link-opener'

const baseSchema = createSchema({
  mediaResolver: tauriMediaResolver,
  linkOpener: tauriLinkOpener,
})

const marks: Record<string, import('prosemirror-model').MarkSpec> = {}
baseSchema.spec.marks.forEach((key: string, spec: import('prosemirror-model').MarkSpec) => {
  marks[key] = spec
})

marks.underline = {
  parseDOM: [
    { tag: 'u' },
    { style: 'text-decoration=underline' },
  ],
  toDOM() {
    return ['u', 0]
  },
}

export const schema = new Schema({
  nodes: baseSchema.spec.nodes,
  marks,
})

export { setDocumentBaseDir, getDocumentBaseDir }

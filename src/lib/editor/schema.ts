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

import { createSchema, setDocumentBaseDir, getDocumentBaseDir } from '@moraya/core'
import { tauriMediaResolver } from './adapters/tauri-media-resolver'
import { tauriLinkOpener } from './adapters/tauri-link-opener'

export const schema = createSchema({
  mediaResolver: tauriMediaResolver,
  linkOpener: tauriLinkOpener,
})

export { setDocumentBaseDir, getDocumentBaseDir }

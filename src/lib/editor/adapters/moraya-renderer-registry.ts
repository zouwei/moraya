/**
 * Moraya implementation of `RendererRegistry` from `@moraya/core`.
 *
 * Adapts moraya's existing renderer plugin system (`$lib/services/plugin/`)
 * to the simpler core interface:
 *   - `has(language)` checks `RENDERER_LANGUAGES`
 *   - `load(language)` resolves the moraya `RendererPlugin`, calls
 *     `loadRendererPlugin(...)` for the JS module, and returns a wrapper
 *     `RendererPluginModule` whose `render()` calls the moraya plugin's
 *     `render(container, source, module, docPath)` while supplying
 *     `currentFilePath` for `isFilePathRenderer` plugins.
 *   - `versions` is a snapshot of `renderer-versions.json` for the picker UI
 *
 * Note: the moraya `RendererPlugin.render()` may return a disposable instance.
 * Core's `RendererPluginModule.destroy(container)` symmetrically cleans up
 * by calling `dispose()` on the stored instance keyed by container in a
 * WeakMap.
 */

import type { RendererRegistry, RendererPluginModule } from '@moraya/core'
import { RENDERER_PLUGINS, RENDERER_LANGUAGES, getRendererPlugin } from '$lib/services/plugin/renderer-registry'
import { loadRendererPlugin } from '$lib/services/plugin/renderer-loader'
import rendererVersions from '$lib/services/plugin/renderer-versions.json'
import { editorStore } from '$lib/stores/editor-store'

/** Find which renderer plugin handles a given code block language. */
function findRendererPluginForLang(lang: string) {
  return RENDERER_PLUGINS.find((p) => p.languages.includes(lang))
}

/** Substitute {version} placeholders in the CDN URL. */
function buildCdnUrl(npmPackage: string, cdnUrl: string): string {
  const ver = (rendererVersions as Record<string, string>)[npmPackage] ?? 'latest'
  return cdnUrl.replaceAll('{version}', ver)
}

/** Tracks `dispose()` instances per container so destroy() can free resources. */
const disposeMap = new WeakMap<HTMLElement, { dispose(): void }>()

export class MorayaRendererRegistry implements RendererRegistry {
  /** Snapshot of npmPackage → version. Picker / cache-keying use this. */
  readonly versions: Readonly<Record<string, string>>

  constructor() {
    // Build a language → version map (one entry per renderable language).
    // Used by code-block-view to derive the picker language list.
    const langVersions: Record<string, string> = {}
    for (const plugin of RENDERER_PLUGINS) {
      const v = (rendererVersions as Record<string, string>)[plugin.npmPackage] ?? 'latest'
      for (const lang of plugin.languages) {
        langVersions[lang] = v
      }
    }
    this.versions = Object.freeze(langVersions)
  }

  has(language: string): boolean {
    return RENDERER_LANGUAGES.has(language)
  }

  async load(language: string): Promise<RendererPluginModule> {
    const plugin = findRendererPluginForLang(language)
    if (!plugin) {
      throw new Error(`[MorayaRendererRegistry] no plugin registered for language "${language}"`)
    }

    const cdnUrl = buildCdnUrl(plugin.npmPackage, plugin.cdnUrl)
    const result = await loadRendererPlugin(plugin, cdnUrl, undefined, plugin.fallbackCdnUrl)

    if (result.status !== 'ready' || !result.module) {
      throw new Error(`[MorayaRendererRegistry] load failed: ${result.error ?? 'unknown'}`)
    }

    const mod = result.module

    return {
      async render(source: string, container: HTMLElement) {
        // Dispose previous render in this container (if any)
        const prev = disposeMap.get(container)
        if (prev) {
          try { prev.dispose() } catch { /* swallow */ }
          disposeMap.delete(container)
        }

        const docPath = plugin.isFilePathRenderer
          ? editorStore.getState().currentFilePath ?? null
          : null

        const inst = await plugin.render(container, source, mod, docPath)
        if (inst && typeof (inst as { dispose(): void }).dispose === 'function') {
          disposeMap.set(container, inst as { dispose(): void })
        }
      },

      destroy(container: HTMLElement) {
        const inst = disposeMap.get(container)
        if (inst) {
          try { inst.dispose() } catch { /* swallow per §4.5 */ }
          disposeMap.delete(container)
        }
      },
    }
  }
}

export const morayaRendererRegistry = new MorayaRendererRegistry()

// Re-export getRendererPlugin in case other moraya modules want it
export { getRendererPlugin }

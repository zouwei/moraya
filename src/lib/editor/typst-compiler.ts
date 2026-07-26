/**
 * Desktop Typst compiler adapter.
 *
 * Implements `@moraya/core/typst`'s injected `TypstCompiler` on top of the
 * Tauri commands in `src-tauri/src/commands/typst_engine.rs`, which shell out
 * to the official `typst` CLI (downloaded on first use, cached under
 * `~/.moraya/typst/`). Desktop deliberately does NOT ship the typst.ts WASM
 * compiler — the native binary keeps Moraya's own bundle small and compiles
 * faster; web injects the WASM implementation instead.
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  TypstArtifact,
  TypstCompiler,
  TypstOutputFormat,
} from '@moraya/core/typst';

export const tauriTypstCompiler: TypstCompiler = {
  async compile(
    source: string,
    format: TypstOutputFormat,
    outputPath?: string,
  ): Promise<TypstArtifact> {
    const result = await invoke<{ pages: string[] }>('typst_compile_source', {
      source,
      format,
      outputPath: outputPath ?? null,
    });
    // The Rust side reuses `pages` for both meanings: document content when the
    // caller wants it in memory (per-page SVG, or HTML with no output path —
    // the Typst → Markdown conversion route), and written file names otherwise.
    const inMemory = format === 'svg' || (format === 'html' && !outputPath);
    return inMemory
      ? { pages: result?.pages ?? [] }
      : { pages: [], files: result?.pages ?? [] };
  },

  async isReady(): Promise<boolean> {
    return invoke<boolean>('typst_engine_status');
  },

  async prepare(): Promise<void> {
    await invoke<string>('typst_ensure_engine');
  },
};

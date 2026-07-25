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
    // The Rust side returns per-page SVG for `svg`, and the written file names
    // for the file-producing formats, in the same `pages` field.
    return format === 'svg'
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

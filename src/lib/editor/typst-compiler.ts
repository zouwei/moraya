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

/**
 * Directory the active document lives in, used as the Typst project root.
 *
 * Kept as adapter state rather than added to core's `TypstCompiler` signature:
 * "where this document sits on disk" is a desktop concept — the browser build
 * resolves through typst.ts's virtual filesystem instead — and the shared
 * contract should stay "compile this source".
 *
 * `null` for an unsaved buffer; the Rust side then compiles in its private
 * scratch dir, where there is nothing to resolve anyway.
 */
let projectRoot: string | null = null;

/** Point the compiler at the directory of the document being edited. */
export function setTypstProjectRoot(dir: string | null): void {
  projectRoot = dir;
}

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
      // Makes `#image("diagram.png")` and `#include "chapter.typ"` resolve
      // against the document's own folder, the way they do when the user runs
      // `typst compile` on the saved file.
      rootDir: projectRoot,
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

/** Where a heading lands on the rendered pages. */
export interface TypstHeadingPosition {
  /** 1-based page number. */
  page: number;
  /** Distance from the top of that page, in points. */
  y: number;
}

/**
 * Ask the compiler where each heading sits on the rendered pages.
 *
 * Only the visual (preview-only) mode needs this: the rendered SVG has no
 * mapping back to the source — glyphs are paths — so outline navigation there
 * cannot be measured from the DOM the way the source pane's is. Returns an
 * empty list when the document does not compile; the preview already shows why.
 */
export async function queryTypstHeadingPositions(
  source: string,
): Promise<TypstHeadingPosition[]> {
  try {
    return await invoke<TypstHeadingPosition[]>('typst_heading_positions', {
      source,
      rootDir: projectRoot,
    });
  } catch {
    return [];
  }
}

/**
 * Typst Universe templates on the desktop.
 *
 * Both calls go through Rust, for different reasons:
 *
 *  - the index, because the app's CSP limits `connect-src` to the Tauri IPC
 *    origin (and the project rule is that external calls live in Rust anyway);
 *  - creation, because the bundled `typst` binary already implements it —
 *    `typst init` downloads the package, unpacks the scaffold and writes it.
 *    The browser build has to hand-roll all of that; desktop should not.
 *
 * Thumbnails are the exception: `img-src` allows `https:`, so the picker points
 * `<img>` straight at the registry.
 */
import { invoke } from '@tauri-apps/api/core';
import { parseTemplateIndex, templateImportSpec, type TypstTemplate } from '@moraya/core/typst';

let cached: TypstTemplate[] | null = null;

/**
 * The template list, parsed by the shared core module.
 *
 * Rust holds the on-disk cache (24h TTL, stale-on-offline); this memoizes the
 * parse so reopening the picker in one session costs nothing.
 */
export async function loadTemplates(force = false): Promise<TypstTemplate[]> {
  if (cached && !force) return cached;
  try {
    const json = await invoke<string>('typst_template_index', { force });
    cached = parseTemplateIndex(JSON.parse(json));
  } catch {
    // Offline with no cache at all — the picker shows its empty state.
    cached = cached ?? [];
  }
  return cached;
}

export type TemplateCreateResult =
  | { ok: true; entryPath: string }
  | { ok: false; message: string };

/**
 * Create a project from a template inside `parentDir`.
 *
 * Returns the path of the entry document to open. The folder name collides
 * with an existing project only if the user has one — Rust picks a free name
 * rather than failing, because `typst init` refuses an existing directory.
 */
export async function createFromTemplate(
  template: TypstTemplate,
  parentDir: string,
): Promise<TemplateCreateResult> {
  try {
    const entryPath = await invoke<string>('typst_init_template', {
      spec: templateImportSpec(template),
      parentDir,
      folderName: template.name,
      entrypoint: template.entrypoint,
    });
    return { ok: true, entryPath };
  } catch (err) {
    return { ok: false, message: typeof err === 'string' ? err : String(err) };
  }
}

/**
 * Template Storage — Disk I/O for custom AI templates
 *
 * Global templates:  ~/.moraya/templates/
 * KB templates:      {kbRoot}/templates/
 *
 * Each template is a single JSON file: {id}.json
 * Load priority: KB > global > builtin (by ID)
 */

import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { open as openDialog, save as saveDialog } from '$lib/utils/native-dialog';
import { filesStore, type FileEntry } from '$lib/stores/files-store';
import type { AITemplate, TemplateExportFile, TemplateSource } from './types';
import { setCustomTemplates } from './registry';

/** Required fields for a valid template */
const REQUIRED_FIELDS = ['id', 'category', 'icon', 'flow', 'contentSource', 'systemPrompt', 'userPromptTemplate', 'defaultActions'] as const;
const VALID_FLOWS = ['auto', 'input', 'selection', 'parameterized', 'interactive'];
const VALID_CONTENT_SOURCES = ['none', 'document', 'selection', 'document_or_selection'];

let globalTemplatesDir = '';

async function ensureGlobalDir(): Promise<string> {
  if (!globalTemplatesDir) {
    const home = await homeDir();
    globalTemplatesDir = `${home}.moraya/templates`;
  }
  // Ensure directory exists by writing a marker (no-op if exists)
  try {
    await invoke('read_dir_recursive', { path: globalTemplatesDir, depth: 1 });
  } catch {
    // Directory doesn't exist — create it by writing a placeholder
    await invoke('write_file', { path: `${globalTemplatesDir}/.gitkeep`, content: '' });
  }
  return globalTemplatesDir;
}

function getKbTemplatesDir(): string | null {
  const kb = filesStore.getActiveKnowledgeBase();
  return kb ? `${kb.path}/templates` : null;
}

/** Validate a template object has all required fields and valid enum values */
function validateTemplate(obj: Record<string, unknown>): { valid: boolean; error?: string } {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }
  if (!obj.name && !obj.nameKey) {
    return { valid: false, error: 'Template must have either "name" or "nameKey"' };
  }
  if (!VALID_FLOWS.includes(obj.flow as string)) {
    return { valid: false, error: `Invalid flow type: ${obj.flow}` };
  }
  if (!VALID_CONTENT_SOURCES.includes(obj.contentSource as string)) {
    return { valid: false, error: `Invalid contentSource: ${obj.contentSource}` };
  }
  if (!Array.isArray(obj.defaultActions)) {
    return { valid: false, error: 'defaultActions must be an array' };
  }
  return { valid: true };
}

/** Sanitize template ID for use as filename */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Load templates from a directory */
async function loadTemplatesFromDir(dir: string, source: TemplateSource): Promise<AITemplate[]> {
  const templates: AITemplate[] = [];
  try {
    const entries = await invoke<FileEntry[]>('read_dir_recursive', { path: dir, depth: 1 });
    const jsonFiles = entries.filter(e => !e.is_dir && e.name.endsWith('.json'));
    for (const file of jsonFiles) {
      try {
        const content = await invoke<string>('read_file', { path: file.path });
        const parsed = JSON.parse(content);
        // Support both single template and export file format
        const tplList: Record<string, unknown>[] = Array.isArray(parsed.templates) ? parsed.templates : [parsed];
        for (const obj of tplList) {
          const { valid, error } = validateTemplate(obj);
          if (valid) {
            const tpl = obj as unknown as AITemplate;
            tpl.source = source;
            tpl.sourcePath = file.path;
            templates.push(tpl);
          } else {
            console.warn(`Invalid template in ${file.path}: ${error}`);
          }
        }
      } catch (e) {
        console.warn(`Failed to load template ${file.path}:`, e);
      }
    }
  } catch {
    // Directory doesn't exist — no custom templates
  }
  return templates;
}

/** Load all custom templates from global + KB directories. KB templates come first (higher priority). */
export async function loadAllCustomTemplates(): Promise<AITemplate[]> {
  const globalDir = await ensureGlobalDir();
  const kbDir = getKbTemplatesDir();

  const [globalTemplates, kbTemplates] = await Promise.all([
    loadTemplatesFromDir(globalDir, 'global'),
    kbDir ? loadTemplatesFromDir(kbDir, 'kb') : Promise.resolve([]),
  ]);

  // KB first so getTemplateById finds KB version first
  const all = [...kbTemplates, ...globalTemplates];

  // Deduplicate by ID (KB wins over global)
  const seen = new Set<string>();
  const deduped: AITemplate[] = [];
  for (const tpl of all) {
    if (!seen.has(tpl.id)) {
      seen.add(tpl.id);
      deduped.push(tpl);
    }
  }

  // Update the registry
  setCustomTemplates(deduped);
  return deduped;
}

/** Save a template to disk */
export async function saveTemplate(tpl: AITemplate, scope: 'global' | 'kb'): Promise<void> {
  let dir: string;
  if (scope === 'kb') {
    const kbDir = getKbTemplatesDir();
    if (!kbDir) throw new Error('No active knowledge base');
    dir = kbDir;
  } else {
    dir = await ensureGlobalDir();
  }

  // Strip runtime fields before saving
  const { source, sourcePath, ...saveable } = tpl;
  const filePath = `${dir}/${sanitizeId(tpl.id)}.json`;
  await invoke('write_file', { path: filePath, content: JSON.stringify(saveable, null, 2) });

  // Reload
  await loadAllCustomTemplates();
}

/** Delete a custom template */
export async function deleteTemplate(id: string, scope: 'global' | 'kb'): Promise<void> {
  let dir: string;
  if (scope === 'kb') {
    const kbDir = getKbTemplatesDir();
    if (!kbDir) throw new Error('No active knowledge base');
    dir = kbDir;
  } else {
    dir = await ensureGlobalDir();
  }

  const filePath = `${dir}/${sanitizeId(id)}.json`;
  try {
    // Overwrite with empty to effectively delete (no delete_file command available)
    await invoke('write_file', { path: filePath, content: '' });
  } catch {
    // File might not exist
  }

  // Reload
  await loadAllCustomTemplates();
}

/** Import templates from a user-selected JSON file. Returns count of imported templates and any errors. */
export async function importTemplatesFromFile(): Promise<{ imported: number; errors: string[] }> {
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!selected) return { imported: 0, errors: [] };

  const filePath = typeof selected === 'string' ? selected : (selected as { path: string }).path;
  const content = await invoke<string>('read_file', { path: filePath });
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { imported: 0, errors: ['Invalid JSON file'] };
  }

  // Support both export file format and single template
  let templates: Record<string, unknown>[];
  if (typeof parsed === 'object' && parsed !== null && 'templates' in parsed && Array.isArray((parsed as { templates: unknown }).templates)) {
    templates = (parsed as TemplateExportFile).templates as unknown as Record<string, unknown>[];
  } else if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
    templates = [parsed as Record<string, unknown>];
  } else {
    return { imported: 0, errors: ['Unrecognized template format'] };
  }

  const errors: string[] = [];
  let imported = 0;
  const globalDir = await ensureGlobalDir();

  for (const obj of templates) {
    const { valid, error } = validateTemplate(obj);
    if (!valid) {
      errors.push(`Template "${obj.id || 'unknown'}": ${error}`);
      continue;
    }
    const tpl = obj as unknown as AITemplate;
    const savePath = `${globalDir}/${sanitizeId(tpl.id)}.json`;
    // Strip runtime fields
    const { source, sourcePath, ...saveable } = tpl;
    await invoke('write_file', { path: savePath, content: JSON.stringify(saveable, null, 2) });
    imported++;
  }

  // Reload registry
  await loadAllCustomTemplates();
  return { imported, errors };
}

/** Export selected templates to a user-chosen file */
export async function exportTemplates(templates: AITemplate[]): Promise<boolean> {
  const savePath = await saveDialog({
    defaultPath: 'moraya-templates.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!savePath) return false;

  const filePath = typeof savePath === 'string' ? savePath : (savePath as { path: string }).path;

  // Strip runtime fields
  const exportable = templates.map(({ source, sourcePath, ...rest }) => rest);
  const exportFile: TemplateExportFile = {
    version: '1.0',
    templates: exportable,
  };

  await invoke('write_file', { path: filePath, content: JSON.stringify(exportFile, null, 2) });
  return true;
}

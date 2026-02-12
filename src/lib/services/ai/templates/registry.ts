/**
 * AI Template Registry — Lookup and Search
 */

import type { AITemplate, AITemplateCategory } from './types';
import { BUILTIN_CATEGORIES, BUILTIN_TEMPLATES } from './builtin-templates';

export function getCategories(): AITemplateCategory[] {
  return BUILTIN_CATEGORIES.slice().sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getTemplatesByCategory(categoryId: string): AITemplate[] {
  return BUILTIN_TEMPLATES
    .filter(t => t.category === categoryId)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

export function getTemplateById(id: string): AITemplate | undefined {
  return BUILTIN_TEMPLATES.find(t => t.id === id);
}

export function getAllTemplates(): AITemplate[] {
  return BUILTIN_TEMPLATES;
}

/**
 * AI Template Engine — Interpolation & Content Resolution
 */

import type { AITemplate, TemplateContext } from './types';

/**
 * Interpolate {{variable}} placeholders in a template string.
 *
 * Supported variables:
 *   {{content}}          — editor content
 *   {{input}}            — user-typed text
 *   {{param.xxx}}        — parameter value
 *   {{paramLabel.xxx}}   — localized parameter label
 *   {{locale}}           — current locale code
 */
export function interpolate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (match, key: string) => {
    if (key === 'content') return ctx.content ?? '';
    if (key === 'input') return ctx.input ?? '';
    if (key === 'locale') return ctx.locale ?? 'en';
    if (key.startsWith('param.')) return ctx.params?.[key.slice(6)] ?? '';
    if (key.startsWith('paramLabel.')) return ctx.paramLabels?.[key.slice(11)] ?? '';
    return match; // preserve unrecognized placeholders
  });
}

/**
 * Resolve editor content based on the template's contentSource.
 * Returns { content, error? } where error is an i18n key if content is missing.
 */
export function resolveContent(
  template: AITemplate,
  documentContent: string,
  selectedText: string,
): { content: string; error?: string } {
  switch (template.contentSource) {
    case 'none':
      return { content: '' };

    case 'document':
      if (!documentContent.trim()) {
        return { content: '', error: 'templates.error.noDocument' };
      }
      return { content: documentContent.slice(-3000) };

    case 'selection':
      if (!selectedText.trim()) {
        return { content: '', error: 'templates.error.noSelection' };
      }
      return { content: selectedText };

    case 'document_or_selection':
      if (!selectedText.trim() && !documentContent.trim()) {
        return { content: '', error: 'templates.error.noContent' };
      }
      return { content: selectedText || documentContent.slice(-3000) };
  }
}

/**
 * Build system prompt + user message from a template and context.
 */
export function buildTemplateMessages(
  template: AITemplate,
  ctx: TemplateContext,
): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt: template.systemPrompt,
    userMessage: interpolate(template.userPromptTemplate, ctx),
  };
}

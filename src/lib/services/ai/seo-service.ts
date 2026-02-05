/**
 * SEO Service
 * Uses the configured text AI to analyze article content and generate SEO metadata.
 */

import { sendAIRequest } from './providers';
import type { AIProviderConfig, SEOData } from './types';

const SEO_SYSTEM_PROMPT = `You are an SEO expert. Analyze the given article and generate SEO metadata.
You MUST respond with a valid JSON object (no markdown, no code fences, just raw JSON) with this exact structure:
{
  "titles": ["title1", "title2", "title3"],
  "excerpt": "120 chars max summary",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "metaDescription": "160 chars max meta description",
  "slug": "url-friendly-slug"
}

Rules:
- titles: Generate 3 SEO-optimized title candidates. Keep the original meaning. Each under 70 chars.
- excerpt: A compelling summary under 120 characters.
- tags: 5-8 relevant keyword tags.
- metaDescription: An SEO meta description under 160 characters.
- slug: A URL-friendly slug using lowercase letters, numbers, and hyphens only.
- If the article is in Chinese, generate Chinese titles/excerpt/description but keep the slug in English.
- Output ONLY the JSON object, nothing else.`;

/**
 * Generate SEO metadata for the given article content.
 */
export async function generateSEOData(
  config: AIProviderConfig,
  articleContent: string,
): Promise<SEOData> {
  const truncated = articleContent.slice(0, 8000); // Limit input size

  const response = await sendAIRequest(config, {
    messages: [
      { role: 'system', content: SEO_SYSTEM_PROMPT, timestamp: Date.now() },
      { role: 'user', content: `Analyze this article and generate SEO metadata:\n\n${truncated}`, timestamp: Date.now() },
    ],
  });

  // Parse JSON from response
  const content = response.content.trim();
  // Try to extract JSON from potential markdown code fences
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI did not return valid JSON');
  }

  const data = JSON.parse(jsonMatch[0]);

  // Validate and normalize
  return {
    titles: Array.isArray(data.titles) ? data.titles.slice(0, 3) : [],
    selectedTitle: data.titles?.[0] || '',
    excerpt: typeof data.excerpt === 'string' ? data.excerpt : '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    metaDescription: typeof data.metaDescription === 'string' ? data.metaDescription : '',
    slug: typeof data.slug === 'string' ? data.slug : '',
  };
}

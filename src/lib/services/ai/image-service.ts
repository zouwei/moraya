/**
 * AIGC Image Generation Service
 * Supports OpenAI DALL-E, Grok (xAI), and Custom (OpenAI-compatible) providers.
 * All providers share the same /images/generations API format.
 */

import type { ImageProviderConfig, AIProviderConfig } from './types';
import { resolveImageSize } from './types';
import { sendAIRequest } from './providers';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export interface ImageGenerationResult {
  url: string;
  revisedPrompt?: string;
}

export interface ImagePrompt {
  prompt: string;       // English prompt for AIGC
  target: number;       // Target paragraph index
  reason: string;       // Why this image fits this paragraph
}

export type ImageStyle =
  // Shared
  | 'auto'
  // Article
  | 'photo' | 'illustration' | 'flat' | 'ink' | 'isometric' | 'infographic' | 'editorial' | 'cartoon' | 'watercolor'
  // Design
  | 'render' | 'sketch' | 'blueprint' | 'clay' | 'wireframe' | 'exploded' | 'section' | 'cad' | 'prototype'
  // Storyboard
  | 'anime' | 'comic' | 'cinematic' | 'pixel' | 'noir' | 'manga' | 'realistic'
  // Product
  | 'studio' | 'lifestyle' | 'flatlay' | 'macro' | 'minimalist' | 'packaging' | 'outdoor' | 'mood'
  // Moodboard
  | 'abstract' | 'texture' | 'gradient' | 'collage' | 'vintage' | 'botanical' | 'geometric' | 'ethereal' | 'brutalist';

/**
 * Detect if the base URL points to Alibaba Cloud DashScope.
 */
function isDashScope(baseURL: string): boolean {
  return /dashscope/i.test(baseURL);
}

/**
 * Generate an image using DashScope's native multimodal-generation API.
 * Used for Alibaba Cloud qwen-image / wanx models.
 */
async function generateImageDashScope(
  config: ImageProviderConfig,
  prompt: string,
  size?: string,
): Promise<ImageGenerationResult> {
  const base = config.baseURL.replace(/\/+$/, '').replace(/\/compatible-mode\/v1$/, '');
  const url = `${base}/api/v1/services/aigc/multimodal-generation/generation`;

  // Convert "1024x1024" to "1024*1024" for DashScope
  const resolvedSize = size || resolveImageSize(config.defaultRatio, config.defaultSizeLevel);
  const dsSize = resolvedSize.replace('x', '*');

  // Use Tauri HTTP plugin to bypass CORS (DashScope native API has no CORS headers)
  const res = await tauriFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: {
        messages: [{
          role: 'user',
          content: [{ text: prompt }],
        }],
      },
      parameters: {
        size: dsSize,
        watermark: false,
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`DashScope image generation failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();

  // DashScope response: output.choices[0].message.content[0].image
  const imageUrl = data.output?.choices?.[0]?.message?.content?.[0]?.image;
  if (!imageUrl) {
    throw new Error(`No image URL in DashScope response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return { url: imageUrl };
}

/**
 * Generate an image using the configured AIGC provider.
 * Supports OpenAI-compatible (/images/generations) and DashScope native API.
 */
export async function generateImage(
  config: ImageProviderConfig,
  prompt: string,
  size?: string,
): Promise<ImageGenerationResult> {
  // Route to DashScope adapter for Alibaba Cloud
  if (isDashScope(config.baseURL)) {
    return generateImageDashScope(config, prompt, size);
  }

  // Standard OpenAI-compatible path
  const url = `${config.baseURL.replace(/\/$/, '')}/images/generations`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      prompt,
      n: 1,
      size: size || resolveImageSize(config.defaultRatio, config.defaultSizeLevel),
      response_format: 'url',
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Image generation failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  const item = data.data?.[0];

  if (!item?.url) {
    throw new Error('No image URL in response');
  }

  return {
    url: item.url,
    revisedPrompt: item.revised_prompt,
  };
}

/**
 * Test the AIGC provider connection by making a minimal request.
 * Uses a simple prompt to verify credentials and endpoint.
 */
export async function testImageConnection(config: ImageProviderConfig): Promise<boolean> {
  try {
    if (isDashScope(config.baseURL)) {
      // DashScope: check the models endpoint on their native API
      const base = config.baseURL.replace(/\/+$/, '').replace(/\/compatible-mode\/v1$/, '');
      const url = `${base}/compatible-mode/v1/models`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
      });
      return res.ok;
    }

    // Standard: check /models endpoint
    const url = `${config.baseURL.replace(/\/$/, '')}/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type ImageGenMode = 'article' | 'design' | 'storyboard' | 'product' | 'moodboard';

export const MODE_STYLES: Record<ImageGenMode, ImageStyle[]> = {
  article:    ['auto', 'photo', 'illustration', 'flat', 'ink', 'watercolor', 'isometric', 'infographic', 'editorial', 'cartoon'],
  design:     ['auto', 'render', 'sketch', 'blueprint', 'clay', 'wireframe', 'exploded', 'section', 'cad', 'prototype'],
  storyboard: ['auto', 'anime', 'comic', 'cinematic', 'watercolor', 'pixel', 'noir', 'manga', 'cartoon', 'realistic'],
  product:    ['auto', 'studio', 'lifestyle', 'flatlay', 'macro', 'minimalist', 'packaging', 'outdoor', 'editorial', 'mood'],
  moodboard:  ['auto', 'abstract', 'texture', 'gradient', 'collage', 'vintage', 'botanical', 'geometric', 'ethereal', 'brutalist'],
};

const JSON_FORMAT_RULES = `You MUST respond with a valid JSON array (no markdown, no code fences, just raw JSON) like:
[
  {"prompt": "english prompt for image generation", "target": 0, "reason": "brief reason in article language"}
]

Rules:
- Each prompt MUST be in English (required by image generation APIs).
- target: paragraph index (0-based) where the image should be inserted after.
- reason: brief explanation in the same language as the article.
- Output ONLY the JSON array, nothing else.`;

const MODE_SYSTEM_PROMPTS: Record<ImageGenMode, string> = {
  article: `You are an AI image prompt generator for article illustrations.
${JSON_FORMAT_RULES}
- Prompts should illustrate key concepts, scenes or metaphors from the article.
- Describe scene, style, lighting, composition in detail.
- Each image should enhance the reader's understanding of the corresponding paragraph.`,

  design: `You are an AI image prompt generator for product/industrial design visualization.
${JSON_FORMAT_RULES}
- Generate multi-angle product design views: front view, side view, 3/4 perspective, top-down, detail close-up, etc.
- Use clean studio lighting, neutral background, professional product photography style.
- Include material textures, surface finishes, and dimensional proportions.
- Each prompt should show the design from a different angle or highlight a different design detail.`,

  storyboard: `You are an AI image prompt generator for visual storyboards.
${JSON_FORMAT_RULES}
- Generate sequential narrative scenes that tell a visual story based on the content.
- Each prompt should represent one frame/scene in chronological order.
- Include character poses, camera angles (wide shot, close-up, over-the-shoulder), and scene transitions.
- Maintain visual consistency across frames: same characters, color palette, and art style.`,

  product: `You are an AI image prompt generator for e-commerce product photography.
${JSON_FORMAT_RULES}
- Generate professional product photography prompts: hero shot, lifestyle context, flat lay, packaging, scale reference, etc.
- Use commercial photography techniques: soft diffused lighting, clean backgrounds, styled props.
- Include different scenarios: product-only, product-in-use, product with lifestyle context.
- Focus on making the product look appealing and purchase-worthy.`,

  moodboard: `You are an AI image prompt generator for mood boards and creative inspiration.
${JSON_FORMAT_RULES}
- Generate abstract, atmospheric images that capture the mood, emotion, and aesthetic of the content.
- Focus on color palettes, textures, patterns, and abstract compositions.
- Include a mix of: color swatches as abstract scenes, texture close-ups, atmospheric landscapes, abstract art.
- Each image should evoke a specific feeling or aesthetic direction rather than literal illustration.`,
};

/**
 * Generate image prompts based on article content using text AI.
 */
export async function generateImagePrompts(
  textAIConfig: AIProviderConfig,
  articleContent: string,
  count: number = 3,
  style: ImageStyle = 'auto',
  mode: ImageGenMode = 'article',
): Promise<ImagePrompt[]> {
  const truncated = articleContent.slice(0, 6000);

  const styleHint = style === 'auto'
    ? 'Choose the most appropriate style for each image.'
    : `Use ${style} style for all images.`;

  const systemPrompt = MODE_SYSTEM_PROMPTS[mode];

  const response = await sendAIRequest(textAIConfig, {
    messages: [
      { role: 'system', content: systemPrompt, timestamp: Date.now() },
      {
        role: 'user',
        content: `Generate ${count} image prompts for this content. ${styleHint}\n\n${truncated}`,
        timestamp: Date.now(),
      },
    ],
  });

  const content = response.content.trim();
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('AI did not return valid JSON array');
  }

  const data = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(data)) {
    throw new Error('AI response is not an array');
  }

  return data.slice(0, count).map((item: any) => ({
    prompt: typeof item.prompt === 'string' ? item.prompt : '',
    target: typeof item.target === 'number' ? item.target : 0,
    reason: typeof item.reason === 'string' ? item.reason : '',
  }));
}

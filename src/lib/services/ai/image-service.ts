/**
 * AIGC Image Generation Service
 * Supports OpenAI DALL-E, Grok (xAI), and Custom (OpenAI-compatible) providers.
 * All providers share the same /images/generations API format.
 */

import type { ImageProviderConfig, AIProviderConfig } from './types';
import { resolveImageSize, DOUBAO_SIZE_MAP } from './types';
import { sendAIRequest, openaiEndpoint } from './providers';
import { generateBaseUrlCandidates } from './ai-service';
import { invoke } from '@tauri-apps/api/core';

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
  | 'abstract' | 'texture' | 'gradient' | 'collage' | 'vintage' | 'botanical' | 'geometric' | 'ethereal' | 'brutalist'
  // Portrait
  | 'portrait' | 'headshot' | 'fullbody' | 'fashion' | 'street' | 'glamour' | 'environmental' | 'candid' | 'group';

/**
 * Detect if the base URL points to Alibaba Cloud DashScope.
 */
function isDashScope(baseURL: string): boolean {
  return /dashscope/i.test(baseURL);
}

/**
 * Generate an image using Google Gemini Imagen API.
 * Endpoint: POST /v1beta/models/{model}:predict?key={apiKey}
 * Response: predictions[0].bytesBase64Encoded → data:image/png;base64,...
 */
async function generateImageGemini(
  config: ImageProviderConfig,
  prompt: string,
): Promise<ImageGenerationResult> {
  const base = config.baseURL.replace(/\/+$/, '');
  const url = `${base}/v1beta/models/${config.model}:predict`;

  const bodyPayload = JSON.stringify({
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: config.defaultRatio,
    },
  });

  const responseText = await invoke<string>('ai_proxy_fetch', {
    configId: config.id,
    keyPrefix: 'image-key:',
    apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
    provider: 'gemini',
    url,
    body: bodyPayload,
  });

  const data = JSON.parse(responseText);
  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) {
    throw new Error(`No image data in Gemini Imagen response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return { url: `data:image/png;base64,${b64}` };
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

  const bodyPayload = JSON.stringify({
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
  });

  // Route through Rust AI proxy (key injected from keychain)
  const responseText = await invoke<string>('ai_proxy_fetch', {
    configId: config.id,
    keyPrefix: 'image-key:',
    apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
    provider: 'dashscope',
    url,
    body: bodyPayload,
  });

  const data = JSON.parse(responseText);

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

  // Route to Gemini Imagen adapter
  if (config.provider === 'gemini') {
    return generateImageGemini(config, prompt);
  }

  // Standard OpenAI-compatible path — via Rust proxy
  const url = openaiEndpoint(config.baseURL, '/images/generations');

  const bodyPayload = JSON.stringify({
    model: config.model,
    prompt,
    n: 1,
    size: size || (config.provider === 'doubao'
      ? (DOUBAO_SIZE_MAP[config.defaultRatio]?.[config.defaultSizeLevel] ?? '2048x2048')
      : resolveImageSize(config.defaultRatio, config.defaultSizeLevel)),
    response_format: 'url',
  });

  const responseText = await invoke<string>('ai_proxy_fetch', {
    configId: config.id,
    keyPrefix: 'image-key:',
    apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
    provider: 'openai',
    url,
    body: bodyPayload,
  });

  const data = JSON.parse(responseText);
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
export async function testImageConnection(config: ImageProviderConfig): Promise<{ success: boolean; error?: string }> {
  function errMsg(e: unknown): string {
    return typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Connection failed');
  }

  if (isDashScope(config.baseURL)) {
    // DashScope: verify auth via native API POST with test input
    const base = config.baseURL.replace(/\/+$/, '').replace(/\/compatible-mode\/v1$/, '');
    const url = `${base}/api/v1/services/aigc/multimodal-generation/generation`;
    try {
      await invoke<string>('ai_proxy_fetch', {
        configId: config.id,
        keyPrefix: 'image-key:',
        apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
        provider: 'dashscope',
        url,
        body: JSON.stringify({
          model: config.model,
          input: { messages: [{ role: 'user', content: [{ text: 'test' }] }] },
        }),
      });
      return { success: true };
    } catch (e: unknown) {
      const msg = errMsg(e);
      if (msg.includes('(400)')) return { success: true };
      return { success: false, error: msg };
    }
  }

  if (config.provider === 'gemini') {
    // Gemini: check models list endpoint (key injected as query param by Rust proxy)
    const base = config.baseURL.replace(/\/+$/, '');
    const url = `${base}/v1beta/models`;
    try {
      await invoke<string>('ai_proxy_fetch', {
        configId: config.id,
        keyPrefix: 'image-key:',
        apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
        provider: 'gemini',
        url,
        body: '{}',
      });
      return { success: true };
    } catch (e: unknown) {
      const msg = errMsg(e);
      if (msg.includes('(400)')) return { success: true };
      return { success: false, error: msg };
    }
  }

  if (config.provider === 'doubao') {
    // VolcEngine /models only accepts GET; use /images/generations POST instead
    const url = openaiEndpoint(config.baseURL, '/images/generations');
    try {
      await invoke<string>('ai_proxy_fetch', {
        configId: config.id,
        keyPrefix: 'image-key:',
        apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
        provider: 'openai',
        url,
        body: JSON.stringify({ model: config.model, prompt: 'test', n: 1 }),
      });
      return { success: true };
    } catch (e: unknown) {
      const msg = errMsg(e);
      // 400/422 = valid key but bad params, 401/403 = bad key
      if (msg.includes('(400)') || msg.includes('(422)')) return { success: true };
      return { success: false, error: msg };
    }
  }

  // Standard: check /models endpoint via proxy
  try {
    const url = openaiEndpoint(config.baseURL, '/models');
    await invoke<string>('ai_proxy_fetch', {
      configId: config.id,
      keyPrefix: 'image-key:',
      apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
      provider: 'openai',
      url,
      body: '{}',
    });
    return { success: true };
  } catch (e: unknown) {
    return { success: false, error: errMsg(e) };
  }
}

/**
 * Test image connection with auto-resolution: progressively strip the base URL path
 * until a working endpoint is found. Returns the resolved URL on success.
 */
export async function testImageConnectionWithResolve(
  config: ImageProviderConfig,
): Promise<{ success: boolean; resolvedBaseUrl?: string; error?: string }> {
  const candidates = generateBaseUrlCandidates(config.baseURL);
  let lastError: string | undefined;
  for (const url of candidates) {
    const result = await testImageConnection({ ...config, baseURL: url || config.baseURL });
    if (result.success) return { success: true, resolvedBaseUrl: url };
    lastError = result.error;
  }
  return { success: false, error: lastError };
}

export type ImageGenMode = 'article' | 'design' | 'storyboard' | 'product' | 'moodboard' | 'portrait';

/**
 * Extract pre-defined image prompts from ```image-prompt(s) code blocks in the document.
 *
 * Supported formats:
 *
 * 1. JSON array (structured):
 *    ```image-prompts
 *    [{"prompt": "...", "target": 3, "reason": "..."}]
 *    ```
 *
 * 2. Plain text (one prompt per block, or multiple separated by ---):
 *    ```image-prompt
 *    A close-up portrait of a woman...
 *    ```
 *
 * Multiple code blocks are collected into a single prompt array.
 * Returns null if no valid blocks are found.
 */
export function extractImagePrompts(content: string): ImagePrompt[] | null {
  // Match both ```image-prompt and ```image-prompts (with or without trailing 's')
  // Allow optional spaces between ``` and language name (``` image-prompts)
  // Use multiline flag: ^/$ match line boundaries so fences must be at line start.
  const blockRegex = /^```\s*image-prompts?\s*\n([\s\S]*?)^```\s*$/gm;
  const prompts: ImagePrompt[] = [];
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(content)) !== null) {
    const body = match[1].trim();
    if (!body) continue;

    // Try JSON array first
    if (body.startsWith('[')) {
      try {
        const raw = JSON.parse(body);
        if (Array.isArray(raw)) {
          for (const item of raw) {
            if (typeof item.prompt === 'string' && item.prompt.trim()) {
              prompts.push({
                prompt: item.prompt.trim(),
                target: typeof item.target === 'number' ? item.target : 0,
                reason: typeof item.reason === 'string' ? item.reason : '',
              });
            }
          }
          continue;
        }
      } catch { /* not valid JSON — fall through to plain text */ }
    }

    // Plain text: split by --- separator for multiple prompts, or treat as single prompt
    const segments = body.split(/\n---\n/).map(s => s.trim()).filter(Boolean);
    for (const seg of segments) {
      prompts.push({ prompt: seg, target: 0, reason: '' });
    }
  }

  return prompts.length > 0 ? prompts : null;
}

/**
 * Count "paragraphs" in markdown content.
 * A paragraph = a group of consecutive non-empty lines separated by blank lines.
 * Matches the counting logic used in handleImageGenInsert (page.svelte).
 */
function countParagraphs(content: string): number {
  const lines = content.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() && (i + 1 >= lines.length || !lines[i + 1]?.trim())) {
      count++;
    }
  }
  return count;
}

/**
 * Compute evenly-spaced target paragraph indices for N images across totalParagraphs.
 * Each image is placed at the center of an equal segment.
 * E.g., 5 images across 20 paragraphs → targets [2, 6, 10, 14, 18]
 */
function computeEvenTargets(count: number, totalParagraphs: number): number[] {
  if (totalParagraphs <= 0 || count <= 0) return [];
  if (count >= totalParagraphs) {
    return Array.from({ length: count }, (_, i) => Math.min(i, totalParagraphs - 1));
  }
  const segmentSize = totalParagraphs / count;
  return Array.from({ length: count }, (_, i) =>
    Math.min(Math.round(segmentSize * i + segmentSize / 2), totalParagraphs - 1),
  );
}

/**
 * Add [P0], [P1], ... markers at the start of each paragraph group.
 * Helps the AI understand paragraph boundaries and positions.
 */
function addParagraphMarkers(content: string): string {
  const lines = content.split('\n');
  let paragraphIdx = 0;
  let inParagraph = false;
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const hasContent = !!lines[i].trim();

    if (hasContent && !inParagraph) {
      // First line of a new paragraph group — add marker
      result.push(`[P${paragraphIdx}] ${lines[i]}`);
      inParagraph = true;
    } else {
      result.push(lines[i]);
    }

    // End of paragraph group: non-empty line followed by empty or EOF
    if (hasContent && (i + 1 >= lines.length || !lines[i + 1]?.trim())) {
      paragraphIdx++;
      inParagraph = false;
    }
  }

  return result.join('\n');
}

export const MODE_STYLES: Record<ImageGenMode, ImageStyle[]> = {
  article:    ['auto', 'photo', 'illustration', 'flat', 'ink', 'watercolor', 'isometric', 'infographic', 'editorial', 'cartoon'],
  design:     ['auto', 'render', 'sketch', 'blueprint', 'clay', 'wireframe', 'exploded', 'section', 'cad', 'prototype'],
  storyboard: ['auto', 'anime', 'comic', 'cinematic', 'watercolor', 'pixel', 'noir', 'manga', 'cartoon', 'realistic'],
  product:    ['auto', 'studio', 'lifestyle', 'flatlay', 'macro', 'minimalist', 'packaging', 'outdoor', 'editorial', 'mood'],
  moodboard:  ['auto', 'abstract', 'texture', 'gradient', 'collage', 'vintage', 'botanical', 'geometric', 'ethereal', 'brutalist'],
  portrait:   ['auto', 'portrait', 'headshot', 'fullbody', 'fashion', 'street', 'cinematic', 'glamour', 'environmental', 'candid', 'group'],
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

  portrait: `You are an AI image prompt generator for portrait and people photography.
${JSON_FORMAT_RULES}
- Generate detailed portrait photography prompts with specific descriptions of: subject appearance, pose, expression, clothing, and accessories.
- Include professional photography parameters: lens focal length (e.g., 85mm f/1.4), lighting setup (Rembrandt, butterfly, rim light, golden hour), background/environment, and depth of field.
- Specify camera angle and framing: headshot, half-body, full-body, 3/4 view, profile, etc.
- Maintain consistent character appearance across all prompts if the article describes a specific person.
- Add mood and atmosphere keywords: warm, dramatic, ethereal, candid, editorial, etc.`,
};

/**
 * Generate image prompts based on article content using text AI.
 * Prompts are extracted from evenly-distributed positions across the article,
 * ensuring images are spread throughout rather than clustered at the beginning.
 */
export async function generateImagePrompts(
  textAIConfig: AIProviderConfig,
  articleContent: string,
  count: number = 3,
  style: ImageStyle = 'auto',
  mode: ImageGenMode = 'article',
): Promise<ImagePrompt[]> {
  const truncated = articleContent.slice(0, 6000);

  // Analyze article structure and compute ideal insertion positions
  const totalParagraphs = countParagraphs(truncated);
  const idealTargets = computeEvenTargets(count, totalParagraphs);
  const markedContent = addParagraphMarkers(truncated);

  const styleHint = style === 'auto'
    ? 'Choose the most appropriate style for each image.'
    : `Use ${style} style for all images.`;

  // Build distribution guidance so AI generates prompts for different parts of the article
  let distributionHint = '';
  if (totalParagraphs > 0 && idealTargets.length > 0) {
    const segmentDescs = idealTargets
      .map((t, i) => `Image ${i + 1}: focus on content near [P${t}]`)
      .join('; ');
    distributionHint = `\n\nIMPORTANT DISTRIBUTION RULE: The article has ${totalParagraphs} paragraphs (marked [P0] to [P${totalParagraphs - 1}]). You MUST spread ${count} images evenly across the ENTIRE article. Assign these targets: ${segmentDescs}. Each image prompt should describe the content near its assigned target paragraph. Do NOT cluster images at the beginning or any single section.`;
  }

  const systemPrompt = MODE_SYSTEM_PROMPTS[mode];

  const response = await sendAIRequest(textAIConfig, {
    messages: [
      { role: 'system', content: systemPrompt, timestamp: Date.now() },
      {
        role: 'user',
        content: `Generate ${count} image prompts for this content. ${styleHint}${distributionHint}\n\n${markedContent}`,
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

  // Parse prompts and force-assign evenly-distributed targets.
  // This guarantees even distribution regardless of what the AI returns.
  return data.slice(0, count).map((item: any, i: number) => ({
    prompt: typeof item.prompt === 'string' ? item.prompt : '',
    target: idealTargets[i] ?? (typeof item.target === 'number' ? item.target : 0),
    reason: typeof item.reason === 'string' ? item.reason : '',
  }));
}

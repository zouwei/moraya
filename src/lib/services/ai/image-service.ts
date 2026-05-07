/**
 * AIGC Image Generation Service
 * Supports OpenAI DALL-E, Grok (xAI), and Custom (OpenAI-compatible) providers.
 * All providers share the same /images/generations API format.
 */

import type { ImageProviderConfig, AIProviderConfig } from './types';
import { resolveImageSize, DOUBAO_SIZE_MAP } from './types';
import { sendAIRequest, openaiEndpoint } from './providers';
import { generateBaseUrlCandidates } from './ai-service';
import { extractOpenAICompatImageUrl, extractDashScopeImageUrl } from './image-response-parser';
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

/** Strip compatible-mode or api suffixes to get the DashScope base domain. */
function dashScopeBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '').replace(/\/(compatible-mode|api)\/v\d+(\/.*)?$/, '');
}

/**
 * DashScope endpoint candidates for image generation.
 * Phase 1: OpenAI-compatible endpoints (tried first).
 * Phase 2: DashScope native async task endpoints (fallback).
 */
function dashScopeOpenAICandidates(baseURL: string): string[] {
  const base = dashScopeBase(baseURL);
  return [
    `${base}/compatible-mode/v1/images/generations`,
    `${base}/v1/images/generations`,
  ];
}

/** DashScope native endpoint candidates with their API format. */
type DashScopeFormat = 'task' | 'multimodal';
interface NativeCandidate { url: string; format: DashScopeFormat }

function dashScopeNativeCandidates(baseURL: string): NativeCandidate[] {
  const base = dashScopeBase(baseURL);
  return [
    // z-image-turbo, qwen-image-2.0 — messages format, sync
    { url: `${base}/api/v1/services/aigc/multimodal-generation/generation`, format: 'multimodal' },
    // wanx-v1, wanx2.1-* — prompt format, async task polling
    { url: `${base}/api/v1/services/aigc/text2image/image-synthesis`, format: 'task' },
    // flux-* models — prompt format
    { url: `${base}/api/v1/services/aigc/text2image/text-to-image`, format: 'task' },
  ];
}

/**
 * Per-config endpoint cache: configId → resolved endpoint info.
 * `native` + `format` determine which API call function to use.
 */
interface ResolvedEndpoint { url: string; native?: boolean; format?: DashScopeFormat }
const _qwenEndpointCache = new Map<string, ResolvedEndpoint>();

/** Shared OpenAI-compatible image API call. */
async function callOpenAIImageAPI(
  config: ImageProviderConfig,
  prompt: string,
  size: string,
  url: string,
): Promise<ImageGenerationResult> {
  const bodyPayload = JSON.stringify({
    model: config.model,
    prompt,
    n: 1,
    size,
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
  const imageUrl = extractOpenAICompatImageUrl(data);

  if (!imageUrl) {
    // Include a response excerpt so the user can report the actual shape returned
    // by their aggregator (helps add new patterns to extractOpenAICompatImageUrl).
    throw new Error(`No image URL in response: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const revised = (data as { data?: Array<{ revised_prompt?: unknown }> }).data?.[0]?.revised_prompt;
  return { url: imageUrl, revisedPrompt: typeof revised === 'string' ? revised : undefined };
}

/**
 * DashScope native task API (input.prompt format).
 * Used by wanx-v1, wanx2.1-* on /text2image/image-synthesis.
 * Tries sync then async; handles 403 sync/async mode errors.
 */
async function callDashScopeTaskAPI(
  config: ImageProviderConfig,
  prompt: string,
  size: string,
  url: string,
): Promise<ImageGenerationResult> {
  const dsSize = size.replace('x', '*');
  const body = JSON.stringify({
    model: config.model,
    input: { prompt },
    parameters: { size: dsSize, n: 1 },
  });

  for (const mode of ['sync', 'async'] as const) {
    try {
      const response = await invoke<string>('ai_proxy_fetch', {
        configId: config.id,
        keyPrefix: 'image-key:',
        apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
        provider: 'openai',
        url,
        body,
        ...(mode === 'async' ? { headers: { 'X-DashScope-Async': 'enable' } } : {}),
      });

      const data = JSON.parse(response);

      const directUrl = extractDashScopeImageUrl(data);
      if (directUrl) return { url: directUrl };

      // Async task → poll
      const taskId = data.output?.task_id;
      if (taskId) {
        const base = url.replace(/\/services\/.*$/, '');
        const taskUrl = `${base}/tasks/${taskId}`;

        for (let i = 0; i < 60; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const statusResponse = await invoke<string>('ai_proxy_fetch', {
            configId: config.id,
            keyPrefix: 'image-key:',
            apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
            provider: 'openai',
            url: taskUrl,
            method: 'GET',
          });
          const statusData = JSON.parse(statusResponse);
          const taskStatus = statusData.output?.task_status;
          if (taskStatus === 'SUCCEEDED') {
            const imageUrl = extractDashScopeImageUrl(statusData);
            if (!imageUrl) throw new Error('No image URL in DashScope result');
            return { url: imageUrl };
          }
          if (taskStatus === 'FAILED') {
            throw new Error(`DashScope task failed: ${statusData.output?.message || 'Unknown error'}`);
          }
        }
        throw new Error('DashScope image generation timed out (120s)');
      }

      throw new Error('No task_id or image URL in DashScope response');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const lower = msg.toLowerCase();
      if (msg.includes('(403)') && (lower.includes('async') || lower.includes('synchronous'))) {
        continue;
      }
      throw e;
    }
  }

  throw new Error('DashScope: neither sync nor async mode succeeded');
}

/**
 * DashScope multimodal-generation API (input.messages format).
 * Used by z-image-turbo, qwen-image-2.0 on /multimodal-generation/generation.
 * Response: output.choices[0].message.content[].image
 */
async function callDashScopeMultimodalAPI(
  config: ImageProviderConfig,
  prompt: string,
  size: string,
  url: string,
): Promise<ImageGenerationResult> {
  const dsSize = size.replace('x', '*');
  const body = JSON.stringify({
    model: config.model,
    input: {
      messages: [{ role: 'user', content: [{ text: prompt }] }],
    },
    parameters: { size: dsSize, n: 1 },
  });

  const response = await invoke<string>('ai_proxy_fetch', {
    configId: config.id,
    keyPrefix: 'image-key:',
    apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
    provider: 'openai',
    url,
    body,
  });

  const data = JSON.parse(response);
  const imageUrl = extractDashScopeImageUrl(data);
  if (!imageUrl) {
    throw new Error(`No image URL in DashScope multimodal response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { url: imageUrl };
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
 * Generate an image using the configured AIGC provider.
 *
 * Routing:
 * - gemini → Imagen predict API (non-OpenAI format)
 * - qwen   → Unified OpenAI-compatible with endpoint auto-discovery & caching
 * - others → OpenAI-compatible /images/generations (VolcEngine, OpenAI, Grok, custom)
 */
export async function generateImage(
  config: ImageProviderConfig,
  prompt: string,
  size?: string,
): Promise<ImageGenerationResult> {
  // Gemini Imagen has a completely different API format (predict endpoint)
  if (config.provider === 'gemini') {
    return generateImageGemini(config, prompt);
  }

  const resolvedSize = size || (config.provider === 'doubao'
    ? (DOUBAO_SIZE_MAP[config.defaultRatio]?.[config.defaultSizeLevel] ?? '2048x2048')
    : resolveImageSize(config.defaultRatio, config.defaultSizeLevel));

  // DashScope (qwen): two-phase endpoint auto-discovery with caching.
  // Phase 1: OpenAI-compatible endpoints.
  // Phase 2: DashScope native endpoints (task API + multimodal API).
  if (config.provider === 'qwen') {
    function callByEndpoint(ep: ResolvedEndpoint, p: string, s: string) {
      if (!ep.native) return callOpenAIImageAPI(config, p, s, ep.url);
      if (ep.format === 'multimodal') return callDashScopeMultimodalAPI(config, p, s, ep.url);
      return callDashScopeTaskAPI(config, p, s, ep.url);
    }

    // Try cached endpoint first
    const cached = _qwenEndpointCache.get(config.id);
    if (cached) {
      try {
        return await callByEndpoint(cached, prompt, resolvedSize);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('(401)')) throw e;
        _qwenEndpointCache.delete(config.id);
      }
    }

    let lastError: unknown;

    // Phase 1: OpenAI-compatible candidates
    for (const url of dashScopeOpenAICandidates(config.baseURL)) {
      try {
        const result = await callOpenAIImageAPI(config, prompt, resolvedSize, url);
        _qwenEndpointCache.set(config.id, { url });
        return result;
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('(401)')) throw e;
      }
    }

    // Phase 2: DashScope native endpoints (each with its own format)
    for (const { url, format } of dashScopeNativeCandidates(config.baseURL)) {
      try {
        const ep: ResolvedEndpoint = { url, native: true, format };
        const result = await callByEndpoint(ep, prompt, resolvedSize);
        _qwenEndpointCache.set(config.id, ep);
        return result;
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('(401)')) throw e;
      }
    }

    throw lastError;
  }

  // Standard OpenAI-compatible path
  const url = openaiEndpoint(config.baseURL, '/images/generations');
  return callOpenAIImageAPI(config, prompt, resolvedSize, url);
}

/**
 * Test the AIGC provider connection by making a minimal request.
 * Uses a simple prompt to verify credentials and endpoint.
 */
export async function testImageConnection(config: ImageProviderConfig): Promise<{ success: boolean; error?: string }> {
  function errMsg(e: unknown): string {
    return typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Connection failed');
  }

  if (config.provider === 'qwen') {
    // DashScope: two-phase endpoint discovery.
    // 200 = auth OK, 400/422 = auth OK but bad params → endpoint valid.
    // EXCEPTION: 400 "url error" = endpoint doesn't match model → try next.
    // 403 "async" = endpoint valid but async not supported → still valid.
    // 401/403 (non-async) = bad API key → stop.
    let lastError: string | undefined;

    function isDashScopeCallModeError(msg: string): boolean {
      const lower = msg.toLowerCase();
      return msg.includes('(403)') && (lower.includes('async') || lower.includes('synchronous'));
    }

    function isDashScopeTestOK(msg: string): boolean {
      // 403 sync/async is NOT proof the endpoint works — only that the call mode is wrong.
      // Let the loop try the other mode; only 400/422 (non-url-error) proves endpoint validity.
      if ((msg.includes('(400)') || msg.includes('(422)')) && !msg.toLowerCase().includes('url error')) return true;
      return false;
    }

    function isDashScopeAuthError(msg: string): boolean {
      if (msg.includes('(401)')) return true;
      // 403 NOT about sync/async = real auth/permission error
      if (msg.includes('(403)') && !isDashScopeCallModeError(msg)) return true;
      return false;
    }

    // Phase 1: OpenAI-compatible endpoints
    for (const url of dashScopeOpenAICandidates(config.baseURL)) {
      try {
        await invoke<string>('ai_proxy_fetch', {
          configId: config.id,
          keyPrefix: 'image-key:',
          apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
          provider: 'openai',
          url,
          body: JSON.stringify({ model: config.model, prompt: 'test', n: 1 }),
        });
        _qwenEndpointCache.set(config.id, { url });
        return { success: true };
      } catch (e: unknown) {
        const msg = errMsg(e);
        if (isDashScopeTestOK(msg)) {
          _qwenEndpointCache.set(config.id, { url });
          return { success: true };
        }
        if (isDashScopeAuthError(msg)) return { success: false, error: msg };
        lastError = msg;
      }
    }

    // Phase 2: DashScope native endpoints — each has its own request format.
    for (const { url, format } of dashScopeNativeCandidates(config.baseURL)) {
      // Build test body matching the format: multimodal uses input.messages, task uses input.prompt.
      // Include size '1*1' (invalid) to trigger model-endpoint validation without generating.
      const testBody = format === 'multimodal'
        ? JSON.stringify({
            model: config.model,
            input: { messages: [{ role: 'user', content: [{ text: 'test' }] }] },
            parameters: { size: '1*1', n: 1 },
          })
        : JSON.stringify({
            model: config.model,
            input: { prompt: 'test' },
            parameters: { size: '1*1', n: 1 },
          });

      // Try sync first, then async (some models only support one mode)
      for (const asyncMode of [false, true]) {
        try {
          await invoke<string>('ai_proxy_fetch', {
            configId: config.id,
            keyPrefix: 'image-key:',
            apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
            provider: 'openai',
            url,
            body: testBody,
            ...(asyncMode ? { headers: { 'X-DashScope-Async': 'enable' } } : {}),
          });
          _qwenEndpointCache.set(config.id, { url, native: true, format });
          return { success: true };
        } catch (e: unknown) {
          const msg = errMsg(e);
          if (isDashScopeTestOK(msg)) {
            _qwenEndpointCache.set(config.id, { url, native: true, format });
            return { success: true };
          }
          if (isDashScopeAuthError(msg)) {
            if (msg.toLowerCase().includes('synchronous') || msg.toLowerCase().includes('async')) continue;
            return { success: false, error: msg };
          }
          lastError = msg;
        }
      }
    }

    return { success: false, error: lastError };
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

  // Standard: POST to /images/generations with minimal payload.
  // Not all providers support /models for image endpoints (DashScope, VolcEngine, etc.),
  // so test the actual endpoint. 400/422 = auth OK but bad params = success.
  try {
    const url = openaiEndpoint(config.baseURL, '/images/generations');
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
    if (msg.includes('(400)') || msg.includes('(422)')) return { success: true };
    return { success: false, error: msg };
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
  // Match ```prompt (new standard) and legacy ```image-prompt(s) for backward compat.
  // Allow optional spaces between ``` and language name.
  // Use multiline flag: ^/$ match line boundaries so fences must be at line start.
  const blockRegex = /^```\s*(?:prompt|image-prompts?)\s*\n([\s\S]*?)^```\s*$/gm;
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

/**
 * Concise visual style keywords appended directly to image generation prompts.
 * These ensure the style is applied at the image API level, not just during
 * prompt generation by the text AI.
 */
export const STYLE_PROMPT_SUFFIXES: Partial<Record<ImageStyle, string>> = {
  // Article
  photo:        'photorealistic photography, professional camera, natural lighting',
  illustration: 'digital illustration, detailed artwork, vibrant colors',
  flat:         'flat design style, minimal vector illustration, clean shapes, solid colors',
  ink:          'ink drawing, black and white line art, pen and ink, crosshatching',
  watercolor:   'watercolor painting, soft translucent washes, painterly texture',
  isometric:    'isometric 3D illustration, geometric shapes, clean precise lines',
  infographic:  'infographic style, data visualization, clean diagrams, informative layout',
  editorial:    'editorial photography, journalistic documentary style, candid reportage',
  cartoon:      'cartoon illustration, bold outlines, vibrant flat colors, fun style',
  // Design
  render:       '3D product render, studio lighting, photorealistic materials, clean background',
  sketch:       'pencil sketch, hand-drawn rough lines, graphite shading',
  blueprint:    'technical blueprint, white lines on dark blue, architectural drawing style',
  clay:         'clay render, soft matte 3D material, pastel tones, rounded shapes',
  wireframe:    'wireframe diagram, line-based technical illustration, structural',
  exploded:     'exploded view technical diagram, components separated in space',
  section:      'cross-section cutaway diagram, interior view, technical illustration',
  cad:          'CAD technical drawing, precise engineering lines, dimensional view',
  prototype:    'product prototype render, development stage model, rough 3D form',
  // Storyboard
  anime:        'anime illustration style, Japanese animation, vibrant cel-shading, expressive',
  comic:        'comic book style, bold ink outlines, halftone dots, dynamic action composition',
  cinematic:    'cinematic style, dramatic film lighting, movie color grading, widescreen',
  pixel:        'pixel art, retro 8-bit or 16-bit game aesthetic, chunky pixels',
  noir:         'film noir style, high-contrast black and white, dramatic deep shadows',
  manga:        'manga illustration, Japanese comic art, expressive black and white linework',
  realistic:    'photorealistic rendering, highly detailed, lifelike, accurate materials',
  // Product
  studio:       'professional studio product photography, white or neutral background, controlled soft-box lighting',
  lifestyle:    'lifestyle product photography, product in everyday use, natural setting, warm atmosphere',
  flatlay:      'flat lay photography, overhead top-down view, styled props arrangement',
  macro:        'macro close-up photography, extreme detail, very shallow depth of field',
  minimalist:   'minimalist photography, simple clean composition, generous negative space',
  packaging:    'product packaging photography, commercial presentation, brand-focused',
  outdoor:      'outdoor lifestyle photography, natural environment, golden hour warm light',
  mood:         'mood photography, atmospheric lighting, strong visual narrative, evocative',
  // Moodboard
  abstract:     'abstract art, non-representational, bold color fields, expressive forms',
  texture:      'texture close-up, surface material detail, tactile abstract photography',
  gradient:     'smooth color gradient art, soft transitions, clean minimal aesthetic',
  collage:      'collage art, mixed media layered composition, combined images and textures',
  vintage:      'vintage retro aesthetic, aged look, film grain, desaturated warm tones',
  botanical:    'botanical illustration, detailed scientific plant drawing, elegant linework',
  geometric:    'geometric abstract art, precise mathematical shapes, tessellation patterns',
  ethereal:     'ethereal dreamy aesthetic, soft luminous glow, mist, otherworldly atmosphere',
  brutalist:    'brutalist aesthetic, raw industrial materials, stark stark contrast, unconventional',
  // Portrait
  portrait:     'portrait photography, face and shoulders framed, shallow depth of field, soft diffused lighting',
  headshot:     'professional headshot, tight crop below shoulders, neutral gradient background, sharp focus, clean',
  fullbody:     'full body portrait, head to toe framing, dynamic pose, environmental background',
  fashion:      'fashion editorial photography, high-fashion clothing, dramatic editorial lighting, magazine quality',
  street:       'street photography portrait, candid or semi-candid, urban environment, natural available light',
  glamour:      'glamour photography, beauty lighting setup, dramatic makeup, luxurious styling, Hollywood',
  environmental:'environmental portrait, person photographed in their natural setting or workplace, storytelling',
  candid:       'candid documentary portrait, genuine natural expression, unposed, photojournalistic style',
  group:        'group portrait photography, multiple subjects, arranged balanced composition, cohesive look',
};

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
  // Distribute targets across the FULL article so images spread over the
  // entire document. Prior behavior truncated to 6000 chars first, which
  // made targets fall only within the article's first section → images
  // clustered at the top of long articles.
  const totalParagraphs = countParagraphs(articleContent);

  // Mark paragraphs on the full article first so [P_] indices match the
  // target distribution, THEN truncate if needed.
  const fullyMarked = addParagraphMarkers(articleContent);
  const MAX_CONTEXT = 24000;
  let markedContent: string;
  let visibleMaxParaIdx: number;
  if (fullyMarked.length <= MAX_CONTEXT) {
    markedContent = fullyMarked;
    visibleMaxParaIdx = totalParagraphs - 1;
  } else {
    markedContent = fullyMarked.slice(0, MAX_CONTEXT);
    // Highest [P_] marker still visible after truncation — targets beyond
    // this point would reference paragraphs the AI cannot see.
    const markerMatches = markedContent.match(/\[P(\d+)\]/g) || [];
    const last = markerMatches[markerMatches.length - 1];
    visibleMaxParaIdx = last ? parseInt(last.match(/\d+/)![0], 10) : 0;
  }
  // Clamp to visible paragraphs so AI can actually describe each target
  const idealTargets = computeEvenTargets(count, visibleMaxParaIdx + 1);

  const styleDesc = style !== 'auto' ? STYLE_PROMPT_SUFFIXES[style] : undefined;
  const styleHint = style === 'auto'
    ? 'Choose the most appropriate style for each image based on the content.'
    : `Use "${style}" style for all image prompts. Visual characteristics: ${styleDesc ?? style}. Include these style keywords explicitly in every prompt you generate.`;

  // Build distribution guidance so AI generates prompts for different parts of the article
  let distributionHint = '';
  if (idealTargets.length > 0) {
    const segmentDescs = idealTargets
      .map((t, i) => `Image ${i + 1}: focus on content near [P${t}]`)
      .join('; ');
    distributionHint = `\n\nIMPORTANT DISTRIBUTION RULE: The content below contains paragraphs marked [P0] to [P${visibleMaxParaIdx}]. You MUST spread ${count} images evenly across the ENTIRE content. Assign these targets: ${segmentDescs}. Each image prompt should describe the content near its assigned target paragraph. Do NOT cluster images at the beginning or any single section.`;
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

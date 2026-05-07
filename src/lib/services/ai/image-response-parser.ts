/**
 * Pure response-shape parsers for image generation APIs.
 *
 * Kept separate from `image-service.ts` so they can be unit-tested without
 * pulling in transitive imports that depend on the Tauri/browser runtime
 * (`window`, `invoke`, etc.).
 */

/** Extract image URL from DashScope response (multiple possible locations). */
export function extractDashScopeImageUrl(data: Record<string, unknown>): string | null {
  const output = data.output as Record<string, unknown> | undefined;
  if (!output) return null;
  // results[0].url (wanx async task)
  const results = output.results as Array<Record<string, unknown>> | undefined;
  if (results?.[0]?.url) return results[0].url as string;
  // result.url (some models)
  const result = output.result as Record<string, unknown> | undefined;
  if (result?.url) return result.url as string;
  // choices[0].message.content[].image (multimodal-generation: z-image-turbo, qwen-image-2.0)
  const choices = output.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content as Array<Record<string, unknown>> | undefined;
  if (content) {
    for (const item of content) {
      if (typeof item.image === 'string') return item.image;
    }
  }
  return null;
}

/**
 * Extract an image URL (or data URI) from an OpenAI-compatible response.
 * Aggregators and proxies (e.g. evolink.ai) often deviate from OpenAI's exact
 * shape, so probe several known patterns before giving up.
 *
 * Supported shapes:
 *   - { data: [{ url }] }                          (OpenAI standard)
 *   - { data: [{ b64_json }] }                     (OpenAI b64 mode)
 *   - { data: [{ image | image_url }] }            (some aggregators)
 *   - { images: ["..."] } / { images: [{ url }] }  (some aggregators)
 *   - { url } / { image } / { image_url }          (flat)
 *   - DashScope passthrough: { output: { ... } }   (e.g. z-image-turbo via aggregator)
 */
export function extractOpenAICompatImageUrl(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;

  const dataArr = root.data as Array<Record<string, unknown>> | undefined;
  const item0 = dataArr?.[0];
  if (item0) {
    if (typeof item0.url === 'string' && item0.url) return item0.url;
    if (typeof item0.image_url === 'string' && item0.image_url) return item0.image_url;
    if (typeof item0.image === 'string' && item0.image) return item0.image;
    if (typeof item0.b64_json === 'string' && item0.b64_json) {
      return `data:image/png;base64,${item0.b64_json}`;
    }
  }

  // DashScope-style passthrough (some aggregators forward Alibaba's response verbatim
  // for models like z-image-turbo, qwen-image-2.0, wanx*).
  if (root.output) {
    const ds = extractDashScopeImageUrl(root);
    if (ds) return ds;
  }

  const images = root.images as unknown;
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0];
    if (typeof first === 'string' && first) return first;
    if (first && typeof first === 'object') {
      const f = first as Record<string, unknown>;
      if (typeof f.url === 'string' && f.url) return f.url;
      if (typeof f.b64_json === 'string' && f.b64_json) return `data:image/png;base64,${f.b64_json}`;
    }
  }

  if (typeof root.url === 'string' && root.url) return root.url;
  if (typeof root.image === 'string' && root.image) return root.image;
  if (typeof root.image_url === 'string' && root.image_url) return root.image_url;

  return null;
}

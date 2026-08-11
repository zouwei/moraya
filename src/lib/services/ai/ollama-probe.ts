/**
 * Detect a locally-running Ollama instance so the AI onboarding empty state
 * can offer a one-click, zero-cost provider setup. Reuses the existing
 * TauriAITransport (→ Rust `ai_proxy_fetch`) instead of a raw frontend
 * fetch(), keeping every external/network call on the Rust-proxied path.
 */
import { TauriAITransport } from './adapters/tauri-ai-transport';
import { PROVIDER_BASE_URLS } from './types';

const transport = new TauriAITransport();

export type OllamaProbeResult =
  | { status: 'unreachable' }
  | { status: 'no_models' }
  | { status: 'ready'; models: string[] };

/** Pure — classifies the raw body already returned by the Rust proxy. */
export function classifyOllamaTagsBody(body: string): OllamaProbeResult {
  let parsed: { models?: { name?: string }[] };
  try {
    parsed = JSON.parse(body);
  } catch {
    // Unexpected shape (e.g. something else answering on :11434) — fail
    // safe rather than guess, so we never show a wrong pull command.
    return { status: 'unreachable' };
  }
  const models = (parsed.models ?? [])
    .map((m) => m.name)
    .filter((name): name is string => !!name);
  return models.length > 0 ? { status: 'ready', models } : { status: 'no_models' };
}

export async function probeOllama(baseUrl: string = PROVIDER_BASE_URLS.ollama): Promise<OllamaProbeResult> {
  try {
    const res = await transport.fetch({
      provider: 'ollama',
      configId: 'ollama-probe',
      method: 'GET',
      url: `${baseUrl.replace(/\/+$/, '')}/api/tags`,
      headers: {},
      body: '',
      auth: { scheme: 'none' },
    });
    return classifyOllamaTagsBody(res.body);
  } catch {
    return { status: 'unreachable' };
  }
}

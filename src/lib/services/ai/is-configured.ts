import type { AIProviderConfig } from './types';

/**
 * Pure — extracted from ai-service.ts so it can be unit-tested without
 * pulling in that file's heavy transitive imports (renderer-manager touches
 * `window` at module scope; not available under the default node test env).
 */
export function computeIsConfigured(configs: AIProviderConfig[], activeId: string | null): boolean {
  const active = configs.find((c) => c.id === activeId);
  if (!active) return false;
  // Ollama (and any future no-key local provider) legitimately has an empty
  // apiKey — presence of the config is enough, unlike cloud providers which
  // require a real key.
  if (active.provider === 'ollama') return true;
  return !!active.apiKey;
}

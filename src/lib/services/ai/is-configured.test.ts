import { describe, it, expect } from 'vitest';
import { computeIsConfigured } from './is-configured';
import type { AIProviderConfig } from './types';

function config(overrides: Partial<AIProviderConfig>): AIProviderConfig {
  return { id: 'cfg-1', provider: 'claude', apiKey: '', model: 'claude-sonnet', ...overrides };
}

describe('computeIsConfigured', () => {
  it('is true for an Ollama config with an empty apiKey — Ollama needs no key', () => {
    const configs = [config({ id: 'ollama-1', provider: 'ollama', apiKey: '', model: 'llama3.3' })];
    expect(computeIsConfigured(configs, 'ollama-1')).toBe(true);
  });

  it('is false for a non-Ollama config with an empty apiKey — cloud providers still need a key', () => {
    const configs = [config({ id: 'claude-1', provider: 'claude', apiKey: '' })];
    expect(computeIsConfigured(configs, 'claude-1')).toBe(false);
  });

  it('is true for a non-Ollama config with a real apiKey (unchanged baseline behavior)', () => {
    const configs = [config({ id: 'claude-1', provider: 'claude', apiKey: 'sk-real-key' })];
    expect(computeIsConfigured(configs, 'claude-1')).toBe(true);
  });

  it('is false when there is no active config', () => {
    const configs = [config({ id: 'claude-1', provider: 'claude', apiKey: 'sk-real-key' })];
    expect(computeIsConfigured(configs, null)).toBe(false);
  });

  it('is false when the active id does not match any config', () => {
    const configs = [config({ id: 'claude-1', provider: 'claude', apiKey: 'sk-real-key' })];
    expect(computeIsConfigured(configs, 'missing-id')).toBe(false);
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { classifyOllamaTagsBody, probeOllama } from './ollama-probe';

describe('classifyOllamaTagsBody', () => {
  it('returns ready with a single model name', () => {
    const result = classifyOllamaTagsBody('{"models":[{"name":"llama3.2:latest"}]}');
    expect(result).toEqual({ status: 'ready', models: ['llama3.2:latest'] });
  });

  it('returns ready with all model names in order when multiple are installed', () => {
    const result = classifyOllamaTagsBody(
      '{"models":[{"name":"llama3.2:latest"},{"name":"qwen2.5:7b"},{"name":"mistral:latest"}]}',
    );
    expect(result).toEqual({ status: 'ready', models: ['llama3.2:latest', 'qwen2.5:7b', 'mistral:latest'] });
  });

  it('returns no_models for an empty models array', () => {
    expect(classifyOllamaTagsBody('{"models":[]}')).toEqual({ status: 'no_models' });
  });

  it('returns no_models when the models key is missing', () => {
    expect(classifyOllamaTagsBody('{}')).toEqual({ status: 'no_models' });
  });

  it('returns unreachable for malformed JSON', () => {
    expect(classifyOllamaTagsBody('not json')).toEqual({ status: 'unreachable' });
  });

  it('filters out model entries missing a name instead of crashing', () => {
    const result = classifyOllamaTagsBody('{"models":[{"name":"llama3.2:latest"},{},{"name":"qwen2.5:7b"}]}');
    expect(result).toEqual({ status: 'ready', models: ['llama3.2:latest', 'qwen2.5:7b'] });
  });
});

describe('probeOllama', () => {
  it('returns ready when the Rust proxy resolves with a tags body containing models', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('{"models":[{"name":"llama3.2:latest"}]}');
    const result = await probeOllama();
    expect(result).toEqual({ status: 'ready', models: ['llama3.2:latest'] });
  });

  it('returns unreachable when the Rust proxy invoke rejects (Ollama not running)', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('AI request failed');
    const result = await probeOllama();
    expect(result).toEqual({ status: 'unreachable' });
  });
});

/**
 * LLM API adapters for multiple providers
 * Each provider normalizes to the same AIResponse interface
 */

import type { AIProviderConfig, AIRequest, AIResponse, ChatMessage } from './types';

/**
 * Send a request to Claude (Anthropic) API
 */
async function callClaude(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'https://api.anthropic.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 4096,
    messages: chatMessages.map(m => ({ role: m.role, content: m.content })),
  };

  if (systemMessages.length > 0) {
    body.system = systemMessages.map(m => m.content).join('\n');
  }

  if (config.temperature !== undefined) {
    body.temperature = config.temperature;
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  const data = await response.json();

  return {
    content: data.content?.[0]?.text || '',
    model: data.model,
    usage: {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
    },
  };
}

/**
 * Stream response from Claude API
 */
async function* streamClaude(config: AIProviderConfig, request: AIRequest): AsyncGenerator<string> {
  const baseUrl = config.baseUrl || 'https://api.anthropic.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 4096,
    stream: true,
    messages: chatMessages.map(m => ({ role: m.role, content: m.content })),
  };

  if (systemMessages.length > 0) {
    body.system = systemMessages.map(m => m.content).join('\n');
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield parsed.delta.text;
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }
}

/**
 * Send a request to OpenAI-compatible API (OpenAI, DeepSeek, local models)
 */
async function callOpenAICompatible(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'https://api.openai.com';

  const body = {
    model: config.model,
    max_tokens: config.maxTokens || 4096,
    temperature: config.temperature ?? 0.7,
    messages: request.messages.map(m => ({ role: m.role, content: m.content })),
  };

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error (${response.status}): ${error}`);
  }

  const data = await response.json();

  return {
    content: data.choices?.[0]?.message?.content || '',
    model: data.model,
    usage: {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Stream response from OpenAI-compatible API
 */
async function* streamOpenAICompatible(config: AIProviderConfig, request: AIRequest): AsyncGenerator<string> {
  const baseUrl = config.baseUrl || 'https://api.openai.com';

  const body = {
    model: config.model,
    max_tokens: config.maxTokens || 4096,
    temperature: config.temperature ?? 0.7,
    stream: true,
    messages: request.messages.map(m => ({ role: m.role, content: m.content })),
  };

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error (${response.status}): ${error}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }
}

/**
 * Send a request to Google Gemini API
 */
async function callGemini(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const contents = chatMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: config.maxTokens || 4096,
      temperature: config.temperature ?? 0.7,
    },
  };

  if (systemMessages.length > 0) {
    body.systemInstruction = { parts: [{ text: systemMessages.map(m => m.content).join('\n') }] };
  }

  const response = await fetch(
    `${baseUrl}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  const data = await response.json();

  return {
    content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    model: config.model,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

/**
 * Send a request to Ollama (local models)
 */
async function callOllama(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'http://localhost:11434';

  const body = {
    model: config.model,
    messages: request.messages.map(m => ({ role: m.role, content: m.content })),
    stream: false,
    options: {
      temperature: config.temperature ?? 0.7,
      num_predict: config.maxTokens || 4096,
    },
  };

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama error (${response.status}): ${error}`);
  }

  const data = await response.json();

  return {
    content: data.message?.content || '',
    model: data.model,
    usage: {
      inputTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0,
    },
  };
}

// ── Public API ──

export async function sendAIRequest(config: AIProviderConfig, request: AIRequest): Promise<AIResponse> {
  switch (config.provider) {
    case 'claude':
      return callClaude(config, request);
    case 'openai':
    case 'deepseek':
    case 'custom':
      return callOpenAICompatible(config, request);
    case 'gemini':
      return callGemini(config, request);
    case 'ollama':
      return callOllama(config, request);
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

export async function* streamAIRequest(config: AIProviderConfig, request: AIRequest): AsyncGenerator<string> {
  switch (config.provider) {
    case 'claude':
      yield* streamClaude(config, request);
      break;
    case 'openai':
    case 'deepseek':
    case 'custom':
      yield* streamOpenAICompatible(config, request);
      break;
    default:
      // Fallback: non-streaming
      const response = await sendAIRequest(config, request);
      yield response.content;
  }
}

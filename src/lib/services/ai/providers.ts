/**
 * LLM API adapters for multiple providers.
 * All requests are proxied through the Rust backend (ai_proxy) to keep
 * API keys out of WebView memory and network requests.
 */

import type { AIProviderConfig, AIRequest, AIResponse, ChatMessage, ToolCallRequest } from './types';
import {
  formatToolsForProvider,
  parseClaudeToolCalls,
  parseOpenAIToolCalls,
  parseGeminiToolCalls,
} from './tool-bridge';
import { invoke, Channel } from '@tauri-apps/api/core';

/** Build OpenAI-compatible endpoint URL, avoiding double version prefix (e.g., /v3/v1/...) */
export function openaiEndpoint(baseUrl: string, path: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  // Base URL already ends with a version segment like /v1, /v2, /v3 → don't add /v1
  if (/\/v\d+$/.test(clean)) return `${clean}${path}`;
  return `${clean}/v1${path}`;
}

/**
 * Non-streaming proxy fetch: sends request through Rust backend which injects
 * the API key from OS keychain and forwards to the AI provider.
 * Supports abort via AbortSignal — generates a requestId and calls ai_proxy_abort.
 */
async function proxyFetch(
  config: AIProviderConfig,
  provider: string,
  url: string,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<any> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const requestId = signal ? crypto.randomUUID() : undefined;

  // Register abort handler to cancel the Rust-side HTTP request
  if (signal && requestId) {
    signal.addEventListener('abort', () => {
      invoke('ai_proxy_abort', { requestId }).catch(() => {});
    }, { once: true });
  }

  const bodyStr = JSON.stringify(body);
  console.log(`[AI] proxy fetch → ${url} (body: ${bodyStr.length} chars, requestId: ${requestId})`);
  const t0 = performance.now();
  try {
    const responseText = await invoke<string>('ai_proxy_fetch', {
      requestId,
      configId: config.id,
      apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
      provider,
      url,
      body: bodyStr,
      headers: extraHeaders || undefined,
    });
    console.log(`[AI] proxy fetch ← ${url} (${Math.round(performance.now() - t0)}ms, response: ${responseText.length} chars)`);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return JSON.parse(responseText);
  } catch (err) {
    console.error(`[AI] proxy fetch ERROR (${Math.round(performance.now() - t0)}ms):`, err);
    // Convert Rust "Aborted by user" to standard AbortError
    if (signal?.aborted || (typeof err === 'string' && err.includes('Aborted'))) {
      throw new DOMException('Aborted', 'AbortError');
    }
    throw err;
  }
}

/**
 * Streaming proxy: sends request through Rust backend, receives text chunks
 * via Tauri Channel as they arrive from the AI provider's SSE stream.
 */
async function* streamViaProxy(
  config: AIProviderConfig,
  provider: string,
  url: string,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const requestId = crypto.randomUUID();
  const chunks: string[] = [];
  let streamDone = false;
  let streamError: Error | null = null;
  let waitResolve: (() => void) | null = null;

  const channel = new Channel<string>();
  channel.onmessage = (text: string) => {
    chunks.push(text);
    waitResolve?.();
    waitResolve = null;
  };

  // Handle user abort
  if (signal) {
    signal.addEventListener('abort', () => {
      invoke('ai_proxy_abort', { requestId }).catch(() => {});
    }, { once: true });
  }

  console.log(`[AI] proxy stream → ${url}`);

  // Start streaming (returns when stream completes)
  const streamPromise = invoke('ai_proxy_stream', {
    onEvent: channel,
    requestId,
    configId: config.id,
    apiKeyOverride: config.apiKey !== '***' ? config.apiKey : undefined,
    provider,
    url,
    body: JSON.stringify(body),
    headers: extraHeaders || undefined,
  }).then(() => {
    streamDone = true;
    waitResolve?.();
  }).catch((err: unknown) => {
    streamDone = true;
    streamError = new Error(typeof err === 'string' ? err : 'Stream failed');
    waitResolve?.();
  });

  // Yield chunks as they arrive
  while (!streamDone || chunks.length > 0) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (chunks.length > 0) {
      yield chunks.shift()!;
    } else if (!streamDone) {
      await new Promise<void>(r => { waitResolve = r; });
    }
  }

  if (streamError) throw streamError;
  await streamPromise;
}

// ── Provider-specific request builders ──

async function callClaude(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'https://api.anthropic.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 8192,
    messages: buildClaudeMessages(chatMessages),
  };

  if (systemMessages.length > 0) {
    body.system = systemMessages.map(m => m.content).join('\n');
  }

  if (config.temperature !== undefined) {
    body.temperature = config.temperature;
  }

  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider('claude', request.tools));
  }

  const data = await proxyFetch(config, 'claude', `${baseUrl}/v1/messages`, body, {
    'anthropic-version': '2023-06-01',
  }, signal);

  const parsed = parseClaudeToolCalls(data);

  return {
    content: parsed.textContent,
    model: data.model,
    usage: {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
    },
    toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
    stopReason: parsed.stopReason as AIResponse['stopReason'],
  };
}

function buildClaudeMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      result.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      const lastMsg = result[result.length - 1];
      const toolResultBlock = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        is_error: msg.isError || false,
      };
      if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content) &&
          (lastMsg.content as Array<Record<string, unknown>>).every((b: Record<string, unknown>) => b.type === 'tool_result')) {
        (lastMsg.content as Array<Record<string, unknown>>).push(toolResultBlock);
      } else {
        result.push({ role: 'user', content: [toolResultBlock] });
      }
    } else if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      // Multimodal: image blocks before text block
      const content: Array<Record<string, unknown>> = [];
      for (const img of msg.images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
        });
      }
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      result.push({ role: 'user', content });
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  return result;
}

async function* streamClaude(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<string> {
  const baseUrl = config.baseUrl || 'https://api.anthropic.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 8192,
    stream: true,
    messages: buildClaudeMessages(chatMessages),
  };

  if (systemMessages.length > 0) {
    body.system = systemMessages.map(m => m.content).join('\n');
  }

  yield* streamViaProxy(config, 'claude', `${baseUrl}/v1/messages`, body, {
    'anthropic-version': '2023-06-01',
  }, signal);
}

async function callOpenAICompatible(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'https://api.openai.com';

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 8192,
    temperature: config.temperature ?? 0.7,
    messages: buildOpenAIMessages(request.messages),
  };

  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider(config.provider, request.tools));
  }

  const provider = config.provider === 'deepseek' ? 'deepseek' : 'openai';
  const data = await proxyFetch(config, provider, openaiEndpoint(baseUrl, '/chat/completions'), body, undefined, signal);
  const parsed = parseOpenAIToolCalls(data);

  return {
    content: parsed.textContent,
    model: data.model,
    usage: {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    },
    toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
    stopReason: parsed.stopReason as AIResponse['stopReason'],
  };
}

function buildOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(msg => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    } else if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      };
    } else if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      // Multimodal: image_url blocks before text block
      const content: Array<Record<string, unknown>> = [];
      for (const img of msg.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
        });
      }
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      return { role: 'user', content };
    }
    return { role: msg.role, content: msg.content };
  });
}

async function* streamOpenAICompatible(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<string> {
  const baseUrl = config.baseUrl || 'https://api.openai.com';

  const body = {
    model: config.model,
    max_tokens: config.maxTokens || 8192,
    temperature: config.temperature ?? 0.7,
    stream: true,
    messages: buildOpenAIMessages(request.messages),
  };

  const provider = config.provider === 'deepseek' ? 'deepseek' : 'openai';
  yield* streamViaProxy(config, provider, openaiEndpoint(baseUrl, '/chat/completions'), body, undefined, signal);
}

async function callGemini(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const contents = buildGeminiContents(chatMessages);

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: config.maxTokens || 8192,
      temperature: config.temperature ?? 0.7,
    },
  };

  if (systemMessages.length > 0) {
    body.systemInstruction = { parts: [{ text: systemMessages.map(m => m.content).join('\n') }] };
  }

  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider('gemini', request.tools));
  }

  // Gemini: key is appended as query param by the Rust proxy
  const url = `${baseUrl}/v1beta/models/${config.model}:generateContent`;
  const data = await proxyFetch(config, 'gemini', url, body, undefined, signal);
  const parsed = parseGeminiToolCalls(data);

  return {
    content: parsed.textContent,
    model: config.model,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount || 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
    toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
    stopReason: parsed.stopReason === 'tool_use' ? 'tool_use' : 'end_turn',
  };
}

function buildGeminiContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(msg => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      return { role: 'model', parts };
    } else if (msg.role === 'tool') {
      return {
        role: 'user',
        parts: [{
          functionResponse: {
            name: msg.toolName,
            response: { content: msg.content },
          },
        }],
      };
    }
    // User message with images
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const parts: Array<Record<string, unknown>> = [];
      for (const img of msg.images) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
      }
      if (msg.content) parts.push({ text: msg.content });
      return { role: 'user', parts };
    }
    return {
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    };
  });
}

/** Build messages for Ollama's native /api/chat format (images as top-level array). */
function buildOllamaMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(msg => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    } else if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      };
    }
    const result: Record<string, unknown> = { role: msg.role, content: msg.content };
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      result.images = msg.images.map(img => img.base64);
    }
    return result;
  });
}

async function callOllama(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'http://localhost:11434';

  const body: Record<string, unknown> = {
    model: config.model,
    messages: buildOllamaMessages(request.messages),
    stream: false,
    options: {
      temperature: config.temperature ?? 0.7,
      num_predict: config.maxTokens || 8192,
    },
  };

  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider('ollama', request.tools));
  }

  const data = await proxyFetch(config, 'ollama', `${baseUrl}/api/chat`, body, undefined, signal);

  const message = data.message as Record<string, unknown> | undefined;
  const toolCalls: ToolCallRequest[] = [];
  const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (rawToolCalls) {
    for (const tc of rawToolCalls) {
      const fn = tc.function as Record<string, unknown>;
      toolCalls.push({
        id: crypto.randomUUID(),
        name: fn.name as string,
        arguments: (fn.arguments as Record<string, unknown>) || {},
      });
    }
  }

  return {
    content: (message?.content as string) || '',
    model: data.model,
    usage: {
      inputTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0,
    },
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
  };
}

// ── Public API ──

export async function sendAIRequest(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  switch (config.provider) {
    case 'claude':
      return callClaude(config, request, signal);
    case 'openai':
    case 'deepseek':
    case 'grok':
    case 'mistral':
    case 'glm':
    case 'minimax':
    case 'doubao':
    case 'custom':
      return callOpenAICompatible(config, request, signal);
    case 'gemini':
      return callGemini(config, request, signal);
    case 'ollama':
      return callOllama(config, request, signal);
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

export async function* streamAIRequest(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<string> {
  switch (config.provider) {
    case 'claude':
      yield* streamClaude(config, request, signal);
      break;
    case 'openai':
    case 'deepseek':
    case 'grok':
    case 'mistral':
    case 'glm':
    case 'minimax':
    case 'doubao':
    case 'custom':
      yield* streamOpenAICompatible(config, request, signal);
      break;
    default:
      // Fallback: non-streaming (gemini, ollama)
      const response = await sendAIRequest(config, request);
      yield response.content;
  }
}

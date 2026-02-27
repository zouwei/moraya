/**
 * LLM API adapters for multiple providers.
 * All requests are proxied through the Rust backend (ai_proxy) to keep
 * API keys out of WebView memory and network requests.
 */

import type { AIProviderConfig, AIRequest, AIResponse, ChatMessage, StreamToolResult, ToolCallRequest } from './types';
import { PROVIDER_BASE_URLS } from './types';
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

  // If no chunk arrives within this window, assume the stream has stalled.
  // This prevents the generator from waiting indefinitely when the provider
  // drops the SSE connection without sending [DONE] or closing properly.
  const CHUNK_TIMEOUT_MS = 30_000;

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
  let yieldCount = 0;
  while (!streamDone || chunks.length > 0) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (chunks.length > 0) {
      yield chunks.shift()!;
      // Periodically yield to the event loop so the browser can process user
      // interactions (stop button, ESC, menus).  Without this, rapid IPC
      // callbacks form a tight microtask chain that starves the event loop,
      // making the entire UI unresponsive.
      if (++yieldCount % 15 === 0) {
        await new Promise<void>(r => setTimeout(r, 0));
      }
    } else if (!streamDone) {
      // Wait for the next chunk with a timeout to prevent infinite hangs.
      // When a chunk arrives (or stream completes), waitResolve is called
      // which clears the timer and resolves the promise.
      // If no data arrives within CHUNK_TIMEOUT_MS, the timer fires,
      // sets the error state, and resolves the promise to exit the loop.
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>;
        waitResolve = () => { clearTimeout(timer); resolve(); };
        timer = setTimeout(() => {
          console.error(`[AI] Stream stalled: no chunk received for ${CHUNK_TIMEOUT_MS / 1000}s, aborting`);
          streamDone = true;
          streamError = new Error(`Stream stalled: no data received for ${CHUNK_TIMEOUT_MS / 1000}s. The AI provider may have dropped the connection.`);
          // Also abort the Rust-side request to clean up resources
          invoke('ai_proxy_abort', { requestId }).catch(() => {});
          resolve();
        }, CHUNK_TIMEOUT_MS);
      });
    }
  }

  if (streamError) throw streamError;
  await streamPromise;
}

// ── Provider-specific request builders ──

async function callClaude(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  const baseUrl = config.baseUrl || PROVIDER_BASE_URLS[config.provider] || 'https://api.anthropic.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 81920,
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
  const baseUrl = config.baseUrl || PROVIDER_BASE_URLS[config.provider] || 'https://api.anthropic.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 81920,
    stream: true,
    messages: buildClaudeMessages(chatMessages),
  };

  if (systemMessages.length > 0) {
    body.system = systemMessages.map(m => m.content).join('\n');
  }

  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider('claude', request.tools));
  }

  yield* streamViaProxy(config, 'claude', `${baseUrl}/v1/messages`, body, {
    'anthropic-version': '2023-06-01',
  }, signal);
}

async function callOpenAICompatible(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  const baseUrl = config.baseUrl || PROVIDER_BASE_URLS[config.provider] || 'https://api.openai.com';

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 81920,
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
  const baseUrl = config.baseUrl || PROVIDER_BASE_URLS[config.provider] || 'https://api.openai.com';

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 81920,
    temperature: config.temperature ?? 0.7,
    stream: true,
    messages: buildOpenAIMessages(request.messages),
  };

  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider(config.provider, request.tools));
  }

  const provider = config.provider === 'deepseek' ? 'deepseek' : 'openai';
  yield* streamViaProxy(config, provider, openaiEndpoint(baseUrl, '/chat/completions'), body, undefined, signal);
}

async function callGemini(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  const baseUrl = config.baseUrl || PROVIDER_BASE_URLS[config.provider] || 'https://generativelanguage.googleapis.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const contents = buildGeminiContents(chatMessages);

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: config.maxTokens || 81920,
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
  const baseUrl = config.baseUrl || PROVIDER_BASE_URLS[config.provider] || 'http://localhost:11434';

  const body: Record<string, unknown> = {
    model: config.model,
    messages: buildOllamaMessages(request.messages),
    stream: false,
    options: {
      temperature: config.temperature ?? 0.7,
      num_predict: config.maxTokens || 81920,
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

// ── Streaming tool call event parsers ──

/** Sentinel prefix used by Rust SSE parser to distinguish tool events from text. */
const TOOL_EVENT_PREFIX = '\x02';

/**
 * Parse accumulated SSE tool events into ToolCallRequest[].
 * Handles both Claude and OpenAI-compatible streaming formats.
 */
function parseStreamToolEvents(
  provider: string,
  events: string[],
): { toolCalls: ToolCallRequest[]; stopReason: string } {
  if (provider === 'claude') {
    return parseClaudeStreamEvents(events);
  }
  return parseOpenAIStreamEvents(events);
}

/** Parse Claude streaming tool call events. */
function parseClaudeStreamEvents(events: string[]): { toolCalls: ToolCallRequest[]; stopReason: string } {
  const toolCalls: ToolCallRequest[] = [];
  let stopReason = 'end_turn';
  // Accumulate partial JSON per content block index
  const partials = new Map<number, { id: string; name: string; json: string }>();

  for (const raw of events) {
    let v: Record<string, unknown>;
    try { v = JSON.parse(raw); } catch { continue; }

    const eventType = v.type as string;
    switch (eventType) {
      case 'content_block_start': {
        const block = v.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          const index = v.index as number;
          partials.set(index, {
            id: block.id as string,
            name: block.name as string,
            json: '',
          });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = v.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'input_json_delta') {
          const index = v.index as number;
          const partial = partials.get(index);
          if (partial) {
            partial.json += (delta.partial_json as string) || '';
          }
        }
        break;
      }
      case 'content_block_stop': {
        const index = v.index as number;
        const partial = partials.get(index);
        if (partial) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(partial.json || '{}');
            toolCalls.push({ id: partial.id, name: partial.name, arguments: args });
          } catch {
            console.warn(`[AI] Skipping tool call ${partial.name}: failed to parse arguments (truncated?): ${partial.json.slice(0, 200)}`);
          }
          partials.delete(index);
        }
        break;
      }
      case 'message_delta': {
        const delta = v.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) {
          stopReason = delta.stop_reason === 'tool_use' ? 'tool_use' : (delta.stop_reason as string);
        }
        break;
      }
    }
  }

  // Remaining partials without content_block_stop = truncated tool calls; skip them
  if (partials.size > 0) {
    for (const [, partial] of partials) {
      console.warn(`[AI] Skipping incomplete Claude tool call ${partial.name}: no content_block_stop received (truncated?)`);
    }
  }

  return { toolCalls, stopReason };
}

/** Parse OpenAI-compatible streaming tool call events. */
function parseOpenAIStreamEvents(events: string[]): { toolCalls: ToolCallRequest[]; stopReason: string } {
  const toolMap = new Map<number, { id: string; name: string; args: string }>();
  let stopReason = 'end_turn';

  for (const raw of events) {
    let v: Record<string, unknown>;
    try { v = JSON.parse(raw); } catch { continue; }

    const choices = v.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) continue;
    const choice = choices[0];

    // Check finish_reason — normalize to unified stop reasons
    const fr = choice.finish_reason as string | null;
    if (fr) {
      if (fr === 'tool_calls') stopReason = 'tool_use';
      else if (fr === 'length') stopReason = 'max_tokens';  // OpenAI 'length' = Claude 'max_tokens'
      else stopReason = fr;
    }

    // Accumulate tool calls by index
    const delta = choice.delta as Record<string, unknown> | undefined;
    const rawToolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls) {
      for (const tc of rawToolCalls) {
        const idx = (tc.index as number) ?? 0;
        const fn = tc.function as Record<string, unknown> | undefined;
        let entry = toolMap.get(idx);
        if (!entry) {
          entry = { id: (tc.id as string) || '', name: '', args: '' };
          toolMap.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id as string;
        if (fn?.name) entry.name = fn.name as string;
        if (fn?.arguments) entry.args += fn.arguments as string;
      }
    }
  }

  const toolCalls: ToolCallRequest[] = [];
  for (const [, entry] of [...toolMap.entries()].sort((a, b) => a[0] - b[0])) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(entry.args || '{}');
    } catch {
      // Truncated or malformed arguments — skip this tool call entirely.
      // This typically happens when the response was cut off (max_tokens/length)
      // and the arguments JSON is incomplete.
      console.warn(`[AI] Skipping tool call ${entry.name}: failed to parse arguments (truncated?): ${entry.args.slice(0, 200)}`);
      continue;
    }
    toolCalls.push({ id: entry.id, name: entry.name, arguments: args });
  }

  return { toolCalls, stopReason };
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

/**
 * Streaming with tool call support.
 * Streams text in real-time via `onTextChunk`, while also accumulating
 * tool call events (prefixed with \x02 from Rust SSE parser).
 * Returns the complete result including any tool calls.
 *
 * For providers without streaming tool support (Gemini, Ollama),
 * falls back to non-streaming sendAIRequest.
 */
export async function streamAIRequestWithTools(
  config: AIProviderConfig,
  request: AIRequest,
  signal?: AbortSignal,
  onTextChunk?: (chunk: string) => void,
): Promise<StreamToolResult> {
  // Gemini and Ollama: no SSE tool streaming — use non-streaming with full response
  if (config.provider === 'gemini' || config.provider === 'ollama') {
    const response = await sendAIRequest(config, request, signal);
    if (response.content) {
      onTextChunk?.(response.content);
    }
    return {
      content: response.content,
      toolCalls: response.toolCalls,
      stopReason: response.stopReason,
    };
  }

  // Claude + OpenAI-compatible: streaming with tool event parsing
  const stream = streamAIRequest(config, request, signal);
  let textContent = '';
  const toolEvents: string[] = [];

  for await (const chunk of stream) {
    if (chunk.startsWith(TOOL_EVENT_PREFIX)) {
      // Tool/metadata event from Rust — accumulate for later parsing
      toolEvents.push(chunk.slice(1));
    } else {
      // Plain text chunk — display in real-time
      textContent += chunk;
      onTextChunk?.(chunk);
    }
  }

  // Parse tool calls from collected events
  if (toolEvents.length > 0) {
    const providerKey = config.provider === 'claude' ? 'claude' : 'openai';
    const parsed = parseStreamToolEvents(providerKey, toolEvents);
    return {
      content: textContent,
      toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
      stopReason: parsed.stopReason,
    };
  }

  return { content: textContent, stopReason: 'end_turn' };
}

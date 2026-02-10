/**
 * LLM API adapters for multiple providers
 * Each provider normalizes to the same AIResponse interface
 */

import type { AIProviderConfig, AIRequest, AIResponse, ChatMessage, ToolCallRequest } from './types';
import {
  formatToolsForProvider,
  parseClaudeToolCalls,
  parseOpenAIToolCalls,
  parseGeminiToolCalls,
} from './tool-bridge';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/** Default timeout for AI API requests (3 minutes) */
const AI_FETCH_TIMEOUT_MS = 180_000;

/** Build OpenAI-compatible endpoint URL, avoiding double version prefix (e.g., /v3/v1/...) */
export function openaiEndpoint(baseUrl: string, path: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  // Base URL already ends with a version segment like /v1, /v2, /v3 → don't add /v1
  if (/\/v\d+$/.test(clean)) return `${clean}${path}`;
  return `${clean}/v1${path}`;
}

/**
 * Fetch via Tauri HTTP plugin (Rust backend) — bypasses WebKit's ~60s timeout.
 * Falls back to global fetch if Tauri plugin is unavailable.
 */
function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = AI_FETCH_TIMEOUT_MS, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  console.log(`[AI] fetch → ${url}`);
  const fetchFn = tauriFetch || fetch;
  return fetchFn(url, { ...init, signal: controller.signal }).catch((err: Error) => {
    console.error(`[AI] fetch failed: ${url}`, err.name, err.message);
    // User-initiated abort: always propagate as AbortError
    if (externalSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (err.name === 'AbortError') {
      throw new Error(`AI 请求超时（${Math.round(timeoutMs / 1000)}s），请尝试简化请求或检查网络`);
    }
    throw new Error(`AI 服务连接失败 (${err.message})，请检查网络连接和 API 配置`);
  }).finally(() => clearTimeout(timer));
}

/**
 * Send a request to Claude (Anthropic) API
 */
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

  // Add tools if available
  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider('claude', request.tools));
  }

  const response = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  }, AI_FETCH_TIMEOUT_MS, signal);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const parsed = parseClaudeToolCalls(data);

  return {
    content: parsed.textContent,
    model: data.model,
    usage: {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
    },
    toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
    stopReason: parsed.stopReason === 'tool_use' ? 'tool_use' : 'end_turn',
  };
}

/**
 * Build Claude-format messages, handling tool call/result messages properly.
 * Claude expects tool_use in assistant content blocks and tool_result in user content blocks.
 */
function buildClaudeMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Assistant message with tool calls: build content blocks
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      result.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      // Tool result: Claude expects this as a user message with tool_result content
      // Group consecutive tool results into one user message
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
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  return result;
}

/**
 * Stream response from Claude API
 */
async function* streamClaude(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<string> {
  const baseUrl = config.baseUrl || 'https://api.anthropic.com';

  const systemMessages = request.messages.filter(m => m.role === 'system');
  const chatMessages = request.messages.filter(m => m.role !== 'system');

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 8192,
    stream: true,
    messages: chatMessages.map(m => ({ role: m.role, content: m.content })),
  };

  if (systemMessages.length > 0) {
    body.system = systemMessages.map(m => m.content).join('\n');
  }

  const response = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  }, AI_FETCH_TIMEOUT_MS, signal);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
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
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Send a request to OpenAI-compatible API (OpenAI, DeepSeek, local models)
 */
async function callOpenAICompatible(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'https://api.openai.com';

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens || 8192,
    temperature: config.temperature ?? 0.7,
    messages: buildOpenAIMessages(request.messages),
  };

  // Add tools if available
  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider(config.provider, request.tools));
  }

  const response = await fetchWithTimeout(openaiEndpoint(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  }, AI_FETCH_TIMEOUT_MS, signal);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  const parsed = parseOpenAIToolCalls(data);

  return {
    content: parsed.textContent,
    model: data.model,
    usage: {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    },
    toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
    stopReason: parsed.stopReason === 'tool_use' ? 'tool_use' : 'end_turn',
  };
}

/**
 * Build OpenAI-format messages, handling tool call/result messages.
 */
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
    }
    return { role: msg.role, content: msg.content };
  });
}

/**
 * Stream response from OpenAI-compatible API
 */
async function* streamOpenAICompatible(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): AsyncGenerator<string> {
  const baseUrl = config.baseUrl || 'https://api.openai.com';

  const body = {
    model: config.model,
    max_tokens: config.maxTokens || 8192,
    temperature: config.temperature ?? 0.7,
    stream: true,
    messages: request.messages.map(m => ({ role: m.role, content: m.content })),
  };

  const response = await fetchWithTimeout(openaiEndpoint(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  }, AI_FETCH_TIMEOUT_MS, signal);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error (${response.status}): ${error}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
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
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Send a request to Google Gemini API
 */
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

  // Add tools if available
  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider('gemini', request.tools));
  }

  const response = await fetchWithTimeout(
    `${baseUrl}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    AI_FETCH_TIMEOUT_MS,
    signal,
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  const data = await response.json();
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

/**
 * Build Gemini-format contents, handling tool call/result messages.
 */
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
    return {
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    };
  });
}

/**
 * Send a request to Ollama (local models)
 */
async function callOllama(config: AIProviderConfig, request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
  const baseUrl = config.baseUrl || 'http://localhost:11434';

  const body: Record<string, unknown> = {
    model: config.model,
    messages: buildOpenAIMessages(request.messages),
    stream: false,
    options: {
      temperature: config.temperature ?? 0.7,
      num_predict: config.maxTokens || 8192,
    },
  };

  // Add tools if available
  if (request.tools && request.tools.length > 0) {
    Object.assign(body, formatToolsForProvider('ollama', request.tools));
  }

  const response = await fetchWithTimeout(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, AI_FETCH_TIMEOUT_MS, signal);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama error (${response.status}): ${error}`);
  }

  const data = await response.json();

  // Parse tool calls from Ollama response (same format as OpenAI)
  const message = data.message as Record<string, unknown> | undefined;
  const toolCalls: ToolCallRequest[] = [];
  const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
  if (rawToolCalls) {
    for (const tc of rawToolCalls) {
      const fn = tc.function as Record<string, unknown>;
      toolCalls.push({
        id: `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    case 'custom':
      yield* streamOpenAICompatible(config, request, signal);
      break;
    default:
      // Fallback: non-streaming
      const response = await sendAIRequest(config, request);
      yield response.content;
  }
}

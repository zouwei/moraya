/**
 * AI Service - orchestrates AI operations for the editor
 */

import { writable, get } from 'svelte/store';
import { load } from '@tauri-apps/plugin-store';
import { sendAIRequest, streamAIRequest } from './providers';
import type {
  AIProviderConfig,
  AICommand,
  ChatMessage,
  AIResponse,
  AI_COMMANDS,
  ToolDefinition,
} from './types';
import { AI_COMMANDS as COMMANDS } from './types';
import { t } from '$lib/i18n';
import { getAllTools, callTool } from '$lib/services/mcp';
import { mcpToolsToToolDefs } from './tool-bridge';
import { INTERNAL_TOOLS, isInternalTool, executeInternalTool } from './internal-tools';
import { editorStore } from '$lib/stores/editor-store';
import { containerStore } from '$lib/services/mcp/container-store';
import { documentDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';

const AI_STORE_FILE = 'ai-config.json';

async function persistAIConfigs(configs: AIProviderConfig[], activeConfigId: string | null) {
  try {
    const store = await load(AI_STORE_FILE);
    await store.set('providerConfigs', configs);
    await store.set('activeConfigId', activeConfigId);
    await store.save();
  } catch { /* ignore */ }
}

// ── AI State Store ──

interface AIState {
  isConfigured: boolean;
  isLoading: boolean;
  error: string | null;
  interrupted: boolean;
  chatHistory: ChatMessage[];
  lastResponse: string | null;
  streamingContent: string;
  providerConfigs: AIProviderConfig[];
  activeConfigId: string | null;
}

function computeIsConfigured(configs: AIProviderConfig[], activeId: string | null): boolean {
  const active = configs.find(c => c.id === activeId);
  return !!active?.apiKey;
}

function createAIStore() {
  const { subscribe, set, update } = writable<AIState>({
    isConfigured: false,
    isLoading: false,
    error: null,
    interrupted: false,
    chatHistory: [],
    lastResponse: null,
    streamingContent: '',
    providerConfigs: [],
    activeConfigId: null,
  });

  return {
    subscribe,

    /** Load configs from disk without re-persisting */
    _load(configs: AIProviderConfig[], activeId: string | null) {
      update(state => ({
        ...state,
        providerConfigs: configs,
        activeConfigId: activeId,
        isConfigured: computeIsConfigured(configs, activeId),
        error: null,
      }));
    },

    addProviderConfig(config: AIProviderConfig) {
      update(state => {
        const configs = [...state.providerConfigs, config];
        const activeId = state.activeConfigId || config.id;
        persistAIConfigs(configs, activeId);
        return {
          ...state,
          providerConfigs: configs,
          activeConfigId: activeId,
          isConfigured: computeIsConfigured(configs, activeId),
        };
      });
    },

    updateProviderConfig(config: AIProviderConfig) {
      update(state => {
        const configs = state.providerConfigs.map(c => c.id === config.id ? config : c);
        persistAIConfigs(configs, state.activeConfigId);
        return {
          ...state,
          providerConfigs: configs,
          isConfigured: computeIsConfigured(configs, state.activeConfigId),
        };
      });
    },

    removeProviderConfig(id: string) {
      update(state => {
        if (state.providerConfigs.length <= 1) return state;
        const configs = state.providerConfigs.filter(c => c.id !== id);
        let activeId = state.activeConfigId;
        if (activeId === id) {
          activeId = configs[0]?.id || null;
        }
        persistAIConfigs(configs, activeId);
        return {
          ...state,
          providerConfigs: configs,
          activeConfigId: activeId,
          isConfigured: computeIsConfigured(configs, activeId),
        };
      });
    },

    setActiveConfig(id: string) {
      update(state => {
        persistAIConfigs(state.providerConfigs, id);
        return {
          ...state,
          activeConfigId: id,
          isConfigured: computeIsConfigured(state.providerConfigs, id),
        };
      });
    },

    getActiveConfig(): AIProviderConfig | null {
      const state = get({ subscribe });
      return state.providerConfigs.find(c => c.id === state.activeConfigId) || null;
    },

    setLoading(loading: boolean) {
      update(state => ({ ...state, isLoading: loading, error: null, interrupted: false }));
    },
    setError(error: string) {
      update(state => ({ ...state, error, isLoading: false }));
    },
    appendStreamContent(chunk: string) {
      update(state => ({ ...state, streamingContent: state.streamingContent + chunk }));
    },
    resetStream() {
      update(state => ({ ...state, streamingContent: '' }));
    },
    addMessage(message: ChatMessage) {
      update(state => ({
        ...state,
        chatHistory: [...state.chatHistory, message],
      }));
    },
    setLastResponse(content: string) {
      update(state => ({ ...state, lastResponse: content, isLoading: false }));
    },
    setInterrupted() {
      update(state => ({ ...state, isLoading: false, interrupted: true }));
    },
    clearHistory() {
      update(state => ({ ...state, chatHistory: [], lastResponse: null, interrupted: false }));
    },
    getState() {
      return get({ subscribe });
    },
  };
}

export const aiStore = createAIStore();

// ── Abort controller ──

let currentAbortController: AbortController | null = null;

/** Abort the currently running AI request (streaming or non-streaming). */
export function abortAIRequest(): void {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

// ── AI Operations ──

/**
 * Execute an AI command on the given text
 */
export async function executeAICommand(
  command: AICommand,
  context: {
    selectedText?: string;
    documentContent?: string;
    customPrompt?: string;
    targetLanguage?: string;
  }
): Promise<string> {
  const state = aiStore.getState();
  const activeConfig = aiStore.getActiveConfig();
  const tr = get(t);
  if (!activeConfig || !state.isConfigured) {
    throw new Error(tr('errors.aiNotConfigured'));
  }

  const commandDef = COMMANDS.find(c => c.command === command);
  if (!commandDef && command !== 'custom') {
    throw new Error(tr('errors.unknownCommand', { command }));
  }

  aiStore.setLoading(true);
  aiStore.resetStream();

  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  try {
    const messages: ChatMessage[] = [];

    // System prompt
    const systemPrompt = command === 'custom'
      ? 'You are a helpful writing assistant. Follow the user\'s instructions. Output in Markdown format.'
      : commandDef!.systemPrompt;

    messages.push({
      role: 'system',
      content: systemPrompt,
      timestamp: Date.now(),
    });

    // Build user message based on command
    let userContent = '';

    switch (command) {
      case 'write':
      case 'outline':
        userContent = context.customPrompt || context.selectedText || '';
        break;

      case 'continue':
        userContent = `Continue writing from this text:\n\n${context.documentContent?.slice(-2000) || ''}`;
        break;

      case 'translate':
        userContent = context.targetLanguage
          ? `Translate the following text to ${context.targetLanguage}:\n\n${context.selectedText || ''}`
          : `${context.selectedText || ''}`;
        break;

      case 'custom':
        userContent = context.customPrompt || '';
        if (context.selectedText) {
          userContent += `\n\nText:\n${context.selectedText}`;
        }
        break;

      default:
        // For commands that operate on selected text
        userContent = context.selectedText || context.documentContent?.slice(-2000) || '';
        break;
    }

    messages.push({
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    });

    // Record in chat history
    aiStore.addMessage(messages[messages.length - 1]);

    // Stream the response
    let fullContent = '';
    const stream = streamAIRequest(activeConfig, { messages, stream: true }, signal);

    for await (const chunk of stream) {
      fullContent += chunk;
      aiStore.appendStreamContent(chunk);
    }

    // Record assistant response (only if we got content)
    if (fullContent) {
      aiStore.addMessage({
        role: 'assistant',
        content: fullContent,
        timestamp: Date.now(),
      });
    }

    aiStore.setLastResponse(fullContent);
    return fullContent;

  } catch (error: any) {
    if (error?.name === 'AbortError' || signal.aborted) {
      // User-initiated abort: save partial content, show interrupted indicator
      const partial = aiStore.getState().streamingContent;
      if (partial) {
        aiStore.addMessage({ role: 'assistant', content: partial, timestamp: Date.now() });
      }
      aiStore.setInterrupted();
      return partial;
    }
    const errMsg = error?.message || get(t)('errors.aiRequestFailed');
    aiStore.setError(errMsg);
    throw error;
  } finally {
    currentAbortController = null;
  }
}

function buildSystemPrompt(
  config: AIProviderConfig,
  toolCount: number,
  currentDir: string | null,
  currentFilePath: string | null,
  documentContext?: string,
): string {
  let prompt = `You are Moraya AI, a helpful writing assistant integrated into a Markdown editor. You are powered by ${config.model} (${config.provider}). Help the user with writing, editing, and content creation. Always respond in Markdown format when producing content.`;

  if (toolCount > 0) {
    prompt += ' You have access to tools. Use them when they can help answer the user\'s question. You can use add_mcp_server to help users install and configure new MCP servers.';
  }

  // Dynamic service creation capability
  const nodeState = containerStore.getState();
  if (nodeState.nodeAvailable) {
    prompt +=
      '\n\nYou can create dynamic MCP services on-the-fly using create_mcp_service. Use this when:' +
      '\n- The user needs data from an HTTP API (REST, GraphQL) and no existing tool covers it' +
      '\n- You need to fetch or process data from a web service' +
      '\n- A temporary automation would help the user' +
      '\n\nWhen creating services:' +
      '\n- Write handler code using Node.js built-in fetch() for HTTP calls' +
      '\n- Pass API keys as env variables, never hardcode them in handler code' +
      '\n- Keep handlers focused and include proper error handling' +
      '\n- The service tools become immediately available for subsequent tool calls';
  }

  if (currentDir) prompt += `\n\nCurrent working directory: ${currentDir}`;
  if (currentFilePath) prompt += `\nCurrent file: ${currentFilePath}`;
  if (documentContext) {
    prompt += `\n\n${documentContext ? `Current document context (last 1000 chars):\n${documentContext.slice(-1000)}` : ''}`;
  }

  return prompt;
}

/**
 * Send a free-form chat message to the AI.
 * If MCP tools are available, enables tool calling with an execution loop.
 */
export async function sendChatMessage(message: string, documentContext?: string): Promise<string> {
  const state = aiStore.getState();
  const activeConfig = aiStore.getActiveConfig();
  if (!activeConfig || !state.isConfigured) {
    throw new Error(get(t)('errors.aiNotConfigured'));
  }

  aiStore.setLoading(true);
  aiStore.resetStream();

  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  try {
    // Collect MCP tools + internal tools
    const mcpTools = getAllTools();
    const toolDefs = [...INTERNAL_TOOLS, ...mcpToolsToToolDefs(mcpTools)];

    // Build working directory context from current file path
    // For unsaved documents, default to user's Documents directory
    const currentFilePath = editorStore.getState().currentFilePath;
    const currentDir = currentFilePath
      ? currentFilePath.replace(/\/[^/]+$/, '')
      : await documentDir().catch(() => null);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(activeConfig, toolDefs.length, currentDir, currentFilePath, documentContext),
        timestamp: Date.now(),
      },
      // Include recent chat history for context (preserve tool call/result pairs)
      ...state.chatHistory.slice(-20),
      {
        role: 'user',
        content: message,
        timestamp: Date.now(),
      },
    ];

    aiStore.addMessage({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    });

    // Tool execution loop
    const MAX_TOOL_ROUNDS = 10;
    let round = 0;
    let finalContent = '';

    while (round < MAX_TOOL_ROUNDS) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      round++;

      console.log(`[AI] Tool round ${round}/${MAX_TOOL_ROUNDS}, messages: ${messages.length}, tools: ${toolDefs.length}`);

      // Use non-streaming for tool call rounds, streaming for final response
      const response = await sendAIRequest(activeConfig, {
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      }, signal);

      console.log(`[AI] Response: stopReason=${response.stopReason}, toolCalls=${response.toolCalls?.length || 0}, content=${response.content?.length || 0} chars`);

      // No tool calls: this is the final response
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // If this is the first round (no tool calls at all), try streaming
        if (round === 1 && toolDefs.length === 0) {
          // Re-do as streaming for better UX when no tools
          aiStore.resetStream();
          let streamContent = '';
          const stream = streamAIRequest(activeConfig, { messages, stream: true }, signal);
          for await (const chunk of stream) {
            streamContent += chunk;
            aiStore.appendStreamContent(chunk);
          }
          finalContent = streamContent;
        } else {
          finalContent = response.content;
          aiStore.appendStreamContent(response.content);
        }
        break;
      }

      // Record assistant message with tool calls
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content || '',
        timestamp: Date.now(),
        toolCalls: response.toolCalls,
      };
      aiStore.addMessage(assistantMsg);
      messages.push(assistantMsg);

      // Execute each tool call (internal or MCP)
      for (const tc of response.toolCalls) {
        aiStore.appendStreamContent(`\n[Calling tool: ${tc.name}...]\n`);

        let resultText = '';
        let isError = false;

        try {
          console.log(`[AI] Calling tool: ${tc.name}`, JSON.stringify(tc.arguments).slice(0, 200));

          if (isInternalTool(tc.name)) {
            // Internal tool — execute locally
            const result = await executeInternalTool(tc);
            resultText = result.content;
            isError = result.isError;
          } else {
            // MCP tool — execute via MCP server
            const result = await callTool(tc.name, tc.arguments);
            resultText = result.content?.map(c => c.text || '').join('\n') || '';
            isError = result.isError || false;

            // Sync editor if the tool wrote to the currently open file
            if (!isError && (tc.name === 'write_file' || tc.name === 'edit_file')) {
              const writtenPath = tc.arguments.path as string;
              const currentPath = editorStore.getState().currentFilePath;
              if (writtenPath && currentPath && writtenPath === currentPath) {
                try {
                  const newContent = await invoke<string>('read_file', { path: writtenPath });
                  editorStore.setContent(newContent);
                  editorStore.setDirty(false);
                  window.dispatchEvent(new CustomEvent('moraya:file-synced', { detail: { content: newContent } }));
                  console.log('[AI] Synced editor content after MCP file write');
                } catch { /* ignore sync errors */ }
              }
            }
          }

          console.log(`[AI] Tool result: ${isError ? 'ERROR' : 'OK'}, ${resultText.length} chars`);
        } catch (error: any) {
          console.error(`[AI] Tool call failed: ${tc.name}`, error);
          resultText = `Error: ${error.message}`;
          isError = true;
        }

        const toolMsg: ChatMessage = {
          role: 'tool',
          content: resultText,
          timestamp: Date.now(),
          toolCallId: tc.id,
          toolName: tc.name,
          isError,
        };
        aiStore.addMessage(toolMsg);
        messages.push(toolMsg);
      }
    }

    // Record final assistant response
    if (finalContent) {
      aiStore.addMessage({
        role: 'assistant',
        content: finalContent,
        timestamp: Date.now(),
      });
    }

    aiStore.setLastResponse(finalContent);
    return finalContent;

  } catch (error: any) {
    if (error?.name === 'AbortError' || signal.aborted) {
      // User-initiated abort: save partial content, show interrupted indicator
      const partial = aiStore.getState().streamingContent;
      if (partial) {
        aiStore.addMessage({ role: 'assistant', content: partial, timestamp: Date.now() });
      }
      aiStore.setInterrupted();
      return partial;
    }
    console.error('[AI] sendChatMessage failed:', error);
    const errMsg = error?.message || get(t)('errors.chatRequestFailed');
    aiStore.setError(errMsg);
    throw error;
  } finally {
    currentAbortController = null;
  }
}

/**
 * Test the AI connection with a given or active config
 */
export async function testAIConnection(config?: AIProviderConfig): Promise<boolean> {
  const testConfig = config || aiStore.getActiveConfig();
  if (!testConfig) return false;

  try {
    const response = await sendAIRequest(testConfig, {
      messages: [
        { role: 'user', content: 'Say "Hello from Moraya!" in exactly 3 words.', timestamp: Date.now() },
      ],
    });
    return !!response.content;
  } catch {
    return false;
  }
}

/**
 * Generate base URL candidates by progressively stripping path segments.
 * e.g. https://host/api/v3/responses → [.../api/v3/responses, .../api/v3, .../api, https://host]
 */
export function generateBaseUrlCandidates(baseUrl?: string): string[] {
  if (!baseUrl) return [''];
  const clean = baseUrl.replace(/\/+$/, '');
  const candidates = [clean];
  try {
    const parsed = new URL(clean);
    const segments = parsed.pathname.split('/').filter(Boolean);
    while (segments.length > 0) {
      segments.pop();
      const path = segments.length > 0 ? '/' + segments.join('/') : '';
      candidates.push(`${parsed.origin}${path}`);
    }
  } catch { /* invalid URL, return original only */ }
  return candidates;
}

/**
 * Test AI connection with auto-resolution: progressively strip the base URL path
 * until a working endpoint is found. Returns the resolved URL on success.
 */
export async function testAIConnectionWithResolve(
  config: AIProviderConfig,
): Promise<{ success: boolean; resolvedBaseUrl?: string }> {
  const candidates = generateBaseUrlCandidates(config.baseUrl);
  for (const url of candidates) {
    const ok = await testAIConnection({ ...config, baseUrl: url || undefined });
    if (ok) return { success: true, resolvedBaseUrl: url };
  }
  return { success: false };
}

/** Load persisted AI config from disk. Call once at app startup. */
export async function initAIStore() {
  try {
    const store = await load(AI_STORE_FILE);

    // Try new format first
    const configs = await store.get<AIProviderConfig[]>('providerConfigs');
    const activeId = await store.get<string>('activeConfigId');

    if (configs && configs.length > 0) {
      // Ensure all configs have ids
      for (const c of configs) {
        if (!c.id) c.id = crypto.randomUUID();
      }
      aiStore._load(configs, activeId || configs[0].id);
    } else {
      // Try old single-config format (migration)
      const saved = await store.get<any>('providerConfig');
      if (saved) {
        saved.id = saved.id || crypto.randomUUID();
        aiStore._load([saved], saved.id);
        // Persist in new format and clean up old key
        await store.set('providerConfigs', [saved]);
        await store.set('activeConfigId', saved.id);
        await store.delete('providerConfig');
        await store.save();
      }
    }
  } catch { /* first launch */ }
}

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
  ImageAttachment,
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
import { settingsStore } from '$lib/stores/settings-store';
import { filesStore } from '$lib/stores/files-store';
import { containerStore } from '$lib/services/mcp/container-store';
import { refreshFileTree } from '$lib/services/file-watcher';
import { documentDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';

const AI_STORE_FILE = 'ai-config.json';
const KEYCHAIN_AI_PREFIX = 'ai-key:';

async function saveKeyToKeychain(configId: string, apiKey: string): Promise<boolean> {
  try {
    await invoke('keychain_set', { key: `${KEYCHAIN_AI_PREFIX}${configId}`, value: apiKey });
    return true;
  } catch {
    return false;
  }
}

async function getKeyFromKeychain(configId: string): Promise<string | null> {
  try {
    return await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_AI_PREFIX}${configId}` });
  } catch {
    return null;
  }
}

async function deleteKeyFromKeychain(configId: string): Promise<void> {
  try {
    await invoke('keychain_delete', { key: `${KEYCHAIN_AI_PREFIX}${configId}` });
  } catch { /* ignore */ }
}

async function persistAIConfigs(configs: AIProviderConfig[], activeConfigId: string | null) {
  try {
    // Save API keys to OS keychain, store "***" placeholder on disk
    const diskConfigs = [];
    for (const c of configs) {
      if (c.apiKey && c.apiKey !== '***') {
        const saved = await saveKeyToKeychain(c.id, c.apiKey);
        diskConfigs.push({ ...c, apiKey: saved ? '***' : c.apiKey });
      } else {
        diskConfigs.push({ ...c });
      }
    }

    const store = await load(AI_STORE_FILE);
    await store.set('providerConfigs', diskConfigs);
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
        deleteKeyFromKeychain(id);
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
      // Revoke blob URLs from image attachments to free memory
      const current = get({ subscribe });
      for (const msg of current.chatHistory) {
        if (msg.images) {
          for (const img of msg.images) {
            if (img.previewUrl) URL.revokeObjectURL(img.previewUrl);
          }
        }
      }
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

    // Immediately update UI: save partial content and show interrupted state.
    // The background request may still be pending (non-streaming invoke),
    // but the user should see immediate feedback.
    const partial = aiStore.getState().streamingContent;
    if (partial) {
      aiStore.addMessage({ role: 'assistant', content: partial, timestamp: Date.now() });
    }
    aiStore.setInterrupted();
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
  const rawConfig = aiStore.getActiveConfig();
  const tr = get(t);
  if (!rawConfig || !state.isConfigured) {
    throw new Error(tr('errors.aiNotConfigured'));
  }

  // Apply global aiMaxTokens setting
  const globalMaxTokens = settingsStore.getState().aiMaxTokens;
  const activeConfig = { ...rawConfig, maxTokens: globalMaxTokens || rawConfig.maxTokens || 16384 };

  const commandDef = COMMANDS.find(c => c.command === command);
  if (!commandDef && command !== 'custom') {
    throw new Error(tr('errors.unknownCommand', { command }));
  }

  aiStore.setLoading(true);
  aiStore.resetStream();

  const controller = new AbortController();
  currentAbortController = controller;
  const signal = controller.signal;

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

    // If aborted while waiting, don't record a duplicate response
    if (signal.aborted) return aiStore.getState().streamingContent || '';

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
    const isStale = currentAbortController !== controller && currentAbortController !== null;

    if (error?.name === 'AbortError' || signal.aborted) {
      if (!isStale && !aiStore.getState().interrupted) {
        const partial = aiStore.getState().streamingContent;
        if (partial) {
          aiStore.addMessage({ role: 'assistant', content: partial, timestamp: Date.now() });
        }
        aiStore.setInterrupted();
      }
      return '';
    }
    if (!isStale) {
      const errMsg = error?.message || get(t)('errors.aiRequestFailed');
      aiStore.setError(errMsg);
    }
    throw error;
  } finally {
    // Only clear if this is still our controller (avoid nulling a newer one)
    if (currentAbortController === controller) {
      currentAbortController = null;
    }
  }
}

const MORAYA_MD_MAX_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 10000;

/** Read MORAYA.md rules file from knowledge base root. Returns null if not found. */
async function readMorayaMd(folderPath: string | null): Promise<{ content: string; truncated: boolean } | null> {
  if (!folderPath) return null;
  try {
    const content = await invoke<string>('read_file', {
      path: `${folderPath}/MORAYA.md`,
    });
    if (!content?.trim()) return null;
    const truncated = content.length > MORAYA_MD_MAX_CHARS;
    return { content: content.slice(0, MORAYA_MD_MAX_CHARS), truncated };
  } catch {
    return null;
  }
}

function buildSystemPrompt(
  config: AIProviderConfig,
  toolCount: number,
  currentDir: string | null,
  currentFilePath: string | null,
  sidebarDir: string | null,
  fallbackDir: string | null,
  documentContext?: string,
  morayaMdResult?: { content: string; truncated: boolean } | null,
): string {
  let prompt = `You are Moraya AI, a helpful writing assistant integrated into a Markdown editor. You are powered by ${config.model} (${config.provider}). Help the user with writing, editing, and content creation. Always respond in Markdown format when producing content.`;

  const morayaMdContent = morayaMdResult?.content;
  if (morayaMdContent) {
    prompt += '\n\n--- Knowledge Base Rules (from MORAYA.md) ---\n' +
      'The following rules were defined by the user for this knowledge base. ' +
      'Follow these rules when generating content:\n\n' +
      morayaMdContent +
      (morayaMdResult.truncated ? '\n\n[Rules truncated — use read_text_file or read_file to see the full MORAYA.md if you need to modify it]' : '') +
      '\n--- End Knowledge Base Rules ---';
  }

  // MORAYA.md convention instructions (always present when sidebar is open)
  if (sidebarDir) {
    prompt += '\n\n--- MORAYA.md Convention ---\n' +
      'This editor supports a per-knowledge-base AI rules file called `MORAYA.md`. ' +
      'When the user asks to create, set up, or modify rules/conventions/guidelines for the current knowledge base:\n' +
      `- The file MUST be named exactly \`MORAYA.md\` (not .rules.md, rules.md, or any other name)\n` +
      `- It MUST be placed at the root of the current knowledge base directory: ${sidebarDir}/MORAYA.md\n` +
      (currentFilePath && currentFilePath.endsWith('/MORAYA.md')
        ? '- MORAYA.md is the currently open file — use `update_editor_content` to modify it (do NOT use `write_file`)\n'
        : '- Use `write_file` to create or update it\n') +
      '- The content of MORAYA.md is automatically loaded into the AI system prompt on every message, so changes take effect immediately in subsequent conversations\n' +
      (morayaMdContent
        ? '- A MORAYA.md file is currently active for this knowledge base (see rules above)\n'
        : '- No MORAYA.md file exists yet in this knowledge base\n') +
      '--- End MORAYA.md Convention ---';
  }

  if (toolCount > 0) {
    prompt += ' You have access to tools. Use them when they can help answer the user\'s question. You can use add_mcp_server to help users install and configure new MCP servers.';

    // Image URL handling — graceful fallback for expired/temporary URLs
    prompt +=
      '\n\nIMPORTANT — Image URL handling (use this tiered strategy):' +
      '\nWhen the user asks to upload or process images that appear in the document as URLs:' +
      '\n1. **Try the URL directly** — pass it to the MCP tool first. If the URL is valid, this is fastest.' +
      '\n2. **If the MCP call fails or times out** (URL may be expired or temporary):' +
      '\n   - Call `fetch_image_to_local(url)` — this uses the browser cache, so it can retrieve images even if the URL has expired.' +
      '\n   - On success it returns a local file path; retry the MCP tool with that local path.' +
      '\n3. **If `fetch_image_to_local` also fails** — the image is not accessible. Report the error to the user and continue with the remaining images.' +
      '\nNever abandon the whole batch because one image failed — process each image independently.';

    // File writing rules
    prompt +=
      '\n\nIMPORTANT — Rules for writing generated content:' +
      '\n' +
      '\n**Single document** (generating one article, post, essay, etc.):' +
      '\n  Use the `update_editor_content` tool. This fills content directly into the Moraya editor.' +
      '\n  - If the editor has an open file, it saves to that file and refreshes the editor.' +
      '\n  - If the editor has a new unsaved document, it fills the editor for the user to save.' +
      '\n' +
      '\n**Multiple documents** (batch generation, e.g. "generate 5 blog posts"):' +
      '\n  Use `write_file` for each document. Choose the target directory in this priority order:' +
      `\n  1. Current file's parent directory: ${currentDir || '(none — new unsaved document)'}` +
      `\n  2. Sidebar open folder: ${sidebarDir || '(none — sidebar not open)'}` +
      `\n  3. Fallback directory: ${fallbackDir || '(unknown)'}` +
      '\n  Use the first available directory from the list above. Name files descriptively with .md extension.' +
      '\n' +
      '\nNever use `write_file` for single-document content that should go into the editor — always prefer `update_editor_content`.' +
      (currentFilePath
        ? `\n\n**CRITICAL**: The file currently open in the editor is: ${currentFilePath}\n` +
          'To modify this file, you MUST use `update_editor_content` (NOT `write_file` or `edit_file`). ' +
          'Using `write_file` on the open file will cause a conflict error. ' +
          'Read the current content from the document context above, make your changes, then pass the full updated content to `update_editor_content`.'
        : '');
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
export async function sendChatMessage(message: string, documentContext?: string, images?: ImageAttachment[]): Promise<string> {
  console.log('[AI] sendChatMessage START', { messageLen: message.length, historyLen: aiStore.getState().chatHistory.length });
  const state = aiStore.getState();
  const rawConfig = aiStore.getActiveConfig();
  if (!rawConfig || !state.isConfigured) {
    throw new Error(get(t)('errors.aiNotConfigured'));
  }

  // Apply global aiMaxTokens setting from Permissions
  const globalMaxTokens = settingsStore.getState().aiMaxTokens;
  const activeConfig = { ...rawConfig, maxTokens: globalMaxTokens || rawConfig.maxTokens || 16384 };

  aiStore.setLoading(true);
  aiStore.resetStream();

  const controller = new AbortController();
  currentAbortController = controller;
  const signal = controller.signal;

  try {
    // Collect MCP tools + internal tools.
    // Deduplicate by name: internal tools take priority; among MCP tools,
    // the first server's tool wins. This prevents "Tool names must be unique"
    // errors when multiple MCP servers expose identically-named tools.
    const mcpTools = getAllTools();
    const allDefs = [...INTERNAL_TOOLS, ...mcpToolsToToolDefs(mcpTools)];
    const seen = new Set<string>();
    const toolDefs = allDefs.filter(t => {
      if (seen.has(t.name)) return false;
      seen.add(t.name);
      return true;
    });

    // Build directory context for file writing rules
    const currentFilePath = editorStore.getState().currentFilePath;
    const currentDir = currentFilePath
      ? currentFilePath.replace(/\/[^/]+$/, '')
      : null;
    const sidebarDir = filesStore.getState().openFolderPath;
    const fallbackDir = await documentDir().catch(() => null);

    // Read MORAYA.md rules from knowledge base root
    const morayaMdResult = await readMorayaMd(sidebarDir);

    // Trim old tool results in chat history to prevent context overflow.
    // Keep the most recent tool result intact; older ones get truncated.
    const HISTORY_TOOL_RESULT_LIMIT = 2000;
    const recentHistory = state.chatHistory.slice(-20);

    // Remove orphaned tool_result messages whose corresponding assistant
    // tool_use was sliced off — Claude API requires each tool_result to have
    // a matching tool_use in the preceding assistant message.
    const toolUseIds = new Set<string>();
    for (const m of recentHistory) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          toolUseIds.add(tc.id);
        }
      }
    }
    const cleanHistory = recentHistory.filter(m => {
      if (m.role === 'tool' && m.toolCallId && !toolUseIds.has(m.toolCallId)) {
        return false; // orphaned tool result — drop it
      }
      return true;
    });

    const lastToolIdx = cleanHistory.findLastIndex(m => m.role === 'tool');
    // Find the last assistant message that has toolCalls (the most recent tool exchange)
    const lastToolCallAssistantIdx = cleanHistory.findLastIndex(m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0);
    const TOOL_ARGS_LIMIT = 500;
    // Strip images from older history messages to save tokens (keep last 5)
    const RECENT_IMAGE_LIMIT = 5;
    const trimmedHistory = cleanHistory.map((m, i) => {
      // Truncate older tool result content
      if (m.role === 'tool' && i !== lastToolIdx && m.content.length > HISTORY_TOOL_RESULT_LIMIT) {
        return { ...m, content: m.content.slice(0, HISTORY_TOOL_RESULT_LIMIT) + '\n[...truncated]' };
      }
      // Truncate toolCalls arguments in older assistant messages to prevent
      // huge payloads (e.g. full article content from MCP publish) being resent
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 && i !== lastToolCallAssistantIdx) {
        const trimmedCalls = m.toolCalls.map(tc => {
          const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
          if (argsStr.length > TOOL_ARGS_LIMIT) {
            return { ...tc, arguments: JSON.parse(`{"_summary":"[truncated ${argsStr.length} chars]"}`) };
          }
          return tc;
        });
        return { ...m, toolCalls: trimmedCalls };
      }
      return m;
    });
    // Remove images from messages older than the most recent RECENT_IMAGE_LIMIT
    let imageCount = 0;
    for (let i = trimmedHistory.length - 1; i >= 0; i--) {
      const m = trimmedHistory[i];
      if (m.images && m.images.length > 0) {
        imageCount++;
        if (imageCount > RECENT_IMAGE_LIMIT) {
          trimmedHistory[i] = { ...m, images: undefined };
        }
      }
    }

    const userMsg: ChatMessage = {
      role: 'user',
      content: message,
      timestamp: Date.now(),
      images: images && images.length > 0 ? images : undefined,
    };

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(activeConfig, toolDefs.length, currentDir, currentFilePath, sidebarDir, fallbackDir, documentContext, morayaMdResult),
        timestamp: Date.now(),
      },
      // Include recent chat history for context (preserve tool call/result pairs)
      ...trimmedHistory,
      userMsg,
    ];

    aiStore.addMessage(userMsg);

    // Tool execution loop
    const MAX_TOOL_ROUNDS = 10;
    const MAX_TRUNCATION_RETRIES = 2;
    let round = 0;
    let truncationRetries = 0;
    let finalContent = '';

    while (round < MAX_TOOL_ROUNDS) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      round++;

      // Use increased max_tokens after truncation to give more room for tool calls
      const effectiveConfig = truncationRetries > 0
        ? { ...activeConfig, maxTokens: Math.max((activeConfig.maxTokens || 8192) * 2, 16384) }
        : activeConfig;

      const bodySize = JSON.stringify(messages).length;
      console.log(`[AI] Tool round ${round}/${MAX_TOOL_ROUNDS}, messages: ${messages.length}, tools: ${toolDefs.length}, maxTokens: ${effectiveConfig.maxTokens}, bodySize: ${bodySize}`);

      // Use non-streaming for tool call rounds, streaming for final response
      console.log('[AI] Calling sendAIRequest...', { provider: effectiveConfig.provider, model: effectiveConfig.model });
      const response = await sendAIRequest(effectiveConfig, {
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      }, signal);

      console.log(`[AI] Response received: stopReason=${response.stopReason}, toolCalls=${response.toolCalls?.length || 0}, content=${response.content?.length || 0} chars`);

      // If response was truncated (max_tokens) with pending tool calls:
      // - First few times: save partial content and ask AI to continue with higher token limit
      // - After max retries: give up and show truncation message
      if (response.stopReason === 'max_tokens' && response.toolCalls && response.toolCalls.length > 0) {
        if (truncationRetries >= MAX_TRUNCATION_RETRIES) {
          console.warn('[AI] Response still truncated after retries — giving up');
          const truncatedNote = response.content
            ? response.content + '\n\n[Response truncated due to output length limit. Tool calls were skipped.]'
            : '[Response truncated due to output length limit. Please try a shorter request or break it into steps.]';
          finalContent = truncatedNote;
          aiStore.appendStreamContent(truncatedNote);
          break;
        }

        truncationRetries++;
        console.warn(`[AI] Response truncated with tool calls — continuation attempt ${truncationRetries}/${MAX_TRUNCATION_RETRIES}`);

        // Save partial text content (discard broken tool calls)
        if (response.content) {
          const partialMsg: ChatMessage = {
            role: 'assistant',
            content: response.content,
            timestamp: Date.now(),
          };
          aiStore.addMessage(partialMsg);
          messages.push(partialMsg);
          aiStore.appendStreamContent(response.content);
        }

        // Ask AI to continue with just the tool call
        const continueMsg: ChatMessage = {
          role: 'user',
          content: 'Your previous response was cut off due to output length limits. The text above has been saved. Now please complete the task by making the necessary tool call(s). Do not repeat the content — use it directly in the tool arguments.',
          timestamp: Date.now(),
        };
        messages.push(continueMsg);
        continue;
      }

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
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        aiStore.appendStreamContent(`\n[Calling tool: ${tc.name}...]\n`);

        let resultText = '';
        let isError = false;

        // Per-tool timeout: if an MCP tool stalls (e.g. slow network, hanging API),
        // the call times out and returns an error to the AI instead of freezing forever.
        const TOOL_TIMEOUT_MS = 20_000;

        // Helper: race a promise against the abort signal AND a per-tool timeout.
        const raceAbortOrTimeout = <T>(p: Promise<T>): Promise<T> => {
          const racers: Promise<never>[] = [];

          if (signal) {
            racers.push(new Promise<never>((_, reject) => {
              if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
              signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            }));
          }

          racers.push(new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Tool call timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)
          ));

          return Promise.race([p, ...racers]);
        };

        try {
          console.log(`[AI] Calling tool: ${tc.name}`, JSON.stringify(tc.arguments).slice(0, 200));

          if (isInternalTool(tc.name)) {
            // Internal tool — execute locally
            const result = await raceAbortOrTimeout(executeInternalTool(tc));
            resultText = result.content;
            isError = result.isError;
          } else {
            // Intercept file operations on the currently open file to avoid conflicts
            const currentPath = editorStore.getState().currentFilePath;
            const isReadOp = tc.name === 'read_file' || tc.name === 'read_text_file';
            const isWriteOp = tc.name === 'write_file' || tc.name === 'edit_file';
            const targetPath = (isReadOp || isWriteOp)
              ? (tc.arguments.path as string)
              : null;
            const isTargetOpenFile = targetPath && currentPath && targetPath === currentPath;

            if (isTargetOpenFile && isReadOp) {
              // Return editor content directly — avoids file access conflicts and includes unsaved changes
              console.log(`[AI] Intercepted ${tc.name} on open file, returning editor content`);
              const editorContent = editorStore.getState().content;
              resultText = editorContent || '';
              isError = false;
            } else if (isTargetOpenFile && isWriteOp && typeof tc.arguments.content === 'string') {
              // Redirect to internal update_editor_content to avoid file conflict
              console.log('[AI] Intercepted write_file on open file, redirecting to update_editor_content');
              const result = await raceAbortOrTimeout(executeInternalTool({
                ...tc,
                name: 'update_editor_content',
                arguments: { content: tc.arguments.content },
              }));
              resultText = result.content;
              isError = result.isError;
            } else {
              // MCP tool — race against abort signal so user can interrupt slow MCP calls
              const result = await raceAbortOrTimeout(callTool(tc.name, tc.arguments));
              resultText = result.content?.map(c => c.text || '').join('\n') || '';
              isError = result.isError || false;

              // Sync editor if the tool wrote to the currently open file
              if (!isError && isTargetOpenFile) {
                try {
                  const newContent = await invoke<string>('read_file', { path: targetPath! });
                  editorStore.setContent(newContent);
                  editorStore.setDirty(false);
                  window.dispatchEvent(new CustomEvent('moraya:file-synced', { detail: { content: newContent } }));
                  console.log('[AI] Synced editor content after MCP file write');
                } catch { /* ignore sync errors */ }
              }
            }

            // Refresh sidebar file tree if a file was written under the open folder
            if (targetPath && isWriteOp) {
              const openFolder = filesStore.getState().openFolderPath;
              if (openFolder && targetPath.startsWith(openFolder)) {
                refreshFileTree(openFolder);
              }
            }
          }

          console.log(`[AI] Tool result: ${isError ? 'ERROR' : 'OK'}, ${resultText.length} chars`);
        } catch (error: any) {
          // Re-throw AbortError so the outer catch handles it
          if (error?.name === 'AbortError' || signal.aborted) throw error;
          console.error(`[AI] Tool call failed: ${tc.name}`, error);
          resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
          isError = true;

          // If this tool call timed out or failed and its arguments contain HTTP URLs,
          // suggest the fetch_image_to_local fallback strategy so the AI can recover.
          const argValues = Object.values(tc.arguments as Record<string, unknown>);
          const hasHttpUrl = argValues.some(
            v => typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://')),
          );
          if (hasHttpUrl) {
            resultText +=
              '\n\nRecovery hint: This tool call failed while working with an image URL. ' +
              'The URL may be expired. Use `fetch_image_to_local(url)` to retrieve the image ' +
              'via browser cache (works even for expired URLs), then retry this tool with the ' +
              'returned local file path instead of the URL.';
          }
        }

        // Truncate excessively large tool results to prevent exceeding AI context limits
        if (resultText.length > MAX_TOOL_RESULT_CHARS) {
          console.warn(`[AI] Tool result truncated: ${resultText.length} → ${MAX_TOOL_RESULT_CHARS} chars`);
          resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS) +
            `\n\n[Content truncated: showing first ${MAX_TOOL_RESULT_CHARS} of ${resultText.length} chars]`;
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

    // If aborted while waiting, don't record a duplicate response
    if (signal.aborted) return aiStore.getState().streamingContent || '';

    // Record final assistant response
    if (finalContent) {
      aiStore.addMessage({
        role: 'assistant',
        content: finalContent,
        timestamp: Date.now(),
      });
    }

    console.log('[AI] sendChatMessage DONE, finalContent length:', finalContent.length);
    aiStore.setLastResponse(finalContent);
    return finalContent;

  } catch (error: any) {
    console.error('[AI] sendChatMessage CATCH:', error?.name, error?.message || error);
    // Guard: only touch the store if this is still the active request.
    // A stale request (whose controller was replaced by a new sendChatMessage
    // or nulled by abortAIRequest) must not corrupt the new request's state.
    const isStale = currentAbortController !== controller && currentAbortController !== null;

    if (error?.name === 'AbortError' || signal.aborted) {
      // User-initiated abort — abortAIRequest() already updated the UI.
      // Only handle if this is the active request and setInterrupted hasn't fired.
      if (!isStale && !aiStore.getState().interrupted) {
        const partial = aiStore.getState().streamingContent;
        if (partial) {
          aiStore.addMessage({ role: 'assistant', content: partial, timestamp: Date.now() });
        }
        aiStore.setInterrupted();
      }
      return '';
    }
    console.error('[AI] sendChatMessage failed:', error);
    if (!isStale) {
      // Tauri invoke rejects with a plain string; JS errors have .message
      const errMsg = (typeof error === 'string' ? error : error?.message) || get(t)('errors.chatRequestFailed');
      aiStore.setError(errMsg);
    }
    throw error;
  } finally {
    // Only clear if this is still our controller (avoid nulling a newer one)
    if (currentAbortController === controller) {
      currentAbortController = null;
    }
  }
}

/**
 * Test the AI connection with a given or active config
 */
export async function testAIConnection(config?: AIProviderConfig): Promise<{ success: boolean; error?: string }> {
  const testConfig = config || aiStore.getActiveConfig();
  if (!testConfig) return { success: false, error: 'No configuration' };

  try {
    const response = await sendAIRequest(testConfig, {
      messages: [
        { role: 'user', content: 'Say "Hello from Moraya!" in exactly 3 words.', timestamp: Date.now() },
      ],
    });
    return { success: !!response.content };
  } catch (e: unknown) {
    const error = typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Connection failed');
    return { success: false, error };
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
): Promise<{ success: boolean; resolvedBaseUrl?: string; error?: string }> {
  const candidates = generateBaseUrlCandidates(config.baseUrl);
  let lastError: string | undefined;
  for (const url of candidates) {
    const result = await testAIConnection({ ...config, baseUrl: url || undefined });
    if (result.success) return { success: true, resolvedBaseUrl: url };
    lastError = result.error;
  }
  return { success: false, error: lastError };
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

      // Restore API keys from keychain / migrate plaintext keys
      let needsMigration = false;
      for (const c of configs) {
        if (c.apiKey === '***') {
          // Restore from keychain
          const key = await getKeyFromKeychain(c.id);
          c.apiKey = key || '';
        } else if (c.apiKey && c.apiKey !== '') {
          // Legacy plaintext key — migrate to keychain
          needsMigration = true;
          await saveKeyToKeychain(c.id, c.apiKey);
        }
      }

      aiStore._load(configs, activeId || configs[0].id);

      // Persist migration (replace plaintext keys with "***" on disk)
      if (needsMigration) {
        persistAIConfigs(configs, activeId || configs[0].id);
      }
    } else {
      // Try old single-config format (migration)
      const saved = await store.get<any>('providerConfig');
      if (saved) {
        saved.id = saved.id || crypto.randomUUID();
        // Migrate key to keychain
        if (saved.apiKey && saved.apiKey !== '***') {
          await saveKeyToKeychain(saved.id, saved.apiKey);
        }
        aiStore._load([saved], saved.id);
        // Persist in new format with key placeholder
        await store.set('providerConfigs', [{ ...saved, apiKey: saved.apiKey ? '***' : '' }]);
        await store.set('activeConfigId', saved.id);
        await store.delete('providerConfig');
        await store.save();
      }
    }
  } catch { /* first launch */ }
}

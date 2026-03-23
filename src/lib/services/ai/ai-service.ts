/**
 * AI Service - orchestrates AI operations for the editor
 */

import { writable, get } from 'svelte/store';
import { load } from '@tauri-apps/plugin-store';
import { sendAIRequest, streamAIRequest, streamAIRequestWithTools } from './providers';
import type {
  AIProviderConfig,
  RealtimeVoiceAIConfig,
  AICommand,
  ChatMessage,
  ImageAttachment,
  AI_COMMANDS,
  ToolDefinition,
} from './types';
import { AI_COMMANDS as COMMANDS } from './types';
import { t, resolveForLocale, resolveAllLocales } from '$lib/i18n';
import type { SupportedLocale } from '$lib/i18n';
import { getAllTools, callTool } from '$lib/services/mcp';
import { mcpToolsToToolDefs } from './tool-bridge';
import { INTERNAL_TOOLS, isInternalTool, executeInternalTool } from './internal-tools';
import { loadRules, buildRulesPrompt, type RulesResult } from './rules-engine';
import { editorStore } from '$lib/stores/editor-store';
import { settingsStore } from '$lib/stores/settings-store';
import { filesStore } from '$lib/stores/files-store';
import { containerStore } from '$lib/services/mcp/container-store';
import { computeImageDir, isInsideKnowledgeBase } from './image-path-utils';
import { refreshFileTree } from '$lib/services/file-watcher';
import { documentDir } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import { rendererManager } from '$lib/services/plugin/renderer-manager';

const AI_STORE_FILE = 'ai-config.json';
const KEYCHAIN_AI_PREFIX = 'ai-key:';
const KEYCHAIN_AI_RT_PREFIX = 'ai-rt-key:';
const KEYCHAIN_AI_RT_APPID_PREFIX = 'ai-rt-appid:';
const KEYCHAIN_AI_RT_AK_PREFIX = 'ai-rt-ak:';
const KEYCHAIN_AI_RT_SK_PREFIX = 'ai-rt-sk:';
const KEYCHAIN_AI_RT_ST_PREFIX = 'ai-rt-st:';

// ── Locale-driven detection patterns for incomplete AI responses ──
// Built once from all locale files so detection works regardless of AI language.
function buildDetectionPatterns() {
  const allPrefixes = resolveAllLocales('ai.detection.intentPrefixes').filter(Boolean).join('|');
  const allVerbs = resolveAllLocales('ai.detection.actionVerbs').filter(Boolean).join('|');
  const allContinuation = resolveAllLocales('ai.detection.continuationPhrases').filter(Boolean).join('|');
  const allRemaining = resolveAllLocales('ai.detection.remainingPhrases').filter(Boolean).join('|');
  const allUnfinished = resolveAllLocales('ai.detection.unfinishedPhrases').filter(Boolean).join('|');

  return {
    intentPattern: new RegExp(`(${allPrefixes})(.*?)(${allVerbs})`, 'ui'),
    continuationPattern: new RegExp(`[，。]?\\s*(${allContinuation})\\S{0,30}[.。:：]?\\s*$`, 'u'),
    remainingPattern: new RegExp(`(${allRemaining})\\S{0,20}$`, 'u'),
    unfinishedPattern: new RegExp(`(${allUnfinished})`, 'u'),
  };
}
const DETECTION = buildDetectionPatterns();

/** Detect conversation language by script analysis and return the matching locale code. */
function detectResponseLocale(text: string): SupportedLocale {
  const sample = text.slice(0, 500);

  // Japanese: kana presence is a strong signal (even if CJK ideographs are mixed in)
  if (/[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/.test(sample)) return 'ja';
  // Korean: hangul syllables or jamo
  if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(sample)) return 'ko';
  // Arabic script
  if (/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/.test(sample)) return 'ar';
  // Devanagari (Hindi)
  if (/[\u0900-\u097f]/.test(sample)) return 'hi';
  // Cyrillic (Russian)
  if (/[\u0400-\u04ff]/.test(sample)) return 'ru';
  // CJK Ideographs without kana/hangul → Chinese
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(sample)) return 'zh-CN';

  // Latin-script languages (de/es/fr/pt) fall back to English —
  // English recovery prompts work well for all Latin-script locales.
  return 'en';
}

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

async function saveRealtimeSecretsToKeychain(config: RealtimeVoiceAIConfig): Promise<RealtimeVoiceAIConfig> {
  const sanitized = { ...config };
  if (config.apiKey && config.apiKey !== '***') {
    try {
      await invoke('keychain_set', { key: `${KEYCHAIN_AI_RT_PREFIX}${config.id}`, value: config.apiKey });
      sanitized.apiKey = '***';
    } catch { /* fallback: keep plaintext */ }
  }
  if (config.appId && config.appId !== '***') {
    try {
      await invoke('keychain_set', { key: `${KEYCHAIN_AI_RT_APPID_PREFIX}${config.id}`, value: config.appId });
      sanitized.appId = '***';
    } catch { /* fallback */ }
  }
  if (config.accessKeyId && config.accessKeyId !== '***') {
    try {
      await invoke('keychain_set', { key: `${KEYCHAIN_AI_RT_AK_PREFIX}${config.id}`, value: config.accessKeyId });
      sanitized.accessKeyId = '***';
    } catch { /* fallback */ }
  }
  if (config.secretAccessKey && config.secretAccessKey !== '***') {
    try {
      await invoke('keychain_set', { key: `${KEYCHAIN_AI_RT_SK_PREFIX}${config.id}`, value: config.secretAccessKey });
      sanitized.secretAccessKey = '***';
    } catch { /* fallback */ }
  }
  if (config.sessionToken && config.sessionToken !== '***') {
    try {
      await invoke('keychain_set', { key: `${KEYCHAIN_AI_RT_ST_PREFIX}${config.id}`, value: config.sessionToken });
      sanitized.sessionToken = '***';
    } catch { /* fallback */ }
  }
  return sanitized;
}

async function restoreRealtimeSecretsFromKeychain(config: RealtimeVoiceAIConfig): Promise<RealtimeVoiceAIConfig> {
  const restored = { ...config };
  if (config.apiKey === '***') {
    try {
      restored.apiKey = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_AI_RT_PREFIX}${config.id}` }) ?? '';
    } catch {
      restored.apiKey = '';
    }
  }
  if (config.appId === '***') {
    try {
      restored.appId = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_AI_RT_APPID_PREFIX}${config.id}` }) ?? '';
    } catch {
      restored.appId = '';
    }
  }
  if (config.accessKeyId === '***') {
    try {
      restored.accessKeyId = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_AI_RT_AK_PREFIX}${config.id}` }) ?? '';
    } catch {
      restored.accessKeyId = '';
    }
  }
  if (config.secretAccessKey === '***') {
    try {
      restored.secretAccessKey = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_AI_RT_SK_PREFIX}${config.id}` }) ?? '';
    } catch {
      restored.secretAccessKey = '';
    }
  }
  if (config.sessionToken === '***') {
    try {
      restored.sessionToken = await invoke<string | null>('keychain_get', { key: `${KEYCHAIN_AI_RT_ST_PREFIX}${config.id}` }) ?? '';
    } catch {
      restored.sessionToken = '';
    }
  }
  return restored;
}

async function deleteRealtimeSecretsFromKeychain(configId: string): Promise<void> {
  await Promise.allSettled([
    invoke('keychain_delete', { key: `${KEYCHAIN_AI_RT_PREFIX}${configId}` }),
    invoke('keychain_delete', { key: `${KEYCHAIN_AI_RT_APPID_PREFIX}${configId}` }),
    invoke('keychain_delete', { key: `${KEYCHAIN_AI_RT_AK_PREFIX}${configId}` }),
    invoke('keychain_delete', { key: `${KEYCHAIN_AI_RT_SK_PREFIX}${configId}` }),
    invoke('keychain_delete', { key: `${KEYCHAIN_AI_RT_ST_PREFIX}${configId}` }),
  ]);
}

function hasRealtimeCredential(config: RealtimeVoiceAIConfig): boolean {
  if (config.provider === 'doubao-realtime') {
    return !!(config.appId && config.apiKey);
  }
  return !!(
    config.apiKey
    || (config.accessKeyId && config.secretAccessKey)
  );
}

async function persistAIConfigs(
  configs: AIProviderConfig[],
  activeConfigId: string | null,
  realtimeVoiceConfigs: RealtimeVoiceAIConfig[],
  activeRealtimeVoiceConfigId: string | null,
) {
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

    const diskRealtimeConfigs: RealtimeVoiceAIConfig[] = [];
    for (const c of realtimeVoiceConfigs) {
      diskRealtimeConfigs.push(await saveRealtimeSecretsToKeychain(c));
    }

    const store = await load(AI_STORE_FILE);
    await store.set('providerConfigs', diskConfigs);
    await store.set('activeConfigId', activeConfigId);
    await store.set('realtimeVoiceConfigs', diskRealtimeConfigs);
    await store.set('activeRealtimeVoiceConfigId', activeRealtimeVoiceConfigId);
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
  realtimeVoiceConfigs: RealtimeVoiceAIConfig[];
  activeRealtimeVoiceConfigId: string | null;
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
    realtimeVoiceConfigs: [],
    activeRealtimeVoiceConfigId: null,
  });

  return {
    subscribe,

    /** Load configs from disk without re-persisting */
    _load(
      configs: AIProviderConfig[],
      activeId: string | null,
      realtimeVoiceConfigs: RealtimeVoiceAIConfig[] = [],
      activeRealtimeVoiceConfigId: string | null = null,
    ) {
      update(state => ({
        ...state,
        providerConfigs: configs,
        activeConfigId: activeId,
        realtimeVoiceConfigs,
        activeRealtimeVoiceConfigId,
        isConfigured: computeIsConfigured(configs, activeId),
        error: null,
      }));
    },

    addProviderConfig(config: AIProviderConfig) {
      update(state => {
        const configs = [...state.providerConfigs, config];
        const activeId = state.activeConfigId || config.id;
        persistAIConfigs(
          configs,
          activeId,
          state.realtimeVoiceConfigs,
          state.activeRealtimeVoiceConfigId,
        );
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
        persistAIConfigs(
          configs,
          state.activeConfigId,
          state.realtimeVoiceConfigs,
          state.activeRealtimeVoiceConfigId,
        );
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
        persistAIConfigs(
          configs,
          activeId,
          state.realtimeVoiceConfigs,
          state.activeRealtimeVoiceConfigId,
        );
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
        persistAIConfigs(
          state.providerConfigs,
          id,
          state.realtimeVoiceConfigs,
          state.activeRealtimeVoiceConfigId,
        );
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

    addRealtimeVoiceConfig(config: RealtimeVoiceAIConfig) {
      update(state => {
        const configs = [...state.realtimeVoiceConfigs, config];
        const activeId = state.activeRealtimeVoiceConfigId || config.id;
        persistAIConfigs(
          state.providerConfigs,
          state.activeConfigId,
          configs,
          activeId,
        );
        return {
          ...state,
          realtimeVoiceConfigs: configs,
          activeRealtimeVoiceConfigId: activeId,
        };
      });
    },

    updateRealtimeVoiceConfig(config: RealtimeVoiceAIConfig) {
      update(state => {
        const configs = state.realtimeVoiceConfigs.map(c => c.id === config.id ? config : c);
        persistAIConfigs(
          state.providerConfigs,
          state.activeConfigId,
          configs,
          state.activeRealtimeVoiceConfigId,
        );
        return {
          ...state,
          realtimeVoiceConfigs: configs,
        };
      });
    },

    removeRealtimeVoiceConfig(id: string) {
      update(state => {
        const configs = state.realtimeVoiceConfigs.filter(c => c.id !== id);
        let activeId = state.activeRealtimeVoiceConfigId;
        if (activeId === id) {
          activeId = configs[0]?.id || null;
        }
        deleteRealtimeSecretsFromKeychain(id);
        persistAIConfigs(
          state.providerConfigs,
          state.activeConfigId,
          configs,
          activeId,
        );
        return {
          ...state,
          realtimeVoiceConfigs: configs,
          activeRealtimeVoiceConfigId: activeId,
        };
      });
    },

    setActiveRealtimeVoiceConfig(id: string) {
      update(state => {
        persistAIConfigs(
          state.providerConfigs,
          state.activeConfigId,
          state.realtimeVoiceConfigs,
          id,
        );
        return {
          ...state,
          activeRealtimeVoiceConfigId: id,
        };
      });
    },

    getActiveRealtimeVoiceConfig(): RealtimeVoiceAIConfig | null {
      const state = get({ subscribe });
      return state.realtimeVoiceConfigs.find(c => c.id === state.activeRealtimeVoiceConfigId) || null;
    },

    hasRealtimeVoiceConfig(): boolean {
      const state = get({ subscribe });
      const active = state.realtimeVoiceConfigs.find(c => c.id === state.activeRealtimeVoiceConfigId);
      return !!active && hasRealtimeCredential(active);
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
      update(state => ({ ...state, chatHistory: [], lastResponse: null, interrupted: false, error: null }));
    },
    /**
     * Remove the last user message and everything after it (partial assistant
     * responses, tool results added during the failed exchange). Clears the
     * error and streaming state so the UI is ready for a retry.
     * Returns the removed user message info, or null if none found.
     */
    popLastUserMessage(): { content: string; images?: ImageAttachment[] } | null {
      const state = get({ subscribe });
      let lastUserIdx = -1;
      for (let i = state.chatHistory.length - 1; i >= 0; i--) {
        if (state.chatHistory[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx === -1) return null;

      const userMsg = state.chatHistory[lastUserIdx];
      update(s => ({
        ...s,
        chatHistory: s.chatHistory.slice(0, lastUserIdx),
        error: null,
        interrupted: false,
        streamingContent: '',
      }));

      return { content: userMsg.content, images: userMsg.images };
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
  console.log('[AI] abortAIRequest called, controller:', !!currentAbortController);
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
  } else {
    // Safety net: if currentAbortController is already null but the store
    // still shows loading, force-reset the UI to prevent a stuck state.
    if (aiStore.getState().isLoading) {
      console.warn('[AI] abortAIRequest: controller is null but still loading — force-resetting UI');
      const partial = aiStore.getState().streamingContent;
      if (partial) {
        aiStore.addMessage({ role: 'assistant', content: partial, timestamp: Date.now() });
      }
      aiStore.setInterrupted();
    }
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

function buildSystemPrompt(
  config: AIProviderConfig,
  toolCount: number,
  currentDir: string | null,
  currentFilePath: string | null,
  sidebarDir: string | null,
  fallbackDir: string | null,
  documentContext?: string,
  rulesResult?: RulesResult | null,
): string {
  let prompt = `You are Moraya AI, a helpful writing assistant integrated into a Markdown editor. You are powered by ${config.model} (${config.provider}). Help the user with writing, editing, and content creation. Always respond in Markdown format when producing content.`;

  // Inject rules from MORAYA.md (auto-split by rules engine)
  if (rulesResult?.active) {
    prompt += '\n\n' + buildRulesPrompt(rulesResult, sidebarDir!);
  }

  // MORAYA.md convention instructions (always present when sidebar is open)
  if (sidebarDir) {
    prompt += '\n\n--- MORAYA.md Convention ---\n' +
      'This editor supports a per-knowledge-base AI rules file called `MORAYA.md`. ' +
      'Rules are automatically split into indexed sections stored in `.moraya/rules/`.\n' +
      `- The file MUST be named exactly \`MORAYA.md\` at: ${sidebarDir}/MORAYA.md\n` +
      (currentFilePath && currentFilePath.endsWith('/MORAYA.md')
        ? '- MORAYA.md is the currently open file — use `update_editor_content` to modify it\n'
        : '- Use `write_file` to create or update it\n') +
      '- Changes to MORAYA.md are automatically detected and re-indexed on the next message\n' +
      '- Use `## Heading <!-- globs: **/*.ts -->` to auto-inject that section only for matching files\n' +
      '- Use `##` headings to organize rules into sections for optimal rule loading\n' +
      (rulesResult?.active
        ? `- MORAYA.md is active with ${rulesResult.sectionCount} indexed rule sections\n`
        : '- No MORAYA.md file exists yet in this knowledge base\n') +
      '--- End MORAYA.md Convention ---';
  }

  if (toolCount > 0) {
    prompt += ' You have access to tools. Use them when they can help answer the user\'s question. You can use add_mcp_server to help users install and configure new MCP servers.' +
      '\n\nIMPORTANT — When installing an MCP server, follow this decision tree in order:' +
      '\n1. **stdio via npx (FIRST CHOICE for npm packages)**' +
      '\n   If the server is published on npm (package name like `@scope/pkg` or `pkg-name`):' +
      '\n   `transport_type: "stdio", command: "npx", args: ["-y", "<package-name>", ...extra-args]`' +
      '\n   - No cloning, no building — npx downloads and runs the latest version automatically.' +
      '\n   - This is the standard install method for the official MCP servers and most community servers.' +
      '\n2. **stdio via uvx (for Python/uv-managed packages)**' +
      '\n   If the server is a Python package distributed via uv/pip:' +
      '\n   `transport_type: "stdio", command: "uvx", args: ["<package-name>", ...extra-args]`' +
      '\n3. **http or sse (for remote/cloud servers)**' +
      '\n   If the server is already running at a URL: `transport_type: "http", url: "http://..."`' +
      '\n4. **Clone + local command (LAST RESORT ONLY)**' +
      '\n   Only if: the package is NOT on npm/PyPI, OR the user explicitly needs to modify the source.' +
      '\n   Never recommend cloning just because the user shared a GitHub URL — check the README for an npm package name first.' +
      '\n\nFor GitHub URLs (e.g. https://github.com/org/repo): read the README to find the npm package name or uvx command, then use method 1 or 2. Do NOT clone by default.';

    // Image URL handling — always localize first, then upload; NEVER regenerate
    prompt +=
      '\n\nIMPORTANT — Image URL handling strategy:' +
      '\nWhen the user asks to upload or process images that appear in the document as URLs:' +
      '\n1. **ALWAYS call `fetch_image_to_local(url)` FIRST** for every image URL from the document.' +
      '\n   - This tool retrieves the image via browser cache — it works even for expired/temporary URLs as long as the image is still displayed in the editor.' +
      '\n   - It returns a local file path (e.g. `/path/to/image-cache/xxx.png`).' +
      '\n2. **Use the local file path** (not the original URL) when calling MCP upload tools.' +
      '\n   - MCP tools cannot access expired URLs, but they can always read local files.' +
      '\n3. **If `fetch_image_to_local` fails** — the image is truly not accessible. Report the error to the user and continue with the remaining images.' +
      '\n4. **Do NOT skip `fetch_image_to_local`** and pass URLs directly to MCP tools — URLs in documents are often temporary and may have expired.' +
      '\n' +
      '\n**NEVER regenerate images.** This is a strict rule:' +
      '\n- When the task is to upload/migrate existing document images, you must use the ORIGINAL images, not generate new ones.' +
      '\n- Regenerating images will produce wrong results — you lack the original prompt, style, seed, and parameters that created the image. The result will be off-topic and incorrect.' +
      '\n- If `fetch_image_to_local` fails for an image, skip it and report the failure. Do NOT call any image generation tool as a replacement.' +
      '\n- Image generation tools (DALL-E, Flux, etc.) should ONLY be used when the user explicitly asks to CREATE NEW images, never as a fallback for retrieving existing ones.' +
      '\nNever abandon the whole batch because one image failed — process each image independently.';

    // Knowledge base image path rule — only inject when inside a KB
    const activeKb = filesStore.getActiveKnowledgeBase();
    if (activeKb && isInsideKnowledgeBase(currentFilePath, activeKb.path)) {
      const imageDir = computeImageDir(currentFilePath, activeKb.path);
      prompt +=
        '\n\nIMPORTANT — Knowledge Base Image Storage Rule:' +
        '\nWhen saving images to the knowledge base, you MUST follow the mirror directory convention:' +
        `\n- Use the built-in tool \`save_image_to_kb\` (PREFERRED) — it handles the path automatically.` +
        '\n- If you must use MCP filesystem tools to write image files, save them to this exact directory:' +
        `\n  ${imageDir}/` +
        '\n- Do NOT save images to any other location within the knowledge base.' +
        (currentFilePath
          ? `\n- Current article image directory: ${imageDir}/`
          : '\n- Current article is unsaved — images will go to images/temp/ and be migrated on first save.');
    }

    // File writing rules
    const openFileNote = currentFilePath && currentFilePath.endsWith('/MORAYA.md')
      ? `\n\n**Currently open in editor**: ${currentFilePath} (the knowledge-base rules file)`
      : currentFilePath
        ? `\n\n**Currently open in editor**: ${currentFilePath}`
        : '';

    prompt +=
      '\n\nIMPORTANT — File write decision rules (read in order, use the FIRST matching rule):' +
      '\n' +
      '\n**Rule 1 — Explicit named target (HIGHEST PRIORITY)**' +
      '\nIf the user says "modify [filename]", "update [path]", "edit the rules file", "write to MORAYA.md", etc.:' +
      '\n  → Modify ONLY that specific file using `write_file` with its exact path.' +
      '\n  → NEVER call `update_editor_content` — that tool writes to the CURRENTLY OPEN EDITOR FILE' +
      (currentFilePath ? ` (which is: ${currentFilePath})` : ' (a new unsaved document)') +
      ', NOT to the file you intend to modify.' +
      '\n  → Skip the currently open document entirely; do not read it, do not write to it.' +
      '\n  → EXCEPTION: if the target file IS already open in the editor (same path), use `update_editor_content`.' +
      '\n' +
      '\n**Rule 2 — Explicit editor target**' +
      '\nOnly if the user says "write to the editor", "put it in the current document", "add to this file", "update what I have open", etc.:' +
      '\n  → Use `update_editor_content`.' +
      (currentFilePath && currentFilePath.endsWith('/MORAYA.md')
        ? '\n  → EXCEPTION: since the open file is MORAYA.md (rules file), do NOT overwrite it with generated content. Create a new file with `write_file` instead.'
        : '') +
      '\n' +
      '\n**Rule 3 — Ambiguous "create content" request (new article, post, essay, etc.)**' +
      '\nIf the user asks to generate/write content WITHOUT specifying where it should go:' +
      '\n  - If the editor has a NEW unsaved document → use `update_editor_content` (fill the blank editor).' +
      '\n  - If the editor has an EXISTING saved file → use `write_file` to a new file. Do NOT overwrite the open document.' +
      '\n' +
      '\n**Rule 4 — Batch / multiple files**' +
      '\nFor batch generation ("create 5 posts", "generate multiple files"):' +
      '\n  → Use `write_file` for each. Target directory priority:' +
      `\n     1. Current file's parent: ${currentDir || '(none)'}` +
      `\n     2. Sidebar folder: ${sidebarDir || '(none)'}` +
      `\n     3. Fallback: ${fallbackDir || '(unknown)'}` +
      '\n' +
      (!currentFilePath
        ? '\n**Rule 5 — New unsaved document (ACTIVE NOW)**' +
          '\nThe editor currently has a NEW unsaved document (no file path). ' +
          'If Rule 1 does NOT apply (user did not name a specific target file), write content into the editor using `update_editor_content`. ' +
          'This is the default destination when no explicit target is given and the document is new.'
        : '\n**Rule 5 — New unsaved document**' +
          '\nIf the editor has a new unsaved document AND no explicit target is named, write to the editor with `update_editor_content`. ' +
          `(Not active now — editor has an existing file: ${currentFilePath})`) +
      openFileNote +
      (currentFilePath && !currentFilePath.endsWith('/MORAYA.md')
        ? `\n\n**Using update_editor_content on the open file**: Only allowed when user explicitly asks to modify the currently open document (${currentFilePath}). When that is the case, read current content from document context, apply changes, then pass full updated content.`
        : '');

    // Remind about MORAYA.md rules if they exist
    if (rulesResult?.active) {
      prompt += '\n\nREMINDER: Before using any tools, ensure you follow the Knowledge Base Rules (MORAYA.md). Read relevant rule sections with read_file if you haven\'t already.';
    }
  }

  // Dynamic service creation capability
  const nodeState = containerStore.getState();
  if (nodeState.nodeAvailable) {
    const mcpDocDir = sidebarDir || fallbackDir;
    prompt +=
      '\n\nYou can create dynamic MCP services on-the-fly using create_mcp_service. Use this when:' +
      '\n- The user needs data from an HTTP API (REST, GraphQL) and no existing tool covers it' +
      '\n- You need to fetch or process data from a web service' +
      '\n- A temporary automation would help the user' +
      '\n\nWhen creating services:' +
      '\n- Write handler code using Node.js built-in fetch() for HTTP calls' +
      '\n- Pass API keys as env variables, never hardcode them in handler code' +
      '\n- Keep handlers focused and include proper error handling' +
      '\n- The service tools become immediately available for subsequent tool calls' +
      '\n\nIMPORTANT — After create_mcp_service succeeds:' +
      '\n- Do NOT call `update_editor_content` and do NOT call `write_file` targeting the currently open document. The service is ready — just report success in your reply text.' +
      '\n- If the user explicitly asks to save documentation or notes about the service, write it as a new Markdown file using `write_file` with the following path priority:' +
      (mcpDocDir
        ? `\n  1. Knowledge base / sidebar directory: ${mcpDocDir}/<filename>.md`
        : '\n  1. Knowledge base / sidebar directory: (none open — skip to step 2)') +
      `\n  2. Fallback — system Documents directory: ${fallbackDir || '(unavailable)'}/<filename>.md` +
      '\n- Never write service documentation into the currently open editor document unless the user explicitly names it as the target.';
  }

  // Renderer plugin AI hints — inject only for enabled+ready plugins
  const enabledRendererPlugins = rendererManager.getEnabled();
  if (enabledRendererPlugins.length > 0) {
    const pluginLines = enabledRendererPlugins
      .map(p => `- \`${p.languages[0]}\` — ${p.aiHint}`)
      .join('\n');
    prompt +=
      '\n\n## Active Renderer Plugins\n' +
      'The following code block types are rendered visually in the editor. Use them when generating visual content:\n' +
      pluginLines;
  }

  if (currentDir) prompt += `\n\nCurrent working directory: ${currentDir}`;
  if (currentFilePath) prompt += `\nCurrent file: ${currentFilePath}`;
  if (documentContext) {
    // NEVER inject MORAYA.md content as document context — that is the rules file, not user content.
    // Injecting it would confuse the AI into writing rules back into articles.
    if (currentFilePath && currentFilePath.endsWith('/MORAYA.md')) {
      prompt += '\n\nCurrent document context: [MORAYA.md — rules file, content omitted to prevent confusion]';
    } else {
      prompt += `\n\nCurrent document context (last 1000 chars):\n${documentContext.slice(-1000)}`;
    }
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

    // Load rules from MORAYA.md (auto-split into indexed segments)
    const rulesResult = await loadRules(sidebarDir, currentFilePath);

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
        content: buildSystemPrompt(activeConfig, toolDefs.length, currentDir, currentFilePath, sidebarDir, fallbackDir, documentContext, rulesResult),
        timestamp: Date.now(),
      },
      // Include recent chat history for context (preserve tool call/result pairs)
      ...trimmedHistory,
      userMsg,
    ];

    aiStore.addMessage(userMsg);

    // Tool execution loop
    const MAX_TOOL_ROUNDS = settingsStore.getState().aiMaxToolRounds || 20;
    const MAX_TRUNCATION_RETRIES = 2;
    const MAX_EMPTY_RETRIES = 3;
    const MAX_CONTINUATION_RETRIES = 3;
    let round = 0;
    let truncationRetries = 0;
    let emptyRetries = 0;
    let continuationRetries = 0;
    let finalContent = '';

    while (round < MAX_TOOL_ROUNDS) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      round++;

      // Use increased max_tokens after truncation to give more room for tool calls
      const effectiveConfig = truncationRetries > 0
        ? { ...activeConfig, maxTokens: Math.max((activeConfig.maxTokens || 41920) * 2, 83840) }
        : activeConfig;

      // Yield to event loop before each API call so user interactions (stop, ESC,
      // menus) can be processed even during rapid multi-round tool loops.
      await new Promise<void>(r => setTimeout(r, 0));

      console.log(`[AI] Tool round ${round}/${MAX_TOOL_ROUNDS}, messages: ${messages.length}, tools: ${toolDefs.length}, maxTokens: ${effectiveConfig.maxTokens}`);

      // Streaming-first: stream text in real-time while also capturing tool events.
      // This gives immediate feedback for ALL models (no more blank screen for slow models).
      console.log('[AI] Calling streamAIRequestWithTools...', { provider: effectiveConfig.provider, model: effectiveConfig.model });
      const response = await streamAIRequestWithTools(effectiveConfig, {
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      }, signal, (chunk) => aiStore.appendStreamContent(chunk));

      // Re-check abort immediately after every major await to avoid stale processing
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      console.log(`[AI] Response received: stopReason=${response.stopReason}, toolCalls=${response.toolCalls?.length || 0}, content=${response.content?.length || 0} chars`);

      // Empty response detection — try recovery in multi-round conversations
      if (!response.content && (!response.toolCalls || response.toolCalls.length === 0)) {
        // In a multi-round tool loop, the model may return empty when confused
        // by tool errors, continuation prompts, or context overflow.
        // Give it a chance to recover before giving up.
        if (round > 1 && emptyRetries < MAX_EMPTY_RETRIES) {
          emptyRetries++;
          console.warn(`[AI] Empty response in round ${round} — recovery attempt ${emptyRetries}/${MAX_EMPTY_RETRIES}`);

          // Find the last non-empty assistant message for context
          let lastAssistantContent = '';
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant' && messages[i].content) {
              lastAssistantContent = messages[i].content!.slice(-200);
              break;
            }
          }

          // Detect language from the conversation to match the AI's language
          const recentText = messages.slice(-6).map(m => m.content || '').join('');
          const promptLocale = detectResponseLocale(recentText);

          const recoveryMsg: ChatMessage = {
            role: 'user',
            content: resolveForLocale('ai.prompts.emptyResponse', promptLocale)
              + (lastAssistantContent
                ? resolveForLocale('ai.prompts.emptyResponseContinue', promptLocale, { lastMessage: lastAssistantContent })
                : ''),
            timestamp: Date.now(),
          };
          messages.push(recoveryMsg);
          continue;
        }
        const emptyMsg = `[Model returned empty response. Provider: ${effectiveConfig.provider}, Model: ${effectiveConfig.model}]`;
        console.warn('[AI] Empty response:', effectiveConfig.provider, effectiveConfig.model);
        aiStore.appendStreamContent(emptyMsg);
        finalContent = emptyMsg;
        break;
      }

      // If response was truncated (max_tokens) with pending tool calls:
      // - First few times: save partial content and ask AI to continue with higher token limit
      // - After max retries: give up and show truncation message
      if (response.stopReason === 'max_tokens' && response.toolCalls && response.toolCalls.length > 0) {
        if (truncationRetries >= MAX_TRUNCATION_RETRIES) {
          console.warn('[AI] Response still truncated after retries — giving up');
          const truncatedNote = '\n\n[Response truncated due to output length limit. Tool calls were skipped.]';
          finalContent = response.content + truncatedNote;
          aiStore.appendStreamContent(truncatedNote);
          break;
        }

        truncationRetries++;
        console.warn(`[AI] Response truncated with tool calls — continuation attempt ${truncationRetries}/${MAX_TRUNCATION_RETRIES}`);

        // Save partial text content (already streamed to UI; discard broken tool calls)
        if (response.content) {
          const partialMsg: ChatMessage = {
            role: 'assistant',
            content: response.content,
            timestamp: Date.now(),
          };
          aiStore.addMessage(partialMsg);
          messages.push(partialMsg);
        }

        // Ask AI to continue — match the language of the truncated response
        const truncLocale = detectResponseLocale(response.content || '');
        const continueMsg: ChatMessage = {
          role: 'user',
          content: resolveForLocale('ai.prompts.truncationContinue', truncLocale),
          timestamp: Date.now(),
        };
        messages.push(continueMsg);
        continue;
      }

      // No tool calls: check if the model intended to continue
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // If truncated with tools defined, the model may have been trying to call tools
        // but the arguments were cut off and couldn't be parsed — retry
        if (response.stopReason === 'max_tokens' && toolDefs.length > 0 && truncationRetries < MAX_TRUNCATION_RETRIES) {
          truncationRetries++;
          console.warn(`[AI] Response truncated with no parseable tool calls — retry ${truncationRetries}/${MAX_TRUNCATION_RETRIES}`);
          if (response.content) {
            const partialMsg: ChatMessage = {
              role: 'assistant',
              content: response.content,
              timestamp: Date.now(),
            };
            aiStore.addMessage(partialMsg);
            messages.push(partialMsg);
          }
          const continueMsg: ChatMessage = {
            role: 'user',
            content: 'Your previous response was cut off due to output length limits. The text above has been saved. Now please complete the task by making the necessary tool call(s). Do not repeat the content — use it directly in the tool arguments.',
            timestamp: Date.now(),
          };
          messages.push(continueMsg);
          continue;
        }

        // Detect incomplete responses: model returned text suggesting it wants to
        // continue with tool calls but stopped without making the call.
        // Detection patterns are built from all locale files (see DETECTION above).
        if (toolDefs.length > 0 && continuationRetries < MAX_CONTINUATION_RETRIES && response.content) {
          const trimmed = response.content.trim();
          const tail = trimmed.slice(-80);

          // Check if ANY sentence expresses intent to take action (common when
          // models describe what they're going to do but fail to emit the tool call).
          const sentences = trimmed.split(/[.。！？!?\n]/).filter(s => s.trim());
          const hasActionIntent = sentences.some(s => DETECTION.intentPattern.test(s));

          const looksIncomplete =
            // Ends with colon (about to do something)
            /[:：]\s*$/.test(tail) ||
            // Ends with continuation phrase
            DETECTION.continuationPattern.test(tail) ||
            // Mentions remaining/next items to process
            DETECTION.remainingPattern.test(tail) ||
            // Previously made tool calls in this session and response mentions more work
            (round > 2 && DETECTION.unfinishedPattern.test(tail)) ||
            // AI states intent to take action but didn't make any tool calls
            hasActionIntent;

          if (looksIncomplete) {
            continuationRetries++;
            console.warn(`[AI] Response appears incomplete (tail: "${tail}", actionIntent: ${hasActionIntent}) — prompting continuation ${continuationRetries}/${MAX_CONTINUATION_RETRIES}`);
            const partialMsg: ChatMessage = {
              role: 'assistant',
              content: response.content,
              timestamp: Date.now(),
            };
            aiStore.addMessage(partialMsg);
            messages.push(partialMsg);
            // Use the same language the model was using to avoid language switching.
            const contLocale = detectResponseLocale(response.content);
            const continueMsg: ChatMessage = {
              role: 'user',
              content: resolveForLocale('ai.prompts.continuationPrompt', contLocale),
              timestamp: Date.now(),
            };
            messages.push(continueMsg);
            continue;
          }
        }

        finalContent = response.content;
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
        // Yield to event loop between tool calls so stop/ESC remain responsive
        await new Promise<void>(r => setTimeout(r, 0));
        aiStore.appendStreamContent(`\n[Calling tool: ${tc.name}...]\n`);

        let resultText = '';
        let isError = false;

        // Per-tool timeout: if an MCP tool stalls (e.g. slow network, hanging API),
        // the call times out and returns an error to the AI instead of freezing forever.
        const TOOL_TIMEOUT_MS = 20_000;

        // Helper: race a promise against the abort signal AND a per-tool timeout.
        // Uses a single Promise wrapper to avoid dangling unhandled rejections from
        // losing race participants (abort / timeout promises).
        const raceAbortOrTimeout = <T>(p: Promise<T>): Promise<T> => {
          if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

          return new Promise<T>((resolve, reject) => {
            let settled = false;
            const settle = (fn: typeof resolve | typeof reject, value: unknown) => {
              if (settled) return;
              settled = true;
              cleanup();
              (fn as (v: unknown) => void)(value);
            };

            const timer = setTimeout(
              () => settle(reject, new Error(`Tool call timed out after ${TOOL_TIMEOUT_MS / 1000}s`)),
              TOOL_TIMEOUT_MS,
            );

            const onAbort = () => settle(reject, new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });

            const cleanup = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', onAbort);
            };

            p.then(
              v => settle(resolve, v),
              e => settle(reject, e),
            );
          });
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
        }

        // If the tool call failed (isError or exception) and its arguments contain HTTP URLs,
        // suggest the fetch_image_to_local fallback strategy so the AI can recover.
        // This covers BOTH MCP tools returning isError:true AND tools that throw exceptions.
        if (isError) {
          const argValues = Object.values(tc.arguments as Record<string, unknown>);
          const hasHttpUrl = argValues.some(
            v => typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://')),
          );
          if (hasHttpUrl) {
            resultText +=
              '\n\nRecovery hint: This tool call failed while working with an image URL. ' +
              'The URL may be expired. Use `fetch_image_to_local(url)` to retrieve the image ' +
              'via browser cache (works even for expired URLs if the image is still displayed in the editor), ' +
              'then retry this tool with the returned local file path instead of the URL. ' +
              'NEVER regenerate the image — you lack the original prompt/style/parameters, ' +
              'regeneration will produce incorrect off-topic results.';
          }
        }

        // Truncate excessively large tool results to prevent exceeding AI context limits
        const toolResultMax = settingsStore.getState().aiToolResultMaxChars || 10000;
        if (resultText.length > toolResultMax) {
          console.warn(`[AI] Tool result truncated: ${resultText.length} → ${toolResultMax} chars`);
          resultText = resultText.slice(0, toolResultMax) +
            `\n\n[Content truncated: showing first ${toolResultMax} of ${resultText.length} chars]`;
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

        // Check abort between tool calls to stop immediately when user interrupts
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      }
    }

    // If the loop exited because MAX_TOOL_ROUNDS was reached (not a break),
    // the model still has pending tool results to process. Give it one final
    // text-only call to summarize what was done and what remains.
    if (round >= MAX_TOOL_ROUNDS && !finalContent) {
      console.warn(`[AI] Tool round limit (${MAX_TOOL_ROUNDS}) reached — generating final summary`);

      // UI-level hint: tell the user they can increase the limit
      const tr = get(t);
      const settingsHint = tr('settings.permissions.aiMaxToolRounds');
      aiStore.appendStreamContent(
        `\n\n⚠️ [${tr('settings.permissions.aiTitle')} → ${settingsHint}: ${MAX_TOOL_ROUNDS}]`
      );

      const summaryPrompt: ChatMessage = {
        role: 'user',
        content: 'You have reached the maximum number of tool call rounds (' + MAX_TOOL_ROUNDS + '). '
          + 'Please summarize what has been completed and list any remaining steps the user needs to do manually.\n\n'
          + 'IMPORTANT: Tell the user they can increase this limit in Settings → Permissions → "' + settingsHint + '" (current value: ' + MAX_TOOL_ROUNDS + ').',
        timestamp: Date.now(),
      };
      messages.push(summaryPrompt);

      try {
        const summaryResponse = await streamAIRequestWithTools(activeConfig, {
          messages,
          // No tools — force text-only response
        }, signal, (chunk) => aiStore.appendStreamContent(chunk));

        finalContent = summaryResponse.content || '';
      } catch (err: any) {
        if (err?.name !== 'AbortError' && !signal.aborted) {
          console.error('[AI] Failed to generate round-limit summary:', err);
        }
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
      // Save any partial streamed content so the user doesn't lose visible text
      const partial = aiStore.getState().streamingContent;
      if (partial) {
        aiStore.addMessage({ role: 'assistant', content: partial, timestamp: Date.now() });
      }
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
    // Cap max_tokens for the connection test — many providers reject very large
    // values (e.g. Dashscope returns 400 for max_tokens > model limit).
    // The test only needs a short reply.
    const response = await sendAIRequest({ ...testConfig, maxTokens: Math.min(testConfig.maxTokens || 1024, 1024) }, {
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
 *
 * Only continues to the next candidate on 404 (path not found) or network
 * errors. On 400/401/403/429/5xx the endpoint was reached — stop immediately
 * so the real error is reported rather than a misleading 404 from a stripped URL.
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
    // A non-404 "API error" means the endpoint was reached but the request
    // itself was rejected (e.g. 400 invalid body, 401 bad key, 429 rate limit).
    // Stop retrying — further URL stripping won't help and may surface a
    // misleading 404 from a non-existent stripped path.
    if (typeof lastError === 'string' && lastError.startsWith('API error (') && !lastError.includes('API error (404)')) break;
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
    const realtimeConfigs = await store.get<RealtimeVoiceAIConfig[]>('realtimeVoiceConfigs');
    const activeRealtimeId = await store.get<string>('activeRealtimeVoiceConfigId');

    if (configs && configs.length > 0) {
      // Ensure all configs have ids
      for (const c of configs) {
        if (!c.id) c.id = crypto.randomUUID();
      }

      // Restore API keys from keychain / migrate plaintext keys
      let needsMigration = false;
      for (const c of configs) {
        if (c.apiKey === '***') {
          // Restore from keychain. If null (keychain temporarily unavailable after
          // upgrade), preserve '***' in memory so the marker isn't permanently lost
          // on the next save. The UI maps '***' → empty field for display.
          const key = await getKeyFromKeychain(c.id);
          if (key !== null) c.apiKey = key;
          // else: keep '***' — keychain will be retried on next app launch
        } else if (c.apiKey && c.apiKey !== '') {
          // Legacy plaintext key — migrate to keychain
          needsMigration = true;
          await saveKeyToKeychain(c.id, c.apiKey);
        }
      }

      let restoredRealtime: RealtimeVoiceAIConfig[] = [];
      let needsRealtimeMigration = false;
      if (realtimeConfigs && realtimeConfigs.length > 0) {
        for (const c of realtimeConfigs) {
          if (!c.id) c.id = crypto.randomUUID();
          const restored = await restoreRealtimeSecretsFromKeychain(c);
          restoredRealtime.push(restored);

          if ((c.apiKey && c.apiKey !== '***')
            || (c.accessKeyId && c.accessKeyId !== '***')
            || (c.secretAccessKey && c.secretAccessKey !== '***')
            || (c.sessionToken && c.sessionToken !== '***')) {
            needsRealtimeMigration = true;
          }
        }
      }

      aiStore._load(
        configs,
        activeId || configs[0].id,
        restoredRealtime,
        activeRealtimeId || restoredRealtime[0]?.id || null,
      );

      // Persist migration (replace plaintext keys with "***" on disk)
      if (needsMigration || needsRealtimeMigration) {
        persistAIConfigs(
          configs,
          activeId || configs[0].id,
          restoredRealtime,
          activeRealtimeId || restoredRealtime[0]?.id || null,
        );
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
        const restoredRealtime: RealtimeVoiceAIConfig[] = [];
        if (realtimeConfigs && realtimeConfigs.length > 0) {
          for (const c of realtimeConfigs) {
            if (!c.id) c.id = crypto.randomUUID();
            restoredRealtime.push(await restoreRealtimeSecretsFromKeychain(c));
          }
        }
        aiStore._load([saved], saved.id, restoredRealtime, activeRealtimeId || restoredRealtime[0]?.id || null);
        // Persist in new format with key placeholder
        await store.set('providerConfigs', [{ ...saved, apiKey: saved.apiKey ? '***' : '' }]);
        await store.set('activeConfigId', saved.id);
        if (restoredRealtime.length > 0) {
          const diskRealtime: RealtimeVoiceAIConfig[] = [];
          for (const c of restoredRealtime) {
            diskRealtime.push(await saveRealtimeSecretsToKeychain(c));
          }
          await store.set('realtimeVoiceConfigs', diskRealtime);
          await store.set('activeRealtimeVoiceConfigId', activeRealtimeId || restoredRealtime[0]?.id || null);
        }
        await store.delete('providerConfig');
        await store.save();
      } else if (realtimeConfigs && realtimeConfigs.length > 0) {
        const restoredRealtime: RealtimeVoiceAIConfig[] = [];
        for (const c of realtimeConfigs) {
          if (!c.id) c.id = crypto.randomUUID();
          restoredRealtime.push(await restoreRealtimeSecretsFromKeychain(c));
        }
        aiStore._load([], null, restoredRealtime, activeRealtimeId || restoredRealtime[0]?.id || null);
      }
    }
  } catch { /* first launch */ }
}

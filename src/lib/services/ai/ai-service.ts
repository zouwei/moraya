/**
 * AI Service - orchestrates AI operations for the editor
 */

import { writable, get } from 'svelte/store';
import { sendAIRequest, streamAIRequest } from './providers';
import type {
  AIProviderConfig,
  AICommand,
  ChatMessage,
  AIResponse,
  AI_COMMANDS,
} from './types';
import { AI_COMMANDS as COMMANDS } from './types';
import { t } from '$lib/i18n';

// ── AI State Store ──

interface AIState {
  isConfigured: boolean;
  isLoading: boolean;
  error: string | null;
  chatHistory: ChatMessage[];
  lastResponse: string | null;
  streamingContent: string;
  providerConfig: AIProviderConfig | null;
}

function createAIStore() {
  const { subscribe, set, update } = writable<AIState>({
    isConfigured: false,
    isLoading: false,
    error: null,
    chatHistory: [],
    lastResponse: null,
    streamingContent: '',
    providerConfig: null,
  });

  return {
    subscribe,
    setConfig(config: AIProviderConfig) {
      update(state => ({
        ...state,
        providerConfig: config,
        isConfigured: !!config.apiKey,
        error: null,
      }));
    },
    setLoading(loading: boolean) {
      update(state => ({ ...state, isLoading: loading, error: null }));
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
    clearHistory() {
      update(state => ({ ...state, chatHistory: [], lastResponse: null }));
    },
    getState() {
      return get({ subscribe });
    },
  };
}

export const aiStore = createAIStore();

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
  const tr = get(t);
  if (!state.providerConfig || !state.isConfigured) {
    throw new Error(tr('errors.aiNotConfigured'));
  }

  const commandDef = COMMANDS.find(c => c.command === command);
  if (!commandDef && command !== 'custom') {
    throw new Error(tr('errors.unknownCommand', { command }));
  }

  aiStore.setLoading(true);
  aiStore.resetStream();

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
    const stream = streamAIRequest(state.providerConfig, { messages, stream: true });

    for await (const chunk of stream) {
      fullContent += chunk;
      aiStore.appendStreamContent(chunk);
    }

    // Record assistant response
    aiStore.addMessage({
      role: 'assistant',
      content: fullContent,
      timestamp: Date.now(),
    });

    aiStore.setLastResponse(fullContent);
    return fullContent;

  } catch (error: any) {
    const errMsg = error?.message || get(t)('errors.aiRequestFailed');
    aiStore.setError(errMsg);
    throw error;
  }
}

/**
 * Send a free-form chat message to the AI
 */
export async function sendChatMessage(message: string, documentContext?: string): Promise<string> {
  const state = aiStore.getState();
  if (!state.providerConfig || !state.isConfigured) {
    throw new Error(get(t)('errors.aiNotConfigured'));
  }

  aiStore.setLoading(true);
  aiStore.resetStream();

  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are Moraya AI, a helpful writing assistant integrated into a Markdown editor. Help the user with writing, editing, and content creation. Always respond in Markdown format when producing content.\n\n${documentContext ? `Current document context (last 1000 chars):\n${documentContext.slice(-1000)}` : ''}`,
        timestamp: Date.now(),
      },
      // Include recent chat history for context
      ...state.chatHistory.slice(-10),
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

    let fullContent = '';
    const stream = streamAIRequest(state.providerConfig, { messages, stream: true });

    for await (const chunk of stream) {
      fullContent += chunk;
      aiStore.appendStreamContent(chunk);
    }

    aiStore.addMessage({
      role: 'assistant',
      content: fullContent,
      timestamp: Date.now(),
    });

    aiStore.setLastResponse(fullContent);
    return fullContent;

  } catch (error: any) {
    const errMsg = error?.message || get(t)('errors.chatRequestFailed');
    aiStore.setError(errMsg);
    throw error;
  }
}

/**
 * Test the AI connection with current config
 */
export async function testAIConnection(): Promise<boolean> {
  const state = aiStore.getState();
  if (!state.providerConfig) return false;

  try {
    const response = await sendAIRequest(state.providerConfig, {
      messages: [
        { role: 'user', content: 'Say "Hello from Moraya!" in exactly 3 words.', timestamp: Date.now() },
      ],
    });
    return !!response.content;
  } catch {
    return false;
  }
}

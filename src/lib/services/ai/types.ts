/**
 * AI Service type definitions for Moraya
 * Supports multiple LLM providers: Claude, OpenAI, Gemini, DeepSeek, local models
 */

// LLM provider catalog is sourced from the shared @moraya/core/ai package —
// the single source of truth (no local fork). resolveCatalog({platform:'desktop'})
// surfaces cloud providers only; on-device (local-mlx/local-llama) are filtered
// out by core's capability metadata.
import { resolveCatalog } from '@moraya/core/ai';
import type { AIProvider } from '@moraya/core/ai';
export type { AIProvider };

/** Cloud chat providers surfaced on desktop, in catalog order (excludes on-device). */
export const CHAT_PROVIDERS: AIProvider[] = resolveCatalog({ platform: 'desktop' }).map((p) => p.id);

/**
 * Providers that run entirely on-device: no API key, no per-token cost.
 * App-local UI concept — @moraya/core's ProviderMeta has no such field
 * (kept out of the shared package for now; see v1.32.0 iteration doc).
 */
export const FREE_LOCAL_PROVIDERS: readonly AIProvider[] = ['ollama'];

/** Console/API-key-creation pages for providers that need one. Ollama and
 *  the generic 'custom' endpoint intentionally have no entry. */
export const PROVIDER_API_KEY_URLS: Partial<Record<AIProvider, string>> = {
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  grok: 'https://console.x.ai',
  mistral: 'https://console.mistral.ai/api-keys/',
  glm: 'https://open.bigmodel.cn/usercenter/apikeys',
  minimax: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  doubao: 'https://console.volcengine.com/ark',
};

export interface AIProviderConfig {
  id: string;
  provider: AIProvider;
  apiKey: string;
  baseUrl?: string;    // For custom/local endpoints
  model: string;
  maxTokens?: number;
  temperature?: number;
}

// Realtime-voice provider types + catalogs now live in @moraya/core/ai (shared
// across desktop + web). Re-exported here so existing importers are unchanged.
export type { RealtimeVoiceProvider, RealtimeVoiceAIConfig } from '@moraya/core/ai/voice';
import type { RealtimeVoiceProvider } from '@moraya/core/ai/voice';

// Cloud provider model lists — re-exported from @moraya/core/ai (authoritative).
export { DEFAULT_MODELS } from '@moraya/core/ai';

export { REALTIME_VOICE_DEFAULT_MODELS } from '@moraya/core/ai/voice';

// Cloud provider base URLs — re-exported from @moraya/core/ai (authoritative).
export { PROVIDER_BASE_URLS } from '@moraya/core/ai';

export { REALTIME_VOICE_BASE_URLS, REALTIME_VOICE_PROVIDER_NAMES } from '@moraya/core/ai/voice';

export const REALTIME_VOICE_ENDPOINT_PRESETS: Partial<
  Record<RealtimeVoiceProvider, { value: string; label: string }[]>
> = {
  'qwen-realtime': [
    { value: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', label: 'DashScope - Beijing' },
    { value: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference', label: 'DashScope - Singapore' },
  ],
  'tongyi-bailing': [
    { value: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', label: 'Tongyi Bailing - Beijing' },
    { value: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference', label: 'Tongyi Bailing - Singapore' },
  ],
  'doubao-realtime': [
    { value: 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue', label: '豆包实时语音对话 - 全球' },
  ],
};

export interface ImageAttachment {
  id: string;           // crypto.randomUUID()
  mimeType: string;     // "image/jpeg", "image/png", etc.
  base64: string;       // base64-encoded data (no data: prefix)
  previewUrl?: string;  // blob URL for UI preview only
  fileName?: string;    // original file name for compact attachment chips
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  images?: ImageAttachment[];
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  isSuccess?: boolean;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  providerMeta?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AIRequest {
  messages: ChatMessage[];
  stream?: boolean;
  tools?: ToolDefinition[];
}

export interface AIResponse {
  content: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  toolCalls?: ToolCallRequest[];
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop';
}

/** Result from streaming with tool call support. */
export interface StreamToolResult {
  content: string;
  toolCalls?: ToolCallRequest[];
  stopReason?: string;
}

export type AICommand =
  | 'write'       // Write content based on prompt
  | 'continue'    // Continue writing from current position
  | 'summarize'   // Summarize selected text
  | 'translate'   // Translate selected text
  | 'improve'     // Improve writing quality
  | 'fix-grammar' // Fix grammar and spelling
  | 'simplify'    // Simplify complex text
  | 'expand'      // Expand on a topic
  | 'tone'        // Change tone (formal, casual, etc.)
  | 'explain'     // Explain selected text
  | 'outline'     // Generate article outline
  | 'custom';     // Custom prompt

export interface AICommandOption {
  command: AICommand;
  labelKey: string;
  icon: string;
  descriptionKey: string;
  requiresSelection?: boolean;
  systemPrompt: string;
}

// --- Image Generation (AIGC) Types ---
// Image provider catalog is sourced from @moraya/core/ai/image (single source of
// truth). Base URLs / model lists / size maps are no longer forked here.
import { IMAGE_DEFAULT_MODELS, IMAGE_BASE_URLS } from '@moraya/core/ai/image';
import type { ImageProvider, ImageAspectRatio, ImageSizeLevel } from '@moraya/core/ai/image';

export type { ImageProvider, ImageAspectRatio, ImageSizeLevel };
export {
  IMAGE_DEFAULT_MODELS as DEFAULT_IMAGE_MODELS,
  IMAGE_SIZE_MAP,
  DOUBAO_SIZE_MAP,
  resolveImageSize,
} from '@moraya/core/ai/image';

export interface ImageProviderConfig {
  id: string;
  provider: ImageProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  defaultRatio: ImageAspectRatio;
  defaultSizeLevel: ImageSizeLevel;
  /** @deprecated Use defaultRatio + defaultSizeLevel instead */
  defaultSize?: string;
}

/** {baseURL, model} per provider — derived from the core image catalog. */
export const IMAGE_PROVIDER_PRESETS: Record<ImageProvider, { baseURL: string; model: string }> =
  Object.fromEntries(
    (Object.keys(IMAGE_BASE_URLS) as ImageProvider[]).map((p) => [
      p,
      { baseURL: IMAGE_BASE_URLS[p], model: IMAGE_DEFAULT_MODELS[p][0] ?? '' },
    ]),
  ) as Record<ImageProvider, { baseURL: string; model: string }>;

export const DEFAULT_IMAGE_PROVIDER_CONFIG: Omit<ImageProviderConfig, 'id'> = {
  provider: 'openai',
  baseURL: IMAGE_BASE_URLS.openai,
  apiKey: '',
  model: IMAGE_DEFAULT_MODELS.openai[0],
  defaultRatio: '16:9',
  defaultSizeLevel: 'medium',
};

// --- SEO Types ---

export interface SEOData {
  titles: string[];
  selectedTitle: string;
  excerpt: string;
  tags: string[];
  metaDescription: string;
  slug: string;
}

// --- AI Commands ---

export const AI_COMMANDS: AICommandOption[] = [
  {
    command: 'write',
    labelKey: 'ai.commands.write',
    icon: '✍',
    descriptionKey: 'ai.commands.write_desc',
    systemPrompt: 'You are a helpful writing assistant. Write content based on the user\'s instructions. Output in Markdown format. Be concise and well-structured.',
  },
  {
    command: 'continue',
    labelKey: 'ai.commands.continue',
    icon: '→',
    descriptionKey: 'ai.commands.continue_desc',
    systemPrompt: 'Continue writing from where the text left off. Maintain the same style, tone, and format. Output in Markdown.',
  },
  {
    command: 'summarize',
    labelKey: 'ai.commands.summarize',
    icon: '📋',
    descriptionKey: 'ai.commands.summarize_desc',
    requiresSelection: true,
    systemPrompt: 'Summarize the following text concisely. Keep key points. Output in Markdown.',
  },
  {
    command: 'translate',
    labelKey: 'ai.commands.translate',
    icon: '🌐',
    descriptionKey: 'ai.commands.translate_desc',
    requiresSelection: true,
    systemPrompt: 'Translate the following text. If the text is in Chinese, translate to English. If in English, translate to Chinese. Maintain formatting. Output in Markdown.',
  },
  {
    command: 'improve',
    labelKey: 'ai.commands.improve',
    icon: '✨',
    descriptionKey: 'ai.commands.improve_desc',
    requiresSelection: true,
    systemPrompt: 'Improve the following text for clarity, coherence, and style. Keep the original meaning. Output in Markdown.',
  },
  {
    command: 'fix-grammar',
    labelKey: 'ai.commands.fix_grammar',
    icon: '🔧',
    descriptionKey: 'ai.commands.fix_grammar_desc',
    requiresSelection: true,
    systemPrompt: 'Fix all grammar, spelling, and punctuation errors in the following text. Keep the original meaning and style. Output the corrected text only.',
  },
  {
    command: 'simplify',
    labelKey: 'ai.commands.simplify',
    icon: '📝',
    descriptionKey: 'ai.commands.simplify_desc',
    requiresSelection: true,
    systemPrompt: 'Simplify the following text to make it easier to understand. Use simpler words and shorter sentences. Output in Markdown.',
  },
  {
    command: 'expand',
    labelKey: 'ai.commands.expand',
    icon: '📖',
    descriptionKey: 'ai.commands.expand_desc',
    requiresSelection: true,
    systemPrompt: 'Expand on the following text with more details, examples, and explanations. Output in Markdown.',
  },
  {
    command: 'outline',
    labelKey: 'ai.commands.outline',
    icon: '📑',
    descriptionKey: 'ai.commands.outline_desc',
    systemPrompt: 'Generate a detailed article outline based on the topic. Use Markdown heading format (##, ###). Include main sections and subsections.',
  },
  {
    command: 'explain',
    labelKey: 'ai.commands.explain',
    icon: '💡',
    descriptionKey: 'ai.commands.explain_desc',
    requiresSelection: true,
    systemPrompt: 'Explain the following text in simple terms. If it contains technical concepts, provide clear explanations. Output in Markdown.',
  },
];

// --- Speech STT Types ---

// SpeechProvider + SpeechProviderConfig are sourced from @moraya/core/ai/voice
// (shared, identical shape — no local fork). Desktop keychain key scheme:
// apiKey → 'speech-key:{id}', awsAccessKey → 'speech-aws-ak:{id}',
// awsSecretKey → 'speech-aws-sk:{id}' (disk placeholder: '***').
import type { SpeechProvider, SpeechProviderConfig } from '@moraya/core/ai/voice';
export type { SpeechProvider, SpeechProviderConfig };

export const SPEECH_PROVIDER_MODELS: Record<SpeechProvider, string[]> = {
  deepgram:         ['nova-3', 'nova-2', 'nova', 'enhanced', 'base'],
  gladia:           ['solaria-1', 'fast', 'accurate'],
  assemblyai:       ['universal-streaming'],
  'azure-speech':   ['latest'],
  'aws-transcribe': ['general', 'medical', 'call-center'],
  custom:           [],
};

export const SPEECH_PROVIDER_BASE_URLS: Record<SpeechProvider, string> = {
  deepgram:         'wss://api.deepgram.com',
  gladia:           'wss://api.gladia.io',
  assemblyai:       'wss://streaming.assemblyai.com',
  'azure-speech':   'wss://{region}.stt.speech.microsoft.com',
  'aws-transcribe': 'wss://transcribestreaming.{region}.amazonaws.com:8443',
  custom:           '',
};

export const SPEECH_PROVIDER_NAMES: Record<SpeechProvider, string> = {
  deepgram:         'Deepgram',
  gladia:           'Gladia',
  assemblyai:       'AssemblyAI',
  'azure-speech':   'Azure Speech',
  'aws-transcribe': 'AWS Transcribe',
  custom:           'Custom',
};

/**
 * AI Service type definitions for Moraya
 * Supports multiple LLM providers: Claude, OpenAI, Gemini, DeepSeek, local models
 */

export type AIProvider = 'claude' | 'openai' | 'gemini' | 'deepseek' | 'ollama' | 'grok' | 'mistral' | 'glm' | 'minimax' | 'doubao' | 'custom';

export interface AIProviderConfig {
  id: string;
  provider: AIProvider;
  apiKey: string;
  baseUrl?: string;    // For custom/local endpoints
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export const DEFAULT_MODELS: Record<AIProvider, string[]> = {
  claude:  ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai:  ['gpt-5.2', 'gpt-5.2-pro', 'gpt-5', 'gpt-5-mini', 'o4-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini'],
  gemini:  ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-pro-exp'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  ollama:  ['llama3.3', 'llama3.2', 'qwen2.5', 'qwen2.5-coder', 'phi4', 'gemma3', 'deepseek-r1', 'mistral', 'codellama'],
  grok:    ['grok-4', 'grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning', 'grok-code-fast-1', 'grok-3'],
  mistral: ['mistral-large-latest', 'mistral-small-latest', 'magistral-medium-latest', 'magistral-small-latest', 'codestral-latest', 'devstral-latest'],
  glm:     ['glm-5', 'glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-z1-flash', 'glm-z1-air'],
  minimax: ['MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-Text-01'],
  doubao:  ['doubao-seed-2-0-pro', 'doubao-seed-2-0-lite', 'doubao-seed-2-0-mini', 'doubao-seed-2-0-code', 'doubao-pro-32k', 'doubao-pro-128k'],
  custom:  [],
};

export const PROVIDER_BASE_URLS: Record<AIProvider, string> = {
  claude:   'https://api.anthropic.com',
  openai:   'https://api.openai.com',
  gemini:   'https://generativelanguage.googleapis.com',
  deepseek: 'https://api.deepseek.com',
  ollama:   'http://localhost:11434',
  grok:     'https://api.x.ai',
  mistral:  'https://api.mistral.ai',
  glm:      'https://open.bigmodel.cn/api/paas/v4',
  minimax:  'https://api.minimax.io/v1',
  doubao:   'https://ark.cn-beijing.volces.com/api/v3',
  custom:   '',
};

export interface ImageAttachment {
  id: string;           // crypto.randomUUID()
  mimeType: string;     // "image/jpeg", "image/png", etc.
  base64: string;       // base64-encoded data (no data: prefix)
  previewUrl?: string;  // blob URL for UI preview only
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
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
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

export type ImageProvider = 'openai' | 'grok' | 'gemini' | 'qwen' | 'doubao' | 'custom';

export const DEFAULT_IMAGE_MODELS: Record<ImageProvider, string[]> = {
  openai: ['dall-e-3', 'dall-e-2', 'gpt-image-1'],
  grok:   ['aurora'],
  gemini: ['imagen-3.0-generate-002', 'imagen-3.0-fast-generate-001'],
  qwen:   ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus', 'wanx-v1'],
  doubao: ['doubao-seedream-5-0-260128', 'doubao-seedream-3-0-t2i-250415'],
  custom: [],
};

export type ImageAspectRatio = '16:9' | '4:3' | '3:2' | '1:1' | '2:3' | '3:4' | '9:16';
export type ImageSizeLevel = 'large' | 'medium' | 'small';

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

/** Resolution map: ratio → sizeLevel → "WxH" */
export const IMAGE_SIZE_MAP: Record<ImageAspectRatio, Record<ImageSizeLevel, string>> = {
  '16:9': { large: '1920x1080', medium: '1280x720',  small: '960x540'  },
  '4:3':  { large: '1600x1200', medium: '1024x768',  small: '800x600'  },
  '3:2':  { large: '1536x1024', medium: '1200x800',  small: '768x512'  },
  '1:1':  { large: '1536x1536', medium: '1024x1024', small: '512x512'  },
  '2:3':  { large: '1024x1536', medium: '800x1200',  small: '512x768'  },
  '3:4':  { large: '1200x1600', medium: '768x1024',  small: '600x800'  },
  '9:16': { large: '1080x1920', medium: '720x1280',  small: '540x960'  },
};

export function resolveImageSize(ratio: ImageAspectRatio, level: ImageSizeLevel): string {
  return IMAGE_SIZE_MAP[ratio]?.[level] ?? '1024x1024';
}

/**
 * Doubao (VolcEngine SeedDream) requires minimum 3,686,400 pixels (1920×1920).
 * All sizes here satisfy this constraint. 16:9/9:16 small=medium because
 * 2560×1440 / 1440×2560 is already the minimum valid size for those ratios.
 * Similarly 3:2/2:3 minimum rounds to 2400×1600 / 1600×2400.
 */
export const DOUBAO_SIZE_MAP: Record<ImageAspectRatio, Record<ImageSizeLevel, string>> = {
  '16:9': { large: '3840x2160', medium: '2560x1440', small: '2560x1440' },
  '4:3':  { large: '3200x2400', medium: '2560x1920', small: '2240x1680' },
  '3:2':  { large: '3000x2000', medium: '2400x1600', small: '2400x1600' },
  '1:1':  { large: '2560x2560', medium: '2048x2048', small: '1920x1920' },
  '2:3':  { large: '2000x3000', medium: '1600x2400', small: '1600x2400' },
  '3:4':  { large: '2400x3200', medium: '1920x2560', small: '1680x2240' },
  '9:16': { large: '2160x3840', medium: '1440x2560', small: '1440x2560' },
};

export const IMAGE_PROVIDER_PRESETS: Record<ImageProvider, { baseURL: string; model: string }> = {
  openai:  { baseURL: 'https://api.openai.com/v1',                          model: 'dall-e-3' },
  grok:    { baseURL: 'https://api.x.ai/v1',                                model: 'aurora' },
  gemini:  { baseURL: 'https://generativelanguage.googleapis.com',           model: 'imagen-3.0-generate-002' },
  qwen:    { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',   model: 'wanx2.1-t2i-turbo' },
  doubao:  { baseURL: 'https://ark.cn-beijing.volces.com/api/v3',            model: 'doubao-seedream-5-0-260128' },
  custom:  { baseURL: '', model: '' },
};

export const DEFAULT_IMAGE_PROVIDER_CONFIG: Omit<ImageProviderConfig, 'id'> = {
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'dall-e-3',
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
    descriptionKey: 'ai.commands.writeDesc',
    systemPrompt: 'You are a helpful writing assistant. Write content based on the user\'s instructions. Output in Markdown format. Be concise and well-structured.',
  },
  {
    command: 'continue',
    labelKey: 'ai.commands.continue',
    icon: '→',
    descriptionKey: 'ai.commands.continueDesc',
    systemPrompt: 'Continue writing from where the text left off. Maintain the same style, tone, and format. Output in Markdown.',
  },
  {
    command: 'summarize',
    labelKey: 'ai.commands.summarize',
    icon: '📋',
    descriptionKey: 'ai.commands.summarizeDesc',
    requiresSelection: true,
    systemPrompt: 'Summarize the following text concisely. Keep key points. Output in Markdown.',
  },
  {
    command: 'translate',
    labelKey: 'ai.commands.translate',
    icon: '🌐',
    descriptionKey: 'ai.commands.translateDesc',
    requiresSelection: true,
    systemPrompt: 'Translate the following text. If the text is in Chinese, translate to English. If in English, translate to Chinese. Maintain formatting. Output in Markdown.',
  },
  {
    command: 'improve',
    labelKey: 'ai.commands.improve',
    icon: '✨',
    descriptionKey: 'ai.commands.improveDesc',
    requiresSelection: true,
    systemPrompt: 'Improve the following text for clarity, coherence, and style. Keep the original meaning. Output in Markdown.',
  },
  {
    command: 'fix-grammar',
    labelKey: 'ai.commands.fixGrammar',
    icon: '🔧',
    descriptionKey: 'ai.commands.fixGrammarDesc',
    requiresSelection: true,
    systemPrompt: 'Fix all grammar, spelling, and punctuation errors in the following text. Keep the original meaning and style. Output the corrected text only.',
  },
  {
    command: 'simplify',
    labelKey: 'ai.commands.simplify',
    icon: '📝',
    descriptionKey: 'ai.commands.simplifyDesc',
    requiresSelection: true,
    systemPrompt: 'Simplify the following text to make it easier to understand. Use simpler words and shorter sentences. Output in Markdown.',
  },
  {
    command: 'expand',
    labelKey: 'ai.commands.expand',
    icon: '📖',
    descriptionKey: 'ai.commands.expandDesc',
    requiresSelection: true,
    systemPrompt: 'Expand on the following text with more details, examples, and explanations. Output in Markdown.',
  },
  {
    command: 'outline',
    labelKey: 'ai.commands.outline',
    icon: '📑',
    descriptionKey: 'ai.commands.outlineDesc',
    systemPrompt: 'Generate a detailed article outline based on the topic. Use Markdown heading format (##, ###). Include main sections and subsections.',
  },
  {
    command: 'explain',
    labelKey: 'ai.commands.explain',
    icon: '💡',
    descriptionKey: 'ai.commands.explainDesc',
    requiresSelection: true,
    systemPrompt: 'Explain the following text in simple terms. If it contains technical concepts, provide clear explanations. Output in Markdown.',
  },
];

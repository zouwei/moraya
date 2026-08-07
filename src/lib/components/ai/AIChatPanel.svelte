<script lang="ts">
  import {
    aiStore,
    sendChatMessage,
    sendAIRequest,
    abortAIRequest,
    type ChatMessage,
    type ImageAttachment,
    type AIProviderConfig,
    type RealtimeVoiceAIConfig,
    type AITemplate,
    resolveContent,
    buildTemplateMessages,
    getTemplateName,
    loadAllCustomTemplates,
    importTemplatesFromFile,
    exportTemplates,
    getAllTemplates,
  } from '$lib/services/ai';
  import { settingsStore } from '$lib/stores/settings-store';
  import { startTranscription, stopTranscription } from '$lib/services/voice/speech-service';
  import type { TranscriptSegment } from '$lib/services/voice/types';
  import type { SpeechProviderConfig, ImageProviderConfig } from '$lib/services/ai/types';
  import { REALTIME_VOICE_BASE_URLS } from '$lib/services/ai/types';
  import { mcpStore } from '$lib/services/mcp';
  import { filesStore } from '$lib/stores/files-store';
  import { invoke, Channel } from '@tauri-apps/api/core';
  import { readFile } from '@tauri-apps/plugin-fs';
  // v0.42.0: chat bubble rendering now goes through @moraya/core/chat-markdown
  // via the local katex/hljs wrapper. `markdownToHtmlBody` (export-service)
  // is reserved for HTML/PDF export, which has different needs (mermaid
  // wrappers, TOC anchors, etc).
  import { renderChatMarkdown } from '$lib/services/ai/chat-render';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { onMount, onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { parseMemorizeCommand, memorizeFromInput } from '$lib/services/memory';
  import { compressImage, blobToBase64 } from '$lib/services/ai/image-utils';
  import ThinkingOrb from './ThinkingOrb.svelte';
  import TemplateGallery from './TemplateGallery.svelte';
  import PromptPalette from '../PromptPalette.svelte';
  import TemplateParamPanel from './TemplateParamPanel.svelte';
  import TemplateManagePanel from './TemplateManagePanel.svelte';
  import { Select } from '$lib/components/ui';

  let {
    documentContent = '',
    selectedText = '',
    getDocumentContent,
    onInsert,
    onReplace,
    onOpenSettings,
    onOpenVoiceSettings,
  }: {
    documentContent?: string;
    selectedText?: string;
    /** On-demand content getter (serializes ProseMirror doc). Falls back to documentContent prop. */
    getDocumentContent?: () => string;
    onInsert?: (text: string) => void;
    onReplace?: (text: string) => void;
    onOpenSettings?: () => void;
    onOpenVoiceSettings?: () => void;
  } = $props();

  /** Get the latest document content, preferring the on-demand getter. */
  function latestContent(): string {
    return getDocumentContent ? getDocumentContent() : documentContent;
  }

  let chatMessages = $state<ChatMessage[]>([]);
  let isLoading = $state(false);
  let error = $state<string | null>(null);
  let interrupted = $state(false);
  let streamingContent = $state('');
  let isConfigured = $state(false);
  let inputText = $state('');
  let showCommands = $state(false);
  let showPromptRecall = $state(false);
  let messagesEl = $state<HTMLDivElement | undefined>(undefined);
  let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let scrollRaf: number | undefined; // RAF throttle for auto-scroll
  let resizeRaf: number | undefined; // RAF throttle for textarea auto-resize
  let streamRenderTimer: ReturnType<typeof setTimeout> | undefined;
  let mcpToolCount = $state(0);
  let providerConfigs = $state<AIProviderConfig[]>([]);
  let activeConfigId = $state<string | null>(null);
  let realtimeVoiceConfigs = $state<RealtimeVoiceAIConfig[]>([]);
  let activeRealtimeVoiceConfigId = $state<string | null>(null);
  let isRealtimeVoiceActive = $state(false);
  let isRealtimeVoiceConnecting = $state(false);

  // Realtime dialogue session state
  type RtDialogueEvent =
    | { type: 'connected'; sessionId: string }
    | { type: 'message'; sessionId: string; data: string }
    | { type: 'error'; sessionId: string; error: string }
    | { type: 'disconnected'; sessionId: string };
  let rtSessionId: string | null = null;
  let rtAudioContext: AudioContext | null = null;   // input (mic capture)
  let rtOutputContext: AudioContext | null = null;  // output (TTS playback)
  let rtNextPlayTime = 0;
  let rtMediaStream: MediaStream | null = null;
  let rtWorkletNode: AudioWorkletNode | null = null;
  let rtCurrentResponse = $state(''); // accumulates streaming AI text
  let rtUserInterim = $state('');    // interim ASR text from user speech

  // Template system state
  let activeTemplate = $state<AITemplate | null>(null);
  let showParamPanel = $state(false);
  let inputPlaceholderOverride = $state<string | null>(null);

  // Template management state
  let showTemplateMenu = $state(false);
  let showManagePanel = $state(false);
  let templateMenuEl = $state<HTMLDivElement | undefined>(undefined);
  let templateMenuBtnEl = $state<HTMLButtonElement | undefined>(undefined);

  // Image attachments
  const MAX_IMAGES = 5;
  let pendingImages = $state<ImageAttachment[]>([]);
  let lightboxSrc = $state<string | null>(null);

  // Model dropdown
  let showModelDropdown = $state(false);
  let modelDropdownTriggerEl = $state<HTMLElement | undefined>(undefined);
  let modelDropdownEl = $state<HTMLElement | undefined>(undefined);

  // Transcription panel / voice mode
  let showActionDrawer = $state(false);
  let showTranscription = $state(false);
  let actionDrawerEl = $state<HTMLDivElement | undefined>(undefined);
  let actionTriggerEl = $state<HTMLButtonElement | undefined>(undefined);

  // Voice mode integrated state
  type VoiceRecordingState = 'idle' | 'connecting' | 'recording' | 'stopping';
  type VoiceSourceMode = 'mic' | 'system' | 'mixed';
  type VoiceSessionMode = 'transcription' | 'interview';
  type VoiceInterviewRow =
    | { id: string; side: 'left'; speaker: string; text: string; timestamp: number }
    | { id: string; side: 'right'; text: string; timestamp: number; status: 'pending' | 'done' | 'failed' };

  let voiceRecordingState = $state<VoiceRecordingState>('idle');
  let voiceSessionId = $state<string | null>(null);
  let voiceSourceMode = $state<VoiceSourceMode>('mic');
  let voiceSessionMode = $state<VoiceSessionMode>('transcription');
  let voiceSourceOptions = $derived([
    { value: 'mic', label: $t('transcription.source_mic') },
    { value: 'system', label: $t('transcription.source_system') },
    { value: 'mixed', label: $t('transcription.source_mixed') },
  ]);
  let voiceSessionModeOptions = $derived([
    { value: 'transcription', label: $t('transcription.mode_transcription') },
    { value: 'interview', label: $t('transcription.mode_interview') },
  ]);
  let voiceElapsedMs = $state(0);
  let voiceStartTime = 0;
  let voiceTimerRef: ReturnType<typeof setInterval> | null = null;
  let voiceError = $state<string | null>(null);
  // Voice transcription segments (both modes)
  let voiceSegments = $state<TranscriptSegment[]>([]);
  // Interview mode rows (left = question, right = AI answer)
  let voiceInterviewRows = $state<VoiceInterviewRow[]>([]);
  let voiceInterviewBusy = $state(false);
  let voiceInterviewCursor = $state(0);
  let voiceInterviewPendingContext = $state('');
  let voiceInterviewLastQuestionKey = $state('');
  let voiceSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  const voiceSpeakerColorMap = new Map<string, string>();

  // Interview mode constants (mirrors TranscriptionPanel)
  const VOICE_SPEAKER_COLORS = [
    '#4A90E2', '#7ED321', '#D0021B', '#F5A623', '#9013FE',
    '#50E3C2', '#B8E986', '#FF6B6B', '#4ECDC4', '#C7B42C',
  ];
  const INTERVIEW_SILENCE_MS = 3000;
  const INTERVIEW_MIN_DELTA_CHARS = 4;
  const INTERVIEW_MIN_SEGMENT_CHARS = 4;
  const INTERVIEW_MIN_CONFIDENCE = 0.55;
  const INTERVIEW_MAX_BUFFER_CHARS = 900;
  const INTERVIEW_CONTEXT_WINDOW_CHARS = 520;
  const INTERVIEW_QUESTION_WINDOW_CHARS = 220;
  const INTERVIEW_QUESTION_CUE_RE = /[?？]|(什么|为何|为什么|怎么|如何|请问|是否|能否|可否|哪(里|个|些)?|多少|几|吗|呢|么|原理|区别|步骤|原因|方案|怎么做|介绍(?:一下|下)?|讲(?:一下|下)?|说(?:一下|下)?|请解释|帮我|给我|总结|分析)|\b(what|why|how|when|where|which|who|whom|whose|can|could|would|should|is|are|do|does|did|explain|tell me|walk me through|compare)\b/i;
  const INTERVIEW_FILLER_ONLY_RE = /^(嗯+|呃+|啊+|额+|噢+|哦+|唉+|呀+|诶+|uh+|um+|er+|ah+|eh+|hmm+|mm+)([，。！？?!、~…\s]*)$/i;

  // Inline voice-to-text (input bar)
  let inlineRecordingState = $state<'idle' | 'recording'>('idle');
  let inlineSessionId = $state<string | null>(null);
  let inlineCommittedTexts = $state<string[]>([]);
  let inlineInterimText = $state('');

  // Inline recording frequency visualization (non-reactive refs)
  let _vizStream: MediaStream | null = null;
  let _vizCtx: AudioContext | null = null;
  let _vizRafId: number | null = null;
  let _vizLastSample = 0;
  const VIZ_COLS = 60;
  let vizHistory = $state<number[]>(new Array(VIZ_COLS).fill(0));

  // MORAYA.md indicator
  let morayaMdActive = $state(false);
  let rulesSectionCount = $state(0);
  let folderPath = $state<string | null>(null);

  // Active speech config for inline voice input
  let speechConfig = $derived.by((): SpeechProviderConfig | null => {
    const s = $settingsStore;
    if (!s.activeSpeechConfigId || !s.speechProviderConfigs?.length) return null;
    return s.speechProviderConfigs.find(c => c.id === s.activeSpeechConfigId) ?? null;
  });
  let voiceProfiles = $derived($settingsStore.voiceProfiles ?? []);
  let imageConfigs = $derived<ImageProviderConfig[]>($settingsStore.imageProviderConfigs ?? []);
  let activeImageId = $derived($settingsStore.activeImageConfigId);
  let speechConfigs = $derived<SpeechProviderConfig[]>($settingsStore.speechProviderConfigs ?? []);
  let activeSpeechId = $derived($settingsStore.activeSpeechConfigId);

  let modelTriggerLabel = $derived.by((): string => {
    const parts: string[] = [];
    if (providerConfigs.length > 0) parts.push($t('ai.model_short.chat'));
    if (realtimeVoiceConfigs.length > 0) parts.push($t('ai.model_short.realtime'));
    if (imageConfigs.length > 0) parts.push($t('ai.model_short.image'));
    if (speechConfigs.length > 0) parts.push($t('ai.model_short.speech'));
    return parts.length > 0 ? parts.join(' · ') : $t('ai.model_short.none');
  });

  // Top-level store subscriptions — do NOT wrap in $effect().
  // In Svelte 5, $effect tracks reads inside subscribe callbacks, causing
  // infinite re-subscription loops when callbacks write to $state vars.
  let prevActiveKbId: string | null = null;
  const unsubFiles = filesStore.subscribe(state => {
    folderPath = state.openFolderPath;
    // Reload custom templates when active KB changes
    if (state.activeKnowledgeBaseId !== prevActiveKbId) {
      prevActiveKbId = state.activeKnowledgeBaseId ?? null;
      loadAllCustomTemplates().catch(e => console.warn('Failed to reload templates:', e));
    }
  });

  $effect(() => {
    const path = folderPath;
    if (!path) {
      morayaMdActive = false;
      rulesSectionCount = 0;
      return;
    }
    invoke<string>('read_file', { path: `${path}/MORAYA.md` })
      .then(content => {
        morayaMdActive = !!content?.trim();
        if (!morayaMdActive) { rulesSectionCount = 0; return; }
        return invoke<string>('read_file', { path: `${path}/.moraya/rules/_index.json` });
      })
      .then(indexJson => {
        if (indexJson) {
          try {
            const idx = JSON.parse(indexJson);
            rulesSectionCount = idx.count || 0;
          } catch { rulesSectionCount = 0; }
        }
      })
      .catch(() => {
        morayaMdActive = false;
        rulesSectionCount = 0;
      });
  });

  const unsubMcp = mcpStore.subscribe(state => {
    mcpToolCount = state.tools.length;
  });

  // ── Cached markdown rendering ──
  // Avoid expensive renderChatMarkdown re-computation on every Svelte render cycle.
  // Messages are immutable once stored, so we cache their rendered HTML by timestamp.
  const htmlCache = new Map<number, string>();

  function cachedHtml(msg: ChatMessage): string {
    const key = msg.timestamp;
    let cached = htmlCache.get(key);
    if (!cached) {
      cached = renderChatMarkdown(msg.content);
      htmlCache.set(key, cached);
    }
    return cached;
  }

  // Throttled streaming HTML: render at most every 150ms to keep the main thread free.
  let renderedStreamHtml = $state('');
  $effect(() => {

    const raw = streamingContent;
    if (!raw) {
      renderedStreamHtml = '';
      clearTimeout(streamRenderTimer);
      streamRenderTimer = undefined;
      return;
    }
    if (!streamRenderTimer) {
      // First chunk — render immediately for fast perceived response
      renderedStreamHtml = renderChatMarkdown(raw);
      streamRenderTimer = setTimeout(() => { streamRenderTimer = undefined; }, 150);
    } else {
      // Subsequent chunks — schedule throttled render
      clearTimeout(streamRenderTimer);
      streamRenderTimer = setTimeout(() => {
        streamRenderTimer = undefined;
        renderedStreamHtml = renderChatMarkdown(streamingContent);
      }, 150);
    }
  });

  // Resizable width — default to 33% of window, persisted to settings
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 800;
  function defaultPanelWidth(): number {
    return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth * 0.33)));
  }
  const savedWidth = settingsStore.getState().aiPanelWidth;
  let panelWidth = $state(
    savedWidth != null
      ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, savedWidth))
      : defaultPanelWidth()
  );
  let isResizing = $state(false);
  let resizeHoverVisible = $state(false);
  let resizeHoverTimer: ReturnType<typeof setTimeout> | undefined;

  function onResizeHandleEnter() { resizeHoverTimer = setTimeout(() => { resizeHoverVisible = true; }, 1000); }
  function onResizeHandleLeave() { clearTimeout(resizeHoverTimer); resizeHoverVisible = false; }

  let resizeRafId: number | undefined;

  function handleResizeStart(e: MouseEvent) {
    e.preventDefault();
    isResizing = true;
    const startX = e.clientX;
    const startWidth = panelWidth;

    function onMouseMove(ev: MouseEvent) {
      // RAF-throttle: coalesce rapid mousemove events into one update per frame
      // to prevent overwhelming Svelte reactivity + ProseMirror reflow.
      if (resizeRafId !== undefined) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = undefined;
        const isRtl = document.documentElement.dir === 'rtl';
        const delta = isRtl ? (ev.clientX - startX) : (startX - ev.clientX); // RTL: moving right = wider
        panelWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      });
    }

    function onMouseUp() {
      if (resizeRafId !== undefined) {
        cancelAnimationFrame(resizeRafId);
        resizeRafId = undefined;
      }
      isResizing = false;
      // Persist width to settings on drag end
      settingsStore.update({ aiPanelWidth: panelWidth });
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  // Expose panel width to titlebar for centering via CSS custom property.
  // Do NOT return a cleanup that removes it on each re-run — that causes
  // double layout invalidation per frame during resize.
  $effect(() => {

    document.documentElement.style.setProperty('--ai-panel-width', `${panelWidth}px`);
  });
  // Clean up on component destroy
  onDestroy(() => {
    if (inlineSessionId) {
      stopTranscription(inlineSessionId).catch(() => { /* ignore */ });
    }
    if (voiceSessionId) {
      stopTranscription(voiceSessionId).catch(() => { /* ignore */ });
    }
    stopVoiceTimer();
    if (voiceSilenceTimer) { clearTimeout(voiceSilenceTimer); voiceSilenceTimer = null; }
    if (isRealtimeVoiceActive || rtSessionId) {
      stopRealtimeVoiceSession();
    }
    unsubFiles();
    unsubMcp();
    unsubAI();
    document.documentElement.style.removeProperty('--ai-panel-width');
  });

  onMount(() => {
    // Load custom templates on mount
    loadAllCustomTemplates().catch(e => console.warn('Failed to load custom templates:', e));

    const handleGlobalPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (showModelDropdown) {
        if (!modelDropdownEl?.contains(target) && !modelDropdownTriggerEl?.contains(target)) {
          showModelDropdown = false;
        }
      }
      if (showTemplateMenu) {
        if (!templateMenuEl?.contains(target) && !templateMenuBtnEl?.contains(target)) {
          showTemplateMenu = false;
        }
      }
      if (!showActionDrawer) return;
      if (actionDrawerEl?.contains(target)) return;
      if (actionTriggerEl?.contains(target)) return;
      showActionDrawer = false;
    };

    document.addEventListener('pointerdown', handleGlobalPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleGlobalPointerDown, true);
    };
  });

  // Auto-scroll: track whether user is near bottom
  let userAtBottom = $state(true);

  // Top-level aiStore subscription — do NOT wrap in $effect().
  // In Svelte 5, $effect tracks reads inside subscribe callbacks (e.g. the
  // `chatMessages !== state.chatHistory` comparison reads $state `chatMessages`),
  // causing the effect to re-run on every write → infinite loop.
  const unsubAI = aiStore.subscribe(state => {
    if (chatMessages !== state.chatHistory) chatMessages = state.chatHistory;
    if (isLoading !== state.isLoading) isLoading = state.isLoading;
    if (error !== state.error) error = state.error;
    if (interrupted !== state.interrupted) interrupted = state.interrupted;
    if (streamingContent !== state.streamingContent) streamingContent = state.streamingContent;
    if (isConfigured !== state.isConfigured) isConfigured = state.isConfigured;
    if (providerConfigs !== state.providerConfigs) providerConfigs = state.providerConfigs;
    if (activeConfigId !== state.activeConfigId) activeConfigId = state.activeConfigId;
    if (realtimeVoiceConfigs !== state.realtimeVoiceConfigs) realtimeVoiceConfigs = state.realtimeVoiceConfigs;
    if (activeRealtimeVoiceConfigId !== state.activeRealtimeVoiceConfigId) activeRealtimeVoiceConfigId = state.activeRealtimeVoiceConfigId;
  });

  $effect(() => {
    if (!hasRealtimeConfig() && isRealtimeVoiceActive) {
      stopRealtimeVoiceSession();
    }
  });

  function handleModelSwitch(e: Event) {
    const val = (e.target as HTMLSelectElement).value;
    if (val.startsWith('rt:')) {
      aiStore.setActiveRealtimeVoiceConfig(val.slice(3));
    } else {
      aiStore.setActiveConfig(val);
    }
  }

  // Auto-scroll during streaming when user is at bottom (RAF-batched)
  $effect(() => {
    const _ = streamingContent;
    const _rt = rtCurrentResponse;
    const _ru = rtUserInterim;
    const _vs = voiceSegments.length;
    const _vr = voiceInterviewRows.length;
    const __ = chatMessages.length;
    if (userAtBottom && messagesEl) {
      if (scrollRaf) return; // skip if already pending
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = undefined;
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
  });

  function handleMessagesScroll() {
    if (!messagesEl) return;
    const threshold = 60;
    const { scrollTop, scrollHeight, clientHeight } = messagesEl;
    userAtBottom = scrollHeight - scrollTop - clientHeight < threshold;
  }

  function basename(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    return normalized.split('/').pop() || path;
  }

  async function addImageFromBlob(blob: Blob, fileName?: string) {
    if (pendingImages.length >= MAX_IMAGES) return;
    try {
      const { blob: processed, mimeType } = await compressImage(blob);
      const base64 = await blobToBase64(processed);
      const previewUrl = URL.createObjectURL(processed);
      pendingImages = [...pendingImages, {
        id: crypto.randomUUID(),
        mimeType,
        base64,
        previewUrl,
        fileName: fileName?.trim() || undefined,
      }];
    } catch (e) {
      console.error('[AI] Failed to process image:', e);
    }
  }

  async function addImageFromFile(filePath: string) {
    if (pendingImages.length >= MAX_IMAGES) return;
    try {
      const data = await readFile(filePath);
      if (!data || data.length === 0) return;
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
      };
      const mime = mimeMap[ext] || 'image/png';
      const blob = new Blob([data], { type: mime });
      await addImageFromBlob(blob, basename(filePath));
    } catch (e) {
      console.error('[AI] Failed to read image file:', e);
    }
  }

  function removeImage(id: string) {
    const img = pendingImages.find(i => i.id === id);
    if (img?.previewUrl) URL.revokeObjectURL(img.previewUrl);
    pendingImages = pendingImages.filter(i => i.id !== id);
  }

  async function handleAttachImage() {
    const result = await openDialog({
      multiple: true,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    for (const p of paths) {
      if (pendingImages.length >= MAX_IMAGES) break;
      await addImageFromFile(p);
    }
  }

  function handleInputPaste(e: ClipboardEvent) {
    if (!e.clipboardData) return;
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) addImageFromBlob(file, file.name);
        return;
      }
    }
  }

  function handleInputDrop(e: DragEvent) {
    e.preventDefault();
    if (!e.dataTransfer) return;
    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/') && pendingImages.length < MAX_IMAGES) {
        addImageFromBlob(files[i], files[i].name);
      }
    }
  }

  function handleInputDragOver(e: DragEvent) {
    e.preventDefault();
  }

  function getImageSrc(img: ImageAttachment): string {
    return img.previewUrl || `data:${img.mimeType};base64,${img.base64}`;
  }

  function getAttachmentDisplayName(img: ImageAttachment): string {
    if (img.fileName?.trim()) return img.fileName.trim();
    const ext = img.mimeType.split('/')[1] || 'img';
    return `image.${ext.replace('+xml', '')}`;
  }

  function openLightbox(img: ImageAttachment) {
    lightboxSrc = getImageSrc(img);
  }

  function closeLightbox() {
    lightboxSrc = null;
  }

  async function handleSend() {
    if ((!inputText.trim() && pendingImages.length === 0) || isLoading) return;
    const message = inputText.trim();
    const images = pendingImages.length > 0 ? [...pendingImages] : undefined;
    inputText = '';
    pendingImages = [];
    showCommands = false;
    userAtBottom = true;
    resetInputHeight();

    // /memorize — capture a long-term memory locally (no LLM round-trip).
    if (parseMemorizeCommand(message)) {
      aiStore.addMessage({ role: 'user', content: message, timestamp: Date.now() });
      try {
        await memorizeFromInput(message);
      } catch { /* store error — still acknowledge so the user isn't confused */ }
      aiStore.addMessage({ role: 'assistant', content: $t('memory.memorize_ack'), timestamp: Date.now() });
      return;
    }

    if (activeTemplate && (activeTemplate.flow === 'input' || activeTemplate.flow === 'parameterized')) {
      // Template input flow: build messages from template
      const content = latestContent();
      const resolved = resolveContent(activeTemplate, content, selectedText);
      const { systemPrompt, userMessage } = buildTemplateMessages(activeTemplate, {
        content: resolved.content,
        input: message,
        locale: navigator.language,
      });
      activeTemplate = null;
      inputPlaceholderOverride = null;
      aiStore.addMessage({ role: 'system', content: systemPrompt, timestamp: Date.now() });
      try {
        await sendChatMessage(userMessage, content, images);
      } catch { /* handled by store */ }
      return;
    }

    // Normal free chat
    try {
      await sendChatMessage(message, latestContent(), images);
    } catch {
      // Error is handled by store
    }
  }

  async function handleRetry() {
    if (isLoading) return;
    const lastMsg = aiStore.popLastUserMessage();
    if (!lastMsg) return;
    userAtBottom = true;
    try {
      await sendChatMessage(lastMsg.content, latestContent(), lastMsg.images);
    } catch {
      // Error is handled by store
    }
  }

  function hasDraftContent(): boolean {
    return !!inputText.trim() || pendingImages.length > 0;
  }

  function getPreferredRealtimeConfig(): RealtimeVoiceAIConfig | null {
    return realtimeVoiceConfigs.find(c => c.id === activeRealtimeVoiceConfigId)
      || realtimeVoiceConfigs[0]
      || null;
  }

  function hasRealtimeCredential(config: RealtimeVoiceAIConfig): boolean {
    if (config.provider === 'doubao-realtime') {
      return !!(config.appId?.trim() && config.apiKey?.trim());
    }
    const apiKey = (config.apiKey || '').trim();
    const ak = (config.accessKeyId || '').trim();
    const sk = (config.secretAccessKey || '').trim();
    return apiKey.length > 0 || (ak.length > 0 && sk.length > 0);
  }

  function hasRealtimeConfig(): boolean {
    return realtimeVoiceConfigs.length > 0;
  }

  function shouldShowWaveAction(): boolean {
    return !hasDraftContent() && hasRealtimeConfig();
  }

  function canShowInlineRecordButton(): boolean {
    return !!speechConfig;
  }

  function stopRealtimeVoiceSession() {
    isRealtimeVoiceActive = false;
    isRealtimeVoiceConnecting = false;
    // Commit any pending streaming response
    if (rtCurrentResponse.trim()) {
      chatMessages = [...chatMessages, {
        role: 'assistant',
        content: rtCurrentResponse,
        timestamp: Date.now(),
      }];
      rtCurrentResponse = '';
    }
    rtUserInterim = '';
    // Stop audio capture
    rtWorkletNode?.disconnect();
    rtWorkletNode = null;
    rtMediaStream?.getTracks().forEach(t => t.stop());
    rtMediaStream = null;
    rtAudioContext?.close().catch(() => {});
    rtAudioContext = null;
    rtOutputContext?.close().catch(() => {});
    rtOutputContext = null;
    rtNextPlayTime = 0;
    // Close backend session
    if (rtSessionId) {
      const sid = rtSessionId;
      rtSessionId = null;
      invoke('rt_dialogue_stop', { sessionId: sid }).catch(() => {});
    }
  }

  function handleRtDialogueEvent(event: RtDialogueEvent) {
    switch (event.type) {
      case 'error':
        aiStore.setError(event.error);
        stopRealtimeVoiceSession();
        break;
      case 'disconnected':
        if (isRealtimeVoiceActive) stopRealtimeVoiceSession();
        break;
      case 'message':
        parseRtServerMessage(event.data);
        break;
    }
  }

  function playRtAudioChunk(base64: string) {
    if (!rtOutputContext) {
      rtOutputContext = new AudioContext({ sampleRate: 24000 });
      rtNextPlayTime = rtOutputContext.currentTime;
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    if (int16.length === 0) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const buffer = rtOutputContext.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    const source = rtOutputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(rtOutputContext.destination);
    const now = rtOutputContext.currentTime;
    const startTime = Math.max(now, rtNextPlayTime);
    source.start(startTime);
    rtNextPlayTime = startTime + buffer.duration;
  }

  function parseRtServerMessage(data: string) {
    try {
      const msg = JSON.parse(data);
      // Binary audio from Doubao TTS
      if (msg.type === 'binary' && msg.data) {
        playRtAudioChunk(msg.data);
        return;
      }

      // Doubao binary-protocol events (wrapped by Rust with doubaoEvent field)
      if (msg.doubaoEvent !== undefined) {
        const ev = msg.doubaoEvent as number;
        const payload = msg.payload || {};
        if (ev === 451) {
          // ASRResponse: interim or final user speech
          const result = payload.results?.[0];
          const text: string = result?.text || '';
          if (result?.is_interim) {
            rtUserInterim = text;
          } else {
            // Final ASR result — commit as user message
            const committed = text || rtUserInterim;
            if (committed.trim()) {
              chatMessages = [...chatMessages, {
                role: 'user',
                content: committed,
                timestamp: Date.now(),
              }];
            }
            rtUserInterim = '';
          }
        } else if (ev === 459) {
          // ASREnded: user turn finished; commit interim if still pending
          if (rtUserInterim.trim()) {
            chatMessages = [...chatMessages, {
              role: 'user',
              content: rtUserInterim,
              timestamp: Date.now(),
            }];
            rtUserInterim = '';
          }
        } else if (ev === 550) {
          // ChatResponse: streaming AI text
          const content: string = payload.content || '';
          if (content) rtCurrentResponse += content;
        } else if (ev === 559) {
          // ChatEnded: AI turn finished
          if (rtCurrentResponse.trim()) {
            chatMessages = [...chatMessages, {
              role: 'assistant',
              content: rtCurrentResponse,
              timestamp: Date.now(),
            }];
            rtCurrentResponse = '';
          }
        }
        return;
      }

      const t = msg.type || msg.event || '';
      // Text delta (OpenAI-style)
      if (t === 'response.text.delta' || t === 'response.audio_transcript.delta') {
        const delta = msg.delta || msg.text || '';
        if (delta) rtCurrentResponse += delta;
      } else if (t === 'response.done' || t === 'response.text.done') {
        if (rtCurrentResponse.trim()) {
          chatMessages = [...chatMessages, {
            role: 'assistant',
            content: rtCurrentResponse,
            timestamp: Date.now(),
          }];
          rtCurrentResponse = '';
        }
      } else if (t === 'error') {
        const errMsg = msg.error?.message || msg.message || 'Realtime dialogue error';
        aiStore.setError(errMsg);
        stopRealtimeVoiceSession();
      }
    } catch { /* ignore non-JSON messages */ }
  }

  async function sendRtAudioChunk(sessionId: string, data: ArrayBuffer) {
    const bytes = new Uint8Array(data);
    const PAGE = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += PAGE) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + PAGE) as unknown as number[]);
    }
    await invoke('rt_dialogue_send_audio', { sessionId, audioB64: btoa(binary) });
  }

  async function startRtAudioCapture(sessionId: string) {
    try {
      rtMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rtAudioContext = new AudioContext({ sampleRate: 16000 });
      await rtAudioContext.audioWorklet.addModule(new URL('../../services/voice/pcm-worklet.js', import.meta.url));
      const source = rtAudioContext.createMediaStreamSource(rtMediaStream);
      rtWorkletNode = new AudioWorkletNode(rtAudioContext, 'pcm-sender');
      source.connect(rtWorkletNode);
      let sending = false;
      rtWorkletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (sending || !rtSessionId) return;
        sending = true;
        sendRtAudioChunk(sessionId, e.data)
          .catch(() => {})
          .finally(() => { sending = false; });
      };
    } catch (e) {
      // Mic access denied — continue without audio
      console.warn('[RT Dialogue] Mic capture failed:', e);
    }
  }

  async function startRealtimeVoiceSession() {
    if (isRealtimeVoiceActive || isRealtimeVoiceConnecting) return;
    const cfg = getPreferredRealtimeConfig();
    if (!cfg) {
      aiStore.setError($t('ai.realtime.missing_config'));
      return;
    }
    if (!hasRealtimeCredential(cfg)) {
      aiStore.setError($t('ai.realtime.config.missing_credential'));
      return;
    }
    showActionDrawer = false;
    isRealtimeVoiceConnecting = true;

    const baseUrl = cfg.baseUrl || REALTIME_VOICE_BASE_URLS[cfg.provider] || '';
    const channel = new Channel<RtDialogueEvent>();
    channel.onmessage = handleRtDialogueEvent;

    try {
      const sessionId = await invoke<string>('rt_dialogue_start', {
        configId: cfg.id,
        provider: cfg.provider,
        baseUrl,
        model: cfg.model,
        resourceId: null,
        onEvent: channel,
      });
      rtSessionId = sessionId;
      isRealtimeVoiceActive = true;
      isRealtimeVoiceConnecting = false;

      // Send provider-specific session initialization
      const initMsg = buildRtSessionInit(cfg);
      if (initMsg) {
        await invoke('rt_dialogue_send_text', { sessionId, data: initMsg });
      }

      // Start microphone audio capture
      await startRtAudioCapture(sessionId);
    } catch (e) {
      aiStore.setError(e instanceof Error ? e.message : String(e));
      isRealtimeVoiceConnecting = false;
    }
  }

  function buildRtSessionInit(cfg: RealtimeVoiceAIConfig): string | null {
    const base = {
      modalities: ['text', 'audio'],
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      turn_detection: { type: 'server_vad', silence_duration_ms: 500, threshold: 0.5 },
    };
    switch (cfg.provider) {
      case 'doubao-realtime':
        // Session init handled by Rust backend (binary protocol handshake)
        return null;
      case 'openai-realtime':
        return JSON.stringify({ type: 'session.update', session: { ...base, model: cfg.model } });
      case 'qwen-realtime':
      case 'stepfun-realtime':
        return JSON.stringify({ type: 'session.update', session: { ...base, model: cfg.model } });
      default:
        return null;
    }
  }

  async function handlePrimaryAction() {
    if (isLoading) {
      abortAIRequest();
      return;
    }
    if (shouldShowWaveAction()) {
      await startRealtimeVoiceSession();
      return;
    }
    await handleSend();
  }

  function buildInlineTranscript(includeInterim = false): string {
    const rows = [...inlineCommittedTexts];
    if (includeInterim && inlineInterimText.trim()) rows.push(inlineInterimText.trim());
    return rows.join('\n');
  }

  async function startVizAnalyser() {
    try {
      _vizStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _vizCtx = new AudioContext();
      const analyser = _vizCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      _vizCtx.createMediaStreamSource(_vizStream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      _vizLastSample = 0;
      const NOISE_FLOOR = 0.08;
      function tick() {
        const now = performance.now();
        if (now - _vizLastSample >= 400) {
          _vizLastSample = now;
          analyser.getByteFrequencyData(buf);
          // Average mid-range frequency magnitudes (0-255 → 0-1)
          const slice = buf.slice(2, 40);
          const avg = slice.reduce((a, b) => a + b, 0) / slice.length / 255;
          // Noise gate: zero out ambient noise below floor
          vizHistory = [...vizHistory.slice(1), avg > NOISE_FLOOR ? avg : 0];
        }
        _vizRafId = requestAnimationFrame(tick);
      }
      _vizRafId = requestAnimationFrame(tick);
    } catch { /* visualization is non-critical */ }
  }

  function stopVizAnalyser() {
    if (_vizRafId !== null) { cancelAnimationFrame(_vizRafId); _vizRafId = null; }
    _vizStream?.getTracks().forEach(t => t.stop());
    _vizStream = null;
    _vizCtx?.close().catch(() => {});
    _vizCtx = null;
    vizHistory = new Array(VIZ_COLS).fill(0);
  }

  function resetInlineRecordingState() {
    stopVizAnalyser();
    inlineRecordingState = 'idle';
    inlineSessionId = null;
    inlineCommittedTexts = [];
    inlineInterimText = '';
  }

  function insertTranscriptAtCursor(text: string) {
    const normalized = text.trim();
    if (!normalized) return;

    if (!inputEl) {
      inputText = inputText ? `${inputText}\n${normalized}` : normalized;
      autoResizeInput();
      return;
    }

    const start = inputEl.selectionStart ?? inputText.length;
    const end = inputEl.selectionEnd ?? inputText.length;
    inputText = inputText.slice(0, start) + normalized + inputText.slice(end);

    const caretPos = start + normalized.length;
    requestAnimationFrame(() => {
      if (!inputEl) return;
      inputEl.focus();
      inputEl.setSelectionRange(caretPos, caretPos);
      autoResizeInput();
    });
  }

  async function startInlineRecording() {
    if (inlineRecordingState === 'recording') return;
    if (!speechConfig) {
      aiStore.setError($t('transcription.no_speech_config'));
      onOpenVoiceSettings?.();
      return;
    }

    inlineRecordingState = 'recording';
    inlineCommittedTexts = [];
    inlineInterimText = '';
    startVizAnalyser();

    try {
      const sid = await startTranscription(
        speechConfig,
        voiceProfiles,
        (seg: TranscriptSegment) => {
          const line = seg.text.trim();
          if (!line) return;
          if (seg.isFinal) {
            inlineCommittedTexts = [...inlineCommittedTexts, line];
            inlineInterimText = '';
          } else {
            inlineInterimText = line;
          }
        },
        (msg) => {
          aiStore.setError(msg);
          resetInlineRecordingState();
        },
        { sourceMode: 'mic' },
      );
      inlineSessionId = sid;
    } catch (e) {
      aiStore.setError(e instanceof Error ? e.message : String(e));
      resetInlineRecordingState();
    }
  }

  async function stopInlineRecordingSession(): Promise<string> {
    if (!inlineSessionId) return buildInlineTranscript(true);
    const sid = inlineSessionId;
    inlineSessionId = null;
    try {
      const { segments: finalSegments } = await stopTranscription(sid);
      if (finalSegments.length > 0) {
        return finalSegments
          .map(seg => seg.text.trim())
          .filter(Boolean)
          .join('\n');
      }
      return buildInlineTranscript(true);
    } catch {
      return buildInlineTranscript(true);
    }
  }

  async function cancelInlineRecording() {
    await stopInlineRecordingSession();
    resetInlineRecordingState();
  }

  async function commitInlineRecording() {
    const transcript = await stopInlineRecordingSession();
    resetInlineRecordingState();
    if (transcript.trim()) insertTranscriptAtCursor(transcript);
  }

  async function handleTemplateSelect(template: AITemplate) {
    showCommands = false;

    // Resolve content for flows that need it
    const content = latestContent();
    const resolved = resolveContent(template, content, selectedText);
    if (resolved.error && template.contentSource !== 'none') {
      aiStore.setError($t(resolved.error));
      return;
    }

    switch (template.flow) {
      case 'auto':
      case 'interactive': {
        // Execute immediately
        const { systemPrompt, userMessage } = buildTemplateMessages(template, {
          content: resolved.content,
          locale: navigator.language,
        });
        activeTemplate = null;
        showParamPanel = false;
        inputPlaceholderOverride = null;
        userAtBottom = true;
        aiStore.addMessage({ role: 'system', content: systemPrompt, timestamp: Date.now() });
        try {
          await sendChatMessage(userMessage, content);
        } catch { /* handled by store */ }
        break;
      }
      case 'input': {
        // Switch to input mode with custom placeholder
        activeTemplate = template;
        showParamPanel = false;
        inputPlaceholderOverride = template.inputHint ?? (template.inputHintKey ? $t(template.inputHintKey) : null);
        inputEl?.focus();
        break;
      }
      case 'selection':
      case 'parameterized': {
        // Show parameter panel
        activeTemplate = template;
        showParamPanel = true;
        inputPlaceholderOverride = null;
        break;
      }
    }
  }

  async function handleParamExecute(params: Record<string, string>, input: string) {
    if (!activeTemplate) return;

    showParamPanel = false;
    userAtBottom = true;

    const content = latestContent();
    const resolved = resolveContent(activeTemplate, content, selectedText);
    if (resolved.error && activeTemplate.contentSource !== 'none') {
      aiStore.setError($t(resolved.error));
      activeTemplate = null;
      return;
    }

    // Build paramLabels for interpolation
    const paramLabels: Record<string, string> = {};
    for (const p of activeTemplate.params ?? []) {
      const selectedOption = p.options.find(o => o.value === params[p.key]);
      if (selectedOption) paramLabels[p.key] = selectedOption.label ?? (selectedOption.labelKey ? $t(selectedOption.labelKey) : selectedOption.value);
    }

    const { systemPrompt, userMessage } = buildTemplateMessages(activeTemplate, {
      content: resolved.content,
      input,
      params,
      paramLabels,
      locale: navigator.language,
    });

    activeTemplate = null;
    inputPlaceholderOverride = null;
    aiStore.addMessage({ role: 'system', content: systemPrompt, timestamp: Date.now() });
    try {
      await sendChatMessage(userMessage, content);
    } catch { /* handled by store */ }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (inlineRecordingState === 'recording') return;
    // Enter behavior is user-configurable (Settings → Shortcuts).
    //  - `modEnterSend` (default): Cmd/Ctrl+Enter sends, Enter = newline.
    //  - `enterSend`:               Enter sends, Shift+Enter = newline.
    // Either way the user can still press the alternate combo to insert
    // a newline, so multi-line composition stays possible in both modes.
    if (event.key === 'Enter') {
      const behavior = $settingsStore.aiChatEnterBehavior ?? 'modEnterSend';
      const isMod = event.ctrlKey || event.metaKey;
      if (behavior === 'enterSend') {
        // Send on plain Enter; Shift+Enter falls through to default newline.
        if (!event.shiftKey && !isMod) {
          event.preventDefault();
          handleSend();
        }
      } else {
        // modEnterSend: Cmd/Ctrl+Enter sends; Enter falls through to newline.
        if (isMod) {
          event.preventDefault();
          handleSend();
        }
      }
    }
    if (event.key === '/' && inputText === '') {
      showCommands = true;
    }
    // `@` on an empty input recalls a saved prompt asset into the message.
    if (event.key === '@' && inputText === '') {
      showPromptRecall = true;
    }
    if (event.key === 'Escape') {
      if (isLoading) {
        abortAIRequest();
      }
      if (activeTemplate) {
        activeTemplate = null;
        showParamPanel = false;
        inputPlaceholderOverride = null;
      }
      showCommands = false;
    }
  }

  function handleInsert(content: string) {
    onInsert?.(content);
  }

  function handleReplace(content: string) {
    onReplace?.(content);
  }

  // ── Voice mode helper functions ─────────────────────────────────────────────

  function getVoiceSpeakerColor(displayName: string): string {
    if (!voiceSpeakerColorMap.has(displayName)) {
      voiceSpeakerColorMap.set(displayName, VOICE_SPEAKER_COLORS[voiceSpeakerColorMap.size % VOICE_SPEAKER_COLORS.length]);
    }
    return voiceSpeakerColorMap.get(displayName)!;
  }

  function formatVoiceSegmentTime(ms: number): string {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function voiceLineKey(text: string): string {
    return text.toLowerCase().replace(/[\s\.,!?，。！？:：;；'"`~\-_/\\()[\]{}<>]/g, '');
  }

  function sanitizeVoiceInterviewLine(text: string): string {
    return text
      .replace(/^[\s【\[]?(?:speaker\s*\d+|说话人\s*\d+|路人\d*|passerby\d*|unknown|user|assistant|ai|面试官|候选人)\s*[:：]\s*/i, '')
      .replace(/\s+/g, ' ')
      .replace(/([，。！？?!])\1+/g, '$1')
      .trim();
  }

  function isVoiceNoiseLine(line: string, confidence: number, hasReliableConfidence: boolean): boolean {
    if (!line) return true;
    if (line.length < INTERVIEW_MIN_SEGMENT_CHARS) return true;
    if (INTERVIEW_FILLER_ONLY_RE.test(line)) return true;
    if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(line)) return true;
    if (hasReliableConfidence && Number.isFinite(confidence) && confidence < INTERVIEW_MIN_CONFIDENCE) return true;
    const compact = line.replace(/\s+/g, '');
    if (compact.length >= 6 && new Set(compact.toLowerCase()).size <= 2) return true;
    return false;
  }

  function appendVoiceInterviewBuffer(deltaText: string) {
    if (!deltaText.trim()) return;
    const next = voiceInterviewPendingContext ? `${voiceInterviewPendingContext}\n${deltaText}` : deltaText;
    voiceInterviewPendingContext = next.length > INTERVIEW_MAX_BUFFER_CHARS ? next.slice(-INTERVIEW_MAX_BUFFER_CHARS) : next;
  }

  function extractVoiceInterviewQuestion(buffer: string): { focus: string; support: string } | null {
    const normalized = buffer.trim();
    if (!normalized) return null;
    const parts = normalized.split(/[\n。！？?!]/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const candidates = parts.filter(part => INTERVIEW_QUESTION_CUE_RE.test(part));
    const focusRaw = (candidates.length > 0 ? candidates.slice(-2).join('；') : parts[parts.length - 1]).trim();
    if (!focusRaw) return null;
    const fallbackFocus = parts.slice(-2).join('；').trim() || parts[parts.length - 1];
    return {
      focus: (focusRaw || fallbackFocus).slice(-INTERVIEW_QUESTION_WINDOW_CHARS),
      support: normalized.slice(-INTERVIEW_CONTEXT_WINDOW_CHARS),
    };
  }

  function voiceQuestionSignature(text: string): string {
    return voiceLineKey(text).slice(-160);
  }

  function clearVoiceSilenceTimer() {
    if (voiceSilenceTimer) { clearTimeout(voiceSilenceTimer); voiceSilenceTimer = null; }
  }

  function resetVoiceInterviewContext(cursorAtEnd = false) {
    voiceInterviewRows = [];
    clearVoiceSilenceTimer();
    voiceInterviewBusy = false;
    voiceInterviewPendingContext = '';
    voiceInterviewLastQuestionKey = '';
    const finals = voiceSegments.filter(seg => seg.isFinal);
    voiceInterviewCursor = cursorAtEnd ? finals.length : 0;
  }

  function scheduleVoiceInterviewAnswer() {
    if (voiceSessionMode !== 'interview' || voiceRecordingState === 'idle' || voiceRecordingState === 'connecting') return;
    clearVoiceSilenceTimer();
    voiceSilenceTimer = setTimeout(() => {
      triggerVoiceInterviewAnswer().catch((e) => console.error('[Voice Interview] trigger failed:', e));
    }, INTERVIEW_SILENCE_MS);
  }

  async function requestVoiceInterviewAnswer(questionFocus: string, supportContext: string): Promise<string> {
    const active = aiStore.getActiveConfig();
    if (!active || !active.apiKey) throw new Error($t('transcription.interview_no_aiconfig'));
    const maxTokens = Math.min($settingsStore.aiMaxTokens || active.maxTokens || 1024, 768);
    const config = { ...active, maxTokens, temperature: Math.min(active.temperature ?? 0.2, 0.3) };
    const now = Date.now();
    const response = await sendAIRequest(config, {
      messages: [
        {
          role: 'system',
          content: 'You are an interview copilot. Every request is the latest transcript delta captured after about 3 seconds of silence. Treat it as the newest interview turn and answer directly even if the wording is incomplete. The ASR transcript may contain recognition errors; infer likely intent and avoid overfitting to noisy words. Focus on the core question first, then give a concise practical answer in Markdown bullet points.',
          timestamp: now,
        },
        {
          role: 'user',
          content: `Question focus:\n${questionFocus}\n\nRecent transcript snippets (may contain ASR mistakes):\n${supportContext}\n\nPlease output:\n1) Direct answer first.\n2) If key terms may be misrecognized, list 1-2 likely corrected terms.\n3) Keep total length under 8 bullets.`,
          timestamp: now + 1,
        },
      ],
    });
    const text = response.content?.trim();
    if (!text) throw new Error($t('transcription.interview_empty_answer'));
    return text;
  }

  async function triggerVoiceInterviewAnswer() {
    if (voiceSessionMode !== 'interview' || voiceInterviewBusy) return;
    const finals = voiceSegments.filter(seg => seg.isFinal);
    if (finals.length <= voiceInterviewCursor) return;
    const deltaSegs = finals.slice(voiceInterviewCursor);
    voiceInterviewCursor = finals.length;
    const hasReliableConfidence = deltaSegs.some(seg => Number.isFinite(seg.confidence) && seg.confidence > 0.05);
    const cleanedLines: string[] = [];
    let lastLineKey = '';
    for (const seg of deltaSegs) {
      const line = sanitizeVoiceInterviewLine(seg.text);
      if (isVoiceNoiseLine(line, seg.confidence, hasReliableConfidence)) continue;
      const key = voiceLineKey(line);
      if (!key || key === lastLineKey) continue;
      lastLineKey = key;
      cleanedLines.push(line);
    }
    if (cleanedLines.length === 0) return;
    appendVoiceInterviewBuffer(cleanedLines.join('\n'));
    if (voiceInterviewPendingContext.length < INTERVIEW_MIN_DELTA_CHARS) return;
    const extracted = extractVoiceInterviewQuestion(voiceInterviewPendingContext);
    if (!extracted) return;
    const questionKey = voiceQuestionSignature(extracted.focus);
    if (questionKey && questionKey === voiceInterviewLastQuestionKey) { voiceInterviewPendingContext = ''; return; }
    voiceInterviewLastQuestionKey = questionKey;
    const rowId = crypto.randomUUID();
    const pendingSnapshot = voiceInterviewPendingContext;
    voiceInterviewPendingContext = '';
    voiceInterviewRows = [
      ...voiceInterviewRows,
      { id: rowId, side: 'right', text: $t('transcription.interview_answer_pending'), timestamp: Date.now(), status: 'pending' },
    ];
    voiceInterviewBusy = true;
    try {
      const answer = await requestVoiceInterviewAnswer(extracted.focus, extracted.support);
      voiceInterviewRows = voiceInterviewRows.map(row =>
        row.id === rowId && row.side === 'right' ? { ...row, text: answer, status: 'done' as const } : row,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : $t('transcription.interview_answer_failed');
      voiceInterviewPendingContext = pendingSnapshot.length > INTERVIEW_MAX_BUFFER_CHARS
        ? pendingSnapshot.slice(-INTERVIEW_MAX_BUFFER_CHARS) : pendingSnapshot;
      voiceInterviewRows = voiceInterviewRows.map(row =>
        row.id === rowId && row.side === 'right' ? { ...row, text: msg, status: 'failed' as const } : row,
      );
    } finally {
      voiceInterviewBusy = false;
    }
  }

  // ── Voice mode recording functions ─────────────────────────────────────────

  async function startVoiceRecording() {
    if (!speechConfig) {
      aiStore.setError($t('transcription.no_speech_config'));
      return;
    }
    voiceRecordingState = 'connecting';
    voiceError = null;
    voiceSegments = [];
    voiceInterviewRows = [];
    voiceSpeakerColorMap.clear();
    resetVoiceInterviewContext(false);

    try {
      const sid = await startTranscription(
        speechConfig,
        voiceProfiles,
        (seg: TranscriptSegment) => {
          // Same merge logic as TranscriptionPanel
          if (voiceSegments.length > 0) {
            const last = voiceSegments[voiceSegments.length - 1];
            if (!last.isFinal && last.speakerId === seg.speakerId) {
              voiceSegments = [...voiceSegments.slice(0, -1), seg];
            } else {
              voiceSegments = [...voiceSegments, seg];
            }
          } else {
            voiceSegments = [...voiceSegments, seg];
          }
          // Interview mode: add final segments as left rows and schedule AI answer
          if (voiceSessionMode === 'interview' && seg.isFinal) {
            voiceInterviewRows = [
              ...voiceInterviewRows,
              { id: crypto.randomUUID(), side: 'left', speaker: seg.displayName, text: seg.text, timestamp: Date.now() },
            ];
            scheduleVoiceInterviewAnswer();
          }
        },
        (msg: string) => {
          voiceError = msg;
          voiceSessionId = null;
          voiceRecordingState = 'idle';
          stopVoiceTimer();
          clearVoiceSilenceTimer();
        },
        { sourceMode: voiceSourceMode },
      );
      if (voiceRecordingState !== 'connecting') return;
      voiceSessionId = sid;
      voiceRecordingState = 'recording';
      voiceElapsedMs = 0;
      voiceStartTime = Date.now();
      startVoiceTimer();
      startVizAnalyser();
    } catch (e: unknown) {
      voiceError = e instanceof Error ? e.message : String(e);
      voiceRecordingState = 'idle';
      clearVoiceSilenceTimer();
    }
  }

  async function stopVoiceRecording() {
    if (!voiceSessionId) return;
    const sid = voiceSessionId;
    voiceSessionId = null;
    voiceRecordingState = 'idle';
    stopVoiceTimer();
    stopVizAnalyser();
    clearVoiceSilenceTimer();
    await stopTranscription(sid).catch(() => {});
    // In interview mode, trigger a final answer for any buffered context
    if (voiceSessionMode === 'interview' && !voiceInterviewBusy) {
      triggerVoiceInterviewAnswer().catch(() => {});
    }
  }

  function startVoiceTimer() {
    voiceTimerRef = setInterval(() => {
      voiceElapsedMs = Date.now() - voiceStartTime;
    }, 1000);
  }

  function stopVoiceTimer() {
    if (voiceTimerRef) { clearInterval(voiceTimerRef); voiceTimerRef = null; }
  }

  async function toggleVoiceRecording() {
    if (voiceRecordingState === 'idle') {
      await startVoiceRecording();
    } else if (voiceRecordingState === 'recording') {
      await stopVoiceRecording();
    }
  }

  async function handleVoiceSourceChange(val: VoiceSourceMode) {
    voiceSourceMode = val;
    if (voiceRecordingState === 'recording') {
      await stopVoiceRecording();
      await startVoiceRecording();
    }
  }

  function exitVoiceMode() {
    stopVoiceRecording();
    clearVoiceSilenceTimer();
    showTranscription = false;
    voiceError = null;
    voiceElapsedMs = 0;
    voiceSegments = [];
    voiceInterviewRows = [];
    voiceInterviewBusy = false;
    voiceInterviewCursor = 0;
    voiceInterviewPendingContext = '';
    voiceInterviewLastQuestionKey = '';
    voiceSpeakerColorMap.clear();
  }

  async function handleVoiceSessionModeChange(next: VoiceSessionMode) {
    if (next === voiceSessionMode) return;
    voiceSessionMode = next;
    if (next === 'interview') {
      resetVoiceInterviewContext(true);
    } else {
      clearVoiceSilenceTimer();
    }
  }

  function formatVoiceElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Send a finished transcript to the LLM as a user message. */
  async function handleTranscriptionToAI(transcript: string) {
    showTranscription = false;
    if (transcript.trim()) {
      inputText = transcript;
      await handleSend();
    }
  }

  // ── Template Management ──

  async function handleImportTemplates() {
    showTemplateMenu = false;
    try {
      const result = await importTemplatesFromFile();
      if (result.imported > 0) {
        // Force gallery refresh
        console.info(`Imported ${result.imported} template(s)`);
      }
      if (result.errors.length > 0) {
        console.warn('Import errors:', result.errors);
      }
    } catch (e) {
      console.error('Template import failed:', e);
    }
  }

  async function handleExportTemplates() {
    showTemplateMenu = false;
    const allTpl = getAllTemplates();
    if (allTpl.length === 0) return;
    try {
      await exportTemplates(allTpl);
    } catch (e) {
      console.error('Template export failed:', e);
    }
  }

  function handleManageTemplates() {
    showTemplateMenu = false;
    showManagePanel = true;
  }

  function clearChat() {
    // Revoke pending image blob URLs
    for (const img of pendingImages) {
      if (img.previewUrl) URL.revokeObjectURL(img.previewUrl);
    }
    pendingImages = [];
    aiStore.clearHistory();
    htmlCache.clear();
    activeTemplate = null;
    showParamPanel = false;
    inputPlaceholderOverride = null;
  }

  function handleInput() {
    autoResizeInput();
    if (showCommands && !inputText.startsWith('/')) {
      showCommands = false;
    }
  }

  function autoResizeInput() {
    if (!inputEl) return;
    if (resizeRaf) return; // RAF-throttle to avoid sync reflow per keystroke
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = undefined;
      if (!inputEl) return;
      inputEl.style.height = 'auto';
      const scrollH = inputEl.scrollHeight;
      inputEl.style.height = Math.min(scrollH, maxInputHeight) + 'px';
      inputEl.style.overflowY = scrollH > maxInputHeight ? 'auto' : 'hidden';
    });
  }

  function resetInputHeight() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.overflowY = 'hidden';
  }

  // Compute max height for 7 lines based on line-height
  const lineHeight = 1.4; // matches CSS line-height
  const fontSize = 14; // --font-size-sm approx
  const paddingY = 16; // 0.5rem * 2
  const maxInputHeight = Math.round(fontSize * lineHeight * 7 + paddingY);

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Intercept link clicks in rendered markdown — open in external browser */
  function handleContentClick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor) {
      e.preventDefault();
      const href = anchor.getAttribute('href');
      if (href) openUrl(href);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ai-panel no-select" class:resizing={isResizing} style="width:{panelWidth}px">
  <div class="resize-handle" class:hover-visible={resizeHoverVisible} onmousedown={handleResizeStart} onmouseenter={onResizeHandleEnter} onmouseleave={onResizeHandleLeave}>
    {#if isResizing}
      <span class="width-indicator">{panelWidth}</span>
    {/if}
  </div>
  <div class="ai-header">
    <div class="ai-header-left">
      <span class="ai-title">{$t('ai.title')}</span>
      <div class="model-dropdown-wrap">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            class="model-dropdown-trigger"
            class:model-trigger-empty={providerConfigs.length + realtimeVoiceConfigs.length + imageConfigs.length + speechConfigs.length === 0}
            bind:this={modelDropdownTriggerEl}
            onclick={() => showModelDropdown = !showModelDropdown}
          >
            <span class="model-trigger-text">{modelTriggerLabel}</span>
            <svg width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true" style="flex-shrink:0;opacity:0.5">
              <path d={showModelDropdown ? 'M7 4L4 1 1 4' : 'M1 1l3 3 3-3'} stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          {#if showModelDropdown}
            <div class="model-dropdown-panel" bind:this={modelDropdownEl}>
              {#if providerConfigs.length > 0}
                <div class="model-group-label">{$t('ai.realtime.chat_model_group')}</div>
                {#each providerConfigs as cfg}
                  <button
                    class="model-dropdown-item"
                    onclick={() => { aiStore.setActiveConfig(cfg.id); showModelDropdown = false; }}
                  >
                    <span class="model-item-dot">{cfg.id === activeConfigId ? '•' : ''}</span>
                    <span class="model-item-name">{cfg.model || cfg.provider}</span>
                  </button>
                {/each}
              {/if}
              {#if realtimeVoiceConfigs.length > 0}
                <div class="model-group-divider"></div>
                <div class="model-group-label">{$t('ai.realtime.realtime_model_group')}</div>
                {#each realtimeVoiceConfigs as cfg}
                  <button
                    class="model-dropdown-item"
                    onclick={() => { aiStore.setActiveRealtimeVoiceConfig(cfg.id); showModelDropdown = false; }}
                  >
                    <span class="model-item-dot">{cfg.id === activeRealtimeVoiceConfigId ? '•' : ''}</span>
                    <span class="model-item-name">{cfg.model || cfg.provider}</span>
                  </button>
                {/each}
              {/if}
              {#if imageConfigs.length > 0}
                <div class="model-group-divider"></div>
                <div class="model-group-label">{$t('ai.realtime.image_model_group')}</div>
                {#each imageConfigs as cfg}
                  <button
                    class="model-dropdown-item"
                    onclick={() => { settingsStore.update({ activeImageConfigId: cfg.id }); showModelDropdown = false; }}
                  >
                    <span class="model-item-dot">{cfg.id === activeImageId ? '•' : ''}</span>
                    <span class="model-item-name">{cfg.model || cfg.provider}</span>
                  </button>
                {/each}
              {/if}
              {#if speechConfigs.length > 0}
                <div class="model-group-divider"></div>
                <div class="model-group-label">{$t('ai.realtime.speech_model_group')}</div>
                {#each speechConfigs as cfg}
                  <button
                    class="model-dropdown-item"
                    onclick={() => { settingsStore.update({ activeSpeechConfigId: cfg.id }); showModelDropdown = false; }}
                  >
                    <span class="model-item-dot">{cfg.id === activeSpeechId ? '•' : ''}</span>
                    <span class="model-item-name">{cfg.model || cfg.provider}</span>
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {#if mcpToolCount > 0}
        <span class="mcp-badge" title="{mcpToolCount} MCP tools available">{mcpToolCount} tools</span>
      {/if}
      {#if morayaMdActive}
        <span class="moraya-md-badge" title={$t('ai.rules_active')}>
          {rulesSectionCount > 0 ? `${rulesSectionCount} rules` : 'MORAYA.md'}
        </span>
      {/if}
    </div>
    {#if chatMessages.length === 0}
      <div class="template-menu-wrap">
        <button
          class="ai-btn"
          bind:this={templateMenuBtnEl}
          onclick={() => showTemplateMenu = !showTemplateMenu}
          title={$t('templates.manage.title')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <circle cx="7" cy="2.5" r="1.3"/>
            <circle cx="7" cy="7" r="1.3"/>
            <circle cx="7" cy="11.5" r="1.3"/>
          </svg>
        </button>
        {#if showTemplateMenu}
          <div class="template-menu-dropdown" bind:this={templateMenuEl}>
            <button class="template-menu-item" onclick={handleImportTemplates}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v7m-3-3l3 3 3-3M1 10h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
              <span>{$t('templates.manage.import')}</span>
            </button>
            <button class="template-menu-item" onclick={handleExportTemplates}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 8V1m-3 3l3-3 3 3M1 10h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
              <span>{$t('templates.manage.export')}</span>
            </button>
            <button class="template-menu-item" onclick={handleManageTemplates}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 3h10M1 6h10M1 9h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
              <span>{$t('templates.manage.manage')}</span>
            </button>
          </div>
        {/if}
      </div>
    {/if}
    {#if chatMessages.length > 0}
      <button class="ai-btn" onclick={clearChat} title={$t('ai.clear_chat')}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <path d="M4 1V0h6v1h4v2H0V1h4zm1 3h1v8H5V4zm3 0h1v8H8V4zM1 3h12l-1 11H2L1 3z"/>
        </svg>
      </button>
    {/if}
  </div>

  {#if showTranscription}
    <div class="voice-mode-bar">
      <div class="voice-mode-bar-controls">
        <label class="voice-top-field">
          <span class="voice-top-label">{$t('transcription.source_label')}</span>
          <Select
            class="voice-top-select"
            size="sm"
            bind:value={voiceSourceMode}
            options={voiceSourceOptions}
            onchange={(v) => handleVoiceSourceChange(v as VoiceSourceMode)}
            disabled={voiceRecordingState === 'connecting'}
          />
        </label>
        <label class="voice-top-field">
          <span class="voice-top-label">{$t('transcription.mode_label')}</span>
          <Select
            class="voice-top-select"
            size="sm"
            bind:value={voiceSessionMode}
            options={voiceSessionModeOptions}
            onchange={(v) => handleVoiceSessionModeChange(v as VoiceSessionMode)}
            disabled={voiceRecordingState === 'connecting'}
          />
        </label>
      </div>
      <div class="voice-mode-bar-right">
        {#if voiceRecordingState === 'recording'}
          <span class="voice-rec-dot"></span>
          <span class="voice-elapsed">{formatVoiceElapsed(voiceElapsedMs)}</span>
        {:else if voiceRecordingState === 'connecting'}
          <span class="voice-elapsed muted">{$t('transcription.connecting')}</span>
        {/if}
        <button class="ctrl-btn icon voice-back-btn" onclick={exitVoiceMode} title={$t('transcription.back')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
            <path d="M10 6H2M5 3L2 6l3 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  {/if}

  {#if !isConfigured}
    <div class="ai-unconfigured">
      <p>{$t('ai.unconfigured')}</p>
      <p class="hint">{$t('ai.unconfigured_hint', { shortcut: navigator.platform.includes('Mac') ? 'Cmd+,' : 'Ctrl+,' })}</p>
      {#if onOpenSettings}
        <button class="open-settings-btn" onclick={onOpenSettings}>{$t('ai.open_settings')}</button>
      {/if}
    </div>
  {:else}
    <div class="ai-messages" bind:this={messagesEl} onscroll={handleMessagesScroll}>
      {#if chatMessages.length === 0 && !isLoading && !showCommands && !isRealtimeVoiceActive && !isRealtimeVoiceConnecting && !showTranscription}
        {#if showManagePanel}
          <TemplateManagePanel onBack={() => showManagePanel = false} />
        {:else}
          <TemplateGallery onSelectTemplate={handleTemplateSelect} />
        {/if}
      {/if}

      {#each chatMessages as msg (msg.timestamp)}
        {#if msg.role === 'tool'}
          <div class="message tool-result">
            <div class="tool-header">
              <span class="tool-icon">&#9881;</span>
              <span class="tool-name">{msg.toolName}</span>
              {#if msg.isError}<span class="tool-error-badge">error</span>{/if}
            </div>
            <pre class="tool-output">{msg.content}</pre>
          </div>
        {:else if msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0}
          <div class="message assistant tool-calling">
            {#if msg.content}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="message-content" onclick={handleContentClick}>{@html cachedHtml(msg)}</div>
            {/if}
            {#each msg.toolCalls as tc}
              <details class="tool-call-block">
                <summary class="tool-call-summary">Calling: {tc.name}</summary>
                <pre class="tool-call-args">{JSON.stringify(tc.arguments, null, 2)}</pre>
              </details>
            {/each}
          </div>
        {:else if msg.role === 'system'}
          <!-- skip system messages in display -->
        {:else}
          <div class="message {msg.role}" class:notify-success={msg.isSuccess} class:notify-error={msg.isError}>
            <div class="message-header">
              <span class="message-role">{msg.role === 'user' ? $t('ai.you') : $t('ai.assistant')}</span>
            </div>
            {#if msg.role === 'assistant'}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="message-content" onclick={handleContentClick}>{@html cachedHtml(msg)}</div>
            {:else}
              {#if msg.images && msg.images.length > 0}
                <div class="message-images">
                  {#each msg.images as img (img.id)}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <img
                      src={getImageSrc(img)}
                      alt=""
                      class="message-image-thumb"
                      onclick={() => openLightbox(img)}
                    />
                  {/each}
                </div>
              {/if}
              {#if msg.content}
                <div class="message-content">{msg.content}</div>
              {/if}
            {/if}
            <span class="message-time">{formatTime(msg.timestamp)}</span>
            <div class="message-actions">
              {#if msg.role === 'assistant'}
                <button class="action-btn" onclick={() => handleInsert(msg.content)} title={$t('ai.insert_to_editor')}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M6 0v5H1v2h5v5h2V7h5V5H8V0H6z"/></svg>
                </button>
                {#if selectedText}
                  <button class="action-btn" onclick={() => handleReplace(msg.content)} title={$t('ai.replace_selection')}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M0 0h5v2H2v3H0V0zm12 12H7v-2h3V7h2v5zM8.5 3.5L5 7 3.5 5.5 2 7l3 3 5-5-1.5-1.5z"/></svg>
                  </button>
                {/if}
              {/if}
              <button class="action-btn" onclick={() => navigator.clipboard.writeText(msg.content)} title={$t('common.copy')}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M4 0h8v8h-2V2H4V0zM0 4h8v8H0V4zm2 2v4h4V6H2z"/></svg>
              </button>
            </div>
          </div>
        {/if}
      {/each}

      {#if isRealtimeVoiceActive && rtUserInterim}
        <div class="message user rt-interim">
          <div class="message-content">{rtUserInterim}</div>
        </div>
      {/if}

      {#if showTranscription}
        {#if voiceSessionMode === 'transcription'}
          <!-- Transcription mode: speaker-labeled segments in chat area -->
          {#if voiceSegments.length === 0 && voiceRecordingState !== 'idle'}
            <div class="voice-area-empty">{$t('transcription.empty_waiting')}</div>
          {/if}
          {#each voiceSegments as seg, i (i)}
            <div class="voice-segment" class:voice-interim={!seg.isFinal}>
              <div class="voice-segment-header">
                <span class="voice-speaker-dot" style="background: {getVoiceSpeakerColor(seg.displayName)}"></span>
                <span class="voice-speaker-name">{seg.displayName}</span>
                <span class="voice-segment-time">{formatVoiceSegmentTime(seg.startMs)}</span>
              </div>
              <p class="voice-segment-text">{seg.text}</p>
            </div>
          {/each}
        {:else}
          <!-- Interview mode: Q&A layout -->
          {#if voiceInterviewRows.length === 0 && voiceRecordingState !== 'idle'}
            <div class="voice-area-empty">{$t('transcription.empty_waiting')}</div>
          {/if}
          {#each voiceInterviewRows as row (row.id)}
            {#if row.side === 'left'}
              <div class="voice-segment voice-interview-q">
                <div class="voice-segment-header">
                  <span class="voice-speaker-dot" style="background: {getVoiceSpeakerColor(row.speaker)}"></span>
                  <span class="voice-speaker-name">{row.speaker}</span>
                </div>
                <p class="voice-segment-text">{row.text}</p>
              </div>
            {:else}
              <div class="voice-interview-a" class:failed={row.status === 'failed'} class:pending={row.status === 'pending'}>
                <div class="voice-interview-a-label">AI</div>
                <p class="voice-interview-a-text">{row.text}</p>
              </div>
            {/if}
          {/each}
        {/if}
        {#if voiceError}
          <div class="voice-error-banner">{voiceError}</div>
        {/if}
      {/if}

      {#if isRealtimeVoiceActive && rtCurrentResponse}
        <div class="message assistant streaming">
          <div class="message-header">
            <span class="message-role">{$t('ai.assistant')}</span>
          </div>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="message-content" onclick={handleContentClick}>{@html renderChatMarkdown(rtCurrentResponse)}</div>
          <span class="typing-indicator">{$t('ai.typing')}</span>
        </div>
      {/if}
      {#if isLoading && streamingContent}
        <div class="message assistant streaming">
          <div class="message-header">
            <span class="message-role">{$t('ai.assistant')}</span>
          </div>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="message-content" onclick={handleContentClick}>{@html renderedStreamHtml}</div>
          <span class="typing-indicator">{$t('ai.typing')}</span>
        </div>
      {:else if isLoading}
        <div class="message assistant">
          <div class="thinking">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </div>
        </div>
      {/if}

      {#if error}
        <div class="message error">
          <span class="error-text">{error}</span>
          <span class="message-time error-time">{formatTime(Date.now())}</span>
          <div class="message-actions">
            <button class="action-btn error-action" onclick={handleRetry} title={$t('ai.retry')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M10.25 6A4.25 4.25 0 1 1 6 1.75V0l3 2.5-3 2.5V3.25A2.75 2.75 0 1 0 8.75 6h1.5z"/></svg>
            </button>
            <button class="action-btn error-action" onclick={() => navigator.clipboard.writeText(error || '')} title={$t('common.copy')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M4 0h8v8h-2V2H4V0zM0 4h8v8H0V4zm2 2v4h4V6H2z"/></svg>
            </button>
          </div>
        </div>
      {/if}

      {#if interrupted}
        <div class="interrupted-indicator">
          <span>{$t('ai.interrupted')}</span>
        </div>
      {/if}
    </div>

    <div class="ai-input-area">
      {#if showActionDrawer}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="action-drawer" bind:this={actionDrawerEl} onclick={() => showActionDrawer = false}>
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <button
            class="drawer-item"
            onclick={(e) => { e.stopPropagation(); showTranscription = true; showActionDrawer = false; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" stroke-width="2"/>
              <path d="M6 11a6 6 0 0 0 12 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path d="M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path d="M8 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            {$t('ai.voice_transcription')}
          </button>
        </div>
      {/if}

      {#if showCommands}
        <div class="commands-dropdown">
          <TemplateGallery onSelectTemplate={handleTemplateSelect} />
        </div>
      {/if}

      {#if showPromptRecall}
        <PromptPalette
          onClose={() => (showPromptRecall = false)}
          onInsertToEditor={(text) => insertTranscriptAtCursor(text)}
        />
      {/if}

      {#if showParamPanel && activeTemplate}
        <div class="param-panel-wrapper">
          <TemplateParamPanel
            template={activeTemplate}
            onExecute={handleParamExecute}
            onCancel={() => { showParamPanel = false; activeTemplate = null; }}
          />
        </div>
      {/if}

      {#if activeTemplate && !showParamPanel}
        <div class="template-hint">
          <span class="template-hint-label">{activeTemplate.icon} {getTemplateName(activeTemplate, $t)}</span>
          <button class="template-hint-close" aria-label={$t('common.close')} onclick={() => { activeTemplate = null; inputPlaceholderOverride = null; }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <path d="M8 2L2 8m0-6l6 6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      {/if}

      <div class="input-shell" class:voice-mode={showTranscription}>
        {#if pendingImages.length > 0}
          <div class="image-preview-strip">
            {#each pendingImages as img (img.id)}
              <div class="image-preview-item">
                <img src={getImageSrc(img)} alt="" class="image-preview-thumb" />
                <span class="image-preview-name" title={getAttachmentDisplayName(img)}>
                  {getAttachmentDisplayName(img)}
                </span>
                <button class="image-remove-btn" onclick={() => removeImage(img.id)} title={$t('ai.remove_image')}>
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M9 3L3 9m0-6l6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                  </svg>
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <div class="input-text-layer">
          <textarea
            class="ai-input"
            bind:this={inputEl}
            bind:value={inputText}
            oninput={handleInput}
            onkeydown={handleKeydown}
            onpaste={handleInputPaste}
            ondrop={handleInputDrop}
            ondragover={handleInputDragOver}
            placeholder={inputPlaceholderOverride ?? (selectedText ? $t('ai.placeholder_selection') : $t('ai.placeholder'))}
            rows={1}
          ></textarea>
        </div>

        <div class="input-action-row" class:recording={inlineRecordingState === 'recording'}>
          <div class="input-action-left" class:hidden={inlineRecordingState === 'recording' || showTranscription}>
            {#if !isRealtimeVoiceActive}
              <button
                class="icon-btn plus-btn"
                bind:this={actionTriggerEl}
                onclick={() => showActionDrawer = !showActionDrawer}
                title={$t('ai.more_actions')}
              >
                <svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M6 0v12M0 6h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </button>
            {/if}
            <button
              class="icon-btn attach-btn"
              onclick={handleAttachImage}
              title={$t('ai.attach_image')}
              disabled={isLoading}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M14 8.5a5.5 5.5 0 01-11 0V4a3.5 3.5 0 017 0v4.5a1.5 1.5 0 01-3 0V5h1v3.5a.5.5 0 001 0V4a2.5 2.5 0 00-5 0v4.5a4.5 4.5 0 009 0V5h1v3.5z"/>
              </svg>
            </button>
          </div>

          <div
            class="input-action-right"
            class:recording-fullrow={inlineRecordingState === 'recording' || (showTranscription && voiceRecordingState === 'recording')}
          >
            {#if showTranscription}
              {#if voiceRecordingState === 'recording'}
                <div class="inline-wave-bars voice-wave-bars" aria-hidden="true">
                  {#each vizHistory as v}
                    {@const active = v >= 0.04}
                    <div
                      class="freq-slot"
                      class:freq-slot--active={active}
                      style="height:{Math.max(3, v * 42)}px; border-radius:{active ? '1px' : '50%'}"
                    ></div>
                  {/each}
                </div>
              {/if}
              <button
                class="icon-btn voice-record-btn"
                class:primary-btn={voiceRecordingState === 'recording'}
                class:ghost-btn={voiceRecordingState !== 'recording'}
                onclick={toggleVoiceRecording}
                disabled={voiceRecordingState === 'connecting' || voiceRecordingState === 'stopping' || !speechConfig}
                title={voiceRecordingState === 'recording' ? $t('transcription.stop') : $t('transcription.start')}
              >
                {#if voiceRecordingState === 'connecting' || voiceRecordingState === 'stopping'}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                {:else if voiceRecordingState === 'recording'}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
                  </svg>
                {:else}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" stroke-width="2"/>
                    <path d="M6 11a6 6 0 0 0 12 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M8 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                {/if}
              </button>
            {:else if isLoading}
              <!-- While a response streams the action button shows the
                   thinking orb with NO fill, and swaps to a stop glyph on
                   hover/focus. It is still the stop control (same handler, same
                   `ai.stop` title for assistive tech, so the orb itself is
                   aria-hidden or it would be announced twice). Mirrors
                   moraya-web's MobileAIChat composing state. -->
              <button
                class="icon-btn composing-btn"
                onclick={abortAIRequest}
                title={$t('ai.composing')}
                aria-label={$t('ai.stop')}
              >
                <span class="composing-orb"><ThinkingOrb orbState="composing" size={20} /></span>
                <span class="composing-stop">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
                  </svg>
                </span>
              </button>
            {:else if isRealtimeVoiceActive}
              <span class="recording-wave rt-wave" aria-hidden="true">
                <svg viewBox="0 0 24 16" fill="none">
                  <rect class="wave-bar wave-bar-1" x="1" y="5" width="3" height="6" rx="1.5" fill="currentColor"></rect>
                  <rect class="wave-bar wave-bar-2" x="6" y="2" width="3" height="12" rx="1.5" fill="currentColor"></rect>
                  <rect class="wave-bar wave-bar-3" x="11" y="4" width="3" height="8" rx="1.5" fill="currentColor"></rect>
                  <rect class="wave-bar wave-bar-4" x="16" y="1" width="3" height="14" rx="1.5" fill="currentColor"></rect>
                  <rect class="wave-bar wave-bar-5" x="21" y="5" width="3" height="6" rx="1.5" fill="currentColor"></rect>
                </svg>
              </span>
              {#if hasDraftContent()}
                <button class="icon-btn primary-btn" onclick={handleSend} title={$t('ai.send')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M3 11.5L21 3 13 21l-2.5-7L3 11.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
                  </svg>
                </button>
              {/if}
              <button class="icon-btn primary-btn stop-btn" onclick={stopRealtimeVoiceSession} title={$t('ai.realtime.stop_voice')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2"/>
                </svg>
              </button>
            {:else if inlineRecordingState === 'recording'}
              <div class="inline-wave-bars" aria-hidden="true">
                {#each vizHistory as v}
                  {@const active = v >= 0.04}
                  <div
                    class="freq-slot"
                    class:freq-slot--active={active}
                    style="height:{Math.max(3, v * 42)}px; border-radius:{active ? '1px' : '50%'}"
                  ></div>
                {/each}
              </div>
              <button class="icon-btn ghost-btn" onclick={cancelInlineRecording} title={$t('ai.voice.cancel')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </button>
              <button class="icon-btn primary-btn" onclick={commitInlineRecording} title={$t('ai.voice.commit')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="m5 13 4 4L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            {:else}
              {#if canShowInlineRecordButton()}
                <button class="icon-btn ghost-btn voice-input-btn" onclick={startInlineRecording} title={$t('ai.voice.record')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" stroke-width="2"/>
                    <path d="M6 11a6 6 0 0 0 12 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M8 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                </button>
              {/if}
              <button
                class="icon-btn primary-btn"
                onclick={handlePrimaryAction}
                disabled={!shouldShowWaveAction() && !hasDraftContent() && !isRealtimeVoiceConnecting}
                title={shouldShowWaveAction() ? $t('ai.realtime.start_voice') : $t('ai.send')}
              >
                {#if shouldShowWaveAction()}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M3 12h2l2-4 3 8 3-12 2 8h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M3 11.5L21 3 13 21l-2.5-7L3 11.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
                  </svg>
                {/if}
              </button>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}

  {#if lightboxSrc}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="lightbox-overlay" onclick={closeLightbox}>
      <img src={lightboxSrc} alt="" class="lightbox-image" />
      <button class="lightbox-close" onclick={closeLightbox} title={$t('ai.close_preview')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M12 4L4 12m0-8l8 8" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  {/if}
</div>

<svelte:window onkeydown={(e) => {
  if (e.key === 'Escape') {
    if (lightboxSrc) { closeLightbox(); return; }
    if (inlineRecordingState === 'recording') { cancelInlineRecording(); return; }
    if (isRealtimeVoiceActive || isRealtimeVoiceConnecting) { stopRealtimeVoiceSession(); return; }
    if (isLoading) { abortAIRequest(); return; }
  }
}} />

<style>
  .ai-panel {
    position: relative;
    height: 100%;
    background: var(--bg-sidebar);
    border-left: 1px solid var(--border-light);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
  }

  .ai-panel.resizing {
    user-select: none;
  }

  .resize-handle {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: col-resize;
    z-index: 10;
    transition: background var(--transition-fast);
  }

  .resize-handle.hover-visible,
  .ai-panel.resizing .resize-handle {
    background: var(--accent-color);
  }

  .width-indicator {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 10px;
    color: white;
    background: var(--accent-color);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 11;
  }

  .ai-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border-light);
  }

  .ai-header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .ai-title {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .model-dropdown-wrap {
    position: relative;
  }

  .model-dropdown-trigger {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 10px;
    padding: 0.15rem 0.4rem 0.15rem 0.45rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    max-width: 140px;
    cursor: pointer;
    user-select: none;
  }

  .model-trigger-empty .model-trigger-text {
    color: var(--text-muted);
    font-style: italic;
  }

  .model-dropdown-trigger:hover {
    border-color: var(--accent-color);
    color: var(--text-primary);
  }

  .model-trigger-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .model-dropdown-panel {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 200;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.18);
    min-width: 200px;
    max-width: 320px;
    padding: 0.3rem 0;
    overflow: hidden;
  }

  .model-group-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    padding: 0.35rem 0.65rem 0.15rem;
  }

  .model-group-divider {
    height: 1px;
    background: var(--border-light);
    margin: 0.25rem 0;
  }

  .model-dropdown-item {
    display: flex;
    align-items: center;
    gap: 0;
    width: 100%;
    text-align: left;
    font-size: 11px;
    padding: 0.3rem 0.65rem;
    background: none;
    border: none;
    color: var(--text-primary);
    cursor: pointer;
    line-height: 1.4;
  }

  .model-dropdown-item:hover {
    background: var(--bg-hover);
  }

  .model-item-dot {
    width: 1rem;
    flex-shrink: 0;
    color: var(--accent-color);
    font-size: 20px;
    line-height: 1;
    text-align: center;
  }

  .model-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .model-name {
    font-size: 10px;
    color: var(--text-muted);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mcp-badge {
    font-size: 10px;
    padding: 0.1rem 0.4rem;
    border-radius: 8px;
    background: var(--accent-color);
    color: white;
    font-weight: 500;
  }

  .moraya-md-badge {
    font-size: 10px;
    padding: 0.1rem 0.4rem;
    border-radius: 8px;
    background: var(--accent-color);
    color: white;
    font-weight: 500;
  }

  .ai-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 3px;
  }

  .ai-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .template-menu-wrap {
    position: relative;
  }

  .template-menu-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 100;
    min-width: 160px;
    white-space: nowrap;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    padding: 0.25rem;
    margin-top: 0.25rem;
  }

  .template-menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    cursor: pointer;
    border-radius: 4px;
    text-align: left;
  }

  .template-menu-item:hover {
    background: var(--bg-hover);
  }

  .template-menu-item svg {
    flex-shrink: 0;
    color: var(--text-muted);
  }

  .ai-unconfigured {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    gap: 0.5rem;
  }

  .open-settings-btn {
    margin-top: 0.5rem;
    padding: 0.4rem 1rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .open-settings-btn:hover {
    background: var(--bg-hover);
  }

  .hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .ai-messages {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .cmd-icon {
    font-size: 1rem;
    flex-shrink: 0;
  }

  .message {
    position: relative;
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    font-size: var(--font-size-sm);
    line-height: 1.5;
    min-width: 6rem; /* prevent action buttons from overlapping timestamp on short messages */
  }

  .message.user {
    background: var(--accent-color);
    color: white;
    align-self: flex-end;
    max-width: 85%;
    margin-left: auto;
  }

  .message.assistant {
    background: var(--bg-primary);
    border: 1px solid var(--border-light);
    max-width: 90%;
  }

  .message.error {
    background: #fee;
    border: 1px solid #fcc;
    color: #c33;
    font-size: var(--font-size-xs);
    position: relative;
    -webkit-user-select: text;
    user-select: text;
    cursor: text;
  }

  .message.notify-success {
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    color: #166534;
  }

  .message.notify-error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
  }
  .error-text {
    word-break: break-word;
  }
  .error-time {
    color: rgba(204, 51, 51, 0.5);
  }
  .error-action {
    color: #c33;
  }
  .error-action:hover {
    background: rgba(204, 51, 51, 0.1);
  }

  .message.streaming {
    border-color: var(--accent-color);
  }

  .interrupted-indicator {
    text-align: center;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    padding: 0.25rem 0;
  }

  .message.tool-result {
    background: var(--bg-hover);
    border: 1px solid var(--border-light);
    border-left: 3px solid var(--text-muted);
    max-width: 90%;
    padding: 0.4rem 0.6rem;
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin-bottom: 0.25rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-weight: 600;
  }

  .tool-icon { font-size: 12px; }

  .tool-name {
    font-family: var(--font-mono, monospace);
  }

  .tool-error-badge {
    font-size: 10px;
    padding: 0 0.3rem;
    border-radius: 3px;
    background: #dc3545;
    color: white;
  }

  .tool-output {
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    max-height: 150px;
    overflow-y: auto;
    color: var(--text-secondary);
    -webkit-user-select: text;
    user-select: text;
    cursor: text;
  }

  .message.tool-calling {
    border-color: var(--accent-color);
    border-style: dashed;
  }

  .tool-call-block {
    margin-top: 0.3rem;
    font-size: var(--font-size-xs);
  }

  .tool-call-summary {
    cursor: pointer;
    color: var(--accent-color);
    font-weight: 500;
    font-family: var(--font-mono, monospace);
  }

  .tool-call-args {
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0.25rem 0 0;
    padding: 0.3rem;
    background: var(--bg-hover);
    border-radius: 4px;
    color: var(--text-secondary);
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.25rem;
  }

  .message-role {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-muted);
  }

  .message.rt-interim {
    opacity: 0.65;
    font-style: italic;
  }

  .rt-wave {
    color: var(--accent-color);
  }

  .rt-badge {
    font-size: 10px;
    color: var(--accent);
    opacity: 0.8;
  }

  .message.user .message-role,
  .message.user .message-time {
    color: rgba(255, 255, 255, 0.7);
  }

  .message-time {
    display: block;
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .message.user .message-time {
    color: rgba(255, 255, 255, 0.5);
    text-align: left;
  }

  .message-content {
    word-break: break-word;
    -webkit-user-select: text;
    user-select: text;
    cursor: text;
  }

  /* User messages stay pre-wrap (plain text) */
  .message.user .message-content {
    white-space: pre-wrap;
  }

  /* Markdown rendered content for assistant messages */
  .message-content :global(p) { margin: 0.4em 0; }
  .message-content :global(p:first-child) { margin-top: 0; }
  .message-content :global(p:last-child) { margin-bottom: 0; }

  .message-content :global(h1),
  .message-content :global(h2),
  .message-content :global(h3),
  .message-content :global(h4),
  .message-content :global(h5),
  .message-content :global(h6) { margin: 0.5em 0 0.3em; font-weight: 600; }
  .message-content :global(h1) { font-size: 1.3em; }
  .message-content :global(h2) { font-size: 1.15em; }
  .message-content :global(h3) { font-size: 1.05em; }

  .message-content :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 0.5em 0;
    display: block;
  }

  .message-content :global(code) {
    background: var(--bg-hover);
    padding: 0.1em 0.3em;
    border-radius: 3px;
    font-size: 0.85em;
    font-family: var(--font-mono, monospace);
  }

  .message-content :global(pre) {
    background: var(--bg-hover);
    padding: 0.6rem;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0.5em 0;
    font-size: 0.85em;
  }
  .message-content :global(pre code) { background: none; padding: 0; }

  .message-content :global(a) {
    color: var(--accent-color);
    text-decoration: underline;
  }

  .message-content :global(ul),
  .message-content :global(ol) {
    margin: 0.4em 0;
    padding-left: 1.5em;
  }

  .message-content :global(blockquote) {
    border-left: 3px solid var(--accent-color);
    padding-left: 0.6em;
    margin: 0.4em 0;
    color: var(--text-secondary);
  }

  .message-content :global(hr) {
    border: none;
    border-top: 1px solid var(--border-color);
    margin: 0.8em 0;
  }

  .message-content :global(.math-block) {
    text-align: center;
    margin: 0.5em 0;
    overflow-x: auto;
  }

  /* Task list checkboxes */
  .message-content :global(.task-item) {
    list-style: none;
    position: relative;
    margin-left: -1.2em;
  }
  .message-content :global(.task-checkbox) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border: 1.5px solid var(--text-secondary);
    border-radius: 3px;
    margin-right: 0.4em;
    vertical-align: -0.2em;
    font-size: 12px;
    line-height: 1;
  }
  .message-content :global(.task-checkbox.checked) {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: #fff;
    font-weight: 700;
    font-size: 13px;
  }
  .message-content :global(.task-item.checked) {
    color: var(--text-secondary);
    text-decoration: line-through;
  }

  /* Action buttons: hidden by default, shown on hover, inside message */
  .message-actions {
    display: flex;
    gap: 0.25rem;
    position: absolute;
    right: 0.4rem;
    bottom: 0.3rem;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--transition-fast);
    background: transparent;
    border: none;
    border-radius: 4px;
    padding: 0;
    z-index: 2;
  }

  .message:hover .message-actions {
    opacity: 1;
    pointer-events: auto;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 3px;
    cursor: pointer;
    padding: 0;
  }

  .action-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .message.user .action-btn {
    color: rgba(255, 255, 255, 0.5);
  }

  .message.user .action-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    color: white;
  }

  .typing-indicator {
    display: block;
    font-size: 10px;
    color: var(--accent-color);
    margin-top: 0.25rem;
    animation: pulse 1.5s infinite;
  }

  .thinking {
    display: flex;
    gap: 0.25rem;
    padding: 0.25rem 0;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: bounce 1.4s infinite ease-in-out;
  }

  .dot:nth-child(1) { animation-delay: 0s; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes bounce {
    0%, 80%, 100% { transform: translateY(0); }
    40% { transform: translateY(-6px); }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .ai-input-area {
    position: relative;
    border-top: 1px solid var(--border-light);
    padding: 0.5rem;
  }

  /* Action drawer (appears above input area) */
  .action-drawer {
    position: absolute;
    bottom: 0.58rem;
    left: 0.5rem;
    transform: translateY(calc(-100% - 0.22rem));
    right: auto;
    min-width: 10.5rem;
    max-width: 14rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    margin: 0;
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.14);
    z-index: 10;
    overflow: hidden;
  }

  .drawer-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.6rem 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .drawer-item:hover {
    background: var(--bg-hover);
  }

  .commands-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    margin: 0 0.5rem 0.25rem;
    max-height: 400px;
    overflow: hidden;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.1);
    z-index: 10;
  }

  .param-panel-wrapper {
    border-bottom: 1px solid var(--border-light);
  }

  .template-hint {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0.5rem;
    background: var(--bg-hover);
    border-radius: 6px;
    margin-bottom: 0.35rem;
  }

  .template-hint-label {
    font-size: var(--font-size-xs);
    color: var(--accent-color);
    font-weight: 500;
  }

  .template-hint-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 3px;
    padding: 0;
  }

  .template-hint-close:hover {
    background: var(--bg-active);
    color: var(--text-primary);
  }

  .input-shell {
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-primary);
    transition: border-color var(--transition-fast);
    overflow: hidden;
  }

  .input-shell:focus-within {
    border-color: var(--accent-color);
  }

  .input-text-layer {
    padding: 0.5rem 0.65rem 0.2rem;
  }

  .ai-input {
    width: 100%;
    resize: none;
    border: none;
    border-radius: 0;
    padding: 0;
    font-size: var(--font-size-sm);
    font-family: var(--font-sans);
    background: transparent;
    color: var(--text-primary);
    line-height: 1.4;
    outline: none;
    overflow-y: hidden;
  }

  .ai-input::placeholder {
    color: var(--text-muted);
  }

  .input-action-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.35rem 0.45rem 0.45rem;
    gap: 0.35rem;
  }

  .input-action-left,
  .input-action-right {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 2rem;
  }

  .input-action-left.hidden {
    display: none;
  }

  /* When left side is hidden (voice mode), push right side to the end */
  .input-action-left.hidden + .input-action-right {
    margin-left: auto;
  }

  .input-action-right.recording-fullrow {
    flex: 1;
    gap: 0.3rem;
  }

  .inline-wave-bars {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 1.95rem;
    overflow: hidden;
  }

  .freq-slot {
    width: 2px;
    flex-shrink: 0;
    max-height: 100%;
    background: var(--text-tertiary, #bbb);
    align-self: center;
    transition: opacity 2s ease-out, border-radius 2s ease-out;
    opacity: 0.25;
  }

  .freq-slot--active {
    background: linear-gradient(to top, var(--accent-color), color-mix(in srgb, var(--accent-color) 55%, white));
    opacity: 0.9;
    box-shadow: 0 0 3px color-mix(in srgb, var(--accent-color) 70%, transparent),
                0 0 7px color-mix(in srgb, var(--accent-color) 35%, transparent);
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.95rem;
    height: 1.95rem;
    padding: 0;
    line-height: 0;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    flex-shrink: 0;
    color: var(--text-secondary);
    background: transparent;
    transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
  }

  .icon-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .icon-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .primary-btn {
    background: var(--accent-color);
    color: #fff;
  }

  .primary-btn:hover:not(:disabled) {
    opacity: 0.9;
    background: var(--accent-color);
    color: #fff;
  }

  .stop-btn {
    background: #dc3545;
  }

  .stop-btn:hover:not(:disabled) {
    background: #c62f3d;
    color: #fff;
  }

  /* Streaming ("composing") state — kept in step with moraya-web.
     No fill: the orb sits directly on the input bar. A filled pill (accent,
     grey, or red) all failed for the same reason — the orb's dot contrast was
     measured against each and a mid-luminance fill swallows it, while the pill
     itself made the state read as a greyed-out send button rather than as the
     AI working. Hover uses the app's ordinary hover wash, not red: this is a
     "stop" control, not an alert. */
  .composing-btn {
    position: relative;
    background: transparent;
    color: var(--text-secondary);
  }
  .composing-btn .composing-orb,
  .composing-btn .composing-stop {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: opacity var(--transition-fast);
  }
  /* Both layers are SPAN wrappers. Putting these rules on the <svg> itself
     pinned the glyph to the top-left corner — `inset: 0` cannot stretch a
     replaced element that carries its own width/height attributes, and
     `display: flex` does nothing to an SVG's internal layout. */
  .composing-btn .composing-stop {
    opacity: 0;
  }
  .composing-btn:hover,
  .composing-btn:focus-visible {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .composing-btn:hover .composing-orb,
  .composing-btn:focus-visible .composing-orb {
    opacity: 0;
  }
  .composing-btn:hover .composing-stop,
  .composing-btn:focus-visible .composing-stop {
    opacity: 1;
  }

  .ghost-btn {
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
  }

  .plus-btn {
    border: 0;
    background: transparent;
  }

  .plus-btn:hover {
    background: var(--bg-hover);
  }

  .attach-btn {
    border: 0;
    background: transparent;
  }

  .voice-input-btn {
    border: 0;
    background: transparent;
  }

  .recording-wave {
    width: 1.95rem;
    height: 1.95rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-color);
  }

  .recording-wave svg {
    width: 1.3rem;
    height: 0.95rem;
    overflow: visible;
  }

  .recording-wave .wave-bar {
    transform-box: fill-box;
    transform-origin: center bottom;
    animation: wavePulse 1.05s ease-in-out infinite;
  }

  .recording-wave .wave-bar-1 { animation-delay: 0s; }
  .recording-wave .wave-bar-2 { animation-delay: 0.12s; }
  .recording-wave .wave-bar-3 { animation-delay: 0.24s; }
  .recording-wave .wave-bar-4 { animation-delay: 0.36s; }
  .recording-wave .wave-bar-5 { animation-delay: 0.48s; }

  @keyframes wavePulse {
    0%, 100% {
      transform: scaleY(0.35);
      opacity: 0.4;
    }
    50% {
      transform: scaleY(1);
      opacity: 1;
    }
  }

  /* ── Image preview strip ── */
  .image-preview-strip {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 0.32rem;
    padding: 0.35rem 0.45rem 0.1rem;
  }

  .image-preview-item {
    min-width: 0;
    height: 1.65rem;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: var(--bg-hover);
    border: 1px solid var(--border-light);
  }

  .image-preview-thumb {
    width: 1.1rem;
    height: 1.1rem;
    object-fit: cover;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .image-preview-name {
    min-width: 0;
    flex: 1;
    font-size: 11px;
    line-height: 1;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .image-remove-btn {
    width: 1rem;
    height: 1rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 999px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    flex-shrink: 0;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .image-remove-btn:hover {
    background: var(--bg-active);
    color: var(--text-primary);
  }

  /* ── Message images ── */
  .message-images {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
    margin-bottom: 0.25rem;
  }

  .message-image-thumb {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.2);
    transition: opacity var(--transition-fast);
  }

  .message-image-thumb:hover {
    opacity: 0.8;
  }

  /* ── Lightbox ── */
  .lightbox-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .lightbox-image {
    max-width: 90%;
    max-height: 90%;
    object-fit: contain;
    border-radius: 8px;
  }

  .lightbox-close {
    position: absolute;
    top: 1rem;
    right: 1rem;
    width: 2rem;
    height: 2rem;
    border: none;
    background: rgba(255, 255, 255, 0.15);
    color: white;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .lightbox-close:hover {
    background: rgba(255, 255, 255, 0.3);
  }

  /* RTL overrides */
  :global([dir="rtl"]) .ai-panel {
    border-left: none;
    border-right: 1px solid var(--border-light);
  }

  :global([dir="rtl"]) .resize-handle {
    left: auto;
    right: 0;
  }

  :global([dir="rtl"]) .message.tool-result {
    border-left: 1px solid var(--border-light);
    border-right: 3px solid var(--text-muted);
  }

  :global([dir="rtl"]) .message.user .message-time {
    text-align: right;
  }

  :global([dir="rtl"]) .message-content :global(ul),
  :global([dir="rtl"]) .message-content :global(ol) {
    padding-left: 0;
    padding-right: 1.5em;
  }

  :global([dir="rtl"]) .message-content :global(blockquote) {
    border-left: none;
    border-right: 3px solid var(--accent-color);
    padding-left: 0;
    padding-right: 0.6em;
  }

  :global([dir="rtl"]) .message-content :global(.task-item) {
    margin-left: 0;
    margin-right: -1.2em;
  }

  :global([dir="rtl"]) .message-content :global(.task-checkbox) {
    margin-right: 0;
    margin-left: 0.4em;
  }

  :global([dir="rtl"]) .message-actions {
    right: auto;
    left: 0.4rem;
  }

  :global([dir="rtl"]) .drawer-item {
    text-align: right;
  }

  /* ── Voice mode bar ───────────────────────────────────────────────── */
  .voice-mode-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
  }

  .voice-mode-bar-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .voice-top-field {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .voice-top-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .voice-top-select {
    font-size: var(--font-size-xs);
    padding: 0.1rem 0.25rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    cursor: pointer;
  }

  .voice-mode-bar-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .voice-rec-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #e53e3e;
    animation: voice-blink 1s ease-in-out infinite;
  }

  @keyframes voice-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .voice-elapsed {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .voice-elapsed.muted {
    opacity: 0.6;
  }

  .voice-back-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-muted);
    cursor: pointer;
  }

  .voice-back-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .voice-record-btn.primary-btn {
    background: #e53e3e;
    border-color: #e53e3e;
    color: white;
  }

  .voice-record-btn.primary-btn:hover:not(:disabled) {
    background: color-mix(in srgb, #e53e3e 82%, black);
    color: white;
    opacity: 1;
  }

  /* ── Voice transcription segments ───────────────────────────────── */
  .voice-area-empty {
    padding: 1.5rem 1rem;
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    text-align: center;
  }

  .voice-segment {
    padding: 0.4rem 0.75rem 0.5rem;
    border-left: 2px solid var(--border-light);
    margin: 0.2rem 0;
    transition: border-color 0.2s;
  }

  .voice-segment.voice-interim {
    opacity: 0.6;
    font-style: italic;
  }

  .voice-segment-header {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.2rem;
  }

  .voice-speaker-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .voice-speaker-name {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .voice-segment-time {
    font-size: 10px;
    color: var(--text-muted);
    margin-left: auto;
  }

  .voice-segment-text {
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    line-height: 1.45;
    word-break: break-word;
  }

  /* Interview Q left indent */
  .voice-interview-q {
    border-left-color: var(--accent-color);
  }

  /* Interview AI answer bubble */
  .voice-interview-a {
    margin: 0.3rem 0.75rem 0.3rem 1.5rem;
    padding: 0.5rem 0.65rem;
    background: color-mix(in srgb, var(--accent-color) 8%, var(--bg-secondary));
    border: 1px solid color-mix(in srgb, var(--accent-color) 20%, var(--border-light));
    border-radius: 8px;
  }

  .voice-interview-a.failed {
    background: color-mix(in srgb, #e53e3e 6%, var(--bg-secondary));
    border-color: color-mix(in srgb, #e53e3e 25%, var(--border-light));
  }

  .voice-interview-a.pending {
    opacity: 0.7;
  }

  .voice-interview-a-label {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--accent-color);
    margin-bottom: 0.25rem;
  }

  .voice-interview-a.failed .voice-interview-a-label {
    color: #e53e3e;
  }

  .voice-interview-a-text {
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .voice-error-banner {
    margin: 0.4rem 0.75rem;
    padding: 0.4rem 0.6rem;
    background: color-mix(in srgb, #e53e3e 8%, var(--bg-secondary));
    border: 1px solid color-mix(in srgb, #e53e3e 25%, var(--border-light));
    border-radius: 6px;
    font-size: var(--font-size-xs);
    color: #e53e3e;
  }

  /* ── Voice mode input-shell theme ────────────────────────────────── */
  .input-shell.voice-mode {
    border-color: color-mix(in srgb, #e53e3e 40%, var(--border-color));
    background: color-mix(in srgb, #e53e3e 4%, var(--bg-primary));
  }

  .input-shell.voice-mode:focus-within {
    border-color: color-mix(in srgb, #e53e3e 70%, var(--border-color));
  }

  .input-shell.voice-mode .ai-input::placeholder {
    color: color-mix(in srgb, #e53e3e 30%, var(--text-muted));
  }

  /* Voice wave bars use red accent instead of --accent-color */
  .voice-wave-bars .freq-slot--active {
    background: linear-gradient(to top, #e53e3e, color-mix(in srgb, #e53e3e 60%, white));
    box-shadow: 0 0 3px color-mix(in srgb, #e53e3e 60%, transparent),
                0 0 7px color-mix(in srgb, #e53e3e 30%, transparent);
  }
</style>

<script lang="ts">
  import {
    aiStore,
    sendChatMessage,
    abortAIRequest,
    type ChatMessage,
    type ImageAttachment,
    type AIProviderConfig,
    type AITemplate,
    resolveContent,
    buildTemplateMessages,
  } from '$lib/services/ai';
  import { mcpStore } from '$lib/services/mcp';
  import { filesStore } from '$lib/stores/files-store';
  import { invoke } from '@tauri-apps/api/core';
  import { readFile } from '@tauri-apps/plugin-fs';
  import { markdownToHtmlBody } from '$lib/services/export-service';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { compressImage, blobToBase64 } from '$lib/services/ai/image-utils';
  import TemplateGallery from './TemplateGallery.svelte';
  import TemplateParamPanel from './TemplateParamPanel.svelte';
  import TranscriptionPanel from '../TranscriptionPanel.svelte';

  let {
    documentContent = '',
    selectedText = '',
    onInsert,
    onReplace,
    onOpenSettings,
    onOpenVoiceSettings,
  }: {
    documentContent?: string;
    selectedText?: string;
    onInsert?: (text: string) => void;
    onReplace?: (text: string) => void;
    onOpenSettings?: () => void;
    onOpenVoiceSettings?: () => void;
  } = $props();

  let chatMessages = $state<ChatMessage[]>([]);
  let isLoading = $state(false);
  let error = $state<string | null>(null);
  let interrupted = $state(false);
  let streamingContent = $state('');
  let isConfigured = $state(false);
  let inputText = $state('');
  let showCommands = $state(false);
  let messagesEl = $state<HTMLDivElement | undefined>(undefined);
  let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let scrollRaf: number | undefined; // RAF throttle for auto-scroll
  let resizeRaf: number | undefined; // RAF throttle for textarea auto-resize
  let streamRenderTimer: ReturnType<typeof setTimeout> | undefined;
  let mcpToolCount = $state(0);
  let providerConfigs = $state<AIProviderConfig[]>([]);
  let activeConfigId = $state<string | null>(null);

  // Template system state
  let activeTemplate = $state<AITemplate | null>(null);
  let showParamPanel = $state(false);
  let inputPlaceholderOverride = $state<string | null>(null);

  // Image attachments
  const MAX_IMAGES = 5;
  let pendingImages = $state<ImageAttachment[]>([]);
  let lightboxSrc = $state<string | null>(null);

  // Transcription panel
  let showActionDrawer = $state(false);
  let showTranscription = $state(false);

  // MORAYA.md indicator
  let morayaMdActive = $state(false);
  let folderPath = $state<string | null>(null);

  $effect(() => {
    const unsub = filesStore.subscribe(state => {
      folderPath = state.openFolderPath;
    });
    return unsub;
  });

  $effect(() => {
    const path = folderPath;
    if (!path) {
      morayaMdActive = false;
      return;
    }
    invoke<string>('read_file', { path: `${path}/MORAYA.md` })
      .then(content => { morayaMdActive = !!content?.trim(); })
      .catch(() => { morayaMdActive = false; });
  });

  $effect(() => {
    const unsub = mcpStore.subscribe(state => {
      mcpToolCount = state.tools.length;
    });
    return unsub;
  });

  // ── Cached markdown rendering ──
  // Avoid expensive markdownToHtmlBody re-computation on every Svelte render cycle.
  // Messages are immutable once stored, so we cache their rendered HTML by timestamp.
  const htmlCache = new Map<number, string>();

  function cachedHtml(msg: ChatMessage): string {
    const key = msg.timestamp;
    let cached = htmlCache.get(key);
    if (!cached) {
      cached = markdownToHtmlBody(msg.content);
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
      renderedStreamHtml = markdownToHtmlBody(raw);
      streamRenderTimer = setTimeout(() => { streamRenderTimer = undefined; }, 150);
    } else {
      // Subsequent chunks — schedule throttled render
      clearTimeout(streamRenderTimer);
      streamRenderTimer = setTimeout(() => {
        streamRenderTimer = undefined;
        renderedStreamHtml = markdownToHtmlBody(streamingContent);
      }, 150);
    }
  });

  // Resizable width — default to golden ratio (smaller portion ≈ 38.2%)
  const GOLDEN_RATIO = 1.618;
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 800;
  let panelWidth = $state(Math.round(
    Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth / (1 + GOLDEN_RATIO)))
  ));
  let isResizing = $state(false);

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
        const delta = startX - ev.clientX; // moving left = wider
        panelWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
      });
    }

    function onMouseUp() {
      if (resizeRafId !== undefined) {
        cancelAnimationFrame(resizeRafId);
        resizeRafId = undefined;
      }
      isResizing = false;
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
  // Clean up only on component destroy
  onMount(() => () => {
    document.documentElement.style.removeProperty('--ai-panel-width');
  });

  // Auto-scroll: track whether user is near bottom
  let userAtBottom = $state(true);

  // Only assign $state vars when the value actually changed — avoids triggering
  // unnecessary Svelte reactivity during high-frequency streaming updates.
  $effect(() => {
    const unsub = aiStore.subscribe(state => {
      if (chatMessages !== state.chatHistory) chatMessages = state.chatHistory;
      if (isLoading !== state.isLoading) isLoading = state.isLoading;
      if (error !== state.error) error = state.error;
      if (interrupted !== state.interrupted) interrupted = state.interrupted;
      if (streamingContent !== state.streamingContent) streamingContent = state.streamingContent;
      if (isConfigured !== state.isConfigured) isConfigured = state.isConfigured;
      if (providerConfigs !== state.providerConfigs) providerConfigs = state.providerConfigs;
      if (activeConfigId !== state.activeConfigId) activeConfigId = state.activeConfigId;
    });
    return unsub;
  });

  function handleModelSwitch(e: Event) {
    const id = (e.target as HTMLSelectElement).value;
    aiStore.setActiveConfig(id);
  }

  // Auto-scroll during streaming when user is at bottom (RAF-batched)
  $effect(() => {
    const _ = streamingContent;
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

  async function addImageFromBlob(blob: Blob) {
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
      await addImageFromBlob(blob);
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
        if (file) addImageFromBlob(file);
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
        addImageFromBlob(files[i]);
      }
    }
  }

  function handleInputDragOver(e: DragEvent) {
    e.preventDefault();
  }

  function getImageSrc(img: ImageAttachment): string {
    return img.previewUrl || `data:${img.mimeType};base64,${img.base64}`;
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

    if (activeTemplate && (activeTemplate.flow === 'input' || activeTemplate.flow === 'parameterized')) {
      // Template input flow: build messages from template
      const resolved = resolveContent(activeTemplate, documentContent, selectedText);
      const { systemPrompt, userMessage } = buildTemplateMessages(activeTemplate, {
        content: resolved.content,
        input: message,
        locale: navigator.language,
      });
      activeTemplate = null;
      inputPlaceholderOverride = null;
      aiStore.addMessage({ role: 'system', content: systemPrompt, timestamp: Date.now() });
      try {
        await sendChatMessage(userMessage, documentContent, images);
      } catch { /* handled by store */ }
      return;
    }

    // Normal free chat
    try {
      await sendChatMessage(message, documentContent, images);
    } catch {
      // Error is handled by store
    }
  }

  async function handleTemplateSelect(template: AITemplate) {
    showCommands = false;

    // Resolve content for flows that need it
    const resolved = resolveContent(template, documentContent, selectedText);
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
          await sendChatMessage(userMessage, documentContent);
        } catch { /* handled by store */ }
        break;
      }
      case 'input': {
        // Switch to input mode with custom placeholder
        activeTemplate = template;
        showParamPanel = false;
        inputPlaceholderOverride = template.inputHintKey ? $t(template.inputHintKey) : null;
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

    const resolved = resolveContent(activeTemplate, documentContent, selectedText);
    if (resolved.error && activeTemplate.contentSource !== 'none') {
      aiStore.setError($t(resolved.error));
      activeTemplate = null;
      return;
    }

    // Build paramLabels for interpolation
    const paramLabels: Record<string, string> = {};
    for (const p of activeTemplate.params ?? []) {
      const selectedOption = p.options.find(o => o.value === params[p.key]);
      if (selectedOption) paramLabels[p.key] = $t(selectedOption.labelKey);
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
      await sendChatMessage(userMessage, documentContent);
    } catch { /* handled by store */ }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    // Ctrl+Enter (Windows/Linux) or Cmd+Enter (macOS) to send.
    // Plain Enter inserts a newline (default textarea behavior).
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      handleSend();
    }
    if (event.key === '/' && inputText === '') {
      showCommands = true;
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

  /** Send a finished transcript to the LLM as a user message. */
  async function handleTranscriptionToAI(transcript: string) {
    showTranscription = false;
    if (transcript.trim()) {
      inputText = transcript;
      await handleSend();
    }
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

  // Compute max height for 5 lines based on line-height
  const lineHeight = 1.4; // matches CSS line-height
  const fontSize = 14; // --font-size-sm approx
  const paddingY = 16; // 0.5rem * 2
  const maxInputHeight = Math.round(fontSize * lineHeight * 5 + paddingY);

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
  <div class="resize-handle" onmousedown={handleResizeStart}>
    {#if isResizing}
      <span class="width-indicator">{panelWidth}</span>
    {/if}
  </div>
  <div class="ai-header">
    <div class="ai-header-left">
      <span class="ai-title">{$t('ai.title')}</span>
      {#if providerConfigs.length > 1}
        <select class="model-switcher" value={activeConfigId} onchange={handleModelSwitch}>
          {#each providerConfigs as cfg}
            <option value={cfg.id}>{cfg.model || cfg.provider}</option>
          {/each}
        </select>
      {:else if providerConfigs.length === 1}
        <span class="model-name">{providerConfigs[0].model || providerConfigs[0].provider}</span>
      {/if}
      {#if mcpToolCount > 0}
        <span class="mcp-badge" title="{mcpToolCount} MCP tools available">{mcpToolCount} tools</span>
      {/if}
      {#if morayaMdActive}
        <span class="moraya-md-badge" title={$t('ai.morayaMdActive')}>MORAYA.md</span>
      {/if}
    </div>
    {#if chatMessages.length > 0}
      <button class="ai-btn" onclick={clearChat} title={$t('ai.clearChat')}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <path d="M4 1V0h6v1h4v2H0V1h4zm1 3h1v8H5V4zm3 0h1v8H8V4zM1 3h12l-1 11H2L1 3z"/>
        </svg>
      </button>
    {/if}
  </div>

  {#if !isConfigured}
    <div class="ai-unconfigured">
      <p>{$t('ai.unconfigured')}</p>
      <p class="hint">{$t('ai.unconfiguredHint', { shortcut: navigator.platform.includes('Mac') ? 'Cmd+,' : 'Ctrl+,' })}</p>
      {#if onOpenSettings}
        <button class="open-settings-btn" onclick={onOpenSettings}>{$t('ai.openSettings')}</button>
      {/if}
    </div>
  {:else}
    {#if showTranscription}
      <TranscriptionPanel
        onSendToAI={handleTranscriptionToAI}
        onBack={() => showTranscription = false}
        {onInsert}
        onOpenSettings={onOpenVoiceSettings}
      />
    {:else}
    <div class="ai-messages" bind:this={messagesEl} onscroll={handleMessagesScroll}>
      {#if chatMessages.length === 0 && !isLoading}
        <TemplateGallery onSelectTemplate={handleTemplateSelect} />
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
          <div class="message {msg.role}">
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
                <button class="action-btn" onclick={() => handleInsert(msg.content)} title={$t('ai.insertToEditor')}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M6 0v5H1v2h5v5h2V7h5V5H8V0H6z"/></svg>
                </button>
                {#if selectedText}
                  <button class="action-btn" onclick={() => handleReplace(msg.content)} title={$t('ai.replaceSelection')}>
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
        <div class="action-drawer" onclick={() => showActionDrawer = false}>
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <button
            class="drawer-item"
            onclick={(e) => { e.stopPropagation(); showTranscription = true; showActionDrawer = false; }}
          >
            🎤 {$t('ai.voiceTranscription')}
          </button>
        </div>
      {/if}

      {#if showCommands}
        <div class="commands-dropdown">
          <TemplateGallery onSelectTemplate={handleTemplateSelect} />
        </div>
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
          <span class="template-hint-label">{activeTemplate.icon} {$t(activeTemplate.nameKey)}</span>
          <button class="template-hint-close" onclick={() => { activeTemplate = null; inputPlaceholderOverride = null; }}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <path d="M8 2L2 8m0-6l6 6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      {/if}

      {#if pendingImages.length > 0}
        <div class="image-preview-strip">
          {#each pendingImages as img (img.id)}
            <div class="image-preview-item">
              <img src={getImageSrc(img)} alt="" class="image-preview-thumb" />
              <button class="image-remove-btn" onclick={() => removeImage(img.id)} title={$t('ai.removeImage')}>
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                  <path d="M6 2L2 6m0-4l4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                </svg>
              </button>
            </div>
          {/each}
          {#if pendingImages.length >= MAX_IMAGES}
            <span class="image-max-hint">{$t('ai.attachImageMax', { max: String(MAX_IMAGES) })}</span>
          {/if}
        </div>
      {/if}

      <div class="input-row">
        <button
          class="plus-btn"
          onclick={() => showActionDrawer = !showActionDrawer}
          title={$t('ai.moreActions')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M6 0v12M0 6h12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
          </svg>
        </button>
        <div class="input-wrapper">
          <button
            class="attach-btn"
            onclick={handleAttachImage}
            title={$t('ai.attachImage')}
            disabled={isLoading}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 8.5a5.5 5.5 0 01-11 0V4a3.5 3.5 0 017 0v4.5a1.5 1.5 0 01-3 0V5h1v3.5a.5.5 0 001 0V4a2.5 2.5 0 00-5 0v4.5a4.5 4.5 0 009 0V5h1v3.5z"/>
            </svg>
          </button>
          <textarea
            class="ai-input"
            bind:this={inputEl}
            bind:value={inputText}
            oninput={autoResizeInput}
            onkeydown={handleKeydown}
            onpaste={handleInputPaste}
            ondrop={handleInputDrop}
            ondragover={handleInputDragOver}
            placeholder={inputPlaceholderOverride ?? (selectedText ? $t('ai.placeholderSelection') : $t('ai.placeholder'))}
            rows={1}
          ></textarea>
        </div>
        {#if isLoading}
          <button
            class="send-btn stop"
            onclick={abortAIRequest}
            title={$t('ai.stop')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <rect x="2" y="2" width="10" height="10" rx="1.5"/>
            </svg>
          </button>
        {:else}
          <button
            class="send-btn"
            onclick={handleSend}
            disabled={!inputText.trim() && pendingImages.length === 0}
            title={$t('ai.send')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 1l14 7-14 7V9l10-1-10-1V1z"/>
            </svg>
          </button>
        {/if}
      </div>
    </div>
    {/if}
  {/if}

  {#if lightboxSrc}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="lightbox-overlay" onclick={closeLightbox}>
      <img src={lightboxSrc} alt="" class="lightbox-image" />
      <button class="lightbox-close" onclick={closeLightbox} title={$t('ai.closePreview')}>
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

  .resize-handle:hover,
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

  .model-switcher {
    font-size: 10px;
    padding: 0.1rem 0.3rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    max-width: 120px;
    cursor: pointer;
  }

  .model-switcher:focus {
    outline: none;
    border-color: var(--accent-color);
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
    background: #34c759;
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
    bottom: 100%;
    left: 0;
    right: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    margin: 0 0.5rem 0.25rem;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.1);
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

  /* "+" action button (leftmost in input row) */
  .plus-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border: 1px solid var(--border-color);
    border-radius: 50%;
    background: var(--bg-primary);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .plus-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
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

  .input-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .input-wrapper {
    flex: 1;
    display: flex;
    align-items: flex-end;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-primary);
    transition: border-color var(--transition-fast);
  }

  .input-wrapper:focus-within {
    border-color: var(--accent-color);
  }

  .ai-input {
    flex: 1;
    resize: none;
    border: none;
    border-radius: 0 8px 8px 0;
    padding: 0.5rem 0.75rem 0.5rem 0;
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

  .send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: none;
    background: var(--accent-color);
    color: white;
    border-radius: 6px;
    cursor: pointer;
    flex-shrink: 0;
    transition: opacity var(--transition-fast);
  }

  .send-btn.stop {
    background: #dc3545;
  }

  .send-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .send-btn:not(:disabled):hover {
    opacity: 0.85;
  }

  /* ── Image attach button ── */
  .attach-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    align-self: stretch;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: 7px 0 0 7px;
    cursor: pointer;
    flex-shrink: 0;
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .attach-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .attach-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  /* ── Image preview strip ── */
  .image-preview-strip {
    display: flex;
    gap: 0.35rem;
    padding: 0.35rem 0;
    overflow-x: auto;
    align-items: center;
  }

  .image-preview-item {
    position: relative;
    flex-shrink: 0;
  }

  .image-preview-thumb {
    width: 48px;
    height: 48px;
    object-fit: cover;
    border-radius: 6px;
    border: 1px solid var(--border-light);
  }

  .image-remove-btn {
    position: absolute;
    top: -4px;
    right: -4px;
    width: 16px;
    height: 16px;
    border: none;
    background: var(--text-muted);
    color: white;
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    opacity: 0;
    transition: opacity var(--transition-fast);
  }

  .image-preview-item:hover .image-remove-btn {
    opacity: 1;
  }

  .image-max-hint {
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
    padding: 0 0.25rem;
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
</style>

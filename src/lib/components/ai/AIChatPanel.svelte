<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    aiStore,
    sendChatMessage,
    executeAICommand,
    AI_COMMANDS,
    type ChatMessage,
    type AICommand,
  } from '$lib/services/ai';
  import { t } from '$lib/i18n';

  let {
    documentContent = '',
    selectedText = '',
    onInsert,
    onReplace,
  }: {
    documentContent?: string;
    selectedText?: string;
    onInsert?: (text: string) => void;
    onReplace?: (text: string) => void;
  } = $props();

  let chatMessages = $state<ChatMessage[]>([]);
  let isLoading = $state(false);
  let error = $state<string | null>(null);
  let streamingContent = $state('');
  let isConfigured = $state(false);
  let inputText = $state('');
  let showCommands = $state(false);
  let messagesEl = $state<HTMLDivElement | undefined>(undefined);

  // Resizable width
  let panelWidth = $state(340);
  let isResizing = $state(false);
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 800;

  function handleResizeStart(e: MouseEvent) {
    e.preventDefault();
    isResizing = true;
    const startX = e.clientX;
    const startWidth = panelWidth;

    function onMouseMove(ev: MouseEvent) {
      const delta = startX - ev.clientX; // moving left = wider
      panelWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
    }

    function onMouseUp() {
      isResizing = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  // Auto-scroll: track whether user is near bottom
  let userAtBottom = $state(true);

  aiStore.subscribe(state => {
    chatMessages = state.chatHistory;
    isLoading = state.isLoading;
    error = state.error;
    streamingContent = state.streamingContent;
    isConfigured = state.isConfigured;
  });

  // Auto-scroll during streaming when user is at bottom
  $effect(() => {
    // Access streamingContent and chatMessages to track changes
    const _ = streamingContent;
    const __ = chatMessages.length;
    if (userAtBottom && messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });

  function handleMessagesScroll() {
    if (!messagesEl) return;
    const threshold = 60;
    const { scrollTop, scrollHeight, clientHeight } = messagesEl;
    userAtBottom = scrollHeight - scrollTop - clientHeight < threshold;
  }

  async function handleSend() {
    if (!inputText.trim() || isLoading) return;
    const message = inputText.trim();
    inputText = '';
    showCommands = false;
    userAtBottom = true;

    try {
      await sendChatMessage(message, documentContent);
    } catch {
      // Error is handled by store
    }
  }

  async function handleCommand(command: AICommand) {
    showCommands = false;
    userAtBottom = true;
    try {
      await executeAICommand(command, {
        selectedText,
        documentContent,
        customPrompt: inputText.trim() || undefined,
      });
      inputText = '';
    } catch {
      // Error handled by store
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
    if (event.key === '/' && inputText === '') {
      showCommands = true;
    }
    if (event.key === 'Escape') {
      showCommands = false;
    }
  }

  function handleInsert(content: string) {
    onInsert?.(content);
  }

  function handleReplace(content: string) {
    onReplace?.(content);
  }

  function clearChat() {
    aiStore.clearHistory();
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ai-panel no-select" class:resizing={isResizing} style="width:{panelWidth}px">
  <div class="resize-handle" onmousedown={handleResizeStart}></div>
  <div class="ai-header">
    <span class="ai-title">{$t('ai.title')}</span>
    <button class="ai-btn" onclick={clearChat} title={$t('ai.clearChat')}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
        <path d="M4 1V0h6v1h4v2H0V1h4zm1 3h1v8H5V4zm3 0h1v8H8V4zM1 3h12l-1 11H2L1 3z"/>
      </svg>
    </button>
  </div>

  {#if !isConfigured}
    <div class="ai-unconfigured">
      <p>{$t('ai.unconfigured')}</p>
      <p class="hint">{$t('ai.unconfiguredHint')}</p>
    </div>
  {:else}
    <div class="ai-messages" bind:this={messagesEl} onscroll={handleMessagesScroll}>
      {#if chatMessages.length === 0 && !isLoading}
        <div class="ai-welcome">
          <p class="welcome-title">{$t('ai.welcomeTitle')}</p>
          <p class="welcome-hint">{$t('ai.welcomeHint', { kbd: '/' })}</p>
          <div class="quick-commands">
            {#each AI_COMMANDS.slice(0, 4) as cmd}
              <button class="quick-cmd" onclick={() => handleCommand(cmd.command)}>
                <span class="cmd-icon">{cmd.icon}</span>
                <span>{$t(cmd.labelKey)}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#each chatMessages as msg}
        <div class="message {msg.role}">
          <div class="message-header">
            <span class="message-role">{msg.role === 'user' ? $t('ai.you') : $t('ai.assistant')}</span>
          </div>
          <div class="message-content">{msg.content}</div>
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
      {/each}

      {#if isLoading && streamingContent}
        <div class="message assistant streaming">
          <div class="message-header">
            <span class="message-role">{$t('ai.assistant')}</span>
          </div>
          <div class="message-content">{streamingContent}</div>
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
          <span>{error}</span>
        </div>
      {/if}
    </div>

    <div class="ai-input-area">
      {#if showCommands}
        <div class="commands-dropdown">
          {#each AI_COMMANDS as cmd}
            <button
              class="command-item"
              onclick={() => handleCommand(cmd.command)}
              disabled={cmd.requiresSelection && !selectedText}
            >
              <span class="cmd-icon">{cmd.icon}</span>
              <div class="cmd-info">
                <span class="cmd-name">{$t(cmd.labelKey)}</span>
                <span class="cmd-desc">{$t(cmd.descriptionKey)}</span>
              </div>
            </button>
          {/each}
        </div>
      {/if}

      <div class="input-row">
        <textarea
          class="ai-input"
          bind:value={inputText}
          onkeydown={handleKeydown}
          placeholder={selectedText ? $t('ai.placeholderSelection') : $t('ai.placeholder')}
          rows={1}
          disabled={isLoading}
        ></textarea>
        <button
          class="send-btn"
          onclick={handleSend}
          disabled={!inputText.trim() || isLoading}
          title={$t('ai.send')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 1l14 7-14 7V9l10-1-10-1V1z"/>
          </svg>
        </button>
      </div>
    </div>
  {/if}
</div>

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

  .ai-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border-light);
  }

  .ai-title {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
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

  .ai-welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem 1rem;
    text-align: center;
    gap: 0.5rem;
  }

  .welcome-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .welcome-hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .quick-commands {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-top: 0.75rem;
    width: 100%;
  }

  .quick-cmd {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.5rem;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-secondary);
    border-radius: 6px;
    cursor: pointer;
    font-size: var(--font-size-xs);
    transition: all var(--transition-fast);
  }

  .quick-cmd:hover {
    border-color: var(--accent-color);
    color: var(--text-primary);
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
  }

  .message.streaming {
    border-color: var(--accent-color);
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
    position: absolute;
    left: 0.5rem;
    bottom: 0.3rem;
    font-size: 10px;
    color: var(--text-muted);
  }

  .message.user .message-time {
    color: rgba(255, 255, 255, 0.5);
  }

  .message-content {
    white-space: pre-wrap;
    word-break: break-word;
    padding-bottom: 1.25rem;
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
    position: absolute;
    left: 0.5rem;
    bottom: 0.3rem;
    font-size: 10px;
    color: var(--accent-color);
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

  .commands-dropdown {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    margin: 0 0.5rem 0.25rem;
    max-height: 280px;
    overflow-y: auto;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.1);
    z-index: 10;
  }

  .command-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
  }

  .command-item:hover {
    background: var(--bg-hover);
  }

  .command-item:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .cmd-info {
    display: flex;
    flex-direction: column;
  }

  .cmd-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
  }

  .cmd-desc {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .input-row {
    display: flex;
    align-items: flex-end;
    gap: 0.35rem;
  }

  .ai-input {
    flex: 1;
    resize: none;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: var(--font-size-sm);
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.4;
    max-height: 100px;
    outline: none;
  }

  .ai-input:focus {
    border-color: var(--accent-color);
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

  .send-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .send-btn:not(:disabled):hover {
    opacity: 0.85;
  }
</style>

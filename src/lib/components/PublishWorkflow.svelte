<script lang="ts">
  import { t } from '$lib/i18n';
  import { mcpStore, type MCPTool, type MCPServerConfig } from '$lib/services/mcp';

  let {
    onClose,
    onSEO,
    onImageGen,
    onPublish,
    onMCPTool,
    seoCompleted = false,
    imageGenCompleted = false,
  }: {
    onClose: () => void;
    onSEO: () => void;
    onImageGen: () => void;
    onPublish: () => void;
    onMCPTool?: (tool: MCPTool, server: MCPServerConfig) => void;
    seoCompleted?: boolean;
    imageGenCompleted?: boolean;
  } = $props();

  const tr = $t;

  // Connected MCP servers that have tools
  let mcpServers = $derived.by(() => {
    const state = $mcpStore;
    return state.servers.filter(s => state.connectedServers.has(s.id) && state.tools.some(t => t.serverId === s.id));
  });

  let showMCPPopup = $state(false);
  let expandedServerId = $state<string | null>(null);

  function openMCPPopup() {
    showMCPPopup = true;
    expandedServerId = null;
  }

  function closeMCPPopup() {
    showMCPPopup = false;
    expandedServerId = null;
  }

  function toggleServer(serverId: string) {
    expandedServerId = expandedServerId === serverId ? null : serverId;
  }

  function getToolsForServer(serverId: string): MCPTool[] {
    return $mcpStore.tools.filter(t => t.serverId === serverId);
  }

  function handleToolClick(tool: MCPTool) {
    const server = $mcpStore.servers.find(s => s.id === tool.serverId);
    if (server && onMCPTool) {
      onMCPTool(tool, server);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="workflow-backdrop" onclick={onClose}>
  <div class="workflow-panel" onclick={(e) => e.stopPropagation()}>
    <div class="panel-header">
      <h3>{tr('workflow.title')}</h3>
      <button class="close-btn" onclick={onClose} aria-label="Close">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path fill="currentColor" d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z"/>
        </svg>
      </button>
    </div>

    <div class="step-list">
      <!-- SEO step -->
      <button class="step-item" class:done={seoCompleted} onclick={onSEO}>
        <span class="step-icon">✦</span>
        <div class="step-info">
          <span class="step-title">{tr('workflow.seoStep')}</span>
          <span class="step-desc">{tr('seo.stepDescription')}</span>
        </div>
        {#if seoCompleted}<span class="step-done">&#x2705;</span>{/if}
      </button>

      <!-- Image Gen step -->
      <button class="step-item" class:done={imageGenCompleted} onclick={onImageGen}>
        <span class="step-icon">&#x1F3A8;</span>
        <div class="step-info">
          <span class="step-title">{tr('workflow.imageGenStep')}</span>
          <span class="step-desc">{tr('imageGen.stepDescription')}</span>
        </div>
        {#if imageGenCompleted}<span class="step-done">&#x2705;</span>{/if}
      </button>

      <!-- Publish step -->
      <button class="step-item" onclick={onPublish}>
        <span class="step-icon">&#x1F4E4;</span>
        <div class="step-info">
          <span class="step-title">{tr('workflow.publishStep')}</span>
          <span class="step-desc">{tr('workflow.publishDesc')}</span>
        </div>
      </button>

      <!-- MCP entry -->
      {#if mcpServers.length > 0}
        <div class="mcp-divider"></div>
        <button class="step-item" onclick={openMCPPopup}>
          <span class="step-icon mcp-icon">&#x2699;</span>
          <div class="step-info">
            <span class="step-title">{tr('workflow.mcpEntry')}</span>
            <span class="step-desc">{mcpServers.length} {tr('workflow.mcpServerCount')}</span>
          </div>
          <span class="mcp-arrow">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <path d="M3 1l5 4-5 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
            </svg>
          </span>
        </button>
      {/if}
    </div>
  </div>
</div>

<!-- MCP popup layer -->
{#if showMCPPopup}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="mcp-backdrop" onclick={closeMCPPopup}>
    <div class="mcp-popup" onclick={(e) => e.stopPropagation()}>
      <div class="mcp-popup-header">
        <button class="mcp-back-btn" onclick={closeMCPPopup}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor">
            <path d="M9.5 1L3.5 7l6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
          </svg>
        </button>
        <h3>{tr('workflow.mcpEntry')}</h3>
      </div>
      <div class="mcp-server-list">
        {#each mcpServers as server}
          <button class="mcp-server-item" onclick={() => toggleServer(server.id)}>
            <span class="mcp-server-icon">&#x2699;</span>
            <div class="mcp-server-info">
              <span class="mcp-server-name">{server.name}</span>
              <span class="mcp-server-count">{getToolsForServer(server.id).length} {tr('workflow.mcpToolCount')}</span>
            </div>
            <span class="mcp-chevron" class:expanded={expandedServerId === server.id}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <path d="M3 1l5 4-5 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
              </svg>
            </span>
          </button>
          {#if expandedServerId === server.id}
            <div class="mcp-tool-list">
              {#each getToolsForServer(server.id) as tool}
                <button class="mcp-tool-item" onclick={() => handleToolClick(tool)}>
                  <span class="mcp-tool-name">{tool.name}</span>
                  <span class="mcp-tool-desc">{tool.description}</span>
                </button>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .workflow-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
  }

  .workflow-panel {
    position: fixed;
    bottom: 28px; /* above StatusBar */
    right: 1rem;
    width: 300px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12);
    z-index: 101;
    animation: slideUp 0.15s ease-out;
  }

  /* iPadOS: flush with StatusBar top border (40px height + 1px border-top) */
  :global(.platform-ipados) .workflow-panel {
    bottom: 41px;
  }

  @keyframes slideUp {
    from { transform: translateY(10px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--border-light);
  }

  .panel-header h3 {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 3px;
  }

  .close-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .step-list {
    padding: 0.5rem;
  }

  .step-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.6rem 0.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 6px;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .step-item:hover {
    background: var(--bg-hover);
  }

  .step-icon {
    font-size: 0.9rem;
    flex-shrink: 0;
    width: 1.2rem;
    text-align: center;
  }

  .step-item.done .step-title {
    color: var(--text-muted);
  }

  .step-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1;
  }

  .step-title {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
  }

  .step-desc {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .step-done {
    font-size: 0.85rem;
    flex-shrink: 0;
  }

  /* MCP entry in workflow */
  .mcp-divider {
    border-top: 1px solid var(--border-light);
    margin: 0.25rem 0;
  }

  .mcp-icon {
    font-size: 0.85rem;
  }

  .mcp-arrow {
    flex-shrink: 0;
    color: var(--text-muted);
    display: flex;
    align-items: center;
  }

  /* MCP popup */
  .mcp-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
  }

  .mcp-popup {
    position: fixed;
    bottom: 28px;
    right: 1rem;
    width: 300px;
    max-height: 400px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.12);
    z-index: 201;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.12s ease-out;
  }

  :global(.platform-ipados) .mcp-popup {
    bottom: 41px;
  }

  .mcp-popup-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--border-light);
  }

  .mcp-popup-header h3 {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .mcp-back-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    background: transparent;
    color: var(--accent-color);
    cursor: pointer;
    border-radius: 3px;
  }

  .mcp-back-btn:hover {
    background: var(--bg-hover);
  }

  .mcp-server-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
  }

  .mcp-server-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 6px;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .mcp-server-item:hover {
    background: var(--bg-hover);
  }

  .mcp-server-icon {
    font-size: 0.85rem;
    flex-shrink: 0;
    width: 1.2rem;
    text-align: center;
    color: var(--text-muted);
  }

  .mcp-server-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1;
    min-width: 0;
  }

  .mcp-server-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
  }

  .mcp-server-count {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .mcp-chevron {
    flex-shrink: 0;
    color: var(--text-muted);
    transition: transform var(--transition-fast);
    display: flex;
    align-items: center;
  }

  .mcp-chevron.expanded {
    transform: rotate(90deg);
  }

  .mcp-tool-list {
    display: flex;
    flex-direction: column;
    padding-left: 1.7rem;
    gap: 0.1rem;
  }

  .mcp-tool-item {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.35rem 0.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 4px;
    text-align: left;
    width: 100%;
    transition: background var(--transition-fast);
  }

  .mcp-tool-item:hover {
    background: var(--bg-hover);
  }

  .mcp-tool-name {
    font-size: var(--font-size-xs);
    font-weight: 500;
    color: var(--text-primary);
  }

  .mcp-tool-desc {
    font-size: 10px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

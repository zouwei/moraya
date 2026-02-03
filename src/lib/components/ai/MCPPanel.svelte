<script lang="ts">
  import {
    mcpStore,
    connectServer,
    disconnectServer,
    publishDocument,
    syncToKnowledgeBase,
    type MCPServerConfig,
    type PublishTarget,
    type SyncConfig,
  } from '$lib/services/mcp';
  import { t } from '$lib/i18n';

  let {
    documentTitle = 'Untitled',
    documentContent = '',
  }: {
    documentTitle?: string;
    documentContent?: string;
  } = $props();

  let servers = $state<MCPServerConfig[]>([]);
  let connectedServers = $state<Set<string>>(new Set());
  let publishTargets = $state<PublishTarget[]>([]);
  let syncConfigs = $state<SyncConfig[]>([]);
  let isLoading = $state(false);
  let error = $state<string | null>(null);
  let publishStatus = $state<string | null>(null);
  let activeTab = $state<'servers' | 'publish' | 'sync'>('servers');

  // Add server form
  let newServerName = $state('');
  let newServerUrl = $state('');
  let newServerTransport = $state<'http' | 'sse'>('http');
  let showAddServer = $state(false);

  mcpStore.subscribe(state => {
    servers = state.servers;
    connectedServers = state.connectedServers;
    publishTargets = state.publishTargets;
    syncConfigs = state.syncConfigs;
    isLoading = state.isLoading;
    error = state.error;
  });

  async function handleConnect(server: MCPServerConfig) {
    try {
      await connectServer(server);
    } catch {
      // Error handled by store
    }
  }

  async function handleDisconnect(serverId: string) {
    await disconnectServer(serverId);
  }

  function handleAddServer() {
    if (!newServerName.trim() || !newServerUrl.trim()) return;

    const config: MCPServerConfig = {
      id: `mcp-${Date.now()}`,
      name: newServerName.trim(),
      transport: {
        type: newServerTransport,
        url: newServerUrl.trim(),
      },
      enabled: true,
    };

    mcpStore.addServer(config);
    newServerName = '';
    newServerUrl = '';
    showAddServer = false;
  }

  function handleRemoveServer(id: string) {
    disconnectServer(id);
    mcpStore.removeServer(id);
  }

  async function handlePublish(targetId: string) {
    publishStatus = $t('mcp.publish.publishing');
    try {
      const result = await publishDocument({
        title: documentTitle,
        content: documentContent,
        format: 'markdown',
        targetId,
      });
      publishStatus = result.success
        ? $t('mcp.publish.published', { info: result.url || result.message || '' })
        : $t('mcp.publish.failed', { message: result.message || '' });
    } catch (e: any) {
      publishStatus = $t('mcp.publish.error', { message: e.message });
    }
    setTimeout(() => { publishStatus = null; }, 5000);
  }

  async function handleSync(configId: string) {
    try {
      await syncToKnowledgeBase(configId, [
        { path: documentTitle, content: documentContent },
      ]);
    } catch {
      // Error handled by store
    }
  }

  // Publish target form
  let newTargetName = $state('');
  let newTargetServerId = $state('');
  let showAddTarget = $state(false);
</script>

<div class="mcp-panel">
  <div class="mcp-tabs">
    <button class="tab" class:active={activeTab === 'servers'} onclick={() => activeTab = 'servers'}>
      {$t('mcp.tabs.servers')}
    </button>
    <button class="tab" class:active={activeTab === 'publish'} onclick={() => activeTab = 'publish'}>
      {$t('mcp.tabs.publish')}
    </button>
    <button class="tab" class:active={activeTab === 'sync'} onclick={() => activeTab = 'sync'}>
      {$t('mcp.tabs.sync')}
    </button>
  </div>

  {#if activeTab === 'servers'}
    <div class="tab-content">
      {#if servers.length === 0 && !showAddServer}
        <div class="empty-state">
          <p>{$t('mcp.servers.empty')}</p>
          <button class="add-btn" onclick={() => showAddServer = true}>
            {$t('mcp.servers.addServer')}
          </button>
        </div>
      {:else}
        {#each servers as server}
          <div class="server-item">
            <div class="server-info">
              <span class="server-name">{server.name}</span>
              <span class="server-status" class:connected={connectedServers.has(server.id)}>
                {connectedServers.has(server.id) ? $t('mcp.servers.connected') : $t('mcp.servers.disconnected')}
              </span>
            </div>
            <div class="server-actions">
              {#if connectedServers.has(server.id)}
                <button class="btn-sm" onclick={() => handleDisconnect(server.id)}>{$t('common.disconnect')}</button>
              {:else}
                <button class="btn-sm primary" onclick={() => handleConnect(server)}>{$t('common.connect')}</button>
              {/if}
              <button class="btn-sm danger" onclick={() => handleRemoveServer(server.id)}>{$t('common.remove')}</button>
            </div>
          </div>
        {/each}

        {#if !showAddServer}
          <button class="add-btn" onclick={() => showAddServer = true}>
            {$t('mcp.servers.addServerPlus')}
          </button>
        {/if}
      {/if}

      {#if showAddServer}
        <div class="add-form">
          <input
            type="text"
            class="form-input"
            bind:value={newServerName}
            placeholder={$t('mcp.servers.serverName')}
          />
          <select class="form-input" bind:value={newServerTransport}>
            <option value="http">{$t('mcp.servers.http')}</option>
            <option value="sse">{$t('mcp.servers.sse')}</option>
          </select>
          <input
            type="text"
            class="form-input"
            bind:value={newServerUrl}
            placeholder={$t('mcp.servers.serverUrl')}
          />
          <div class="form-actions">
            <button class="btn-sm" onclick={() => showAddServer = false}>{$t('common.cancel')}</button>
            <button class="btn-sm primary" onclick={handleAddServer}>{$t('common.add')}</button>
          </div>
        </div>
      {/if}
    </div>

  {:else if activeTab === 'publish'}
    <div class="tab-content">
      {#if publishTargets.length === 0}
        <div class="empty-state">
          <p>{$t('mcp.publish.empty')}</p>
          <p class="hint">{$t('mcp.publish.hint')}</p>
        </div>
      {:else}
        {#each publishTargets as target}
          <div class="target-item">
            <div class="target-info">
              <span class="target-name">{target.name}</span>
              <span class="target-type">{target.type}</span>
            </div>
            <button class="btn-sm primary" onclick={() => handlePublish(target.id)}>
              {$t('mcp.publish.button')}
            </button>
          </div>
        {/each}
      {/if}

      {#if publishStatus}
        <div class="status-message">{publishStatus}</div>
      {/if}
    </div>

  {:else if activeTab === 'sync'}
    <div class="tab-content">
      {#if syncConfigs.length === 0}
        <div class="empty-state">
          <p>{$t('mcp.sync.empty')}</p>
          <p class="hint">{$t('mcp.sync.hint')}</p>
        </div>
      {:else}
        {#each syncConfigs as config}
          <div class="sync-item">
            <div class="sync-info">
              <span class="sync-name">{config.name}</span>
              <span class="sync-path">{config.remotePath}</span>
            </div>
            <button class="btn-sm primary" onclick={() => handleSync(config.id)}>
              {$t('mcp.sync.syncNow')}
            </button>
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  {#if error}
    <div class="error-bar">{error}</div>
  {/if}
</div>

<style>
  .mcp-panel {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .mcp-tabs {
    display: flex;
    border-bottom: 1px solid var(--border-light);
    padding: 0 0.5rem;
  }

  .tab {
    flex: 1;
    padding: 0.5rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    font-weight: 500;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all var(--transition-fast);
  }

  .tab:hover { color: var(--text-secondary); }
  .tab.active {
    color: var(--accent-color);
    border-bottom-color: var(--accent-color);
  }

  .tab-content {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .empty-state {
    text-align: center;
    padding: 1.5rem 0.5rem;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .hint { font-size: var(--font-size-xs); margin-top: 0.25rem; }

  .server-item, .target-item, .sync-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem;
    border: 1px solid var(--border-light);
    border-radius: 6px;
    gap: 0.5rem;
  }

  .server-info, .target-info, .sync-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .server-name, .target-name, .sync-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .server-status {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .server-status.connected { color: #28a745; }

  .target-type, .sync-path {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .server-actions {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .btn-sm {
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
  }

  .btn-sm:hover { background: var(--bg-hover); }
  .btn-sm.primary { border-color: var(--accent-color); color: var(--accent-color); }
  .btn-sm.primary:hover { background: var(--accent-color); color: white; }
  .btn-sm.danger { border-color: #dc3545; color: #dc3545; }
  .btn-sm.danger:hover { background: #dc3545; color: white; }

  .add-btn {
    padding: 0.4rem;
    border: 1px dashed var(--border-color);
    background: transparent;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
    font-size: var(--font-size-sm);
    text-align: center;
  }

  .add-btn:hover {
    border-color: var(--accent-color);
    color: var(--accent-color);
  }

  .add-form {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
  }

  .form-input {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: var(--font-sans);
  }

  .form-input:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.35rem;
  }

  .status-message {
    font-size: var(--font-size-xs);
    padding: 0.4rem 0.5rem;
    border-radius: 4px;
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .error-bar {
    padding: 0.4rem 0.75rem;
    background: #fee;
    border-top: 1px solid #fcc;
    color: #c33;
    font-size: var(--font-size-xs);
  }
</style>

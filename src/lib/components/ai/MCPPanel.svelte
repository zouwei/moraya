<script lang="ts">
  import {
    mcpStore,
    connectServer,
    disconnectServer,
    publishDocument,
    syncToKnowledgeBase,
    addSyncConfig,
    removeSyncConfig,
    discoverPublishTargets,
    MCP_PRESETS,
    type MCPServerConfig,
    type PublishTarget,
    type SyncConfig,
    type SyncStatus,
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
  let syncStatuses = $state<Map<string, SyncStatus>>(new Map());
  let isLoading = $state(false);
  let error = $state<string | null>(null);
  let publishStatus = $state<string | null>(null);
  let activeTab = $state<'servers' | 'publish' | 'sync'>('servers');

  // Add server form
  let newServerName = $state('');
  let newServerUrl = $state('');
  let newServerCommand = $state('');
  let newServerArgs = $state('');
  let newServerTransport = $state<'http' | 'sse' | 'stdio'>('stdio');
  let showAddServer = $state(false);
  let addMode = $state<'form' | 'json'>('form');
  let jsonInput = $state('');
  let jsonError = $state<string | null>(null);

  // Edit server form
  let editingServerId = $state<string | null>(null);
  let editName = $state('');
  let editTransport = $state<'http' | 'sse' | 'stdio'>('stdio');
  let editCommand = $state('');
  let editArgs = $state('');
  let editUrl = $state('');

  mcpStore.subscribe(state => {
    servers = state.servers;
    connectedServers = state.connectedServers;
    publishTargets = state.publishTargets;
    syncConfigs = state.syncConfigs;
    syncStatuses = state.syncStatuses;
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
    if (!newServerName.trim()) return;

    let transport: MCPServerConfig['transport'];
    if (newServerTransport === 'stdio') {
      if (!newServerCommand.trim()) return;
      const args = newServerArgs.trim() ? newServerArgs.trim().split(/\s+/) : [];
      transport = { type: 'stdio', command: newServerCommand.trim(), args };
    } else {
      if (!newServerUrl.trim()) return;
      transport = { type: newServerTransport, url: newServerUrl.trim() };
    }

    const config: MCPServerConfig = {
      id: `mcp-${Date.now()}`,
      name: newServerName.trim(),
      transport,
      enabled: true,
    };

    mcpStore.addServer(config);
    newServerName = '';
    newServerUrl = '';
    newServerCommand = '';
    newServerArgs = '';
    showAddServer = false;
  }

  function buildTransport(sc: Record<string, unknown>): MCPServerConfig['transport'] {
    if (sc.command) {
      return {
        type: 'stdio' as const,
        command: sc.command as string,
        args: (sc.args as string[]) || [],
        env: sc.env as Record<string, string> | undefined,
      };
    } else if (sc.url) {
      const t = (sc.type as string) || 'http';
      return { type: t as 'http' | 'sse', url: sc.url as string };
    }
    throw new Error('Invalid config: need "command" or "url"');
  }

  function inferServerName(sc: Record<string, unknown>): string {
    const args = (sc.args as string[]) || [];
    const pkg = args.find((a: string) => a.startsWith('@') && a.includes('server-'));
    if (pkg) {
      const match = pkg.match(/server-(.+)/);
      return match ? match[1] : pkg;
    }
    return (sc.command as string) || 'mcp-server';
  }

  function parseMCPJSON(data: Record<string, unknown>): MCPServerConfig[] {
    const configs: MCPServerConfig[] = [];

    // Format 1: Claude Desktop { mcpServers: { name: config } }
    if (data.mcpServers && typeof data.mcpServers === 'object') {
      for (const [name, serverConfig] of Object.entries(data.mcpServers as Record<string, unknown>)) {
        const sc = serverConfig as Record<string, unknown>;
        configs.push({
          id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name,
          transport: buildTransport(sc),
          enabled: true,
        });
      }
      return configs;
    }

    // Format 2/3: Single server { name?, command, args } or { url }
    if (data.command || data.url) {
      const name = (data.name as string) || inferServerName(data);
      configs.push({
        id: `mcp-${Date.now()}`,
        name,
        transport: buildTransport(data),
        enabled: true,
      });
      return configs;
    }

    return configs;
  }

  function handleAddFromJSON() {
    jsonError = null;
    const trimmed = jsonInput.trim();
    if (!trimmed) return;

    try {
      const parsed = JSON.parse(trimmed);
      const configs = parseMCPJSON(parsed);
      if (configs.length === 0) {
        jsonError = $t('mcp.servers.jsonNoConfig');
        return;
      }
      for (const config of configs) {
        mcpStore.addServer(config);
      }
      jsonInput = '';
      jsonError = null;
      showAddServer = false;
      addMode = 'form';
    } catch (e: any) {
      jsonError = `JSON ${$t('mcp.servers.jsonParseError')}: ${e.message}`;
    }
  }

  function handleRemoveServer(id: string) {
    disconnectServer(id);
    mcpStore.removeServer(id);
  }

  function startEdit(server: MCPServerConfig) {
    editingServerId = server.id;
    editName = server.name;
    editTransport = server.transport.type as 'http' | 'sse' | 'stdio';
    if (server.transport.type === 'stdio') {
      editCommand = server.transport.command;
      editArgs = (server.transport.args || []).join(' ');
      editUrl = '';
    } else {
      editCommand = '';
      editArgs = '';
      editUrl = server.transport.url;
    }
  }

  function cancelEdit() {
    editingServerId = null;
  }

  async function handleSaveEdit() {
    if (!editingServerId || !editName.trim()) return;

    let transport: MCPServerConfig['transport'];
    if (editTransport === 'stdio') {
      if (!editCommand.trim()) return;
      const args = editArgs.trim() ? editArgs.trim().split(/\s+/) : [];
      transport = { type: 'stdio', command: editCommand.trim(), args };
    } else {
      if (!editUrl.trim()) return;
      transport = { type: editTransport, url: editUrl.trim() };
    }

    const wasConnected = connectedServers.has(editingServerId);

    const updatedConfig: MCPServerConfig = {
      id: editingServerId,
      name: editName.trim(),
      transport,
      enabled: true,
    };

    // Disconnect first if connected, then update and reconnect
    if (wasConnected) {
      await disconnectServer(editingServerId);
    }
    mcpStore.addServer(updatedConfig);
    if (wasConnected) {
      try { await connectServer(updatedConfig); } catch { /* ignore */ }
    }

    editingServerId = null;
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

  // Presets
  function addFromPreset(preset: typeof MCP_PRESETS[0]) {
    const config: MCPServerConfig = {
      id: `mcp-${Date.now()}`,
      ...preset.createConfig(),
    };
    mcpStore.addServer(config);
  }

  function isPresetAdded(presetName: string): boolean {
    return servers.some(s => s.name === presetName);
  }

  // Sync config form
  let showAddSync = $state(false);
  let newSyncName = $state('');
  let newSyncServerId = $state('');
  let newSyncRemotePath = $state('');
  let newSyncLocalPath = $state('');
  let newSyncDirection = $state<'push' | 'pull' | 'bidirectional'>('push');

  function handleAddSync() {
    if (!newSyncName.trim() || !newSyncServerId) return;
    addSyncConfig({
      id: `sync-${Date.now()}`,
      name: newSyncName.trim(),
      mcpServerId: newSyncServerId,
      remotePath: newSyncRemotePath.trim(),
      localPath: newSyncLocalPath.trim(),
      autoSync: false,
      syncInterval: 300000,
      direction: newSyncDirection,
      conflictResolution: 'local-wins',
    });
    newSyncName = '';
    newSyncServerId = '';
    newSyncRemotePath = '';
    newSyncLocalPath = '';
    showAddSync = false;
  }

  function handleRemoveSync(configId: string) {
    removeSyncConfig(configId);
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
      <!-- Presets section -->
      {#if MCP_PRESETS.some(p => !isPresetAdded(p.name))}
        <div class="presets-section">
          <div class="section-label">{$t('mcp.servers.presets')}</div>
          <div class="presets-grid">
            {#each MCP_PRESETS as preset}
              {#if !isPresetAdded(preset.name)}
                <button class="preset-item" onclick={() => addFromPreset(preset)}>
                  <div class="preset-info">
                    <span class="preset-name">{preset.name}</span>
                    <span class="preset-desc">{preset.descriptionZh}</span>
                  </div>
                  <span class="preset-add">+</span>
                </button>
              {/if}
            {/each}
          </div>
        </div>
      {/if}

      {#if servers.length === 0 && !showAddServer && MCP_PRESETS.every(p => !isPresetAdded(p.name))}
        <div class="empty-state">
          <p>{$t('mcp.servers.empty')}</p>
          <button class="add-btn" onclick={() => showAddServer = true}>
            {$t('mcp.servers.addServer')}
          </button>
        </div>
      {:else}
        {#each servers as server}
          {#if editingServerId === server.id}
            <div class="add-form">
              <input
                type="text"
                class="form-input"
                bind:value={editName}
                placeholder={$t('mcp.servers.serverName')}
              />
              <select class="form-input" bind:value={editTransport}>
                <option value="stdio">{$t('mcp.servers.stdio')}</option>
                <option value="http">{$t('mcp.servers.http')}</option>
                <option value="sse">{$t('mcp.servers.sse')}</option>
              </select>
              {#if editTransport === 'stdio'}
                <input
                  type="text"
                  class="form-input"
                  bind:value={editCommand}
                  placeholder={$t('mcp.servers.commandPlaceholder')}
                />
                <input
                  type="text"
                  class="form-input"
                  bind:value={editArgs}
                  placeholder={$t('mcp.servers.argsPlaceholder')}
                />
              {:else}
                <input
                  type="text"
                  class="form-input"
                  bind:value={editUrl}
                  placeholder={$t('mcp.servers.serverUrl')}
                />
              {/if}
              <div class="form-actions">
                <button class="btn-sm" onclick={cancelEdit}>{$t('common.cancel')}</button>
                <button class="btn-sm primary" onclick={handleSaveEdit}>{$t('common.save')}</button>
              </div>
            </div>
          {:else}
            <div class="server-item">
              <div class="server-info">
                <span class="server-name">{server.name}</span>
                <div class="server-meta">
                  <span class="server-transport-label">{server.transport.type}</span>
                  <span class="server-status" class:connected={connectedServers.has(server.id)}>
                    {connectedServers.has(server.id) ? $t('mcp.servers.connected') : $t('mcp.servers.disconnected')}
                  </span>
                </div>
              </div>
              <div class="server-actions">
                <button class="btn-sm" onclick={() => startEdit(server)}>{$t('common.edit')}</button>
                {#if connectedServers.has(server.id)}
                  <button class="btn-sm" onclick={() => handleDisconnect(server.id)}>{$t('common.disconnect')}</button>
                {:else}
                  <button class="btn-sm primary" onclick={() => handleConnect(server)}>{$t('common.connect')}</button>
                {/if}
                <button class="btn-sm danger" onclick={() => handleRemoveServer(server.id)}>{$t('common.remove')}</button>
              </div>
            </div>
          {/if}
        {/each}

        {#if !showAddServer}
          <button class="add-btn" onclick={() => showAddServer = true}>
            {$t('mcp.servers.addServerPlus')}
          </button>
        {/if}
      {/if}

      {#if showAddServer}
        <div class="add-form">
          <div class="add-mode-tabs">
            <button class="mode-tab" class:active={addMode === 'form'} onclick={() => addMode = 'form'}>
              {$t('mcp.servers.formMode')}
            </button>
            <button class="mode-tab" class:active={addMode === 'json'} onclick={() => addMode = 'json'}>
              {$t('mcp.servers.jsonMode')}
            </button>
          </div>

          {#if addMode === 'json'}
            <textarea
              class="form-input json-input"
              bind:value={jsonInput}
              placeholder={$t('mcp.servers.jsonPlaceholder')}
              rows="8"
            ></textarea>
            {#if jsonError}
              <div class="json-error">{jsonError}</div>
            {/if}
            <div class="form-actions">
              <button class="btn-sm" onclick={() => { showAddServer = false; addMode = 'form'; jsonError = null; }}>{$t('common.cancel')}</button>
              <button class="btn-sm primary" onclick={handleAddFromJSON}>{$t('common.add')}</button>
            </div>
          {:else}
            <input
              type="text"
              class="form-input"
              bind:value={newServerName}
              placeholder={$t('mcp.servers.serverName')}
            />
            <select class="form-input" bind:value={newServerTransport}>
              <option value="stdio">{$t('mcp.servers.stdio')}</option>
              <option value="http">{$t('mcp.servers.http')}</option>
              <option value="sse">{$t('mcp.servers.sse')}</option>
            </select>
            {#if newServerTransport === 'stdio'}
              <input
                type="text"
                class="form-input"
                bind:value={newServerCommand}
                placeholder={$t('mcp.servers.commandPlaceholder')}
              />
              <input
                type="text"
                class="form-input"
                bind:value={newServerArgs}
                placeholder={$t('mcp.servers.argsPlaceholder')}
              />
            {:else}
              <input
                type="text"
                class="form-input"
                bind:value={newServerUrl}
                placeholder={$t('mcp.servers.serverUrl')}
              />
            {/if}
            <div class="form-actions">
              <button class="btn-sm" onclick={() => showAddServer = false}>{$t('common.cancel')}</button>
              <button class="btn-sm primary" onclick={handleAddServer}>{$t('common.add')}</button>
            </div>
          {/if}
        </div>
      {/if}
    </div>

  {:else if activeTab === 'publish'}
    <div class="tab-content">
      {#if [...publishTargets, ...discoverPublishTargets()].length === 0}
        <div class="empty-state">
          <p>{$t('mcp.publish.empty')}</p>
          <p class="hint">{$t('mcp.publish.hint')}</p>
        </div>
      {:else}
        {#each [...publishTargets, ...discoverPublishTargets()] as target}
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
      {#if syncConfigs.length === 0 && !showAddSync}
        <div class="empty-state">
          <p>{$t('mcp.sync.empty')}</p>
          <p class="hint">{$t('mcp.sync.hint')}</p>
          {#if [...connectedServers].length > 0}
            <button class="add-btn" onclick={() => showAddSync = true}>
              {$t('mcp.sync.addSync')}
            </button>
          {/if}
        </div>
      {:else}
        {#each syncConfigs as config}
          {@const status = syncStatuses.get(config.id)}
          <div class="sync-item">
            <div class="sync-info">
              <span class="sync-name">{config.name}</span>
              <div class="sync-meta">
                <span class="sync-path">{config.direction}</span>
                <span class="sync-path">{config.remotePath}</span>
              </div>
              {#if status}
                <span class="sync-status" class:sync-error={status.status === 'error'} class:sync-success={status.status === 'success'}>
                  {#if status.status === 'syncing'}
                    {$t('mcp.sync.syncing')}
                  {:else if status.status === 'success'}
                    {$t('mcp.sync.success')} ({status.filesChanged} files)
                  {:else if status.status === 'error'}
                    {status.error}
                  {/if}
                </span>
              {/if}
            </div>
            <div class="server-actions">
              <button class="btn-sm primary" onclick={() => handleSync(config.id)} disabled={status?.status === 'syncing'}>
                {$t('mcp.sync.syncNow')}
              </button>
              <button class="btn-sm danger" onclick={() => handleRemoveSync(config.id)}>
                {$t('common.remove')}
              </button>
            </div>
          </div>
        {/each}

        {#if !showAddSync}
          <button class="add-btn" onclick={() => showAddSync = true}>
            {$t('mcp.sync.addSync')}
          </button>
        {/if}
      {/if}

      {#if showAddSync}
        <div class="add-form">
          <input type="text" class="form-input" bind:value={newSyncName} placeholder={$t('mcp.sync.name')} />
          <select class="form-input" bind:value={newSyncServerId}>
            <option value="" disabled>{$t('mcp.sync.server')}</option>
            {#each servers.filter(s => connectedServers.has(s.id)) as server}
              <option value={server.id}>{server.name}</option>
            {/each}
          </select>
          <input type="text" class="form-input" bind:value={newSyncRemotePath} placeholder={$t('mcp.sync.remotePath')} />
          <input type="text" class="form-input" bind:value={newSyncLocalPath} placeholder={$t('mcp.sync.localPath')} />
          <select class="form-input" bind:value={newSyncDirection}>
            <option value="push">{$t('mcp.sync.push')}</option>
            <option value="pull">{$t('mcp.sync.pull')}</option>
            <option value="bidirectional">{$t('mcp.sync.bidirectional')}</option>
          </select>
          <div class="form-actions">
            <button class="btn-sm" onclick={() => showAddSync = false}>{$t('common.cancel')}</button>
            <button class="btn-sm primary" onclick={handleAddSync}>{$t('common.add')}</button>
          </div>
        </div>
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

  .server-meta {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .server-transport-label {
    font-size: 10px;
    padding: 0 0.3rem;
    border-radius: 3px;
    background: var(--bg-hover);
    color: var(--text-muted);
    font-family: var(--font-mono, monospace);
  }

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

  .presets-section {
    margin-bottom: 0.5rem;
  }

  .section-label {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin-bottom: 0.35rem;
  }

  .presets-grid {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .preset-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.5rem;
    border: 1px dashed var(--border-color);
    background: transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: all var(--transition-fast);
    text-align: left;
  }

  .preset-item:hover {
    border-color: var(--accent-color);
    border-style: solid;
    background: var(--bg-hover);
  }

  .preset-info {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    min-width: 0;
  }

  .preset-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
  }

  .preset-desc {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preset-add {
    font-size: 1.1rem;
    color: var(--accent-color);
    font-weight: 600;
    flex-shrink: 0;
    margin-left: 0.5rem;
  }

  .sync-meta {
    display: flex;
    gap: 0.35rem;
    align-items: center;
  }

  .sync-status {
    font-size: 10px;
    color: var(--text-muted);
  }

  .sync-status.sync-success { color: #28a745; }
  .sync-status.sync-error { color: #dc3545; }

  .add-mode-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border-light);
    margin-bottom: 0.4rem;
  }

  .mode-tab {
    flex: 1;
    padding: 0.3rem 0.5rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }

  .mode-tab:hover { color: var(--text-secondary); }
  .mode-tab.active {
    color: var(--accent-color);
    border-bottom-color: var(--accent-color);
  }

  .json-input {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    resize: vertical;
    min-height: 80px;
    line-height: 1.4;
  }

  .json-error {
    font-size: 11px;
    color: #dc3545;
    padding: 0.2rem 0;
  }

  .error-bar {
    padding: 0.4rem 0.75rem;
    background: #fee;
    border-top: 1px solid #fcc;
    color: #c33;
    font-size: var(--font-size-xs);
  }
</style>

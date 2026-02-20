<script lang="ts">
  import { onMount } from 'svelte';
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
    searchMarketplace,
    loadMarketplaceSource,
    saveMarketplaceSource,
    MARKETPLACE_SOURCES,
    type MCPServerConfig,
    type PublishTarget,
    type SyncConfig,
    type SyncStatus,
    type MarketplaceServer,
    type MarketplaceSource,
  } from '$lib/services/mcp';
  import { t } from '$lib/i18n';
  import { isIPadOS } from '$lib/utils/platform';
  import { ask } from '@tauri-apps/plugin-dialog';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { containerStore, type DynamicService } from '$lib/services/mcp/container-store';
  import { saveService, removeService } from '$lib/services/mcp/container-manager';
  import { invoke } from '@tauri-apps/api/core';
  import { settingsStore } from '$lib/stores/settings-store';

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
  let activeTab = $state<'servers' | 'publish' | 'sync' | 'marketplace'>('servers');

  // Dynamic AI services state
  let dynamicServices = $state<DynamicService[]>([]);
  let nodeAvailable = $state<boolean | null>(null);
  let nodeVersion = $state<string | null>(null);
  let expandedServiceId = $state<string | null>(null);

  // Marketplace state
  let mpSource = $state<MarketplaceSource>('official');
  let mpQuery = $state('');
  let mpResults = $state<MarketplaceServer[]>([]);
  let mpLoading = $state(false);
  let mpHasMore = $state(false);
  let mpPage = $state(1);
  let mpError = $state<string | null>(null);
  let mpInstalling = $state<MarketplaceServer | null>(null);
  let mpEnvValues = $state<Record<string, string>>({});
  let mpSearchTimer: ReturnType<typeof setTimeout> | null = null;

  // Add server form
  let newServerName = $state('');
  let newServerUrl = $state('');
  let newServerCommand = $state('');
  let newServerArgs = $state('');
  let newServerEnv = $state('');
  let newServerTransport = $state<'http' | 'sse' | 'stdio'>(isIPadOS ? 'http' : 'stdio');
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
  let editEnv = $state('');

  mcpStore.subscribe(state => {
    servers = state.servers;
    connectedServers = state.connectedServers;
    publishTargets = state.publishTargets;
    syncConfigs = state.syncConfigs;
    syncStatuses = state.syncStatuses;
    isLoading = state.isLoading;
    error = state.error;
  });

  containerStore.subscribe(state => {
    dynamicServices = state.services;
    nodeAvailable = state.nodeAvailable;
    nodeVersion = state.nodeVersion;
  });

  async function handleConnect(server: MCPServerConfig) {
    try {
      // Show security confirmation for stdio servers (launching local processes)
      // Skip if auto-approve is enabled
      if (server.transport.type === 'stdio' && !settingsStore.getState().mcpAutoApprove) {
        const args = server.transport.args?.join(' ') || '';
        const confirmed = await ask(
          $t('mcp.servers.launchConfirmMsg', {
            command: server.transport.command,
            args: args || '(none)',
          }),
          {
            title: $t('mcp.servers.launchConfirmTitle'),
            kind: 'warning',
            okLabel: $t('mcp.servers.launchConfirmOk'),
            cancelLabel: $t('mcp.servers.launchConfirmCancel'),
          },
        );
        if (!confirmed) return;
      }
      await connectServer(server);
    } catch {
      // Error handled by store
    }
  }

  async function handleDisconnect(serverId: string) {
    await disconnectServer(serverId);
  }

  /** Parse "KEY=VALUE" lines into a Record, returns undefined if empty */
  function parseEnvString(envStr: string): Record<string, string> | undefined {
    const lines = envStr.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return undefined;
    const env: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    return Object.keys(env).length > 0 ? env : undefined;
  }

  /** Serialize env Record to "KEY=VALUE" lines */
  function envToString(env?: Record<string, string>): string {
    if (!env) return '';
    return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
  }

  function handleAddServer() {
    if (!newServerName.trim()) return;

    let transport: MCPServerConfig['transport'];
    if (newServerTransport === 'stdio') {
      if (!newServerCommand.trim()) return;
      const args = newServerArgs.trim() ? newServerArgs.trim().split(/\s+/) : [];
      transport = { type: 'stdio', command: newServerCommand.trim(), args, env: parseEnvString(newServerEnv) };
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
    newServerEnv = '';
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
      editEnv = envToString(server.transport.env);
      editUrl = '';
    } else {
      editCommand = '';
      editArgs = '';
      editEnv = '';
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
      transport = { type: 'stdio', command: editCommand.trim(), args, env: parseEnvString(editEnv) };
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
      id: `preset-${preset.id}`,
      ...preset.createConfig(),
    };
    mcpStore.addServer(config);
  }

  function isPresetAdded(presetId: string): boolean {
    return servers.some(s => s.id === `preset-${presetId}`);
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

  // ── Marketplace functions ──

  onMount(async () => {
    mpSource = await loadMarketplaceSource();
  });

  async function mpSearch(page = 1) {
    mpLoading = true;
    mpError = null;
    try {
      const result = await searchMarketplace(mpSource, {
        query: mpQuery,
        page,
        pageSize: 20,
      });
      if (page === 1) {
        mpResults = result.servers;
      } else {
        mpResults = [...mpResults, ...result.servers];
      }
      mpPage = page;
      mpHasMore = result.hasMore;
    } catch (e: any) {
      mpError = e.message || String(e);
    } finally {
      mpLoading = false;
    }
  }

  function mpOnQueryInput() {
    if (mpSearchTimer) clearTimeout(mpSearchTimer);
    mpSearchTimer = setTimeout(() => mpSearch(1), 400);
  }

  async function mpChangeSource(source: MarketplaceSource) {
    mpSource = source;
    await saveMarketplaceSource(source);
    mpResults = [];
    mpPage = 1;
    mpHasMore = false;
    mpSearch(1);
  }

  function mpStartInstall(server: MarketplaceServer) {
    mpInstalling = server;
    mpEnvValues = {};
    if (server.install?.envVars) {
      for (const ev of server.install.envVars) {
        mpEnvValues[ev.name] = '';
      }
    }
  }

  function mpCancelInstall() {
    mpInstalling = null;
    mpEnvValues = {};
  }

  async function mpConfirmInstall() {
    if (!mpInstalling?.install) return;
    const inst = mpInstalling.install;
    const serverName = mpInstalling.name;
    let transport: MCPServerConfig['transport'];
    if (inst.transport === 'stdio') {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(mpEnvValues)) {
        if (v.trim()) env[k] = v.trim();
      }
      transport = {
        type: 'stdio',
        command: inst.command || 'npx',
        args: inst.args || [],
        env: Object.keys(env).length > 0 ? env : undefined,
      };
    } else {
      transport = { type: inst.transport as 'http' | 'sse', url: inst.url || '' };
    }

    const config: MCPServerConfig = {
      id: `mcp-${Date.now()}`,
      name: serverName,
      transport,
      enabled: true,
    };
    mcpStore.addServer(config);
    mpInstalling = null;
    mpEnvValues = {};

    // Switch to servers tab so user can see the new server
    activeTab = 'servers';

    try {
      await connectServer(config);
    } catch {
      // Server is added but connection failed — user can retry from servers tab
    }
  }

  function mpIsInstalled(serverName: string): boolean {
    return servers.some(s => s.name === serverName);
  }

  /** Format large numbers: 1234 → "1.2K", 1234567 → "1.2M" */
  function formatCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  // Publish target form
  let newTargetName = $state('');
  let newTargetServerId = $state('');
  let showAddTarget = $state(false);

  // ── Dynamic AI service handlers ──
  let serviceCodeCache = $state<Record<string, string>>({});

  async function toggleServiceCode(serviceId: string) {
    if (expandedServiceId === serviceId) {
      expandedServiceId = null;
      return;
    }
    expandedServiceId = serviceId;
    if (!serviceCodeCache[serviceId]) {
      const svc = dynamicServices.find(s => s.id === serviceId);
      if (svc) {
        try {
          const code = await invoke<string>('read_file', { path: `${svc.serviceDir}/handlers.js` });
          serviceCodeCache = { ...serviceCodeCache, [serviceId]: code };
        } catch {
          serviceCodeCache = { ...serviceCodeCache, [serviceId]: '// Failed to load code' };
        }
      }
    }
  }

  async function handleSaveService(serviceId: string) {
    try {
      await saveService(serviceId);
    } catch { /* handled by store */ }
  }

  async function handleRemoveService(serviceId: string) {
    try {
      await removeService(serviceId);
      if (expandedServiceId === serviceId) expandedServiceId = null;
    } catch { /* handled by store */ }
  }
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
    <button class="tab" class:active={activeTab === 'marketplace'} onclick={() => { activeTab = 'marketplace'; if (mpResults.length === 0 && !mpLoading) mpSearch(1); }}>
      {$t('mcp.tabs.marketplace')}
    </button>
  </div>

  {#if activeTab === 'servers'}
    <div class="tab-content">
      <!-- Presets section -->
      {#if MCP_PRESETS.some(p => !isPresetAdded(p.id))}
        <div class="presets-section">
          <div class="section-label">{$t('mcp.servers.presets')}</div>
          <div class="presets-grid">
            {#each MCP_PRESETS as preset}
              {#if !isPresetAdded(preset.id)}
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

      {#if servers.filter(s => !s.id.startsWith('ai-svc-')).length === 0 && !showAddServer && MCP_PRESETS.every(p => !isPresetAdded(p.id))}
        <div class="empty-state">
          <p>{$t('mcp.servers.empty')}</p>
          <button class="add-btn" onclick={() => showAddServer = true}>
            {$t('mcp.servers.addServer')}
          </button>
        </div>
      {:else}
        {#each servers.filter(s => !s.id.startsWith('ai-svc-')) as server}
          {#if editingServerId === server.id}
            <div class="add-form">
              <input
                type="text"
                class="form-input"
                bind:value={editName}
                placeholder={$t('mcp.servers.serverName')}
              />
              <select class="form-input" bind:value={editTransport}>
                {#if !isIPadOS}<option value="stdio">{$t('mcp.servers.stdio')}</option>{/if}
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
                <textarea
                  class="form-input env-input"
                  bind:value={editEnv}
                  placeholder={$t('mcp.servers.envPlaceholder')}
                  rows="2"
                ></textarea>
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
              {#if !isIPadOS}<option value="stdio">{$t('mcp.servers.stdio')}</option>{/if}
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
              <textarea
                class="form-input env-input"
                bind:value={newServerEnv}
                placeholder={$t('mcp.servers.envPlaceholder')}
                rows="2"
              ></textarea>
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

      <!-- Local MCP (AI-created dynamic services) -->
      <div class="local-mcp-section">
        <div class="section-label">{$t('mcp.servers.localMcp')}</div>
        <div class="node-status">
          <span class="node-dot" class:available={nodeAvailable === true} class:unavailable={nodeAvailable === false}></span>
          {#if nodeAvailable === true}
            <span class="node-label">Node.js {nodeVersion}</span>
          {:else if nodeAvailable === false}
            <span class="node-label node-missing">{$t('mcp.aiServices.nodeRequired')}</span>
          {:else}
            <span class="node-label">{$t('mcp.aiServices.checkingNode')}</span>
          {/if}
        </div>

        {#if dynamicServices.length === 0}
          <div class="empty-state local-mcp-empty">
            <p>{$t('mcp.aiServices.empty')}</p>
            <p class="hint">{$t('mcp.aiServices.hint')}</p>
          </div>
        {:else}
          {#each dynamicServices as service}
            <div class="server-item dyn-service-item">
              <div class="server-info">
                <div class="dyn-service-header">
                  <span class="server-name">{service.name}</span>
                  <span class="lifecycle-badge" class:temp={service.lifecycle === 'temp'} class:saved={service.lifecycle === 'saved'}>
                    {service.lifecycle === 'temp' ? $t('mcp.aiServices.temp') : $t('mcp.aiServices.saved')}
                  </span>
                </div>
                <span class="dyn-service-desc">{service.description}</span>
                <div class="server-meta">
                  <span class="server-status" class:connected={service.status === 'running'} class:dyn-error={service.status === 'error'}>
                    {service.status}
                  </span>
                  <span class="dyn-tool-count">{service.tools.length} tools</span>
                </div>
                {#if service.error}
                  <span class="dyn-error-msg">{service.error}</span>
                {/if}
              </div>
              <div class="server-actions">
                <button class="btn-sm" onclick={() => toggleServiceCode(service.id)}>
                  {$t('mcp.aiServices.viewCode')}
                </button>
                {#if service.lifecycle === 'temp'}
                  <button class="btn-sm primary" onclick={() => handleSaveService(service.id)}>
                    {$t('common.save')}
                  </button>
                {/if}
                <button class="btn-sm danger" onclick={() => handleRemoveService(service.id)}>
                  {$t('common.remove')}
                </button>
              </div>
            </div>
            {#if expandedServiceId === service.id}
              <pre class="service-code">{serviceCodeCache[service.id] || '...'}</pre>
            {/if}
          {/each}
        {/if}
      </div>
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

  {:else if activeTab === 'marketplace'}
    <div class="tab-content">
      <!-- Source selector + search -->
      <div class="mp-toolbar">
        <select class="form-input mp-source-select" value={mpSource} onchange={(e) => mpChangeSource((e.target as HTMLSelectElement).value as MarketplaceSource)}>
          {#each MARKETPLACE_SOURCES as src}
            <option value={src.value}>{$t(src.labelKey)}</option>
          {/each}
        </select>
        <input
          type="text"
          class="form-input mp-search-input"
          placeholder={$t('mcp.marketplace.search')}
          bind:value={mpQuery}
          oninput={mpOnQueryInput}
          onkeydown={(e) => { if (!e.isComposing && e.key === 'Enter') { if (mpSearchTimer) clearTimeout(mpSearchTimer); mpSearch(1); } }}
        />
      </div>

      <!-- Install panel (overlay on card click) -->
      {#if mpInstalling}
        <div class="mp-install-panel">
          <div class="mp-install-header">
            <span class="mp-install-name">{mpInstalling.name}</span>
            <!-- svelte-ignore a11y_missing_attribute -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span class="mp-install-close" onclick={mpCancelInstall} onkeydown={() => {}}>×</span>
          </div>
          <p class="mp-install-desc">{mpInstalling.description}</p>

          {#if mpInstalling.install?.envVars && mpInstalling.install.envVars.length > 0}
            <div class="mp-env-section">
              <div class="section-label">{$t('mcp.marketplace.envVars')}</div>
              {#each mpInstalling.install.envVars as ev}
                <div class="mp-env-row">
                  <label class="mp-env-label">
                    {ev.name}
                    {#if ev.isSecret}<span class="mp-env-secret">*</span>{/if}
                  </label>
                  <input
                    type={ev.isSecret ? 'password' : 'text'}
                    class="form-input"
                    placeholder={ev.description}
                    value={mpEnvValues[ev.name] || ''}
                    oninput={(e) => { mpEnvValues[ev.name] = (e.target as HTMLInputElement).value; mpEnvValues = mpEnvValues; }}
                  />
                </div>
              {/each}
            </div>
          {/if}

          <div class="form-actions">
            <button class="btn-sm" onclick={mpCancelInstall}>{$t('mcp.marketplace.cancel')}</button>
            <button class="btn-sm primary" onclick={mpConfirmInstall}>
              {$t('mcp.marketplace.installAndConnect')}
            </button>
          </div>
        </div>
      {/if}

      <!-- Results -->
      {#if mpError}
        <div class="mp-error">
          <span>{$t('mcp.marketplace.networkError')}: {mpError}</span>
          <button class="btn-sm" onclick={() => mpSearch(mpPage)}>{$t('mcp.marketplace.retry')}</button>
        </div>
      {/if}

      {#if mpResults.length === 0 && !mpLoading && !mpError}
        <div class="empty-state">
          <p>{$t('mcp.marketplace.noResults')}</p>
        </div>
      {/if}

      <div class="mp-grid">
        {#each mpResults as server}
          <div class="mp-card">
            <div class="mp-card-header">
              {#if server.icon}
                <img class="mp-card-icon" src={server.icon} alt="" />
              {:else}
                <div class="mp-card-icon-placeholder">M</div>
              {/if}
              <div class="mp-card-title-area">
                <span class="mp-card-name">{server.name}</span>
                {#if server.author}<span class="mp-card-author">{server.author}</span>{/if}
              </div>
            </div>
            <p class="mp-card-desc">{server.description}</p>
            <div class="mp-card-footer">
              <div class="mp-card-meta">
                {#if server.popularity != null && server.popularity > 0}
                  <span class="mp-card-stat" title={$t('mcp.marketplace.installs')}>
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 110 16A8 8 0 018 0zm.5 4.5v5.793l2.146-2.147a.5.5 0 01.708.708l-3 3a.5.5 0 01-.708 0l-3-3a.5.5 0 01.708-.708L7.5 10.293V4.5a.5.5 0 011 0z"/></svg>
                    {formatCount(server.popularity)}
                  </span>
                {/if}
                {#if server.stars != null && server.stars > 0}
                  <span class="mp-card-stat" title="GitHub Stars">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/></svg>
                    {formatCount(server.stars)}
                  </span>
                {/if}
                {#if server.verified}
                  <span class="mp-card-verified">{$t('mcp.marketplace.verified')}</span>
                {/if}
              </div>
              <div class="mp-card-actions">
                {#if server.homepage}
                  <!-- svelte-ignore a11y_missing_attribute -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <span class="mp-link" onclick={() => server.homepage && openUrl(server.homepage)} onkeydown={() => {}}>{$t('mcp.marketplace.viewDetails')}</span>
                {/if}
                {#if mpIsInstalled(server.name)}
                  <span class="mp-installed-badge">{$t('mcp.marketplace.installed')}</span>
                {:else if server.install}
                  <button class="btn-sm primary" onclick={() => mpStartInstall(server)}>
                    {$t('mcp.marketplace.install')}
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>

      {#if mpLoading}
        <div class="mp-loading">{$t('mcp.marketplace.search')}...</div>
      {/if}

      {#if mpHasMore && !mpLoading}
        <button class="add-btn" onclick={() => mpSearch(mpPage + 1)}>
          {$t('mcp.marketplace.loadMore')}
        </button>
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
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
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
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
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

  .env-input {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    resize: vertical;
    line-height: 1.4;
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

  /* ── Marketplace ── */

  .mp-toolbar {
    display: flex;
    gap: 0.35rem;
  }

  .mp-source-select {
    width: 90px;
    flex-shrink: 0;
    font-size: 11px;
  }

  .mp-search-input {
    flex: 1;
  }

  .mp-grid {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .mp-card {
    border: 1px solid var(--border-light);
    border-radius: 6px;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .mp-card:hover {
    border-color: var(--border-color);
  }

  .mp-card-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .mp-card-icon {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    object-fit: contain;
    flex-shrink: 0;
  }

  .mp-card-icon-placeholder {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    background: var(--bg-hover);
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .mp-card-title-area {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .mp-card-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mp-card-author {
    font-size: 10px;
    color: var(--text-muted);
  }

  .mp-card-desc {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.4;
  }

  .mp-card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.3rem;
  }

  .mp-card-meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .mp-card-stat {
    font-size: 10px;
    color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
  }

  .mp-card-verified {
    font-size: 10px;
    padding: 0 0.3rem;
    border-radius: 3px;
    background: #e6f7e6;
    color: #28a745;
  }

  :global([data-theme="dark"]) .mp-card-verified {
    background: rgba(40, 167, 69, 0.15);
  }

  .mp-card-actions {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
  }

  .mp-link {
    font-size: 11px;
    color: var(--accent-color);
    cursor: pointer;
    text-decoration: underline;
  }

  .mp-link:hover {
    opacity: 0.8;
  }

  .mp-installed-badge {
    font-size: 10px;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    background: var(--bg-hover);
    color: var(--text-muted);
  }

  .mp-loading {
    text-align: center;
    padding: 0.75rem;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
  }

  .mp-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    background: #fee;
    border: 1px solid #fcc;
    border-radius: 4px;
    color: #c33;
    font-size: var(--font-size-xs);
  }

  :global([data-theme="dark"]) .mp-error {
    background: rgba(220, 53, 69, 0.1);
    border-color: rgba(220, 53, 69, 0.25);
  }

  .mp-install-panel {
    border: 1px solid var(--accent-color);
    border-radius: 6px;
    padding: 0.6rem;
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .mp-install-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .mp-install-name {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .mp-install-close {
    cursor: pointer;
    font-size: 1.1rem;
    color: var(--text-muted);
    line-height: 1;
  }

  .mp-install-close:hover { color: var(--text-primary); }

  .mp-install-desc {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    margin: 0;
  }

  .mp-env-section {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .mp-env-row {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .mp-env-label {
    font-size: 11px;
    font-weight: 500;
    color: var(--text-secondary);
    font-family: var(--font-mono, monospace);
  }

  .mp-env-secret {
    color: #dc3545;
    margin-left: 0.15rem;
  }

  /* ── Local MCP section ── */

  .local-mcp-section {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-light);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .local-mcp-empty {
    padding: 0.75rem 0.5rem;
  }

  /* ── AI Services ── */

  .node-status {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0;
  }

  .node-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }

  .node-dot.available { background: #28a745; }
  .node-dot.unavailable { background: #dc3545; }

  .node-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .node-label.node-missing { color: #dc3545; }

  .dyn-service-item {
    flex-direction: column;
    align-items: stretch;
    gap: 0.35rem;
  }

  .dyn-service-item .server-info {
    flex-direction: column;
    gap: 0.15rem;
  }

  .dyn-service-item .server-actions {
    justify-content: flex-end;
  }

  .dyn-service-header {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .lifecycle-badge {
    font-size: 10px;
    padding: 0 0.3rem;
    border-radius: 3px;
    font-weight: 500;
  }

  .lifecycle-badge.temp {
    background: #fff3cd;
    color: #856404;
  }

  .lifecycle-badge.saved {
    background: #cce5ff;
    color: #004085;
  }

  :global([data-theme="dark"]) .lifecycle-badge.temp {
    background: rgba(255, 193, 7, 0.15);
    color: #ffc107;
  }

  :global([data-theme="dark"]) .lifecycle-badge.saved {
    background: rgba(0, 123, 255, 0.15);
    color: #5ba3f5;
  }

  .dyn-service-desc {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .dyn-tool-count {
    font-size: 10px;
    color: var(--text-muted);
  }

  .dyn-error-msg {
    font-size: 10px;
    color: #dc3545;
  }

  .server-status.dyn-error { color: #dc3545; }

  .service-code {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    line-height: 1.4;
    padding: 0.5rem;
    border: 1px solid var(--border-light);
    border-radius: 4px;
    background: var(--bg-hover);
    color: var(--text-secondary);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    max-height: 200px;
    overflow-y: auto;
  }
</style>

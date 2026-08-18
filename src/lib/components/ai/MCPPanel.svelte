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
  import { Select } from '$lib/components/ui';
  import { isIPadOS, isWindows, isMacOS, isLinux } from '$lib/utils/platform';
  import { ask } from '$lib/utils/native-dialog';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { containerStore, type DynamicService } from '$lib/services/mcp/container-store';
  import { saveService, removeService, stopService, startService } from '$lib/services/mcp/container-manager';
  import { invoke } from '@tauri-apps/api/core';
  import QRCode from 'qrcode';
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
  let addFormError = $state<string | null>(null);
  let editFormError = $state<string | null>(null);

  // Edit server form
  let editingServerId = $state<string | null>(null);
  let editName = $state('');
  let editTransport = $state<'http' | 'sse' | 'stdio'>('stdio');
  let editCommand = $state('');
  let editArgs = $state('');
  let editUrl = $state('');
  let editEnv = $state('');
  let editEnvEl = $state<HTMLTextAreaElement | null>(null);
  let newServerEnvEl = $state<HTMLTextAreaElement | null>(null);

  // Plain JS variables (NOT $state) for env textarea raw content.
  // WKWebView may truncate textarea.value or bind:value for multi-line content.
  // undefined = not yet initialized; string = set by startEdit() or oninput.
  let _editEnvRaw: string | undefined = undefined;
  let _newServerEnvRaw: string | undefined = undefined;

  // Top-level store subscriptions — do NOT wrap in $effect().
  // Svelte 5 $effect tracks reads in subscribe callbacks, causing infinite loops.
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

  // ── LAN bridge: expose a connected MCP server over the local network so the
  //    mobile app can consume it. serverId -> { url, token }. ──────────────────
  let lanExposed = $state<Record<string, { url: string; token: string }>>({});
  let lanQr = $state<Record<string, string>>({}); // serverId -> QR data URL
  let lanCopied = $state<string | null>(null);

  async function refreshLanStatus() {
    try {
      const rows = await invoke<Array<{ server_id: string; url: string; token: string }>>('mcp_lan_status');
      const next: Record<string, { url: string; token: string }> = {};
      for (const r of rows) next[r.server_id] = { url: r.url, token: r.token };
      lanExposed = next;
      for (const r of rows) genLanQr(r.server_id);
    } catch { /* bridge unavailable — leave empty */ }
  }

  async function toggleLanExpose(server: MCPServerConfig) {
    try {
      if (lanExposed[server.id]) {
        await invoke('mcp_lan_unexpose', { serverId: server.id });
        const next = { ...lanExposed };
        delete next[server.id];
        lanExposed = next;
        const q = { ...lanQr };
        delete q[server.id];
        lanQr = q;
      } else {
        const info = await invoke<{ url: string; token: string; port: number }>('mcp_lan_expose', { serverId: server.id });
        lanExposed = { ...lanExposed, [server.id]: { url: info.url, token: info.token } };
        genLanQr(server.id);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  /** Payload encoded for paste / QR — matches the mobile parser. */
  function lanConfigJson(server: MCPServerConfig): string {
    const e = lanExposed[server.id];
    if (!e) return '';
    return JSON.stringify({ v: 1, name: server.name, url: e.url, token: e.token });
  }

  /** Render the connection payload as a scannable QR (data URL). */
  async function genLanQr(serverId: string) {
    const server = servers.find(s => s.id === serverId);
    const payload = server ? lanConfigJson(server) : '';
    if (!payload) return;
    try {
      lanQr = { ...lanQr, [serverId]: await QRCode.toDataURL(payload, { width: 176, margin: 1 }) };
    } catch { /* QR generation failed — card still shows copyable text */ }
  }

  async function copyLanText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      lanCopied = key;
      setTimeout(() => { if (lanCopied === key) lanCopied = null; }, 1200);
    } catch { /* clipboard denied */ }
  }

  async function handleConnect(server: MCPServerConfig) {
    try {
      // Show security confirmation for stdio servers (launching local processes)
      // Skip if auto-approve is enabled
      if (server.transport.type === 'stdio' && !settingsStore.getState().mcpAutoApprove) {
        const args = server.transport.args?.join(' ') || '';
        const confirmed = await ask(
          $t('mcp.servers.launch_confirm_msg', {
            command: server.transport.command,
            args: args || '(none)',
          }),
          {
            title: $t('mcp.servers.launch_confirm_title'),
            kind: 'warning',
            okLabel: $t('mcp.servers.launch_confirm_ok'),
            cancelLabel: $t('mcp.servers.launch_confirm_cancel'),
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
    // Split on \r\n, \r, or \n to handle all line-ending styles (WKWebView may use \r)
    const lines = envStr.trim().split(/\r\n|\r|\n/).filter(l => l.trim());
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
    addFormError = null;
    if (!newServerName.trim()) {
      addFormError = $t('mcp.servers.error_name_required');
      return;
    }

    let transport: MCPServerConfig['transport'];
    if (newServerTransport === 'stdio') {
      if (!newServerCommand.trim()) {
        addFormError = $t('mcp.servers.error_command_required');
        return;
      }
      const args = newServerArgs.trim() ? newServerArgs.trim().split(/\s+/) : [];
      // Use _newServerEnvRaw (plain variable updated by oninput) as primary source.
      // Use ?? so an intentionally-cleared (empty) textarea is respected.
      const envText = _newServerEnvRaw !== undefined ? _newServerEnvRaw : (newServerEnvEl?.value ?? newServerEnv);
      transport = { type: 'stdio', command: newServerCommand.trim(), args, env: parseEnvString(envText) };
    } else {
      if (!newServerUrl.trim()) {
        addFormError = $t('mcp.servers.error_url_required');
        return;
      }
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
    _newServerEnvRaw = undefined;
    addFormError = null;
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
        jsonError = $t('mcp.servers.json_no_config');
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
      jsonError = `JSON ${$t('mcp.servers.json_parse_error')}: ${e.message}`;
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
      _editEnvRaw = editEnv; // initialize plain var from source data directly
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
    _editEnvRaw = undefined;
    editFormError = null;
  }

  async function handleSaveEdit() {
    editFormError = null;
    if (!editingServerId) return;
    if (!editName.trim()) {
      editFormError = $t('mcp.servers.error_name_required');
      return;
    }

    let transport: MCPServerConfig['transport'];
    if (editTransport === 'stdio') {
      if (!editCommand.trim()) {
        editFormError = $t('mcp.servers.error_command_required');
        return;
      }
      const args = editArgs.trim() ? editArgs.trim().split(/\s+/) : [];
      // Use _editEnvRaw (plain variable updated by oninput) as primary source.
      // Use ?? so an intentionally-cleared (empty) textarea is respected.
      const envText = _editEnvRaw !== undefined ? _editEnvRaw : (editEnvEl?.value ?? editEnv);
      transport = { type: 'stdio', command: editCommand.trim(), args, env: parseEnvString(envText) };
    } else {
      if (!editUrl.trim()) {
        editFormError = $t('mcp.servers.error_url_required');
        return;
      }
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
    _editEnvRaw = undefined;
    editFormError = null;
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
  let presetInstalling = $state<typeof MCP_PRESETS[0] | null>(null);
  let presetEnvValues = $state<Record<string, string>>({});

  function isPresetVisibleOnPlatform(preset: typeof MCP_PRESETS[0]): boolean {
    if (!preset.platform) return true;
    if (preset.platform === 'windows') return isWindows;
    if (preset.platform === 'macos') return isMacOS;
    if (preset.platform === 'linux') return isLinux;
    return true;
  }

  function addFromPreset(preset: typeof MCP_PRESETS[0]) {
    if (preset.envVars && preset.envVars.length > 0) {
      // Show env config dialog
      presetInstalling = preset;
      presetEnvValues = {};
      for (const ev of preset.envVars) {
        presetEnvValues[ev.name] = '';
      }
      return;
    }
    // No envVars — one-click add
    const config: MCPServerConfig = {
      id: `preset-${preset.id}`,
      ...preset.createConfig(),
    };
    mcpStore.addServer(config);
    connectServer(config).catch(() => {});
  }

  function cancelPresetInstall() {
    presetInstalling = null;
    presetEnvValues = {};
  }

  async function confirmPresetInstall() {
    if (!presetInstalling) return;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(presetEnvValues)) {
      if (v.trim()) env[k] = v.trim();
    }
    // Validate required env vars
    if (presetInstalling.envVars) {
      for (const ev of presetInstalling.envVars) {
        if (ev.required && !env[ev.name]) return;
      }
    }
    const config: MCPServerConfig = {
      id: `preset-${presetInstalling.id}`,
      ...presetInstalling.createConfig(env),
    };
    mcpStore.addServer(config);
    presetInstalling = null;
    presetEnvValues = {};
    try {
      await connectServer(config);
    } catch {
      // Added but connection failed — user can retry
    }
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

  let transportOptions = $derived([
    ...(isIPadOS ? [] : [{ value: 'stdio', label: $t('mcp.servers.stdio') }]),
    { value: 'http', label: $t('mcp.servers.http') },
    { value: 'sse', label: $t('mcp.servers.sse') },
  ]);
  let syncServerOptions = $derived([
    { value: '', label: $t('mcp.sync.server'), disabled: true },
    ...servers.filter(s => connectedServers.has(s.id)).map(s => ({ value: s.id, label: s.name })),
  ]);
  let syncDirectionOptions = $derived([
    { value: 'push', label: $t('mcp.sync.push') },
    { value: 'pull', label: $t('mcp.sync.pull') },
    { value: 'bidirectional', label: $t('mcp.sync.bidirectional') },
  ]);
  let mpSourceOptions = $derived(MARKETPLACE_SOURCES.map(src => ({ value: src.value, label: $t(src.labelKey) })));

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
    refreshLanStatus();
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

  async function handleStopService(serviceId: string) {
    try { await stopService(serviceId); } catch { /* ignore */ }
  }

  async function handleStartService(serviceId: string) {
    try { await startService(serviceId); } catch { /* handled by store */ }
  }
</script>

<div class="mcp-panel gx-tab">
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
      {#if MCP_PRESETS.some(p => !isPresetAdded(p.id) && isPresetVisibleOnPlatform(p))}
        <div class="presets-section">
          <div class="section-label">{$t('mcp.servers.presets')}</div>
          <div class="presets-grid">
            {#each MCP_PRESETS as preset}
              {#if !isPresetAdded(preset.id) && isPresetVisibleOnPlatform(preset)}
                <button class="preset-item" onclick={() => addFromPreset(preset)}>
                  <div class="preset-info">
                    <span class="preset-name">{preset.name}</span>
                    <span class="preset-desc">{$t(preset.descriptionKey)}</span>
                  </div>
                  <span class="preset-add">+</span>
                </button>
              {/if}
            {/each}
          </div>
        </div>
      {/if}

      <!-- Preset env config dialog -->
      {#if presetInstalling}
        <div class="mp-install-panel">
          <div class="mp-install-header">
            <span class="mp-install-name">{presetInstalling.name}</span>
            <!-- svelte-ignore a11y_missing_attribute -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span class="mp-install-close" onclick={cancelPresetInstall} onkeydown={() => {}}>×</span>
          </div>
          <p class="mp-install-desc">{$t(presetInstalling.descriptionKey)}</p>

          {#if presetInstalling.envVars && presetInstalling.envVars.length > 0}
            <div class="mp-env-section">
              <div class="section-label">{$t('mcp.servers.preset_env_title')}</div>
              {#each presetInstalling.envVars as ev}
                <div class="mp-env-row">
                  <label class="mp-env-label">
                    {ev.name}
                    {#if ev.required}<span class="mp-env-secret">*</span>{/if}
                  </label>
                  <input
                    type={ev.isSecret ? 'password' : 'text'}
                    class="form-input"
                    placeholder={$t(ev.descriptionKey)}
                    value={presetEnvValues[ev.name] || ''}
                    oninput={(e) => { presetEnvValues[ev.name] = (e.target as HTMLInputElement).value; presetEnvValues = presetEnvValues; }}
                  />
                </div>
              {/each}
            </div>
          {/if}

          <div class="form-actions">
            <button class="btn-sm" onclick={cancelPresetInstall}>{$t('mcp.marketplace.cancel')}</button>
            <button class="btn-sm primary" onclick={confirmPresetInstall}>
              {$t('mcp.servers.preset_add')}
            </button>
          </div>
        </div>
      {/if}

      {#if servers.filter(s => !s.id.startsWith('ai-svc-')).length === 0 && !showAddServer && MCP_PRESETS.every(p => !isPresetAdded(p.id) || !isPresetVisibleOnPlatform(p))}
        <div class="empty-state">
          <p>{$t('mcp.servers.empty')}</p>
          <button class="add-btn" onclick={() => showAddServer = true}>
            {$t('mcp.servers.add_server')}
          </button>
        </div>
      {:else}
        {#each servers.filter(s => !s.id.startsWith('ai-svc-')).sort((a, b) => (connectedServers.has(b.id) ? 1 : 0) - (connectedServers.has(a.id) ? 1 : 0)) as server}
          {#if editingServerId === server.id}
            <div class="add-form">
              <input
                type="text"
                class="form-input"
                bind:value={editName}
                placeholder={$t('mcp.servers.server_name')}
              />
              <Select class="form-input" block bind:value={editTransport} options={transportOptions} />
              {#if editTransport === 'stdio'}
                <input
                  type="text"
                  class="form-input"
                  bind:value={editCommand}
                  placeholder={$t('mcp.servers.command_placeholder')}
                />
                <input
                  type="text"
                  class="form-input"
                  bind:value={editArgs}
                  placeholder={$t('mcp.servers.args_placeholder')}
                />
                <textarea
                  class="form-input env-input"
                  bind:this={editEnvEl}
                  bind:value={editEnv}
                  oninput={(e) => { _editEnvRaw = (e.currentTarget as HTMLTextAreaElement).value; }}
                  placeholder={$t('mcp.servers.env_placeholder')}
                  rows="4"
                  spellcheck="false"
                ></textarea>
              {:else}
                <input
                  type="text"
                  class="form-input"
                  bind:value={editUrl}
                  placeholder={$t('mcp.servers.server_url')}
                />
              {/if}
              {#if editFormError}
                <div class="json-error">{editFormError}</div>
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

              {#if connectedServers.has(server.id) && server.transport.type !== 'stdio'}
                <!-- LAN bridge only proxies stdio subprocesses. http/sse servers
                     already have a reachable URL, so bridging is not applicable. -->
                <p class="lan-na">{$t('mcp.lan.only_stdio')}</p>
              {:else if connectedServers.has(server.id)}
                <div class="lan-expose">
                  <label class="lan-toggle">
                    <input type="checkbox" checked={!!lanExposed[server.id]} onchange={() => toggleLanExpose(server)} />
                    <span>{$t('mcp.lan.expose')}</span>
                  </label>
                  {#if lanExposed[server.id]}
                    <div class="lan-card">
                      <div class="lan-row">
                        <span class="lan-label">URL</span>
                        <code class="lan-value">{lanExposed[server.id].url}</code>
                        <button class="btn-xs" onclick={() => copyLanText(server.id + ':url', lanExposed[server.id].url)}>
                          {lanCopied === server.id + ':url' ? '✓' : $t('mcp.lan.copy')}
                        </button>
                      </div>
                      <div class="lan-row">
                        <span class="lan-label">Token</span>
                        <code class="lan-value">{lanExposed[server.id].token}</code>
                        <button class="btn-xs" onclick={() => copyLanText(server.id + ':token', lanExposed[server.id].token)}>
                          {lanCopied === server.id + ':token' ? '✓' : $t('mcp.lan.copy')}
                        </button>
                      </div>
                      <div class="lan-row">
                        <span class="lan-label">{$t('mcp.lan.config')}</span>
                        <button class="btn-xs primary" onclick={() => copyLanText(server.id + ':cfg', lanConfigJson(server))}>
                          {lanCopied === server.id + ':cfg' ? '✓' : $t('mcp.lan.copy_config')}
                        </button>
                      </div>
                      {#if lanQr[server.id]}
                        <div class="lan-qr-wrap">
                          <img class="lan-qr" src={lanQr[server.id]} alt={$t('mcp.lan.scan_hint')} />
                          <span class="lan-qr-cap">{$t('mcp.lan.scan_hint')}</span>
                        </div>
                      {/if}
                      <p class="lan-hint">{$t('mcp.lan.hint')}</p>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {/each}

        {#if !showAddServer}
          <button class="add-btn" onclick={() => showAddServer = true}>
            {$t('mcp.servers.add_server_plus')}
          </button>
        {/if}
      {/if}

      {#if showAddServer}
        <div class="add-form">
          <div class="add-mode-tabs">
            <button class="mode-tab" class:active={addMode === 'form'} onclick={() => addMode = 'form'}>
              {$t('mcp.servers.form_mode')}
            </button>
            <button class="mode-tab" class:active={addMode === 'json'} onclick={() => addMode = 'json'}>
              {$t('mcp.servers.json_mode')}
            </button>
          </div>

          {#if addMode === 'json'}
            <textarea
              class="form-input json-input"
              bind:value={jsonInput}
              placeholder={$t('mcp.servers.json_placeholder')}
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
              placeholder={$t('mcp.servers.server_name')}
            />
            <Select class="form-input" block bind:value={newServerTransport} options={transportOptions} />
            {#if newServerTransport === 'stdio'}
              <input
                type="text"
                class="form-input"
                bind:value={newServerCommand}
                placeholder={$t('mcp.servers.command_placeholder')}
              />
              <input
                type="text"
                class="form-input"
                bind:value={newServerArgs}
                placeholder={$t('mcp.servers.args_placeholder')}
              />
              <textarea
                class="form-input env-input"
                bind:this={newServerEnvEl}
                bind:value={newServerEnv}
                oninput={(e) => { _newServerEnvRaw = (e.currentTarget as HTMLTextAreaElement).value; }}
                placeholder={$t('mcp.servers.env_placeholder')}
                rows="4"
                spellcheck="false"
              ></textarea>
            {:else}
              <input
                type="text"
                class="form-input"
                bind:value={newServerUrl}
                placeholder={$t('mcp.servers.server_url')}
              />
            {/if}
            {#if addFormError}
              <div class="json-error">{addFormError}</div>
            {/if}
            <div class="form-actions">
              <button class="btn-sm" onclick={() => { showAddServer = false; addFormError = null; }}>{$t('common.cancel')}</button>
              <button class="btn-sm primary" onclick={handleAddServer}>{$t('common.add')}</button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Local MCP (AI-created dynamic services) -->
      <div class="local-mcp-section">
        <div class="section-label">{$t('mcp.servers.local_mcp')}</div>
        <div class="node-status">
          <span class="node-dot" class:available={nodeAvailable === true} class:unavailable={nodeAvailable === false}></span>
          {#if nodeAvailable === true}
            <span class="node-label">Node.js {nodeVersion}</span>
          {:else if nodeAvailable === false}
            <span class="node-label node-missing">{$t('mcp.ai_services.node_required')}</span>
          {:else}
            <span class="node-label">{$t('mcp.ai_services.checking_node')}</span>
          {/if}
        </div>

        {#if dynamicServices.length === 0}
          <div class="empty-state local-mcp-empty">
            <p>{$t('mcp.ai_services.empty')}</p>
            <p class="hint">{$t('mcp.ai_services.hint')}</p>
          </div>
        {:else}
          {#each dynamicServices as service}
            <div class="server-item dyn-service-item">
              <div class="server-info">
                <div class="dyn-service-header">
                  <span class="server-name">{service.name}</span>
                  <span class="lifecycle-badge" class:temp={service.lifecycle === 'temp'} class:saved={service.lifecycle === 'saved'}>
                    {service.lifecycle === 'temp' ? $t('mcp.ai_services.temp') : $t('mcp.ai_services.saved')}
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
                  {$t('mcp.ai_services.view_code')}
                </button>
                {#if service.lifecycle === 'temp'}
                  <button class="btn-sm primary" onclick={() => handleSaveService(service.id)}>
                    {$t('common.save')}
                  </button>
                {/if}
                {#if service.status === 'running' || service.status === 'starting'}
                  <button class="btn-sm" onclick={() => handleStopService(service.id)}>
                    {$t('common.stop')}
                  </button>
                {:else if service.lifecycle === 'saved'}
                  <button class="btn-sm primary" onclick={() => handleStartService(service.id)}>
                    {$t('common.start')}
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
              {$t('mcp.sync.add_sync')}
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
                {$t('mcp.sync.sync_now')}
              </button>
              <button class="btn-sm danger" onclick={() => handleRemoveSync(config.id)}>
                {$t('common.remove')}
              </button>
            </div>
          </div>
        {/each}

        {#if !showAddSync}
          <button class="add-btn" onclick={() => showAddSync = true}>
            {$t('mcp.sync.add_sync')}
          </button>
        {/if}
      {/if}

      {#if showAddSync}
        <div class="add-form">
          <input type="text" class="form-input" bind:value={newSyncName} placeholder={$t('mcp.sync.name')} />
          <Select class="form-input" block bind:value={newSyncServerId} options={syncServerOptions} />
          <input type="text" class="form-input" bind:value={newSyncRemotePath} placeholder={$t('mcp.sync.remote_path')} />
          <input type="text" class="form-input" bind:value={newSyncLocalPath} placeholder={$t('mcp.sync.local_path')} />
          <Select class="form-input" block bind:value={newSyncDirection} options={syncDirectionOptions} />
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
        <Select class="form-input mp-source-select" bind:value={mpSource} options={mpSourceOptions} onchange={(v) => mpChangeSource(v as MarketplaceSource)} />
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
              <div class="section-label">{$t('mcp.marketplace.env_vars')}</div>
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
              {$t('mcp.marketplace.install_and_connect')}
            </button>
          </div>
        </div>
      {/if}

      <!-- Results -->
      {#if mpError}
        <div class="mp-error">
          <span>{$t('mcp.marketplace.network_error')}: {mpError}</span>
          <button class="btn-sm" onclick={() => mpSearch(mpPage)}>{$t('mcp.marketplace.retry')}</button>
        </div>
      {/if}

      {#if mpResults.length === 0 && !mpLoading && !mpError}
        <div class="empty-state">
          <p>{$t('mcp.marketplace.no_results')}</p>
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
                  <span class="mp-link" onclick={() => server.homepage && openUrl(server.homepage)} onkeydown={() => {}}>{$t('mcp.marketplace.view_details')}</span>
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
          {$t('mcp.marketplace.load_more')}
        </button>
      {/if}
    </div>

  {/if}

  {#if error}
    <div class="error-bar">
      <span class="error-bar-msg">{error}</span>
      <button
        type="button"
        class="error-bar-close"
        aria-label={$t('common.close')}
        title={$t('common.close')}
        onclick={() => mcpStore.setError(null)}
      >×</button>
    </div>
  {/if}
</div>

<style>
  /* mcp-panel uses .gx-tab on root, which sets gap: 1.25rem + bottom
     padding. Override gap to 0.75rem so the segmented control sits
     tighter to the tab content below. */
  .mcp-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* Segmented control — macOS-style pill with rounded inner buttons.
     Replaces the older bottom-border tab bar so it harmonizes with the
     card-based visual language used in the other settings tabs. */
  .mcp-tabs {
    display: inline-flex;
    align-self: stretch;
    padding: 3px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    gap: 2px;
  }

  .tab {
    flex: 1;
    padding: 5px 12px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    font-family: inherit;
    font-weight: 500;
    cursor: pointer;
    border-radius: 5px;
    transition: background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
    white-space: nowrap;
  }

  .tab:hover:not(.active) {
    color: var(--text-primary);
    background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  }
  .tab.active {
    color: var(--text-primary);
    background: var(--bg-primary);
    border-color: var(--border-color);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    font-weight: 600;
  }

  .tab-content {
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
    flex-wrap: wrap;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    gap: 0.5rem 0.75rem;
    row-gap: 0;
  }

  .server-info, .target-info, .sync-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1 1 auto;
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
    white-space: nowrap;
  }

  .server-status.connected { color: #28a745; }

  .server-meta {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
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

  /* ── LAN expose (per connected server) ── */
  .lan-expose {
    flex-basis: 100%;
    width: 100%;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-light);
  }
  .lan-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
    user-select: none;
  }
  /* Muted note shown for http/sse servers where LAN bridge doesn't apply. */
  .lan-na {
    flex-basis: 100%;
    width: 100%;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-light);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    line-height: 1.45;
  }
  .lan-card {
    margin-top: 0.5rem;
    padding: 0.5rem 0.6rem;
    background: var(--bg-secondary, #f6f6f6);
    border: 1px solid var(--border-color, #e5e5e5);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .lan-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .lan-label {
    flex-shrink: 0;
    width: 3.2rem;
    font-size: 0.72rem;
    color: var(--text-secondary, #888);
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .lan-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.74rem;
    font-family: var(--font-mono, ui-monospace, monospace);
    background: var(--bg-primary, #fff);
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
    border: 1px solid var(--border-color, #e5e5e5);
  }
  .btn-xs {
    flex-shrink: 0;
    padding: 0.15rem 0.45rem;
    font-size: 0.72rem;
    border: 1px solid var(--border-color, #ddd);
    border-radius: 4px;
    background: var(--bg-primary, #fff);
    cursor: pointer;
  }
  .btn-xs.primary {
    background: var(--accent-color, #6366f1);
    color: #fff;
    border-color: transparent;
  }
  .lan-hint {
    margin: 0.2rem 0 0;
    font-size: 0.7rem;
    color: var(--text-secondary, #999);
    line-height: 1.4;
  }
  .lan-qr-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    padding: 0.4rem 0;
  }
  .lan-qr {
    width: 176px;
    height: 176px;
    image-rendering: pixelated;
    background: #fff;
    border-radius: 6px;
    border: 1px solid var(--border-color, #e5e5e5);
  }
  .lan-qr-cap {
    font-size: 0.7rem;
    color: var(--text-secondary, #999);
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
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.4rem 0.75rem;
    background: #fee;
    border-top: 1px solid #fcc;
    color: #c33;
    font-size: var(--font-size-xs);
  }

  .error-bar-msg {
    flex: 1;
    min-width: 0;
    word-break: break-word;
  }

  .error-bar-close {
    flex-shrink: 0;
    border: none;
    background: transparent;
    color: #c33;
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.15rem;
    opacity: 0.7;
  }

  .error-bar-close:hover {
    opacity: 1;
  }

  /* ── Marketplace ── */

  .mp-toolbar {
    display: flex;
    gap: 0.35rem;
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

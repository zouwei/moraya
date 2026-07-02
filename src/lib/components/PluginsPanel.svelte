<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { invoke } from '@tauri-apps/api/core';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { pluginStore } from '$lib/services/plugin';
  import { rendererManager } from '$lib/services/plugin/renderer-manager';
  import { RENDERER_PLUGINS } from '$lib/services/plugin/renderer-registry';
  import rendererVersions from '$lib/services/plugin/renderer-versions.json';
  import type { PluginMarketData, InstalledPlugin, PluginStateEntry, PluginSandboxLevel } from '$lib/services/plugin';
  import type { RendererPluginState } from '$lib/services/plugin/renderer-manager';

  type ActiveTab = 'preset' | 'installed' | 'market';

  let activeTab = $state<ActiveTab>('preset');
  let searchQuery = $state('');
  let selectedCategory = $state('all');
  let detailPlugin = $state<PluginMarketData | null>(null);
  let validatingUrl = $state('');
  let urlError = $state('');
  let urlImporting = $state(false);
  let urlStatus = $state('');
  let installing = $state<Record<string, boolean>>({});

  let storeState = $state({
    installed: [] as InstalledPlugin[],
    market: [] as PluginMarketData[],
    marketLoading: false,
    marketFromCache: false,
    marketFetchedAt: 0,
    installProgress: {} as Record<string, { downloaded: number; total: number }>,
    blacklist: [] as string[],
  });

  let rendererState = $state({ plugins: [] as RendererPluginState[], initializing: true });

  // Top-level store subscriptions — do NOT wrap in $effect().
  const unsubPlugin = pluginStore.subscribe(s => { storeState = s; });
  const unsubRenderer = rendererManager.subscribe(s => { rendererState = s; });
  onDestroy(() => { unsubPlugin(); unsubRenderer(); });

  onMount(() => { rendererManager.init(); });

  // ── Derived ─────────────────────────────────────

  const categories = $derived.by(() => {
    const cats = new Set(['all', ...storeState.market.map(p => p.category)]);
    return [...cats];
  });

  const filteredMarket = $derived.by(() =>
    storeState.market.filter(p => {
      const q = searchQuery.toLowerCase();
      const matchQuery = !q || (p.name ?? '').toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q);
      const matchCat = selectedCategory === 'all' || p.category === selectedCategory;
      return matchQuery && matchCat;
    })
  );

  // ── Helpers ──────────────────────────────────────

  function isInstalled(id: string): boolean {
    return storeState.installed.some(p => p.manifest.id === id);
  }

  function sandboxLabel(level: PluginSandboxLevel): string {
    if (level === 'sandbox') return '🟢';
    if (level === 'local') return '🟡';
    return '🔴';
  }

  function sandboxText(level: PluginSandboxLevel): string {
    if (level === 'sandbox') return $t('plugins.sandbox.sandbox');
    if (level === 'local') return $t('plugins.sandbox.local');
    return $t('plugins.sandbox.system');
  }

  function formatDate(ts: number): string {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString();
  }

  function formatDownloaded(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function toEntry(p: InstalledPlugin): PluginStateEntry {
    return { id: p.manifest.id, enabled: p.enabled, pluginDir: p.pluginDir, installedAt: p.installedAt, manifest: p.manifest };
  }

  function getRendererState(id: string): RendererPluginState {
    return rendererState.plugins.find(p => p.id === id) ?? { id, enabled: false, status: 'idle' };
  }

  function statusLabel(status: RendererPluginState['status']): string {
    switch (status) {
      case 'downloading': return $t('plugins.preset.downloading');
      case 'loading': return $t('plugins.preset.loading');
      case 'ready': return $t('plugins.preset.ready');
      case 'error': return $t('plugins.preset.error');
      default: return '';
    }
  }

  // ── Actions ──────────────────────────────────────

  async function handleToggle(plugin: InstalledPlugin): Promise<void> {
    const entry = toEntry(plugin);
    if (plugin.enabled) {
      await pluginStore.disablePlugin(plugin.manifest.id);
    } else {
      await pluginStore.enablePlugin(entry);
    }
  }

  async function handleUninstall(plugin: InstalledPlugin): Promise<void> {
    await pluginStore.uninstallPlugin(plugin.manifest.id);
  }

  async function handleInstallFile(): Promise<void> {
    const result = await pluginStore.installFromFile();
    if (!result.ok && result.error) {
      alert(result.error);
    }
  }

  async function handleInstallMarket(plugin: PluginMarketData): Promise<void> {
    if (!plugin.manifest) return;
    const platform = detectPlatform();
    const downloadUrl = plugin.downloadUrls[platform];
    const sha256 = plugin.sha256[platform];
    if (!downloadUrl || !sha256) {
      alert($t('plugins.error.platformNotSupported'));
      return;
    }
    installing = { ...installing, [plugin.id]: true };
    try {
      const result = await pluginStore.installFromUrl(plugin.id, downloadUrl, sha256);
      if (!result.ok && result.error) alert(result.error);
    } finally {
      installing = { ...installing };
      delete installing[plugin.id];
    }
  }

  async function handleUrlImport(): Promise<void> {
    urlError = '';
    urlStatus = '';
    if (!validatingUrl.trim() || urlImporting) return;

    let rawUrl = validatingUrl.trim();
    const isGithubRepo = rawUrl.includes('github.com/') && !rawUrl.includes('raw.githubusercontent.com');
    if (isGithubRepo) {
      rawUrl = rawUrl.replace('https://github.com/', 'https://raw.githubusercontent.com/') + '/main/plugin.json';
    }

    urlImporting = true;
    try {
      urlStatus = $t('plugins.install.fetchingRelease');
      let result = await pluginStore.validateManifest(rawUrl);
      // Fallback: try master branch if main branch 404s
      if (!result.valid && isGithubRepo && result.errors.some(e => e.includes('404'))) {
        const masterUrl = rawUrl.replace('/main/plugin.json', '/master/plugin.json');
        const masterResult = await pluginStore.validateManifest(masterUrl);
        if (masterResult.valid) { result = masterResult; rawUrl = masterUrl; }
      }
      if (!result.valid) {
        urlError = result.errors.join('\n');
        return;
      }
      if (!result.manifest) return;

      const confirmMsg = `${$t('plugins.install.confirmUrl')}\n\n${result.manifest.name} v${result.manifest.version}\n${$t('plugins.install.author')}: ${result.manifest.author}\n${$t('plugins.install.permissions')}: ${result.manifest.permissions.join(', ') || $t('plugins.install.noPermissions')}`;
      if (!confirm(confirmMsg)) return;

      const ownerRepo = validatingUrl.trim().replace(/\/$/, '').replace('https://github.com/', '');
      const platform = detectPlatform();

      const downloadUrl = await invoke<string>('plugin_fetch_github_asset', { ownerRepo, platform });

      urlStatus = $t('plugins.install.downloading');
      const res = await pluginStore.installFromUrl(result.manifest.id, downloadUrl, '');
      if (!res.ok && res.error) {
        urlError = res.error;
      } else {
        validatingUrl = '';
        urlStatus = '';
      }
    } catch (e: unknown) {
      urlError = e instanceof Error ? e.message : String(e);
    } finally {
      urlImporting = false;
      if (!urlError) urlStatus = '';
    }
  }

  function detectPlatform(): 'darwin-aarch64' | 'darwin-x86_64' | 'win32' | 'linux-x86_64' {
    const ua = navigator.userAgent;
    if (ua.includes('Mac')) {
      return (navigator as unknown as { userAgentData?: { architecture?: string } }).userAgentData?.architecture === 'arm' ? 'darwin-aarch64' : 'darwin-x86_64';
    }
    if (ua.includes('Win')) return 'win32';
    return 'linux-x86_64';
  }

  function openMarketplace(): void {
    activeTab = 'market';
    if (storeState.market.length === 0) {
      pluginStore.fetchMarket(false);
    }
  }
</script>

<div class="plugins-panel gx-tab">
  <!-- Tab bar -->
  <div class="tab-bar">
    <button
      class="tab-btn"
      class:active={activeTab === 'preset'}
      onclick={() => { activeTab = 'preset'; detailPlugin = null; }}
    >
      {$t('plugins.tabs.preset')}
    </button>
    <button
      class="tab-btn"
      class:active={activeTab === 'installed'}
      onclick={() => { activeTab = 'installed'; detailPlugin = null; }}
    >
      {$t('plugins.tabs.installed')} ({storeState.installed.length})
    </button>
    <button
      class="tab-btn"
      class:active={activeTab === 'market'}
      onclick={openMarketplace}
    >
      {$t('plugins.tabs.market')}
    </button>
  </div>

  <!-- ── PRESET RENDERER PLUGINS TAB ── -->
  {#if activeTab === 'preset'}
    <div class="plugin-list">
      {#if rendererState.initializing}
        <div class="loading-state">{$t('plugins.preset.initializing')}</div>
      {:else}
        {#each RENDERER_PLUGINS as plugin (plugin.id)}
          {@const ps = getRendererState(plugin.id)}
          {@const isLarge = plugin.sizeKb > 500}
          <div class="plugin-card preset-card" class:enabled={ps.enabled}>
            <div class="plugin-card-header">
              <span class="plugin-name">{plugin.name}</span>
              <span class="preset-size" class:large={isLarge}>
                ~{plugin.sizeKb >= 1000 ? (plugin.sizeKb / 1000).toFixed(1) + ' MB' : plugin.sizeKb + ' KB'}
                {#if isLarge}<span class="large-warning" data-tooltip={$t('plugins.preset.largeBundle')}>⚠</span>{/if}
              </span>
              <div class="plugin-actions">
                {#if ps.status === 'downloading' || ps.status === 'loading'}
                  <span class="status-badge loading">{statusLabel(ps.status)}</span>
                  <button class="btn-secondary" onclick={() => rendererManager.cancel(plugin.id)}>
                    {$t('plugins.preset.cancel')}
                  </button>
                {:else if ps.status === 'error'}
                  <button class="btn-secondary" onclick={() => rendererManager.update(plugin.id)}>
                    {$t('plugins.preset.retry')}
                  </button>
                {:else if ps.status === 'ready'}
                  <!-- Downloaded and in memory (enabled=true) -->
                  <label class="toggle-switch">
                    <input
                      type="checkbox"
                      checked={ps.enabled}
                      onchange={() => ps.enabled ? rendererManager.disable(plugin.id) : rendererManager.enable(plugin.id)}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                  <button class="btn-danger-sm" disabled>
                    {$t('plugins.preset.delete')}
                  </button>
                {:else if ps.installedVersion}
                  <!-- Downloaded but disabled (file on disk, not in memory) -->
                  <label class="toggle-switch">
                    <input
                      type="checkbox"
                      checked={false}
                      onchange={() => rendererManager.enable(plugin.id)}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                  <button class="btn-danger-sm" onclick={() => rendererManager.delete(plugin.id)}>
                    {$t('plugins.preset.delete')}
                  </button>
                {:else}
                  <!-- Not downloaded -->
                  <button class="btn-secondary" onclick={() => rendererManager.enable(plugin.id)}>
                    {$t('plugins.preset.download')}
                  </button>
                {/if}
              </div>
            </div>
            {#if ps.status === 'error' && ps.error}
              <div class="preset-error">{ps.error}</div>
            {/if}
            <div class="plugin-desc">{plugin.description}</div>
            <div class="preset-langs">
              {#each plugin.languages as lang}
                <code class="lang-chip">{lang}</code>
              {/each}
            </div>
            <div class="plugin-meta">
              ★ {plugin.stars >= 1000 ? (plugin.stars / 1000).toFixed(1) + 'k' : plugin.stars}
              ·
              v{(rendererVersions as Record<string, string>)[plugin.npmPackage] ?? '—'}
              ·
              <span
                class="plugin-homepage"
                role="link"
                tabindex="0"
                onclick={() => openUrl(plugin.homepage)}
                onkeydown={(e) => e.key === 'Enter' && openUrl(plugin.homepage)}
              >{plugin.homepage.replace(/^https?:\/\//, '')}</span>
            </div>
          </div>
        {/each}
      {/if}
    </div>

  <!-- ── INSTALLED (MARKET PLUGINS) TAB ── -->
  {:else if activeTab === 'installed'}
    <div class="plugin-list">
      {#if storeState.installed.length === 0}
        <div class="empty-state">
          <p>{$t('plugins.installed.empty')}</p>
          <button class="btn-secondary" onclick={openMarketplace}>{$t('plugins.tabs.market')}</button>
        </div>
      {:else}
        {#each storeState.installed as plugin (plugin.manifest.id)}
          {@const isBlacklisted = storeState.blacklist.includes(plugin.manifest.id)}
          <div class="plugin-card" class:blacklisted={isBlacklisted}>
            <div class="plugin-card-header">
              <span class="sandbox-badge" title={sandboxText(plugin.manifest.sandboxLevel)}>
                {sandboxLabel(plugin.manifest.sandboxLevel)}
              </span>
              <span class="plugin-name">{plugin.manifest.name}</span>
              <span class="plugin-version">v{plugin.manifest.version}</span>
              {#if isBlacklisted}
                <span class="blacklist-badge">{$t('plugins.blacklisted')}</span>
              {/if}
              <div class="plugin-actions">
                <label class="toggle-switch" title={plugin.enabled ? $t('plugins.disable') : $t('plugins.enable')}>
                  <input
                    type="checkbox"
                    checked={plugin.enabled && !isBlacklisted}
                    disabled={isBlacklisted || plugin.processState === 'starting'}
                    onchange={() => handleToggle(plugin)}
                  />
                  <span class="toggle-slider"></span>
                </label>
                <button class="btn-danger-sm" onclick={() => handleUninstall(plugin)}>
                  {$t('plugins.uninstall')}
                </button>
              </div>
            </div>
            <div class="plugin-meta">
              {plugin.manifest.author}
              {#if plugin.manifest.permissions.length > 0}
                ·
                {#each plugin.manifest.permissions as perm}
                  <span class="perm-tag">{perm}</span>
                {/each}
              {:else}
                · <span class="perm-tag no-perm">{$t('plugins.install.noPermissions')}</span>
              {/if}
            </div>
            {#if plugin.processState === 'error'}
              <div class="process-error">{$t('plugins.processError')}</div>
            {/if}
            {#if isBlacklisted}
              <div class="blacklist-warning">{$t('plugins.blacklistWarning')}</div>
            {/if}
          </div>
        {/each}
      {/if}

      <!-- Local install -->
      <div class="local-install-row">
        <button class="btn-secondary" onclick={handleInstallFile}>
          {$t('plugins.install.fromFile')}
        </button>
        <div class="url-import">
          <input
            class="url-input"
            type="text"
            placeholder={$t('plugins.install.urlPlaceholder')}
            bind:value={validatingUrl}
            disabled={urlImporting}
            onkeydown={(e) => e.key === 'Enter' && handleUrlImport()}
          />
          <button class="btn-secondary" onclick={handleUrlImport} disabled={urlImporting}>
            {urlImporting ? '…' : $t('plugins.install.validate')}
          </button>
        </div>
        {#if urlStatus && !urlError}
          <div class="url-status">{urlStatus}</div>
        {/if}
        {#if urlError}
          <div class="url-error">{urlError}</div>
        {/if}
      </div>
    </div>

  <!-- ── MARKETPLACE TAB ── -->
  {:else}
    <div class="market-toolbar">
      <input
        class="search-input"
        type="text"
        placeholder={$t('plugins.market.search')}
        bind:value={searchQuery}
      />
      <button
        class="refresh-btn"
        title={$t('plugins.market.refresh')}
        disabled={storeState.marketLoading}
        onclick={() => pluginStore.fetchMarket(true)}
      >↻</button>
    </div>

    <div class="category-bar">
      {#each categories as cat}
        <button
          class="cat-btn"
          class:active={selectedCategory === cat}
          onclick={() => selectedCategory = cat}
        >
          {cat === 'all' ? $t('plugins.market.catAll') : cat}
        </button>
      {/each}
    </div>

    {#if storeState.marketFromCache}
      <div class="cache-notice">{$t('plugins.market.cached')}</div>
    {/if}

    <div class="market-layout">
      <div class="plugin-list market-list">
        {#if storeState.marketLoading && storeState.market.length === 0}
          <div class="loading-state">{$t('plugins.market.loading')}</div>
        {:else if filteredMarket.length === 0}
          <div class="empty-state">{$t('plugins.market.empty')}</div>
        {:else}
          {#each filteredMarket as plugin (plugin.id)}
            {@const manifest = plugin.manifest}
            {@const progress = storeState.installProgress[plugin.id]}
            {@const installed = isInstalled(plugin.id)}
            {@const isInstalling = !!installing[plugin.id]}
            <div
              class="plugin-card market-card"
              class:selected={detailPlugin?.id === plugin.id}
              onclick={() => detailPlugin = detailPlugin?.id === plugin.id ? null : plugin}
              role="button"
              tabindex="0"
              onkeydown={e => e.key === 'Enter' && (detailPlugin = plugin)}
            >
              <div class="plugin-card-header">
                {#if plugin.verified}
                  <span class="verified-badge" title={$t('plugins.verified')}>✦</span>
                {/if}
                {#if plugin.iconUrl}
                  <img class="plugin-icon" src={plugin.iconUrl} alt="" onerror={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                {/if}
                <span class="plugin-name">{plugin.name ?? plugin.id}</span>
                <span class="plugin-version">v{plugin.pinnedVersion}</span>
                <div class="plugin-actions" onclick={e => e.stopPropagation()} role="none">
                  {#if progress}
                    <div class="progress-bar">
                      <div
                        class="progress-fill"
                        style="width: {progress.total > 0 ? Math.round(progress.downloaded / progress.total * 100) : 0}%"
                      ></div>
                      <span class="progress-text">
                        {formatDownloaded(progress.downloaded)}
                        {#if progress.total > 0}/ {formatDownloaded(progress.total)}{/if}
                      </span>
                    </div>
                  {:else if isInstalling}
                    <span class="installing-text">{$t('plugins.market.installing')}</span>
                  {:else if installed}
                    <span class="installed-badge">{$t('plugins.market.installed')}</span>
                  {:else}
                    <button
                      class="btn-install"
                      onclick={(e) => { e.stopPropagation(); handleInstallMarket(plugin); }}
                      disabled={!manifest}
                    >
                      {$t('plugins.market.install')}
                    </button>
                  {/if}
                </div>
              </div>
              <div class="plugin-desc">{plugin.description ?? ''}</div>
              <div class="plugin-meta">
                {#if manifest}
                  {sandboxLabel(manifest.sandboxLevel)} {sandboxText(manifest.sandboxLevel)}
                  ·
                {/if}
                {plugin.license ?? ''}
                {#if plugin.stars != null}· ★ {plugin.stars}{/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Detail side panel -->
      {#if detailPlugin}
        {@const dp = detailPlugin}
        {@const dm = dp.manifest}
        <div class="detail-panel">
          <div class="detail-header">
            <button class="detail-close" onclick={() => detailPlugin = null}>←</button>
            <span class="detail-name">{dp.name ?? dp.id}</span>
            <span class="plugin-version">v{dp.pinnedVersion}</span>
          </div>
          <div class="detail-body">
            <div class="detail-meta">
              {#if dp.verified}<span class="verified-badge">✦ {$t('plugins.verified')}</span>{/if}
              {dp.license ?? ''} · ★ {dp.stars ?? 0}
            </div>
            <p class="detail-desc">{dp.description ?? ''}</p>

            {#if dm}
              <div class="detail-section">
                <div class="detail-section-title">{$t('plugins.sandbox.label')}</div>
                <div class="sandbox-row">
                  {sandboxLabel(dm.sandboxLevel)} {sandboxText(dm.sandboxLevel)}
                </div>
              </div>

              {#if dm.permissions.length > 0}
                <div class="detail-section">
                  <div class="detail-section-title">{$t('plugins.permissions.label')}</div>
                  <div class="perm-list">
                    {#each dm.permissions as perm}
                      <div class="perm-row">
                        <span class="perm-name">{perm}</span>
                        <span class="perm-reason">{dm.permissionReasons?.[perm] ?? ''}</span>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
            {/if}

            {#if dp.changelog}
              <div class="detail-section">
                <div class="detail-section-title">{$t('plugins.changelog')}</div>
                <pre class="changelog">{dp.changelog.slice(0, 500)}</pre>
              </div>
            {/if}

            <div class="detail-footer">
              {#if dp.repo}
                <a
                  href="https://github.com/{dp.repo}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="btn-secondary"
                >
                  {$t('plugins.viewSource')} ↗
                </a>
              {/if}
              {#if isInstalled(dp.id)}
                <span class="installed-badge">{$t('plugins.market.installed')}</span>
              {:else}
                <button
                  class="btn-install"
                  onclick={() => handleInstallMarket(dp)}
                  disabled={!dm}
                >
                  {$t('plugins.market.install')}
                </button>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .plugins-panel { display: flex; flex-direction: column; height: 100%; gap: 0.75rem; }

  /* Segmented control — matches MCPPanel's tab bar style for visual
     consistency across settings tabs that have internal sub-navigation. */
  .tab-bar {
    display: inline-flex;
    align-self: stretch;
    padding: 3px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    gap: 2px;
    flex-shrink: 0;
  }
  .tab-btn {
    flex: 1;
    padding: 5px 12px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: var(--font-size-sm);
    font-family: inherit;
    font-weight: 500;
    transition: background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease;
    white-space: nowrap;
  }
  .tab-btn:hover:not(.active) {
    color: var(--text-primary);
    background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  }
  .tab-btn.active {
    color: var(--text-primary);
    background: var(--bg-primary);
    border-color: var(--border-color);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    font-weight: 600;
  }

  /* Plugin list */
  .plugin-list { flex: 1; overflow-y: auto; padding: 0; display: flex; flex-direction: column; gap: 8px; }

  .plugin-card {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;
    background: var(--bg-secondary);
    transition: border-color 0.15s;
  }
  .plugin-card:hover { border-color: var(--accent-color); }
  .plugin-card.selected { border-color: var(--accent-color); }
  .plugin-card.blacklisted { border-color: #ef4444; background: rgba(239, 68, 68, 0.05); }

  /* Preset plugin card */
  .preset-card.enabled { border-color: var(--accent-color); }

  .preset-size { font-size: var(--font-size-xs); color: var(--text-tertiary); }
  .preset-size.large { color: #e67e22; }
  .large-warning {
    cursor: help;
    position: relative;
  }
  .large-warning::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 11px;
    min-width: 200px;
    max-width: 300px;
    word-wrap: break-word;
    white-space: normal;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
    z-index: 200;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  }
  .large-warning:hover::after { opacity: 1; }

  .preset-langs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .lang-chip { font-size: 11px; background: var(--bg-tertiary); color: var(--text-secondary); padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono); }

  .plugin-homepage { font-size: 11px; color: var(--accent-color); text-decoration: none; cursor: pointer; }
  .plugin-homepage:hover { text-decoration: underline; }

  /* Status badges */
  .status-badge { font-size: var(--font-size-xs); padding: 3px 8px; border-radius: 10px; }
  .status-badge.loading { color: var(--text-secondary); background: var(--bg-tertiary); }

  /* Buttons */
  .plugin-card-header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .plugin-name { font-weight: 600; font-size: var(--font-size-sm); color: var(--text-primary); flex: 1; min-width: 0; }
  .plugin-version { color: var(--text-secondary); font-size: var(--font-size-xs); }
  .plugin-desc { font-size: var(--font-size-xs); color: var(--text-secondary); margin-top: 4px; line-height: 1.4; }
  .plugin-meta { font-size: var(--font-size-xs); color: var(--text-tertiary); margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .plugin-icon { width: 20px; height: 20px; border-radius: 4px; object-fit: cover; }

  .plugin-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-shrink: 0; }

  /* Badges */
  .sandbox-badge { font-size: 14px; flex-shrink: 0; }
  .verified-badge { color: var(--accent-color); font-size: var(--font-size-xs); flex-shrink: 0; }
  .blacklist-badge { background: #ef4444; color: white; font-size: 10px; padding: 2px 6px; border-radius: 10px; }
  .installed-badge { background: var(--accent-color); color: white; font-size: 10px; padding: 4px 10px; border-radius: 10px; }

  /* Perm tags */
  .perm-tag { background: var(--bg-tertiary); color: var(--text-secondary); font-size: 10px; padding: 1px 5px; border-radius: 4px; }
  .perm-tag.no-perm { color: var(--text-tertiary); }

  /* Toggle */
  .toggle-switch { position: relative; display: inline-flex; align-items: center; cursor: pointer; }
  .toggle-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
  .toggle-slider { width: 32px; height: 18px; background: var(--border-color); border-radius: 9px; transition: background 0.2s; position: relative; }
  .toggle-slider::after { content: ''; position: absolute; width: 14px; height: 14px; background: white; border-radius: 50%; top: 2px; left: 2px; transition: transform 0.2s; }
  .toggle-switch input:checked + .toggle-slider { background: var(--accent-color); }
  .toggle-switch input:checked + .toggle-slider::after { transform: translateX(14px); }
  .toggle-switch input:disabled + .toggle-slider { opacity: 0.5; cursor: not-allowed; }

  /* Buttons */
  .btn-secondary { padding: 5px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; font-size: var(--font-size-xs); transition: all 0.15s; white-space: nowrap; }
  .btn-secondary:hover { border-color: var(--accent-color); color: var(--accent-color); }
  .btn-danger-sm { padding: 4px 10px; border: 1px solid #ef4444; border-radius: 6px; background: transparent; color: #ef4444; cursor: pointer; font-size: var(--font-size-xs); }
  .btn-danger-sm:hover { background: rgba(239,68,68,0.1); }
  .btn-danger-sm:disabled { opacity: 0.5; cursor: not-allowed; color: var(--text-tertiary); border-color: var(--border-color); }
  .btn-install { padding: 5px 14px; border: none; border-radius: 6px; background: var(--accent-color); color: white; cursor: pointer; font-size: var(--font-size-xs); white-space: nowrap; }
  .btn-install:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Errors / warnings */
  .process-error, .blacklist-warning, .url-error { font-size: var(--font-size-xs); color: #ef4444; margin-top: 4px; }
  .url-status { font-size: var(--font-size-xs); color: var(--text-muted); margin-top: 4px; }
  .preset-error { font-size: var(--font-size-xs); color: #ef4444; margin-top: 4px; word-break: break-all; }
  .cache-notice { font-size: var(--font-size-xs); color: var(--text-tertiary); padding: 4px 12px; text-align: right; }

  /* Local install row */
  .local-install-row { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; border-top: 1px solid var(--border-color); margin-top: 4px; }
  .url-import { display: flex; gap: 8px; }
  .url-input { flex: 1; padding: 5px 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font-size: var(--font-size-xs); }
  .url-input:focus { outline: none; border-color: var(--accent-color); }

  /* Market toolbar */
  .market-toolbar { display: flex; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
  .search-input { flex: 1; padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font-size: var(--font-size-xs); }
  .search-input:focus { outline: none; border-color: var(--accent-color); }
  .refresh-btn { padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; font-size: 14px; }
  .refresh-btn:hover { border-color: var(--accent-color); }
  .refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Category bar */
  .category-bar { display: flex; gap: 4px; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
  .cat-btn { padding: 3px 10px; border: 1px solid var(--border-color); border-radius: 12px; background: none; color: var(--text-secondary); cursor: pointer; font-size: var(--font-size-xs); }
  .cat-btn.active { background: var(--accent-color); color: white; border-color: var(--accent-color); }

  /* Market layout */
  .market-layout { flex: 1; display: flex; overflow: hidden; }
  .market-list { flex: 1; min-width: 0; overflow-y: auto; padding: 12px; gap: 8px; }
  .market-card { cursor: pointer; }

  /* Progress bar */
  .progress-bar { position: relative; width: 100px; height: 18px; background: var(--bg-tertiary); border-radius: 9px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent-color); border-radius: 9px; transition: width 0.3s; }
  .progress-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 9px; color: var(--text-primary); font-weight: 600; }
  .installing-text { font-size: var(--font-size-xs); color: var(--text-secondary); }

  /* Empty / loading states */
  .empty-state, .loading-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px 20px; color: var(--text-secondary); font-size: var(--font-size-sm); }

  /* Detail panel */
  .detail-panel { width: 300px; flex-shrink: 0; border-left: 1px solid var(--border-color); display: flex; flex-direction: column; overflow: hidden; }
  .detail-header { display: flex; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
  .detail-name { font-weight: 600; font-size: var(--font-size-sm); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail-close { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 16px; padding: 0 4px; }
  .detail-body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
  .detail-meta { font-size: var(--font-size-xs); color: var(--text-secondary); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .detail-desc { font-size: var(--font-size-xs); color: var(--text-primary); line-height: 1.5; }
  .detail-section { display: flex; flex-direction: column; gap: 6px; }
  .detail-section-title { font-size: var(--font-size-xs); font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .sandbox-row { font-size: var(--font-size-xs); color: var(--text-primary); }
  .perm-list { display: flex; flex-direction: column; gap: 4px; background: var(--bg-secondary); border-radius: 6px; padding: 8px; }
  .perm-row { display: flex; flex-direction: column; gap: 2px; }
  .perm-name { font-size: var(--font-size-xs); font-weight: 600; color: var(--text-primary); }
  .perm-reason { font-size: 11px; color: var(--text-secondary); }
  .changelog { font-size: 11px; color: var(--text-secondary); white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
  .detail-footer { display: flex; gap: 8px; align-items: center; padding-top: 8px; border-top: 1px solid var(--border-color); flex-wrap: wrap; }
</style>

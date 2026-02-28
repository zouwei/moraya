<script lang="ts">
  import { onDestroy } from 'svelte';
  import { settingsStore, type Theme } from '../stores/settings-store';
  import { filesStore, type KnowledgeBase } from '../stores/files-store';
  import { t, SUPPORTED_LOCALES, type LocaleSelection } from '$lib/i18n';
  import { isMacOS } from '$lib/utils/platform';
  import { builtinThemes, getLightThemes, getDarkThemes } from '$lib/styles/themes';
  import AISettings from './ai/AISettings.svelte';
  import MCPPanel from './ai/MCPPanel.svelte';
  import ImageHostingSettings from './ImageHostingSettings.svelte';
  import PublishSettings from './PublishSettings.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import PluginsPanel from './PluginsPanel.svelte';

  type Tab = 'general' | 'editor' | 'appearance' | 'ai' | 'mcp' | 'image' | 'publish' | 'permissions' | 'voice' | 'plugins';

  let {
    onClose,
    initialTab = 'general' as Tab,
  }: {
    onClose: () => void;
    initialTab?: Tab;
  } = $props();

  // svelte-ignore state_referenced_locally
  let activeTab = $state<Tab>(initialTab);

  let theme = $state<Theme>('system');
  let colorTheme = $state('default-light');
  let darkColorTheme = $state('default-dark');
  let useSeparateDarkTheme = $state(false);
  let fontSize = $state(16);
  let autoSave = $state(true);
  let autoSaveInterval = $state(30);
  let rememberLastFolder = $state(true);
  let currentLocale = $state<LocaleSelection>('system');
  let editorLineWidth = $state(800);
  let editorTabSize = $state(4);
  let showLineNumbers = $state(false);

  let knowledgeBases = $state<KnowledgeBase[]>([]);
  let showKBManager = $state(false);

  const lightThemes = getLightThemes();
  const darkThemes = getDarkThemes();

  // Top-level store subscriptions — do NOT wrap in $effect().
  // Svelte 5 $effect tracks reads in subscribe callbacks, causing infinite loops.
  const unsub1 = filesStore.subscribe(state => {
    knowledgeBases = state.knowledgeBases;
  });
  const unsub2 = settingsStore.subscribe(state => {
    theme = state.theme;
    colorTheme = state.colorTheme;
    darkColorTheme = state.darkColorTheme;
    useSeparateDarkTheme = state.useSeparateDarkTheme;
    fontSize = state.fontSize;
    autoSave = state.autoSave;
    autoSaveInterval = state.autoSaveInterval / 1000;
    rememberLastFolder = state.rememberLastFolder;
    currentLocale = state.localeSelection;
    editorLineWidth = state.editorLineWidth;
    editorTabSize = state.editorTabSize;
    showLineNumbers = state.showLineNumbers;
  });
  onDestroy(() => { unsub1(); unsub2(); });

  function handleLocaleChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value as LocaleSelection;
    settingsStore.setLocaleSelection(value);
  }

  function handleThemeChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value as Theme;
    settingsStore.setTheme(value);
  }

  function handleColorThemeChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    settingsStore.setColorTheme(value);
  }

  function handleDarkColorThemeChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    settingsStore.setDarkColorTheme(value);
  }

  function handleSeparateDarkThemeChange(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    settingsStore.setUseSeparateDarkTheme(checked);
  }

  function handleFontSizeChange(event: Event) {
    const value = parseInt((event.target as HTMLInputElement).value);
    settingsStore.update({ fontSize: value });
    document.documentElement.style.setProperty('--font-size-base', `${value}px`);
  }

  function handleAutoSaveChange(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    settingsStore.update({ autoSave: checked });
  }

  function handleIntervalChange(event: Event) {
    const value = parseInt((event.target as HTMLInputElement).value);
    settingsStore.update({ autoSaveInterval: value * 1000 });
  }

  function handleLineWidthChange(event: Event) {
    const value = parseInt((event.target as HTMLInputElement).value);
    settingsStore.update({ editorLineWidth: value });
  }

  function handleTabSizeChange(event: Event) {
    const value = parseInt((event.target as HTMLSelectElement).value);
    settingsStore.update({ editorTabSize: value });
  }

  function handleLineNumbersChange(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    settingsStore.update({ showLineNumbers: checked });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onClose();
    }
  }

  const tabs: { key: Tab; icon: string; labelKey: string }[] = [
    { key: 'general', icon: '⚙', labelKey: 'settings.tabs.general' },
    { key: 'editor', icon: '✎', labelKey: 'settings.tabs.editor' },
    { key: 'appearance', icon: '◐', labelKey: 'settings.tabs.appearance' },
    { key: 'permissions', icon: '🔒', labelKey: 'settings.tabs.permissions' },
    { key: 'ai', icon: '✦', labelKey: 'settings.tabs.ai' },
    { key: 'mcp', icon: '⇌', labelKey: 'settings.tabs.mcp' },
    { key: 'image', icon: '▣', labelKey: 'settings.tabs.image' },
    { key: 'publish', icon: '📤', labelKey: 'settings.tabs.publish' },
    { key: 'voice', icon: '🎤', labelKey: 'settings.tabs.voice' },
    { key: 'plugins', icon: '⊞', labelKey: 'settings.tabs.plugins' },
  ];
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="settings-overlay" onclick={onClose}>
  <div class="settings-panel" onclick={(e) => e.stopPropagation()}>
    <!-- Full-width top bar -->
    <div class="panel-header">
      {#if isMacOS}
        <button class="close-btn" onclick={onClose} title={$t('common.close')}>
          <svg width="14" height="14" viewBox="0 0 10 10">
            <path fill="currentColor" d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z"/>
          </svg>
        </button>
      {/if}
      <h2 class="panel-title">{$t('settings.title')}</h2>
      {#if !isMacOS}
        <button class="close-btn" onclick={onClose} title={$t('common.close')}>
          <svg width="14" height="14" viewBox="0 0 10 10">
            <path fill="currentColor" d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z"/>
          </svg>
        </button>
      {/if}
    </div>

    <!-- Body: sidebar + content side by side -->
    <div class="panel-body">
      <!-- Left sidebar -->
      <div class="settings-sidebar">
        <nav class="sidebar-nav">
          {#each tabs as tab}
            <button
              class="nav-item"
              class:active={activeTab === tab.key}
              onclick={() => activeTab = tab.key}
            >
              <span class="nav-icon">{tab.icon}</span>
              <span class="nav-label">{$t(tab.labelKey)}</span>
            </button>
          {/each}
        </nav>
        <div class="sidebar-footer">
          <span class="version">{$t('settings.version', { version: __APP_VERSION__ })}</span>
        </div>
      </div>

      <!-- Right content -->
      <div class="settings-content">
        <div class="content-body">
          <h3 class="content-title">{$t(tabs.find(t => t.key === activeTab)?.labelKey ?? '')}</h3>
          <!-- Heavy components: always mounted, shown/hidden via CSS to avoid remount lag -->
          <div class="tab-pane" class:active={activeTab === 'ai'}><AISettings /></div>
        <div class="tab-pane" class:active={activeTab === 'mcp'}><MCPPanel /></div>
        <div class="tab-pane" class:active={activeTab === 'image'}><ImageHostingSettings /></div>
        <div class="tab-pane" class:active={activeTab === 'publish'}><PublishSettings /></div>
        <div class="tab-pane" class:active={activeTab === 'voice'}><VoiceSettings /></div>
        <div class="tab-pane" class:active={activeTab === 'plugins'}><PluginsPanel /></div>

        {#if activeTab === 'general'}
          <div class="setting-group">
            <label class="setting-label" for="settings-locale">{$t('settings.language.label')}</label>
            <select id="settings-locale" class="setting-input" value={currentLocale} onchange={handleLocaleChange}>
              {#each SUPPORTED_LOCALES as loc}
                <option value={loc.code}>{loc.code === 'system' ? $t('settings.language.system') : loc.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-group">
            <label class="setting-label">
              <input
                type="checkbox"
                checked={autoSave}
                onchange={handleAutoSaveChange}
              />
              {$t('settings.autoSave.label')}
            </label>
          </div>

          {#if autoSave}
            <div class="setting-group">
              <label class="setting-label" for="settings-autosave-interval">{$t('settings.autoSave.interval')}</label>
              <div class="setting-row">
                <input
                  id="settings-autosave-interval"
                  type="range"
                  min="5"
                  max="120"
                  step="5"
                  value={autoSaveInterval}
                  oninput={handleIntervalChange}
                  class="setting-range"
                />
                <span class="setting-value">{autoSaveInterval}s</span>
              </div>
            </div>
          {/if}

          <div class="setting-group">
            <label class="setting-label">
              <input
                type="checkbox"
                checked={rememberLastFolder}
                onchange={(e: Event) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  settingsStore.update({ rememberLastFolder: checked });
                  if (!checked) {
                    settingsStore.update({ lastOpenedFolder: null });
                  }
                }}
              />
              {$t('settings.rememberLastFolder')}
            </label>
          </div>

          <div class="setting-section">
            <div class="section-header">{$t('knowledgeBase.title')}</div>
            <div class="setting-group">
              <div class="kb-setting-row">
                <span class="kb-count">{knowledgeBases.length} {$t('knowledgeBase.title').toLowerCase()}</span>
                <button class="kb-manage-btn" onclick={() => showKBManager = true}>
                  {$t('knowledgeBase.manage')}
                </button>
              </div>
            </div>
          </div>

        {:else if activeTab === 'editor'}
          <div class="setting-group">
            <label class="setting-label" for="settings-line-width">{$t('settings.editor.lineWidth')}</label>
            <div class="setting-row">
              <input
                id="settings-line-width"
                type="range"
                min="600"
                max="1200"
                step="50"
                value={editorLineWidth}
                oninput={handleLineWidthChange}
                class="setting-range"
              />
              <span class="setting-value">{editorLineWidth}px</span>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label" for="settings-tab-size">{$t('settings.editor.tabSize')}</label>
            <select id="settings-tab-size" class="setting-input" value={editorTabSize} onchange={handleTabSizeChange}>
              <option value={2}>2</option>
              <option value={4}>4</option>
              <option value={8}>8</option>
            </select>
          </div>

          <div class="setting-group">
            <label class="setting-label">
              <input
                type="checkbox"
                checked={showLineNumbers}
                onchange={handleLineNumbersChange}
              />
              {$t('settings.editor.showLineNumbers')}
            </label>
          </div>

        {:else if activeTab === 'appearance'}
          <!-- Theme section -->
          <div class="setting-section">
            <div class="section-header">{$t('settings.appearance.themeSection')}</div>

            <div class="setting-group">
              <label class="setting-label" for="settings-color-theme">{$t('settings.theme.label')}</label>
              <select id="settings-color-theme" class="setting-input" value={colorTheme} onchange={handleColorThemeChange}>
                {#each builtinThemes as ct}
                  <option value={ct.id}>{ct.name}</option>
                {/each}
              </select>
            </div>

            <div class="setting-group">
              <label class="setting-label">
                <input
                  type="checkbox"
                  checked={useSeparateDarkTheme}
                  onchange={handleSeparateDarkThemeChange}
                />
                {$t('settings.appearance.separateDarkTheme')}
              </label>
            </div>

            {#if useSeparateDarkTheme}
              <div class="setting-group">
                <label class="setting-label" for="settings-dark-theme">{$t('settings.appearance.darkTheme')}</label>
                <select id="settings-dark-theme" class="setting-input" value={darkColorTheme} onchange={handleDarkColorThemeChange}>
                  {#each darkThemes as ct}
                    <option value={ct.id}>{ct.name}</option>
                  {/each}
                </select>
              </div>
            {/if}
          </div>

          <!-- Dark mode section -->
          <div class="setting-section">
            <div class="section-header">{$t('settings.appearance.darkModeSection')}</div>

            <div class="setting-group">
              <label class="setting-label" for="settings-dark-mode">{$t('settings.appearance.darkModeLabel')}</label>
              <select id="settings-dark-mode" class="setting-input" value={theme} onchange={handleThemeChange}>
                <option value="system">{$t('settings.theme.system')}</option>
                <option value="light">{$t('settings.theme.light')}</option>
                <option value="dark">{$t('settings.theme.dark')}</option>
              </select>
            </div>
          </div>

          <!-- Font section -->
          <div class="setting-section">
            <div class="section-header">{$t('settings.appearance.fontSection')}</div>

            <div class="setting-group">
              <label class="setting-label" for="settings-font-size">{$t('settings.fontSize.label')}</label>
              <div class="setting-row">
                <input
                  id="settings-font-size"
                  type="range"
                  min="12"
                  max="24"
                  value={fontSize}
                  oninput={handleFontSizeChange}
                  class="setting-range"
                />
                <span class="setting-value">{fontSize}px</span>
              </div>
            </div>
          </div>

        {:else if activeTab === 'permissions'}
          <div class="setting-section">
            <div class="section-header">{$t('settings.permissions.aiTitle')}</div>
            <div class="setting-group">
              <label class="setting-label" for="settings-ai-max-tokens">{$t('settings.permissions.aiMaxTokens')}</label>
              <input
                id="settings-ai-max-tokens"
                type="number"
                class="setting-input"
                value={$settingsStore.aiMaxTokens}
                min={1024}
                max={128000}
                step={1024}
                onchange={(e) => {
                  const v = parseInt((e.target as HTMLInputElement).value);
                  if (v >= 1024 && v <= 128000) settingsStore.update({ aiMaxTokens: v });
                }}
              />
              <p class="perm-hint">{$t('settings.permissions.aiMaxTokensHint')}</p>
            </div>
            <div class="setting-group">
              <label class="setting-label" for="settings-ai-rules-max-chars">{$t('settings.permissions.aiRulesMaxChars')}</label>
              <input
                id="settings-ai-rules-max-chars"
                type="number"
                class="setting-input"
                value={$settingsStore.aiRulesMaxChars}
                min={2000}
                max={64000}
                step={2000}
                onchange={(e) => {
                  const v = parseInt((e.target as HTMLInputElement).value);
                  if (v >= 2000 && v <= 64000) settingsStore.update({ aiRulesMaxChars: v });
                }}
              />
              <p class="perm-hint">{$t('settings.permissions.aiRulesMaxCharsHint')}</p>
            </div>
            <div class="setting-group">
              <label class="setting-label" for="settings-ai-tool-result-max-chars">{$t('settings.permissions.aiToolResultMaxChars')}</label>
              <input
                id="settings-ai-tool-result-max-chars"
                type="number"
                class="setting-input"
                value={$settingsStore.aiToolResultMaxChars}
                min={2000}
                max={64000}
                step={2000}
                onchange={(e) => {
                  const v = parseInt((e.target as HTMLInputElement).value);
                  if (v >= 2000 && v <= 64000) settingsStore.update({ aiToolResultMaxChars: v });
                }}
              />
              <p class="perm-hint">{$t('settings.permissions.aiToolResultMaxCharsHint')}</p>
            </div>
            <div class="setting-group">
              <label class="setting-label" for="settings-ai-max-tool-rounds">{$t('settings.permissions.aiMaxToolRounds')}</label>
              <input
                id="settings-ai-max-tool-rounds"
                type="number"
                class="setting-input"
                value={$settingsStore.aiMaxToolRounds}
                min={1}
                max={100}
                step={1}
                onchange={(e) => {
                  const v = parseInt((e.target as HTMLInputElement).value);
                  if (v >= 1 && v <= 100) settingsStore.update({ aiMaxToolRounds: v });
                }}
              />
              <p class="perm-hint">{$t('settings.permissions.aiMaxToolRoundsHint')}</p>
            </div>
          </div>

          <div class="setting-section">
            <div class="section-header">{$t('settings.permissions.mcpTitle')}</div>
            <div class="setting-group">
              <label class="setting-toggle">
                <input
                  type="checkbox"
                  checked={$settingsStore.mcpAutoApprove}
                  onchange={(e) => settingsStore.update({ mcpAutoApprove: (e.target as HTMLInputElement).checked })}
                />
                <span class="setting-label">{$t('mcp.servers.autoApprove')}</span>
              </label>
              <p class="perm-hint">{$t('mcp.servers.autoApproveHint')}</p>
            </div>
          </div>
        {/if}
        </div><!-- content-body -->
      </div><!-- settings-content -->
    </div><!-- panel-body -->
  </div><!-- settings-panel -->
</div><!-- settings-overlay -->

{#if showKBManager}
  {#await import('./KnowledgeBaseManager.svelte') then { default: KnowledgeBaseManager }}
    <KnowledgeBaseManager onClose={() => showKBManager = false} />
  {/await}
{/if}

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .settings-panel {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    width: 720px;
    height: 520px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  }

  /* Full-width top bar */
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--border-light);
    flex-shrink: 0;
  }

  .panel-title {
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  /* macOS: close btn on left → use flex-start, gap between btn and title */
  :global(.platform-macos) .panel-header {
    justify-content: flex-start;
    gap: 0.5rem;
  }

  /* Sidebar + content side by side */
  .panel-body {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  /* Left sidebar */
  .settings-sidebar {
    width: 180px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border-light);
  }

  .sidebar-nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 0.25rem 0.5rem;
    gap: 0.125rem;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    border-radius: 6px;
    text-align: left;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .nav-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .nav-item.active {
    background: var(--accent-color);
    color: white;
  }

  .nav-icon {
    font-size: 0.85rem;
    width: 1.2rem;
    text-align: center;
    flex-shrink: 0;
  }

  .nav-label {
    white-space: nowrap;
  }

  .sidebar-footer {
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .version {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  /* Right content */
  .settings-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .close-btn {
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
    flex-shrink: 0;
  }

  .close-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .content-title {
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 0.25rem;
  }

  .content-body {
    flex: 1;
    padding: 1.25rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  /* Heavy tab components stay mounted; CSS toggles visibility */
  .tab-pane {
    display: none;
  }
  .tab-pane.active {
    display: contents; /* transparent wrapper — children flow directly into flex container */
  }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .setting-label {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .setting-input {
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    max-width: 280px;
  }

  .setting-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-width: 320px;
  }

  .setting-range {
    flex: 1;
    accent-color: var(--accent-color);
  }

  .setting-value {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    min-width: 3.5rem;
    text-align: right;
  }

  .setting-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .setting-section + .setting-section {
    margin-top: 0.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-light);
  }

  .section-header {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .setting-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  .setting-toggle input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
    accent-color: var(--accent-color);
  }

  .perm-hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin: 0;
    line-height: 1.4;
  }

  .kb-setting-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .kb-count {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .kb-manage-btn {
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 5px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    cursor: pointer;
  }

  .kb-manage-btn:hover {
    border-color: var(--accent-color);
    color: var(--accent-color);
  }

</style>

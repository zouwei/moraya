<script lang="ts">
  import { onDestroy } from 'svelte';
  import { settingsStore, type Theme } from '../stores/settings-store';
  import { filesStore, type KnowledgeBase } from '../stores/files-store';
  import { t, SUPPORTED_LOCALES, type LocaleSelection } from '$lib/i18n';
  import { isMacOS } from '$lib/utils/platform';
  import { builtinThemes, getLightThemes, getDarkThemes } from '$lib/styles/themes';
  import AISettings from './ai/AISettings.svelte';
  import ImageAISettings from './ai/ImageAISettings.svelte';
  import MCPPanel from './ai/MCPPanel.svelte';
  import ImageHostingSettings from './ImageHostingSettings.svelte';
  import PublishSettings from './PublishSettings.svelte';
  import VoiceSettings from './VoiceSettings.svelte';
  import PluginsPanel from './PluginsPanel.svelte';
  import KBIndexSettings from './KBIndexSettings.svelte';
  import KbSyncSettings from './KbSyncSettings.svelte';
  import MemorySettings from './MemorySettings.svelte';
  import PicoraSettingsTab from './picora-tab/PicoraSettingsTab.svelte';
  import ExportSettings from './ExportSettings.svelte';
  import ShortcutsPanel from './ShortcutsPanel.svelte';
  import { Select } from '$lib/components/ui';

  type Tab = 'general' | 'ai' | 'image-ai' | 'mcp' | 'image' | 'publish' | 'shortcuts' | 'voice' | 'plugins' | 'knowledge-base' | 'picora' | 'memory';

  let {
    onClose,
    initialTab = 'general' as Tab,
  }: {
    onClose: () => void;
    initialTab?: Tab;
  } = $props();

  // svelte-ignore state_referenced_locally
  let activeTab = $state<Tab>(initialTab);

  // Lazy tab mounting. The heavy tab components (AI/MCP/Voice/Plugins/…) used
  // to ALL mount on every panel open, which is the source of the noticeable
  // open delay. Instead, a tab's component mounts on first visit and stays
  // mounted afterwards (so switching back is instant). The effect marks the
  // active tab visited — covering both clicks and programmatic jumps.
  // svelte-ignore state_referenced_locally
  let visitedTabs = $state<Record<string, boolean>>({ [initialTab]: true });
  $effect(() => { visitedTabs[activeTab] = true; });

  let theme = $state<Theme>('system');
  let colorTheme = $state('default-light');
  let darkColorTheme = $state('default-dark');
  let useSeparateDarkTheme = $state(false);
  let fontSize = $state(16);
  let autoSave = $state(true);
  let autoSaveMaxMinutes = $state(10);
  let autoSaveIdleMinutes = $state(3);
  let rememberLastFolder = $state(true);
  let rulesHistoryCount = $state(10);
  let versionHistoryEnabled = $state(true);
  let versionHistoryMax = $state(50);
  let currentLocale = $state<LocaleSelection>('system');
  let editorLineWidth = $state(800);
  let editorTabSize = $state(4);
  let showLineNumbers = $state(false);

  let knowledgeBases = $state<KnowledgeBase[]>([]);

  function openPicoraManualImport() {
    window.dispatchEvent(new CustomEvent('moraya:picora-open-manual'));
  }

  const lightThemes = getLightThemes();
  const darkThemes = getDarkThemes();

  let localeOptions = $derived(
    SUPPORTED_LOCALES.map(loc => ({
      value: loc.code,
      label: loc.code === 'system' ? $t('settings.language.system') : loc.label,
    }))
  );
  const tabSizeOptions = [
    { value: 2, label: '2' },
    { value: 4, label: '4' },
    { value: 8, label: '8' },
  ];
  const colorThemeOptions = builtinThemes.map(ct => ({ value: ct.id, label: ct.name }));
  const darkThemeOptions = darkThemes.map(ct => ({ value: ct.id, label: ct.name }));
  let darkModeOptions = $derived([
    { value: 'system', label: $t('settings.theme.system') },
    { value: 'light', label: $t('settings.theme.light') },
    { value: 'dark', label: $t('settings.theme.dark') },
  ]);

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
    autoSaveMaxMinutes = state.autoSaveMaxMinutes ?? 10;
    autoSaveIdleMinutes = state.autoSaveIdleMinutes ?? 3;
    rememberLastFolder = state.rememberLastFolder;
    rulesHistoryCount = state.rulesHistoryCount ?? 10;
    versionHistoryEnabled = state.versionHistoryEnabled ?? true;
    versionHistoryMax = state.versionHistoryMax ?? 50;
    currentLocale = state.localeSelection;
    editorLineWidth = state.editorLineWidth;
    editorTabSize = state.editorTabSize;
    showLineNumbers = state.showLineNumbers;
  });
  onDestroy(() => { unsub1(); unsub2(); });

  function handleLocaleChange(value: LocaleSelection) {
    settingsStore.setLocaleSelection(value);
  }

  function handleThemeChange(value: Theme) {
    settingsStore.setTheme(value);
  }

  function handleColorThemeChange(value: string) {
    settingsStore.setColorTheme(value);
  }

  function handleDarkColorThemeChange(value: string) {
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

  function handleAutoSaveMaxChange(event: Event) {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    if (value >= 1 && value <= 120) settingsStore.update({ autoSaveMaxMinutes: value });
  }

  function handleAutoSaveIdleChange(event: Event) {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    if (value >= 1 && value <= 60) settingsStore.update({ autoSaveIdleMinutes: value });
  }

  function handleLineWidthChange(event: Event) {
    const value = parseInt((event.target as HTMLInputElement).value);
    settingsStore.update({ editorLineWidth: value });
  }

  function handleTabSizeChange(value: number) {
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

  const tabGroups: { groupKey: string; items: { key: Tab; icon: string; labelKey: string }[] }[] = [
    {
      groupKey: 'settings.groups.picora',
      items: [
        { key: 'picora', icon: '☁', labelKey: 'settings.tabs.picora' },
        { key: 'knowledge-base', icon: '📚', labelKey: 'settings.tabs.knowledge_base' },
      ],
    },
    {
      groupKey: 'settings.groups.general',
      items: [
        { key: 'general', icon: '⚙', labelKey: 'settings.tabs.general' },
        { key: 'shortcuts', icon: '⌘', labelKey: 'settings.tabs.shortcuts' },
      ],
    },
    {
      groupKey: 'settings.groups.ai',
      items: [
        { key: 'ai', icon: '✦', labelKey: 'settings.tabs.ai' },
        { key: 'image-ai', icon: '🖼', labelKey: 'settings.tabs.image_ai' },
        { key: 'voice', icon: '🎤', labelKey: 'settings.tabs.voice' },
        { key: 'mcp', icon: '⇌', labelKey: 'settings.tabs.mcp' },
        { key: 'memory', icon: '🧠', labelKey: 'memory.title' },
      ],
    },
    {
      groupKey: 'settings.groups.extensions',
      items: [
        { key: 'image', icon: '▣', labelKey: 'settings.tabs.image' },
        { key: 'publish', icon: '📤', labelKey: 'settings.tabs.publish' },
        { key: 'plugins', icon: '⊞', labelKey: 'settings.tabs.plugins' },
      ],
    },
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
        <button class="close-btn close-btn-win" onclick={onClose} title={$t('common.close')}>
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
          {#each tabGroups as group}
            <div class="nav-group-label">{$t(group.groupKey)}</div>
            {#each group.items as tab}
              <button
                class="nav-item"
                class:active={activeTab === tab.key}
                onclick={() => activeTab = tab.key}
              >
                <span class="nav-icon">
                  {#if tab.key === 'picora'}
                    <!-- Picora brand mark (picora-mark-mono-blue.svg) -->
                    <svg width="10" height="12" viewBox="8 6 16 20" fill="none" style="vertical-align:-1px"><path d="M9.5 7.5v17" stroke="#2563eb" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="14" r="6.5" stroke="#2563eb" stroke-width="3"/><circle cx="16" cy="14" r="2.4" fill="#2563eb"/></svg>
                  {:else}{tab.icon}{/if}
                </span>
                <span class="nav-label">{$t(tab.labelKey)}</span>
              </button>
            {/each}
          {/each}
        </nav>
        <div class="sidebar-footer">
          <span class="version">{$t('settings.version', { version: __APP_VERSION__ })}</span>
        </div>
      </div>

      <!-- Right content -->
      <div class="settings-content">
        <div class="content-body">
          <!-- Tab descriptions for select tabs -->
          {#if activeTab === 'image'}
            <p class="tab-desc">{$t('settings.tab_desc.image')} {$t('settings.image_host.subtitle_suffix')}</p>
          {:else if activeTab === 'publish'}
            <p class="tab-desc">{$t('settings.tab_desc.publish')}</p>
          {/if}

          <!-- Heavy components: mounted lazily on first visit, then kept mounted
               (shown/hidden via CSS) so switching back has no remount lag. -->
          <div class="tab-pane" class:active={activeTab === 'ai'}>{#if visitedTabs['ai']}<AISettings />{/if}</div>
          <div class="tab-pane" class:active={activeTab === 'image-ai'}>{#if visitedTabs['image-ai']}<ImageAISettings />{/if}</div>
        <div class="tab-pane" class:active={activeTab === 'mcp'}>{#if visitedTabs['mcp']}<MCPPanel />{/if}</div>
        <div class="tab-pane" class:active={activeTab === 'image'}>
          {#if visitedTabs['image']}
            <ImageHostingSettings
              onImportPicora={openPicoraManualImport}
              onJumpToPicora={() => activeTab = 'picora'}
            />
          {/if}
        </div>
        <div class="tab-pane" class:active={activeTab === 'publish'}>{#if visitedTabs['publish']}<PublishSettings />{/if}</div>
        <div class="tab-pane" class:active={activeTab === 'voice'}>{#if visitedTabs['voice']}<VoiceSettings />{/if}</div>
        <!-- Merged "知识库" tab: KB index/manage + KB sync (prompt assets & memory
             bindings now live per-KB inside KbSyncSettings' "AI memory asset" panel). -->
        <div class="tab-pane merged-kb" class:active={activeTab === 'knowledge-base'}>
          {#if visitedTabs['knowledge-base']}
            <KBIndexSettings />
            <KbSyncSettings />
          {/if}
        </div>
        <div class="tab-pane" class:active={activeTab === 'memory'}>{#if visitedTabs['memory']}<MemorySettings />{/if}</div>
        <div class="tab-pane" class:active={activeTab === 'picora'}>
          {#if visitedTabs['picora']}
            <PicoraSettingsTab onJumpToKbSync={() => activeTab = 'knowledge-base'} />
          {/if}
        </div>
        <div class="tab-pane" class:active={activeTab === 'plugins'}>{#if visitedTabs['plugins']}<PluginsPanel />{/if}</div>

        {#if activeTab === 'general'}
          <div class="gx-tab">
            <!-- 1. General — language, autosave, etc. -->
            <section class="gx-section">
              <h3 class="gx-section-title">{$t('settings.tabs.general')}</h3>
              <div class="gx-card">
                <div class="gx-row">
                  <label class="gx-label" for="settings-locale">{$t('settings.language.label')}</label>
                  <div class="gx-control">
                    <Select id="settings-locale" class="gx-select" block bind:value={currentLocale} options={localeOptions} onchange={(v) => handleLocaleChange(v as LocaleSelection)} />
                  </div>
                </div>

                <div class="gx-row gx-row-check">
                  <label class="gx-check">
                    <input type="checkbox" checked={autoSave} onchange={handleAutoSaveChange} />
                    <span>{$t('settings.auto_save.label')}</span>
                  </label>
                </div>

                {#if autoSave}
                  <div class="gx-row gx-row-indent">
                    <label class="gx-label" for="settings-autosave-max">{$t('settings.auto_save.max_interval')}</label>
                    <div class="gx-control gx-control-inline">
                      <input
                        id="settings-autosave-max"
                        type="number"
                        min="1" max="120"
                        value={autoSaveMaxMinutes}
                        oninput={handleAutoSaveMaxChange}
                        class="gx-number"
                      />
                      <span class="gx-value">{$t('settings.auto_save.minutes_unit')}</span>
                    </div>
                    <p class="gx-hint gx-hint-indent">{$t('settings.auto_save.max_interval_hint')}</p>
                  </div>
                  <div class="gx-row gx-row-indent">
                    <label class="gx-label" for="settings-autosave-idle">{$t('settings.auto_save.idle_interval')}</label>
                    <div class="gx-control gx-control-inline">
                      <input
                        id="settings-autosave-idle"
                        type="number"
                        min="1" max="60"
                        value={autoSaveIdleMinutes}
                        oninput={handleAutoSaveIdleChange}
                        class="gx-number"
                      />
                      <span class="gx-value">{$t('settings.auto_save.minutes_unit')}</span>
                    </div>
                    <p class="gx-hint gx-hint-indent">{$t('settings.auto_save.idle_interval_hint')}</p>
                  </div>
                {/if}

                <div class="gx-row gx-row-check">
                  <label class="gx-check">
                    <input
                      type="checkbox"
                      checked={versionHistoryEnabled}
                      onchange={(e: Event) => settingsStore.update({ versionHistoryEnabled: (e.target as HTMLInputElement).checked })}
                    />
                    <span>{$t('settings.version_history.label')}</span>
                  </label>
                  <p class="gx-hint gx-hint-indent">{$t('settings.version_history.hint')}</p>
                </div>

                {#if versionHistoryEnabled}
                  <div class="gx-row gx-row-indent">
                    <label class="gx-label" for="settings-version-history-max">{$t('settings.version_history.max')}</label>
                    <div class="gx-control">
                      <input
                        id="settings-version-history-max"
                        type="number"
                        min="1" max="500"
                        value={versionHistoryMax}
                        oninput={(e: Event) => {
                          const val = parseInt((e.target as HTMLInputElement).value, 10);
                          if (val >= 1 && val <= 500) settingsStore.update({ versionHistoryMax: val });
                        }}
                        class="gx-number"
                      />
                    </div>
                  </div>
                {/if}

                <div class="gx-row gx-row-check">
                  <label class="gx-check">
                    <input
                      type="checkbox"
                      checked={rememberLastFolder}
                      onchange={(e: Event) => {
                        const checked = (e.target as HTMLInputElement).checked;
                        settingsStore.update({ rememberLastFolder: checked });
                        if (!checked) settingsStore.update({ lastOpenedFolder: null });
                      }}
                    />
                    <span>{$t('settings.remember_last_folder')}</span>
                  </label>
                </div>

                <div class="gx-row gx-row-check">
                  <label class="gx-check">
                    <input
                      type="checkbox"
                      checked={$settingsStore.showCloudInsertEntries}
                      onchange={(e: Event) => settingsStore.update({ showCloudInsertEntries: (e.target as HTMLInputElement).checked })}
                    />
                    <span>{$t('settings.show_cloud_insert_entries')}</span>
                  </label>
                  <p class="gx-hint gx-hint-indent">{$t('settings.show_cloud_insert_entries_desc')}</p>
                </div>

                <div class="gx-row">
                  <label class="gx-label" for="settings-rules-history-count">{$t('settings.rules_history_count')}</label>
                  <div class="gx-control">
                    <input
                      id="settings-rules-history-count"
                      type="number"
                      min="1" max="100"
                      value={rulesHistoryCount}
                      oninput={(e: Event) => {
                        const val = parseInt((e.target as HTMLInputElement).value, 10);
                        if (val >= 1 && val <= 100) settingsStore.update({ rulesHistoryCount: val });
                      }}
                      class="gx-number"
                    />
                    <p class="gx-hint">{$t('settings.rules_history_count_hint')}</p>
                  </div>
                </div>
              </div>
            </section>

            <!-- 2. Editor — line width, tab size, line numbers -->
            <section class="gx-section">
              <h3 class="gx-section-title">{$t('settings.tabs.editor')}</h3>
              <div class="gx-card">
                <div class="gx-row">
                  <label class="gx-label" for="settings-line-width">{$t('settings.editor.line_width')}</label>
                  <div class="gx-control gx-control-inline">
                    <input
                      id="settings-line-width"
                      type="range"
                      min="600" max="1600" step="50"
                      value={editorLineWidth}
                      oninput={handleLineWidthChange}
                      class="gx-range"
                    />
                    <span class="gx-value">{editorLineWidth}px</span>
                  </div>
                </div>

                <div class="gx-row">
                  <label class="gx-label" for="settings-tab-size">{$t('settings.editor.tab_size')}</label>
                  <div class="gx-control">
                    <Select id="settings-tab-size" class="gx-select" block bind:value={editorTabSize} options={tabSizeOptions} onchange={(v) => handleTabSizeChange(v as number)} />
                  </div>
                </div>

                <div class="gx-row gx-row-check">
                  <label class="gx-check">
                    <input type="checkbox" checked={showLineNumbers} onchange={handleLineNumbersChange} />
                    <span>{$t('settings.editor.show_line_numbers')}</span>
                  </label>
                </div>
              </div>
            </section>

            <!-- 3. Appearance — theme / dark mode / font (three sub-cards) -->
            <section class="gx-section">
              <h3 class="gx-section-title">{$t('settings.tabs.appearance')}</h3>

              <div class="gx-card">
                <div class="gx-subhead">{$t('settings.appearance.theme_section')}</div>
                <div class="gx-row">
                  <label class="gx-label" for="settings-color-theme">{$t('settings.theme.label')}</label>
                  <div class="gx-control">
                    <Select id="settings-color-theme" class="gx-select" block bind:value={colorTheme} options={colorThemeOptions} onchange={(v) => handleColorThemeChange(v as string)} />
                  </div>
                </div>
                <div class="gx-row gx-row-check">
                  <label class="gx-check">
                    <input type="checkbox" checked={useSeparateDarkTheme} onchange={handleSeparateDarkThemeChange} />
                    <span>{$t('settings.appearance.separate_dark_theme')}</span>
                  </label>
                </div>
                {#if useSeparateDarkTheme}
                  <div class="gx-row gx-row-indent">
                    <label class="gx-label" for="settings-dark-theme">{$t('settings.appearance.dark_theme')}</label>
                    <div class="gx-control">
                      <Select id="settings-dark-theme" class="gx-select" block bind:value={darkColorTheme} options={darkThemeOptions} onchange={(v) => handleDarkColorThemeChange(v as string)} />
                    </div>
                  </div>
                {/if}
              </div>

              <div class="gx-card">
                <div class="gx-subhead">{$t('settings.appearance.dark_mode_section')}</div>
                <div class="gx-row">
                  <label class="gx-label" for="settings-dark-mode">{$t('settings.appearance.dark_mode_label')}</label>
                  <div class="gx-control">
                    <Select id="settings-dark-mode" class="gx-select" block bind:value={theme} options={darkModeOptions} onchange={(v) => handleThemeChange(v as Theme)} />
                  </div>
                </div>
              </div>

              <div class="gx-card">
                <div class="gx-subhead">{$t('settings.appearance.font_section')}</div>
                <div class="gx-row">
                  <label class="gx-label" for="settings-font-size">{$t('settings.font_size.label')}</label>
                  <div class="gx-control gx-control-inline">
                    <input
                      id="settings-font-size"
                      type="range"
                      min="12" max="24"
                      value={fontSize}
                      oninput={handleFontSizeChange}
                      class="gx-range"
                    />
                    <span class="gx-value">{fontSize}px</span>
                  </div>
                </div>
              </div>
            </section>

            <!-- 4. Export — merged from the standalone Export tab (v0.41.5) -->
            <section class="gx-section">
              <h3 class="gx-section-title">{$t('settings.tabs.export')}</h3>
              <p class="gx-section-desc">{$t('settings.tab_desc.export')}</p>
              <div class="gx-card gx-card-padded">
                <ExportSettings />
              </div>
            </section>

            <!-- 5. AI Limits -->
            <section class="gx-section">
              <h3 class="gx-section-title">{$t('settings.permissions.ai_title')}</h3>
              <div class="gx-card">
                <div class="gx-row">
                  <label class="gx-label" for="settings-ai-max-tokens">{$t('settings.permissions.ai_max_tokens')}</label>
                  <div class="gx-control">
                    <input
                      id="settings-ai-max-tokens"
                      type="number"
                      class="gx-number"
                      value={$settingsStore.aiMaxTokens}
                      min={1024} max={128000} step={1024}
                      onchange={(e) => {
                        const v = parseInt((e.target as HTMLInputElement).value);
                        if (v >= 1024 && v <= 128000) settingsStore.update({ aiMaxTokens: v });
                      }}
                    />
                    <p class="gx-hint">{$t('settings.permissions.ai_max_tokens_hint')}</p>
                  </div>
                </div>
                <div class="gx-row">
                  <label class="gx-label" for="settings-ai-tool-result-max-chars">{$t('settings.permissions.ai_tool_result_max_chars')}</label>
                  <div class="gx-control">
                    <input
                      id="settings-ai-tool-result-max-chars"
                      type="number"
                      class="gx-number"
                      value={$settingsStore.aiToolResultMaxChars}
                      min={2000} max={64000} step={2000}
                      onchange={(e) => {
                        const v = parseInt((e.target as HTMLInputElement).value);
                        if (v >= 2000 && v <= 64000) settingsStore.update({ aiToolResultMaxChars: v });
                      }}
                    />
                    <p class="gx-hint">{$t('settings.permissions.ai_tool_result_max_chars_hint')}</p>
                  </div>
                </div>
                <div class="gx-row">
                  <label class="gx-label" for="settings-ai-max-tool-rounds">{$t('settings.permissions.ai_max_tool_rounds')}</label>
                  <div class="gx-control">
                    <input
                      id="settings-ai-max-tool-rounds"
                      type="number"
                      class="gx-number"
                      value={$settingsStore.aiMaxToolRounds}
                      min={1} max={100} step={1}
                      onchange={(e) => {
                        const v = parseInt((e.target as HTMLInputElement).value);
                        if (v >= 1 && v <= 100) settingsStore.update({ aiMaxToolRounds: v });
                      }}
                    />
                    <p class="gx-hint">{$t('settings.permissions.ai_max_tool_rounds_hint')}</p>
                  </div>
                </div>
              </div>
            </section>

            <!-- 6. MCP Permissions -->
            <section class="gx-section">
              <h3 class="gx-section-title">{$t('settings.permissions.mcp_title')}</h3>
              <div class="gx-card">
                <div class="gx-row gx-row-check">
                  <label class="gx-check">
                    <input
                      type="checkbox"
                      checked={$settingsStore.mcpAutoApprove}
                      onchange={(e) => settingsStore.update({ mcpAutoApprove: (e.target as HTMLInputElement).checked })}
                    />
                    <span>{$t('mcp.servers.auto_approve')}</span>
                  </label>
                  <p class="gx-hint gx-hint-indent">{$t('mcp.servers.auto_approve_hint')}</p>
                </div>
              </div>
            </section>
          </div>

        {:else if activeTab === 'shortcuts'}
          <ShortcutsPanel />
        {/if}
        </div><!-- content-body -->
      </div><!-- settings-content -->
    </div><!-- panel-body -->
  </div><!-- settings-panel -->
</div><!-- settings-overlay -->

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
    padding: 0.45rem 1rem;
    border-bottom: 1px solid var(--border-light);
    flex-shrink: 0;
    min-height: 36px;
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
    overflow-y: auto;
  }

  .nav-group-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    padding: 0.6rem 0.6rem 0.2rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .nav-group-label:first-child {
    padding-top: 0.25rem;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.6rem;
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

  /* macOS traffic light style */
  :global(.platform-macos) .close-btn {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #FF5F57;
    border: 1px solid #E0443E;
    padding: 0;
    color: transparent;
  }

  :global(.platform-macos) .close-btn:hover {
    background: #FF5F57 !important;
    color: rgba(0, 0, 0, 0.45);
  }

  :global(.platform-macos) .close-btn svg {
    width: 6px;
    height: 6px;
  }

  /* Windows close button: red hover (scoped class, avoids :not() parent selector bug) */
  .close-btn-win:hover {
    background: #C42B1C;
    color: #fff;
  }

  .content-body {
    flex: 1;
    padding: 0.75rem 1.25rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .tab-desc {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border-light);
  }

  /* Heavy tab components stay mounted; CSS toggles visibility */
  .tab-pane {
    display: none;
  }
  .tab-pane.active {
    display: contents; /* transparent wrapper — children flow directly into flex container */
  }

  /* Merged 知识库 tab stacks three feature components — add a divider between them. */
  .merged-kb :global(.gx-tab + .gx-tab) {
    margin-top: 0.25rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border-light);
  }

  /* The .gx-* design system lives in src/lib/styles/settings.css (global)
     so every settings panel can opt in by reusing the same class names. */
</style>

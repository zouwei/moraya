<script lang="ts">
  import {
    aiStore,
    testAIConnectionWithResolve,
    CHAT_PROVIDERS,
    FREE_LOCAL_PROVIDERS,
    PROVIDER_API_KEY_URLS,
    DEFAULT_MODELS,
    PROVIDER_BASE_URLS,
    REALTIME_VOICE_DEFAULT_MODELS,
    REALTIME_VOICE_BASE_URLS,
    REALTIME_VOICE_ENDPOINT_PRESETS,
    REALTIME_VOICE_PROVIDER_NAMES,
    type AIProvider,
    type AIProviderConfig,
    type RealtimeVoiceProvider,
    type RealtimeVoiceAIConfig,
  } from '$lib/services/ai';
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { Select } from '$lib/components/ui';
  import { openUrl } from '@tauri-apps/plugin-opener';

  // ── Session chat model state ──
  let chatConfigs = $state<AIProviderConfig[]>([]);
  let activeChatConfigId = $state<string | null>(null);
  let editingChatId = $state<string | null>(null);
  let addingChat = $state(false);

  let formProvider = $state<AIProvider>('claude');
  let formApiKey = $state('');
  let formBaseUrl = $state('');
  let formModel = $state('');
  let formMaxTokens = $state(41920);
  let formTemperature = $state(0.7);
  let formTestStatus = $state<'idle' | 'testing' | 'success' | 'failed'>('idle');
  let formTestError = $state('');
  let showModelDropdown = $state(false);

  // ── Realtime voice model state ──
  let realtimeConfigs = $state<RealtimeVoiceAIConfig[]>([]);
  let activeRealtimeConfigId = $state<string | null>(null);
  let editingRealtimeId = $state<string | null>(null);
  let addingRealtime = $state(false);

  let realtimeProvider = $state<RealtimeVoiceProvider>('openai-realtime');
  let realtimeApiKey = $state('');
  let realtimeBaseUrl = $state('');
  let realtimeModel = $state('');
  let realtimeVoice = $state('');
  let realtimeRegion = $state('');
  let realtimeAppId = $state('');
  let realtimeAccessKeyId = $state('');
  let realtimeSecretAccessKey = $state('');
  let realtimeSessionToken = $state('');
  let realtimeTestStatus = $state<'idle' | 'testing' | 'success' | 'failed'>('idle');
  let realtimeTestError = $state('');
  let showRealtimeModelDropdown = $state(false);

  let chatTestTimer: ReturnType<typeof setTimeout> | null = null;
  let realtimeTestTimer: ReturnType<typeof setTimeout> | null = null;

  // CHAT_PROVIDERS now comes from the shared @moraya/core/ai catalog
  // (resolveCatalog desktop view) via $lib/services/ai — no local hardcoded list.

  const REALTIME_PROVIDERS: RealtimeVoiceProvider[] = [
    'gemini-live',
    'openai-realtime',
    'doubao-realtime',
    'qwen-realtime',
    'stepfun-realtime',
    'tongyi-bailing',
    'amazon-nova-sonic',
  ];

  const CHAT_BASE_URL_PRESETS: Partial<Record<AIProvider, { value: string; label: string }[]>> = {
    doubao: [
      { value: 'https://ark.cn-beijing.volces.com/api/v3', label: 'cn-beijing - 华北（北京）' },
    ],
    custom: [
      { value: 'https://dashscope.aliyuncs.com/compatible-mode/v1', label: 'DashScope - 中国（北京）' },
      { value: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', label: 'DashScope - Singapore' },
      { value: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', label: 'DashScope - US (Virginia)' },
      { value: 'https://api.deepseek.com', label: 'DeepSeek' },
      { value: 'http://localhost:11434', label: 'Ollama (localhost)' },
    ],
  };

  let chatProviderOptions = $derived(CHAT_PROVIDERS.map(p => ({
    value: p,
    label: FREE_LOCAL_PROVIDERS.includes(p)
      ? `${$t(`ai.providers.${p}`)}  ${$t('ai.onboarding.free_badge')}`
      : $t(`ai.providers.${p}`),
  })));
  let realtimeProviderOptions = $derived(REALTIME_PROVIDERS.map(p => ({ value: p, label: getRealtimeProviderLabel(p) })));

  function getChatBaseUrlPresets(provider: AIProvider): { value: string; label: string }[] {
    return CHAT_BASE_URL_PRESETS[provider] ?? [];
  }

  function getRealtimeBaseUrlPresets(provider: RealtimeVoiceProvider): { value: string; label: string }[] {
    return REALTIME_VOICE_ENDPOINT_PRESETS[provider] ?? [];
  }

  const unsub = aiStore.subscribe(state => {
    chatConfigs = state.providerConfigs;
    activeChatConfigId = state.activeConfigId;
    realtimeConfigs = state.realtimeVoiceConfigs;
    activeRealtimeConfigId = state.activeRealtimeVoiceConfigId;
  });

  onDestroy(() => {
    unsub();
    if (chatTestTimer) clearTimeout(chatTestTimer);
    if (realtimeTestTimer) clearTimeout(realtimeTestTimer);
  });

  // ── Session chat handlers ──

  function getChatModels(): string[] {
    return DEFAULT_MODELS[formProvider] || [];
  }

  function getChatModelPlaceholder(): string {
    if (formProvider === 'doubao') return $t('ai.config.endpoint_id_placeholder');
    return $t('ai.config.model_placeholder');
  }

  function startEditChat(config: AIProviderConfig) {
    editingChatId = config.id;
    addingChat = false;
    formProvider = config.provider;
    // '***' means key is stored in keychain but not yet loaded — show empty field
    formApiKey = config.apiKey === '***' ? '' : config.apiKey;
    formBaseUrl = config.baseUrl || '';
    formModel = config.model;
    formMaxTokens = config.maxTokens || 41920;
    formTemperature = config.temperature || 0.7;
    formTestStatus = 'idle';
    formTestError = '';
  }

  function startAddChat() {
    addingChat = true;
    editingChatId = null;
    formProvider = 'claude';
    formApiKey = '';
    formBaseUrl = PROVIDER_BASE_URLS.claude || '';
    formModel = DEFAULT_MODELS.claude[0] || '';
    formMaxTokens = 41920;
    formTemperature = 0.7;
    formTestStatus = 'idle';
    formTestError = '';
  }

  function cancelChatForm() {
    editingChatId = null;
    addingChat = false;
    formTestStatus = 'idle';
    formTestError = '';
  }

  function handleChatProviderChange(value: unknown) {
    formProvider = value as AIProvider;
    formModel = getChatModels()[0] || '';
    formBaseUrl = PROVIDER_BASE_URLS[formProvider] || '';
    formTestStatus = 'idle';
    formTestError = '';
  }

  function saveChatConfig() {
    // If editing and user left key field empty, preserve existing '***' placeholder
    // so the keychain entry isn't overwritten with an empty value.
    const existingConfig = editingChatId ? chatConfigs.find(c => c.id === editingChatId) : null;
    const resolvedApiKey = formApiKey !== '' || !existingConfig || existingConfig.apiKey !== '***'
      ? formApiKey
      : '***';

    const config: AIProviderConfig = {
      id: editingChatId || crypto.randomUUID(),
      provider: formProvider,
      apiKey: resolvedApiKey,
      baseUrl: formBaseUrl || undefined,
      model: formModel || getChatModels()[0] || '',
      maxTokens: formMaxTokens,
      temperature: formTemperature,
    };

    if (editingChatId) {
      aiStore.updateProviderConfig(config);
    } else {
      aiStore.addProviderConfig(config);
    }
    cancelChatForm();
  }

  function removeChatConfig(id: string) {
    aiStore.removeProviderConfig(id);
  }

  function setDefaultChat(id: string) {
    aiStore.setActiveConfig(id);
  }

  async function handleChatTest() {
    formTestStatus = 'testing';
    formTestError = '';
    const config: AIProviderConfig = {
      id: editingChatId || 'chat-test',
      provider: formProvider,
      apiKey: formApiKey,
      baseUrl: formBaseUrl || undefined,
      model: formModel || getChatModels()[0] || '',
      maxTokens: formMaxTokens,
      temperature: formTemperature,
    };

    const result = await testAIConnectionWithResolve(config);
    if (result.success && result.resolvedBaseUrl !== undefined && result.resolvedBaseUrl !== (formBaseUrl || '')) {
      formBaseUrl = result.resolvedBaseUrl;
    }

    formTestStatus = result.success ? 'success' : 'failed';
    formTestError = result.success ? '' : (result.error || $t('ai.config.test_failed'));

    if (chatTestTimer) clearTimeout(chatTestTimer);
    chatTestTimer = setTimeout(() => {
      formTestStatus = 'idle';
      formTestError = '';
    }, 3000);
  }

  // ── Realtime voice handlers ──

  function getRealtimeModels(): string[] {
    return REALTIME_VOICE_DEFAULT_MODELS[realtimeProvider] || [];
  }

  function getRealtimeModelPlaceholder(): string {
    return $t('ai.config.model_placeholder');
  }

  function providerNeedsAwsCredential(provider: RealtimeVoiceProvider): boolean {
    return provider === 'amazon-nova-sonic';
  }

  function getRealtimeProviderLabel(provider: RealtimeVoiceProvider): string {
    const key = `ai.realtime.providers.${provider}`;
    const translated = $t(key);
    return translated === key ? (REALTIME_VOICE_PROVIDER_NAMES[provider] || provider) : translated;
  }

  function startAddRealtime() {
    addingRealtime = true;
    editingRealtimeId = null;
    realtimeProvider = 'openai-realtime';
    realtimeApiKey = '';
    realtimeBaseUrl = REALTIME_VOICE_BASE_URLS['openai-realtime'] || '';
    realtimeModel = REALTIME_VOICE_DEFAULT_MODELS['openai-realtime']?.[0] || '';
    realtimeVoice = '';
    realtimeRegion = '';
    realtimeAppId = '';
    realtimeAccessKeyId = '';
    realtimeSecretAccessKey = '';
    realtimeSessionToken = '';
    realtimeTestStatus = 'idle';
    realtimeTestError = '';
  }

  function startEditRealtime(config: RealtimeVoiceAIConfig) {
    editingRealtimeId = config.id;
    addingRealtime = false;
    realtimeProvider = config.provider;
    realtimeApiKey = config.apiKey || '';
    realtimeBaseUrl = config.baseUrl || '';
    realtimeModel = config.model;
    realtimeVoice = config.voice || '';
    realtimeRegion = config.region || '';
    realtimeAppId = config.appId || '';
    realtimeAccessKeyId = config.accessKeyId || '';
    realtimeSecretAccessKey = config.secretAccessKey || '';
    realtimeSessionToken = config.sessionToken || '';
    realtimeTestStatus = 'idle';
    realtimeTestError = '';
  }

  function cancelRealtimeForm() {
    editingRealtimeId = null;
    addingRealtime = false;
    realtimeTestStatus = 'idle';
    realtimeTestError = '';
  }

  function handleRealtimeProviderChange(value: unknown) {
    realtimeProvider = value as RealtimeVoiceProvider;
    realtimeModel = REALTIME_VOICE_DEFAULT_MODELS[realtimeProvider]?.[0] || '';
    realtimeBaseUrl = REALTIME_VOICE_BASE_URLS[realtimeProvider] || '';
    realtimeVoice = '';
    realtimeRegion = '';
    realtimeAppId = '';
    realtimeAccessKeyId = '';
    realtimeSecretAccessKey = '';
    realtimeSessionToken = '';
    realtimeTestStatus = 'idle';
    realtimeTestError = '';
  }

  function providerNeedsDoubaoCredential(provider: RealtimeVoiceProvider): boolean {
    return provider === 'doubao-realtime';
  }

  function buildRealtimeConfig(id: string): RealtimeVoiceAIConfig {
    return {
      id,
      provider: realtimeProvider,
      apiKey: realtimeApiKey || undefined,
      baseUrl: realtimeBaseUrl || undefined,
      model: realtimeModel || REALTIME_VOICE_DEFAULT_MODELS[realtimeProvider]?.[0] || '',
      voice: realtimeVoice || undefined,
      region: realtimeRegion || undefined,
      appId: realtimeAppId || undefined,
      accessKeyId: realtimeAccessKeyId || undefined,
      secretAccessKey: realtimeSecretAccessKey || undefined,
      sessionToken: realtimeSessionToken || undefined,
    };
  }

  function hasRealtimeCredential(config: RealtimeVoiceAIConfig): boolean {
    if (config.provider === 'doubao-realtime') {
      return !!(config.appId?.trim() && config.apiKey?.trim());
    }
    return !!(
      (config.apiKey && config.apiKey.trim())
      || ((config.accessKeyId && config.accessKeyId.trim()) && (config.secretAccessKey && config.secretAccessKey.trim()))
    );
  }

  function saveRealtimeConfig() {
    const config = buildRealtimeConfig(editingRealtimeId || crypto.randomUUID());
    if (!hasRealtimeCredential(config)) return;

    if (editingRealtimeId) {
      aiStore.updateRealtimeVoiceConfig(config);
    } else {
      aiStore.addRealtimeVoiceConfig(config);
    }
    cancelRealtimeForm();
  }

  function removeRealtimeConfig(id: string) {
    aiStore.removeRealtimeVoiceConfig(id);
  }

  function setDefaultRealtime(id: string) {
    aiStore.setActiveRealtimeVoiceConfig(id);
  }

  async function handleRealtimeTest() {
    realtimeTestStatus = 'testing';
    realtimeTestError = '';

    const cfg = buildRealtimeConfig(editingRealtimeId || 'realtime-test');
    if (!hasRealtimeCredential(cfg)) {
      realtimeTestStatus = 'failed';
      realtimeTestError = $t('ai.realtime.config.missing_credential');
      return;
    }

    if (providerNeedsAwsCredential(cfg.provider) || providerNeedsDoubaoCredential(cfg.provider)) {
      // WebSocket-only providers cannot be tested via HTTP — mark as saved
      realtimeTestStatus = 'success';
      realtimeTestError = '';
      if (realtimeTestTimer) clearTimeout(realtimeTestTimer);
      realtimeTestTimer = setTimeout(() => {
        realtimeTestStatus = 'idle';
      }, 3000);
      return;
    }

    const probe: AIProviderConfig = {
      id: 'realtime-probe',
      provider: 'custom',
      apiKey: cfg.apiKey || '',
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      maxTokens: 256,
      temperature: 0,
    };

    const result = await testAIConnectionWithResolve(probe);
    if (result.success && result.resolvedBaseUrl !== undefined && result.resolvedBaseUrl !== (realtimeBaseUrl || '')) {
      realtimeBaseUrl = result.resolvedBaseUrl;
    }

    realtimeTestStatus = result.success ? 'success' : 'failed';
    realtimeTestError = result.success ? '' : (result.error || $t('ai.config.test_failed'));

    if (realtimeTestTimer) clearTimeout(realtimeTestTimer);
    realtimeTestTimer = setTimeout(() => {
      realtimeTestStatus = 'idle';
      realtimeTestError = '';
    }, 3000);
  }
</script>

<div class="ai-settings gx-tab">
  <section class="settings-section">
    <div class="section-header">
      <div>
        <h3 class="section-title">{$t('ai.sections.session_ai')}</h3>
        <p class="section-subtitle">{$t('ai.sections.session_aihint')}</p>
      </div>
    </div>

    {#if chatConfigs.length === 0 && !addingChat}
      <div class="empty-state">
        <p>{$t('ai.multi_model.no_models')}</p>
        <p class="empty-hint">{$t('ai.multi_model.no_models_hint')}</p>
      </div>
    {/if}

    {#each chatConfigs as config (config.id)}
      {#if editingChatId === config.id}
        <div class="config-form">
          <div class="setting-group">
            <label class="setting-label">{$t('ai.config.provider')}</label>
            <Select class="setting-input" block bind:value={formProvider} options={chatProviderOptions} onchange={handleChatProviderChange} />
          </div>

          <div class="setting-group">
            <label class="setting-label">{$t('ai.config.api_key')}</label>
            <input
              type="password"
              class="setting-input"
              bind:value={formApiKey}
              placeholder={formProvider === 'ollama' ? $t('ai.config.api_key_not_required') : $t('ai.config.api_key_placeholder', { provider: formProvider })}
            />
            {#if PROVIDER_API_KEY_URLS[formProvider]}
              <button type="button" class="get-api-key-link" onclick={() => openUrl(PROVIDER_API_KEY_URLS[formProvider]!)}>
                {$t('ai.onboarding.get_api_key')} ↗
              </button>
            {/if}
            {#if formProvider !== 'ollama' && formProvider !== 'custom'}
              <p class="cost-hint">{$t('ai.onboarding.cost_hint')}</p>
            {/if}
          </div>

          <div class="setting-group">
            <label class="setting-label">{$t('ai.config.base_url')}</label>
            <input
              type="text"
              class="setting-input"
              bind:value={formBaseUrl}
              list="chat-baseurl-datalist-edit"
              placeholder={PROVIDER_BASE_URLS[formProvider]}
            />
            {#if getChatBaseUrlPresets(formProvider).length > 0}
              <datalist id="chat-baseurl-datalist-edit">
                {#each getChatBaseUrlPresets(formProvider) as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </datalist>
            {/if}
          </div>

          <div class="model-tokens-row">
            <div class="setting-group" style="flex:1;min-width:0">
              <label class="setting-label">{$t('ai.config.model')}</label>
              <div class="combo-wrapper">
                <input
                  type="text"
                  class="setting-input"
                  bind:value={formModel}
                  onfocus={() => { if (getChatModels().length > 0) showModelDropdown = true; }}
                  onblur={() => { setTimeout(() => { showModelDropdown = false; }, 150); }}
                  placeholder={getChatModelPlaceholder()}
                />
                {#if showModelDropdown && getChatModels().length > 0}
                  <div class="model-dropdown">
                    {#each getChatModels() as m}
                      <button
                        class="model-option"
                        class:active={formModel === m}
                        onmousedown={(e) => { e.preventDefault(); formModel = m; showModelDropdown = false; }}
                      >{m}</button>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
            <div class="setting-group" style="width:5.5rem;flex-shrink:0">
              <label class="setting-label">{$t('ai.config.max_tokens')}</label>
              <input type="number" class="setting-input" bind:value={formMaxTokens} min={256} max={128000} step={256} />
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">{$t('ai.config.temperature')}</label>
            <div class="setting-row">
              <input type="range" class="setting-range" bind:value={formTemperature} min={0} max={1} step={0.1} />
              <span class="setting-value">{formTemperature}</span>
            </div>
          </div>

          <div class="form-actions">
            <button
              class="test-btn"
              class:testing={formTestStatus === 'testing'}
              class:success={formTestStatus === 'success'}
              class:failed={formTestStatus === 'failed'}
              onclick={handleChatTest}
              disabled={formTestStatus === 'testing' || (!formApiKey && formProvider !== 'ollama')}
            >
              {#if formTestStatus === 'testing'}{$t('ai.config.testing')}
              {:else if formTestStatus === 'success'}{$t('ai.config.connected')}
              {:else if formTestStatus === 'failed'}{$t('ai.config.failed')}
              {:else}{$t('ai.config.test_connection')}{/if}
            </button>
            {#if formTestError && formTestStatus === 'failed'}
              <p class="test-error">{formTestError}</p>
            {/if}
            <div class="form-actions-right">
              <button class="btn-sm" onclick={cancelChatForm}>{$t('common.cancel')}</button>
              <button class="btn-sm primary" onclick={saveChatConfig}>{$t('common.save')}</button>
            </div>
          </div>
        </div>
      {:else}
        <div class="config-item">
          <div class="config-info">
            <span class="config-provider">{$t(`ai.providers.${config.provider}`)}</span>
            {#if FREE_LOCAL_PROVIDERS.includes(config.provider)}
              <span class="free-local-badge">{$t('ai.onboarding.free_badge')}</span>
            {/if}
            <span class="config-model">{config.model}</span>
            <span class="config-tokens">{config.maxTokens || 41920}</span>
            {#if config.id === activeChatConfigId}
              <span class="default-badge">{$t('ai.multi_model.default')}</span>
            {/if}
          </div>
          <div class="config-actions">
            {#if config.id !== activeChatConfigId}
              <button class="btn-sm" onclick={() => setDefaultChat(config.id)}>{$t('ai.multi_model.set_default')}</button>
            {/if}
            <button class="btn-sm" onclick={() => startEditChat(config)}>{$t('common.edit')}</button>
            {#if chatConfigs.length > 1}
              <button class="btn-sm danger" onclick={() => removeChatConfig(config.id)}>{$t('common.remove')}</button>
            {/if}
          </div>
        </div>
      {/if}
    {/each}

    {#if addingChat}
      <div class="config-form">
        <div class="setting-group">
          <label class="setting-label">{$t('ai.config.provider')}</label>
          <Select class="setting-input" block bind:value={formProvider} options={chatProviderOptions} onchange={handleChatProviderChange} />
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.config.api_key')}</label>
          <input
            type="password"
            class="setting-input"
            bind:value={formApiKey}
            placeholder={formProvider === 'ollama' ? $t('ai.config.api_key_not_required') : $t('ai.config.api_key_placeholder', { provider: formProvider })}
          />
          {#if PROVIDER_API_KEY_URLS[formProvider]}
            <button type="button" class="get-api-key-link" onclick={() => openUrl(PROVIDER_API_KEY_URLS[formProvider]!)}>
              {$t('ai.onboarding.get_api_key')} ↗
            </button>
          {/if}
          {#if formProvider !== 'ollama' && formProvider !== 'custom'}
            <p class="cost-hint">{$t('ai.onboarding.cost_hint')}</p>
          {/if}
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.config.base_url')}</label>
          <input
            type="text"
            class="setting-input"
            bind:value={formBaseUrl}
            list="chat-baseurl-datalist-add"
            placeholder={PROVIDER_BASE_URLS[formProvider]}
          />
          {#if getChatBaseUrlPresets(formProvider).length > 0}
            <datalist id="chat-baseurl-datalist-add">
              {#each getChatBaseUrlPresets(formProvider) as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </datalist>
          {/if}
        </div>

        <div class="model-tokens-row">
          <div class="setting-group" style="flex:1;min-width:0">
            <label class="setting-label">{$t('ai.config.model')}</label>
            <div class="combo-wrapper">
              <input
                type="text"
                class="setting-input"
                bind:value={formModel}
                onfocus={() => { if (getChatModels().length > 0) showModelDropdown = true; }}
                onblur={() => { setTimeout(() => { showModelDropdown = false; }, 150); }}
                placeholder={getChatModelPlaceholder()}
              />
              {#if showModelDropdown && getChatModels().length > 0}
                <div class="model-dropdown">
                  {#each getChatModels() as m}
                    <button
                      class="model-option"
                      class:active={formModel === m}
                      onmousedown={(e) => { e.preventDefault(); formModel = m; showModelDropdown = false; }}
                    >{m}</button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
          <div class="setting-group" style="width:5.5rem;flex-shrink:0">
            <label class="setting-label">{$t('ai.config.max_tokens')}</label>
            <input type="number" class="setting-input" bind:value={formMaxTokens} min={256} max={128000} step={256} />
          </div>
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.config.temperature')}</label>
          <div class="setting-row">
            <input type="range" class="setting-range" bind:value={formTemperature} min={0} max={1} step={0.1} />
            <span class="setting-value">{formTemperature}</span>
          </div>
        </div>

        <div class="form-actions">
          <button
            class="test-btn"
            class:testing={formTestStatus === 'testing'}
            class:success={formTestStatus === 'success'}
            class:failed={formTestStatus === 'failed'}
            onclick={handleChatTest}
            disabled={formTestStatus === 'testing' || (!formApiKey && formProvider !== 'ollama')}
          >
            {#if formTestStatus === 'testing'}{$t('ai.config.testing')}
            {:else if formTestStatus === 'success'}{$t('ai.config.connected')}
            {:else if formTestStatus === 'failed'}{$t('ai.config.failed')}
            {:else}{$t('ai.config.test_connection')}{/if}
          </button>
          {#if formTestError && formTestStatus === 'failed'}
            <p class="test-error">{formTestError}</p>
          {/if}
          <div class="form-actions-right">
            <button class="btn-sm" onclick={cancelChatForm}>{$t('common.cancel')}</button>
            <button class="btn-sm primary" onclick={saveChatConfig}>{$t('common.save')}</button>
          </div>
        </div>
      </div>
    {/if}

    {#if !addingChat && editingChatId === null}
      <button class="add-model-btn" onclick={startAddChat}>{$t('ai.multi_model.add_model')}</button>
    {/if}
  </section>

  <section class="settings-section">
    <div class="section-header">
      <div>
        <h3 class="section-title">{$t('ai.sections.realtime_voice_ai')}</h3>
        <p class="section-subtitle">{$t('ai.sections.realtime_voice_aihint')}</p>
      </div>
    </div>

    {#if realtimeConfigs.length === 0 && !addingRealtime}
      <div class="empty-state">
        <p>{$t('ai.realtime.no_models')}</p>
        <p class="empty-hint">{$t('ai.realtime.no_models_hint')}</p>
      </div>
    {/if}

    {#each realtimeConfigs as config (config.id)}
      {#if editingRealtimeId === config.id}
        <div class="config-form">
          <div class="setting-group">
            <label class="setting-label">{$t('ai.config.provider')}</label>
            <Select class="setting-input" block bind:value={realtimeProvider} options={realtimeProviderOptions} onchange={handleRealtimeProviderChange} />
          </div>

          {#if providerNeedsAwsCredential(realtimeProvider)}
            <div class="setting-group">
              <label class="setting-label">{$t('ai.realtime.config.access_key_id')}</label>
              <input type="password" class="setting-input" bind:value={realtimeAccessKeyId} placeholder="AKIA..." />
            </div>
            <div class="setting-group">
              <label class="setting-label">{$t('ai.realtime.config.secret_access_key')}</label>
              <input type="password" class="setting-input" bind:value={realtimeSecretAccessKey} placeholder={$t('ai.realtime.config.secret_placeholder')} />
            </div>
            <div class="setting-group">
              <label class="setting-label">{$t('ai.realtime.config.session_token')}</label>
              <input type="password" class="setting-input" bind:value={realtimeSessionToken} placeholder={$t('ai.realtime.config.optional')} />
            </div>
          {:else if providerNeedsDoubaoCredential(realtimeProvider)}
            <div class="setting-group">
              <label class="setting-label">{$t('ai.realtime.config.doubao_app_id')}</label>
              <input type="text" class="setting-input" bind:value={realtimeAppId} placeholder="123456789" />
            </div>
            <div class="setting-group">
              <label class="setting-label">{$t('ai.realtime.config.doubao_access_key')}</label>
              <input type="password" class="setting-input" bind:value={realtimeApiKey} placeholder="your-access-token" />
            </div>
          {:else}
            <div class="setting-group">
              <label class="setting-label">{$t('ai.config.api_key')}</label>
              <input type="password" class="setting-input" bind:value={realtimeApiKey} placeholder={$t('ai.config.api_key_placeholder', { provider: realtimeProvider })} />
            </div>
          {/if}

          <div class="setting-group">
            <label class="setting-label">{$t('ai.config.base_url')}</label>
            <input
              type="text"
              class="setting-input"
              bind:value={realtimeBaseUrl}
              list="realtime-baseurl-datalist-edit"
              placeholder={REALTIME_VOICE_BASE_URLS[realtimeProvider]}
            />
            {#if getRealtimeBaseUrlPresets(realtimeProvider).length > 0}
              <datalist id="realtime-baseurl-datalist-edit">
                {#each getRealtimeBaseUrlPresets(realtimeProvider) as opt (opt.value)}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </datalist>
            {/if}
          </div>

          <div class="setting-group">
            <label class="setting-label">{$t('ai.config.model')}</label>
            <div class="combo-wrapper">
              <input
                type="text"
                class="setting-input"
                bind:value={realtimeModel}
                onfocus={() => { if (getRealtimeModels().length > 0) showRealtimeModelDropdown = true; }}
                onblur={() => { setTimeout(() => { showRealtimeModelDropdown = false; }, 150); }}
                placeholder={getRealtimeModelPlaceholder()}
              />
              {#if showRealtimeModelDropdown && getRealtimeModels().length > 0}
                <div class="model-dropdown">
                  {#each getRealtimeModels() as m}
                    <button
                      class="model-option"
                      class:active={realtimeModel === m}
                      onmousedown={(e) => { e.preventDefault(); realtimeModel = m; showRealtimeModelDropdown = false; }}
                    >{m}</button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>

          <div class="model-tokens-row">
            <div class="setting-group" style="flex:1;min-width:0">
              <label class="setting-label">{$t('ai.realtime.config.voice')}</label>
              <input type="text" class="setting-input" bind:value={realtimeVoice} placeholder={$t('ai.realtime.config.optional')} />
            </div>
            <div class="setting-group" style="width:8rem;flex-shrink:0">
              <label class="setting-label">{$t('ai.realtime.config.region')}</label>
              <input type="text" class="setting-input" bind:value={realtimeRegion} placeholder={$t('ai.realtime.config.optional')} />
            </div>
          </div>

          <div class="form-actions">
            <button
              class="test-btn"
              class:testing={realtimeTestStatus === 'testing'}
              class:success={realtimeTestStatus === 'success'}
              class:failed={realtimeTestStatus === 'failed'}
              onclick={handleRealtimeTest}
              disabled={realtimeTestStatus === 'testing'}
            >
              {#if realtimeTestStatus === 'testing'}{$t('ai.config.testing')}
              {:else if realtimeTestStatus === 'success'}{$t('ai.config.connected')}
              {:else if realtimeTestStatus === 'failed'}{$t('ai.config.failed')}
              {:else}{$t('ai.config.test_connection')}{/if}
            </button>
            {#if realtimeTestError && realtimeTestStatus === 'failed'}
              <p class="test-error">{realtimeTestError}</p>
            {/if}
            <div class="form-actions-right">
              <button class="btn-sm" onclick={cancelRealtimeForm}>{$t('common.cancel')}</button>
              <button class="btn-sm primary" onclick={saveRealtimeConfig}>{$t('common.save')}</button>
            </div>
          </div>
        </div>
      {:else}
        <div class="config-item">
          <div class="config-info">
            <span class="config-provider">{getRealtimeProviderLabel(config.provider)}</span>
            <span class="config-model">{config.model}</span>
            {#if config.baseUrl}
              <span class="config-endpoint">{config.baseUrl}</span>
            {/if}
            {#if config.id === activeRealtimeConfigId}
              <span class="default-badge">{$t('ai.multi_model.default')}</span>
            {/if}
          </div>
          <div class="config-actions">
            {#if config.id !== activeRealtimeConfigId}
              <button class="btn-sm" onclick={() => setDefaultRealtime(config.id)}>{$t('ai.multi_model.set_default')}</button>
            {/if}
            <button class="btn-sm" onclick={() => startEditRealtime(config)}>{$t('common.edit')}</button>
            <button class="btn-sm danger" onclick={() => removeRealtimeConfig(config.id)}>{$t('common.remove')}</button>
          </div>
        </div>
      {/if}
    {/each}

    {#if addingRealtime}
      <div class="config-form">
        <div class="setting-group">
          <label class="setting-label">{$t('ai.config.provider')}</label>
          <Select class="setting-input" block bind:value={realtimeProvider} options={realtimeProviderOptions} onchange={handleRealtimeProviderChange} />
        </div>

        {#if providerNeedsAwsCredential(realtimeProvider)}
          <div class="setting-group">
            <label class="setting-label">{$t('ai.realtime.config.access_key_id')}</label>
            <input type="password" class="setting-input" bind:value={realtimeAccessKeyId} placeholder="AKIA..." />
          </div>
          <div class="setting-group">
            <label class="setting-label">{$t('ai.realtime.config.secret_access_key')}</label>
            <input type="password" class="setting-input" bind:value={realtimeSecretAccessKey} placeholder={$t('ai.realtime.config.secret_placeholder')} />
          </div>
          <div class="setting-group">
            <label class="setting-label">{$t('ai.realtime.config.session_token')}</label>
            <input type="password" class="setting-input" bind:value={realtimeSessionToken} placeholder={$t('ai.realtime.config.optional')} />
          </div>
        {:else if providerNeedsDoubaoCredential(realtimeProvider)}
          <div class="setting-group">
            <label class="setting-label">{$t('ai.realtime.config.doubao_app_id')}</label>
            <input type="text" class="setting-input" bind:value={realtimeAppId} placeholder="123456789" />
          </div>
          <div class="setting-group">
            <label class="setting-label">{$t('ai.realtime.config.doubao_access_key')}</label>
            <input type="password" class="setting-input" bind:value={realtimeApiKey} placeholder="your-access-token" />
          </div>
        {:else}
          <div class="setting-group">
            <label class="setting-label">{$t('ai.config.api_key')}</label>
            <input type="password" class="setting-input" bind:value={realtimeApiKey} placeholder={$t('ai.config.api_key_placeholder', { provider: realtimeProvider })} />
          </div>
        {/if}

        <div class="setting-group">
          <label class="setting-label">{$t('ai.config.base_url')}</label>
          <input
            type="text"
            class="setting-input"
            bind:value={realtimeBaseUrl}
            list="realtime-baseurl-datalist-add"
            placeholder={REALTIME_VOICE_BASE_URLS[realtimeProvider]}
          />
          {#if getRealtimeBaseUrlPresets(realtimeProvider).length > 0}
            <datalist id="realtime-baseurl-datalist-add">
              {#each getRealtimeBaseUrlPresets(realtimeProvider) as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </datalist>
          {/if}
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.config.model')}</label>
          <div class="combo-wrapper">
            <input
              type="text"
              class="setting-input"
              bind:value={realtimeModel}
              onfocus={() => { if (getRealtimeModels().length > 0) showRealtimeModelDropdown = true; }}
              onblur={() => { setTimeout(() => { showRealtimeModelDropdown = false; }, 150); }}
              placeholder={getRealtimeModelPlaceholder()}
            />
            {#if showRealtimeModelDropdown && getRealtimeModels().length > 0}
              <div class="model-dropdown">
                {#each getRealtimeModels() as m}
                  <button
                    class="model-option"
                    class:active={realtimeModel === m}
                    onmousedown={(e) => { e.preventDefault(); realtimeModel = m; showRealtimeModelDropdown = false; }}
                  >{m}</button>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        <div class="model-tokens-row">
          <div class="setting-group" style="flex:1;min-width:0">
            <label class="setting-label">{$t('ai.realtime.config.voice')}</label>
            <input type="text" class="setting-input" bind:value={realtimeVoice} placeholder={$t('ai.realtime.config.optional')} />
          </div>
          <div class="setting-group" style="width:8rem;flex-shrink:0">
            <label class="setting-label">{$t('ai.realtime.config.region')}</label>
            <input type="text" class="setting-input" bind:value={realtimeRegion} placeholder={$t('ai.realtime.config.optional')} />
          </div>
        </div>

        <div class="form-actions">
          <button
            class="test-btn"
            class:testing={realtimeTestStatus === 'testing'}
            class:success={realtimeTestStatus === 'success'}
            class:failed={realtimeTestStatus === 'failed'}
            onclick={handleRealtimeTest}
            disabled={realtimeTestStatus === 'testing'}
          >
            {#if realtimeTestStatus === 'testing'}{$t('ai.config.testing')}
            {:else if realtimeTestStatus === 'success'}{$t('ai.config.connected')}
            {:else if realtimeTestStatus === 'failed'}{$t('ai.config.failed')}
            {:else}{$t('ai.config.test_connection')}{/if}
          </button>
          {#if realtimeTestError && realtimeTestStatus === 'failed'}
            <p class="test-error">{realtimeTestError}</p>
          {/if}
          <div class="form-actions-right">
            <button class="btn-sm" onclick={cancelRealtimeForm}>{$t('common.cancel')}</button>
            <button class="btn-sm primary" onclick={saveRealtimeConfig}>{$t('common.save')}</button>
          </div>
        </div>
      </div>
    {/if}

    {#if !addingRealtime && editingRealtimeId === null}
      <button class="add-model-btn" onclick={startAddRealtime}>{$t('ai.realtime.add_model')}</button>
    {/if}
  </section>
</div>

<style>
  /* Outer layout: .gx-tab on root provides flex column + gap.
     .section-title / .section-subtitle / .section-header inherit from
     the shared settings.css (large bold heading + secondary subtitle),
     matching ImageAISettings. */
  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .section-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .config-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.55rem 0.85rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-primary);
    gap: 0.5rem;
    transition: border-color 0.1s ease, background 0.1s ease;
  }
  .config-item + .config-item {
    margin-top: 0.4rem;
  }

  .config-info {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    overflow: hidden;
    flex-wrap: wrap;
  }

  .config-provider {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .config-model {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    font-family: var(--font-mono, monospace);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .config-tokens {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-family: var(--font-mono, monospace);
    flex-shrink: 0;
  }

  .config-endpoint {
    font-size: 10px;
    color: var(--text-muted);
    max-width: 15rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .default-badge {
    font-size: 10px;
    padding: 0.05rem 0.35rem;
    border-radius: 8px;
    background: var(--accent-color);
    color: white;
    font-weight: 500;
    flex-shrink: 0;
  }

  .free-local-badge {
    font-size: 10px;
    padding: 0.05rem 0.35rem;
    border-radius: 8px;
    background: var(--success-color, #2e7d32);
    color: white;
    font-weight: 500;
    flex-shrink: 0;
  }

  .get-api-key-link {
    align-self: flex-start;
    margin-top: 0.35rem;
    padding: 0;
    border: none;
    background: none;
    color: var(--accent-color);
    font-size: var(--font-size-xs);
    cursor: pointer;
    text-decoration: underline;
  }

  .get-api-key-link:hover {
    opacity: 0.8;
  }

  .cost-hint {
    margin-top: 0.35rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    line-height: 1.4;
  }

  .config-actions {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .btn-sm {
    padding: 0.2rem 0.45rem;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    font-size: var(--font-size-xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-sm:hover {
    border-color: var(--accent-color);
    color: var(--text-primary);
  }

  .btn-sm.primary {
    background: var(--accent-color);
    color: white;
    border-color: var(--accent-color);
  }

  .btn-sm.danger {
    color: #dc3545;
    border-color: #dc3545;
  }

  .btn-sm.danger:hover {
    background: #dc354510;
  }

  .config-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.6rem;
    border: 1px solid var(--accent-color);
    border-radius: 6px;
    background: var(--bg-primary);
  }

  .form-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .form-actions-right {
    display: flex;
    gap: 0.25rem;
  }

  .empty-state {
    text-align: center;
    padding: 0.75rem;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
  }

  .empty-hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .add-model-btn {
    padding: 0.35rem;
    border: 1px dashed var(--border-color);
    background: transparent;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
    font-size: var(--font-size-xs);
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .add-model-btn:hover {
    border-color: var(--accent-color);
    color: var(--accent-color);
  }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .setting-label {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }

  .setting-input {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: var(--font-sans);
  }

  .setting-input:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .setting-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .setting-range {
    flex: 1;
    accent-color: var(--accent-color);
  }

  .setting-value {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    min-width: 2rem;
  }

  .model-tokens-row {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .combo-wrapper {
    position: relative;
    width: 100%;
  }

  .combo-wrapper .setting-input {
    width: 100%;
    box-sizing: border-box;
  }

  .model-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 10;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-top: none;
    border-radius: 0 0 4px 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    max-height: 200px;
    overflow-y: auto;
  }

  .model-option {
    display: block;
    width: 100%;
    padding: 0.35rem 0.5rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: var(--font-mono, monospace);
    text-align: left;
    cursor: pointer;
  }

  .model-option:hover {
    background: var(--bg-hover);
  }

  .model-option.active {
    color: var(--accent-color);
    font-weight: 600;
  }

  .test-btn {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-xs);
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .test-btn:hover:not(:disabled) {
    border-color: var(--accent-color);
    color: var(--text-primary);
  }

  .test-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .test-btn.testing {
    border-color: var(--accent-color);
    color: var(--accent-color);
  }

  .test-btn.success {
    border-color: #28a745;
    color: #28a745;
    background: #28a74510;
  }

  .test-btn.failed {
    border-color: #dc3545;
    color: #dc3545;
    background: #dc354510;
  }

  .test-error {
    margin: 4px 0 0 0;
    font-size: var(--font-size-xs);
    color: #dc3545;
    word-break: break-all;
  }
</style>

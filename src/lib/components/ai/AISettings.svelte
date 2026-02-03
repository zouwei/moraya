<script lang="ts">
  import {
    aiStore,
    testAIConnection,
    DEFAULT_MODELS,
    PROVIDER_BASE_URLS,
    type AIProvider,
    type AIProviderConfig,
  } from '$lib/services/ai';
  import { t } from '$lib/i18n';

  let provider = $state<AIProvider>('claude');
  let apiKey = $state('');
  let baseUrl = $state('');
  let model = $state('');
  let maxTokens = $state(4096);
  let temperature = $state(0.7);
  let testStatus = $state<'idle' | 'testing' | 'success' | 'failed'>('idle');

  // Load from store
  aiStore.subscribe(state => {
    if (state.providerConfig) {
      provider = state.providerConfig.provider;
      apiKey = state.providerConfig.apiKey;
      baseUrl = state.providerConfig.baseUrl || '';
      model = state.providerConfig.model;
      maxTokens = state.providerConfig.maxTokens || 4096;
      temperature = state.providerConfig.temperature || 0.7;
    }
  });

  function getModels(): string[] {
    return DEFAULT_MODELS[provider] || [];
  }

  function handleProviderChange(event: Event) {
    provider = (event.target as HTMLSelectElement).value as AIProvider;
    model = getModels()[0] || '';
    baseUrl = PROVIDER_BASE_URLS[provider] || '';
    saveConfig();
  }

  function saveConfig() {
    const config: AIProviderConfig = {
      provider,
      apiKey,
      baseUrl: baseUrl || undefined,
      model: model || getModels()[0] || '',
      maxTokens,
      temperature,
    };
    aiStore.setConfig(config);
  }

  async function handleTest() {
    saveConfig();
    testStatus = 'testing';
    const success = await testAIConnection();
    testStatus = success ? 'success' : 'failed';
    setTimeout(() => { testStatus = 'idle'; }, 3000);
  }

  function handleInputChange() {
    saveConfig();
  }
</script>

<div class="ai-settings">
  <h3>{$t('ai.config.title')}</h3>

  <div class="setting-group">
    <label class="setting-label">{$t('ai.config.provider')}</label>
    <select class="setting-input" value={provider} onchange={handleProviderChange}>
      <option value="claude">{$t('ai.providers.claude')}</option>
      <option value="openai">{$t('ai.providers.openai')}</option>
      <option value="gemini">{$t('ai.providers.gemini')}</option>
      <option value="deepseek">{$t('ai.providers.deepseek')}</option>
      <option value="ollama">{$t('ai.providers.ollama')}</option>
      <option value="custom">{$t('ai.providers.custom')}</option>
    </select>
  </div>

  <div class="setting-group">
    <label class="setting-label">{$t('ai.config.apiKey')}</label>
    <input
      type="password"
      class="setting-input"
      bind:value={apiKey}
      oninput={handleInputChange}
      placeholder={provider === 'ollama' ? $t('ai.config.apiKeyNotRequired') : $t('ai.config.apiKeyPlaceholder', { provider })}
    />
  </div>

  {#if provider === 'custom' || provider === 'ollama'}
    <div class="setting-group">
      <label class="setting-label">{$t('ai.config.baseUrl')}</label>
      <input
        type="text"
        class="setting-input"
        bind:value={baseUrl}
        oninput={handleInputChange}
        placeholder={PROVIDER_BASE_URLS[provider]}
      />
    </div>
  {/if}

  <div class="setting-group">
    <label class="setting-label">{$t('ai.config.model')}</label>
    {#if getModels().length > 0}
      <select class="setting-input" bind:value={model} onchange={handleInputChange}>
        {#each getModels() as m}
          <option value={m}>{m}</option>
        {/each}
      </select>
    {:else}
      <input
        type="text"
        class="setting-input"
        bind:value={model}
        oninput={handleInputChange}
        placeholder={$t('ai.config.modelPlaceholder')}
      />
    {/if}
  </div>

  <div class="setting-group">
    <label class="setting-label">{$t('ai.config.maxTokens')}</label>
    <input
      type="number"
      class="setting-input"
      bind:value={maxTokens}
      oninput={handleInputChange}
      min={256}
      max={128000}
      step={256}
    />
  </div>

  <div class="setting-group">
    <label class="setting-label">{$t('ai.config.temperature')}</label>
    <div class="setting-row">
      <input
        type="range"
        class="setting-range"
        bind:value={temperature}
        oninput={handleInputChange}
        min={0}
        max={1}
        step={0.1}
      />
      <span class="setting-value">{temperature}</span>
    </div>
  </div>

  <div class="setting-group">
    <button
      class="test-btn"
      class:testing={testStatus === 'testing'}
      class:success={testStatus === 'success'}
      class:failed={testStatus === 'failed'}
      onclick={handleTest}
      disabled={testStatus === 'testing' || !apiKey}
    >
      {#if testStatus === 'testing'}
        {$t('ai.config.testing')}
      {:else if testStatus === 'success'}
        {$t('ai.config.connected')}
      {:else if testStatus === 'failed'}
        {$t('ai.config.failed')}
      {:else}
        {$t('ai.config.testConnection')}
      {/if}
    </button>
  </div>
</div>

<style>
  .ai-settings {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .ai-settings h3 {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    margin: 0.5rem 0 0;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-light);
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

  .test-btn {
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-sm);
    transition: all var(--transition-fast);
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
</style>

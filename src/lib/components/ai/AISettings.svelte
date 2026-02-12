<script lang="ts">
  import {
    aiStore,
    testAIConnectionWithResolve,
    DEFAULT_MODELS,
    PROVIDER_BASE_URLS,
    type AIProvider,
    type AIProviderConfig,
    IMAGE_PROVIDER_PRESETS,
    type ImageProvider,
    type ImageProviderConfig,
    type ImageAspectRatio,
    type ImageSizeLevel,
    IMAGE_SIZE_MAP,
    resolveImageSize,
  } from '$lib/services/ai';
  import { testImageConnectionWithResolve } from '$lib/services/ai/image-service';
  import { settingsStore } from '$lib/stores/settings-store';
  import { invoke } from '@tauri-apps/api/core';
  import { t } from '$lib/i18n';

  // ── AI Chat Model State ──
  let chatConfigs = $state<AIProviderConfig[]>([]);
  let activeChatConfigId = $state<string | null>(null);
  let editingChatId = $state<string | null>(null);
  let addingChat = $state(false);

  // Chat form fields
  let formProvider = $state<AIProvider>('claude');
  let formApiKey = $state('');
  let formBaseUrl = $state('');
  let formModel = $state('');
  let formMaxTokens = $state(8192);
  let formTemperature = $state(0.7);
  let formTestStatus = $state<'idle' | 'testing' | 'success' | 'failed'>('idle');
  let showModelDropdown = $state(false);

  // ── AI Image Model State ──
  let imageConfigs = $state<ImageProviderConfig[]>([]);
  let activeImageConfigId = $state<string | null>(null);
  let editingImageId = $state<string | null>(null);
  let addingImage = $state(false);

  // Image form fields
  let imgFormProvider = $state<ImageProvider>('openai');
  let imgFormApiKey = $state('');
  let imgFormBaseUrl = $state('https://api.openai.com/v1');
  let imgFormModel = $state('dall-e-3');
  let imgFormRatio = $state<ImageAspectRatio>('16:9');
  let imgFormSizeLevel = $state<ImageSizeLevel>('medium');
  let imgFormTestStatus = $state<'idle' | 'testing' | 'success' | 'failed'>('idle');

  const RATIO_OPTIONS: ImageAspectRatio[] = ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'];
  const SIZE_LEVEL_OPTIONS: ImageSizeLevel[] = ['large', 'medium', 'small'];

  let imgFormResolvedSize = $derived(resolveImageSize(imgFormRatio, imgFormSizeLevel));

  // ── Subscribe to stores ──
  aiStore.subscribe(state => {
    chatConfigs = state.providerConfigs;
    activeChatConfigId = state.activeConfigId;
  });

  settingsStore.subscribe(state => {
    imageConfigs = state.imageProviderConfigs;
    activeImageConfigId = state.activeImageConfigId;
  });

  // ── Chat Model Functions ──
  function getChatModels(): string[] {
    return DEFAULT_MODELS[formProvider] || [];
  }

  function startEditChat(config: AIProviderConfig) {
    editingChatId = config.id;
    addingChat = false;
    formProvider = config.provider;
    formApiKey = config.apiKey;
    formBaseUrl = config.baseUrl || '';
    formModel = config.model;
    formMaxTokens = config.maxTokens || 8192;
    formTemperature = config.temperature || 0.7;
    formTestStatus = 'idle';
  }

  function startAddChat() {
    addingChat = true;
    editingChatId = null;
    formProvider = 'claude';
    formApiKey = '';
    formBaseUrl = '';
    formModel = DEFAULT_MODELS.claude[0] || '';
    formMaxTokens = 8192;
    formTemperature = 0.7;
    formTestStatus = 'idle';
  }

  function cancelChatForm() {
    editingChatId = null;
    addingChat = false;
  }

  function handleChatProviderChange(event: Event) {
    formProvider = (event.target as HTMLSelectElement).value as AIProvider;
    formModel = getChatModels()[0] || '';
    formBaseUrl = PROVIDER_BASE_URLS[formProvider] || '';
  }

  function saveChatConfig() {
    const config: AIProviderConfig = {
      id: editingChatId || crypto.randomUUID(),
      provider: formProvider,
      apiKey: formApiKey,
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
    editingChatId = null;
    addingChat = false;
  }

  function removeChatConfig(id: string) {
    aiStore.removeProviderConfig(id);
  }

  function setDefaultChat(id: string) {
    aiStore.setActiveConfig(id);
  }

  async function handleChatTest() {
    formTestStatus = 'testing';
    const config: AIProviderConfig = {
      id: editingChatId || 'test',
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
    setTimeout(() => { formTestStatus = 'idle'; }, 3000);
  }

  // ── Image Model Functions ──
  function startEditImage(config: ImageProviderConfig) {
    editingImageId = config.id;
    addingImage = false;
    imgFormProvider = config.provider;
    imgFormApiKey = config.apiKey;
    imgFormBaseUrl = config.baseURL;
    imgFormModel = config.model;
    imgFormRatio = config.defaultRatio;
    imgFormSizeLevel = config.defaultSizeLevel;
    imgFormTestStatus = 'idle';
  }

  function startAddImage() {
    addingImage = true;
    editingImageId = null;
    imgFormProvider = 'openai';
    imgFormApiKey = '';
    imgFormBaseUrl = 'https://api.openai.com/v1';
    imgFormModel = 'dall-e-3';
    imgFormRatio = '16:9';
    imgFormSizeLevel = 'medium';
    imgFormTestStatus = 'idle';
  }

  function cancelImageForm() {
    editingImageId = null;
    addingImage = false;
  }

  function handleImgProviderChange(event: Event) {
    imgFormProvider = (event.target as HTMLSelectElement).value as ImageProvider;
    const preset = IMAGE_PROVIDER_PRESETS[imgFormProvider];
    imgFormBaseUrl = preset.baseURL;
    imgFormModel = preset.model;
  }

  function saveImageConfig() {
    const config: ImageProviderConfig = {
      id: editingImageId || crypto.randomUUID(),
      provider: imgFormProvider,
      baseURL: imgFormBaseUrl,
      apiKey: imgFormApiKey,
      model: imgFormModel,
      defaultRatio: imgFormRatio,
      defaultSizeLevel: imgFormSizeLevel,
    };

    if (editingImageId) {
      const configs = imageConfigs.map(c => c.id === config.id ? config : c);
      settingsStore.update({ imageProviderConfigs: configs });
    } else {
      const configs = [...imageConfigs, config];
      const activeId = activeImageConfigId || config.id;
      settingsStore.update({ imageProviderConfigs: configs, activeImageConfigId: activeId });
    }
    editingImageId = null;
    addingImage = false;
  }

  function removeImageConfig(id: string) {
    if (imageConfigs.length <= 1) return;
    const configs = imageConfigs.filter(c => c.id !== id);
    let activeId = activeImageConfigId;
    if (activeId === id) activeId = configs[0]?.id || null;
    invoke('keychain_delete', { key: `image-key:${id}` }).catch(() => {});
    settingsStore.update({ imageProviderConfigs: configs, activeImageConfigId: activeId });
  }

  function setDefaultImage(id: string) {
    settingsStore.update({ activeImageConfigId: id });
  }

  async function handleImgTest() {
    imgFormTestStatus = 'testing';
    const config: ImageProviderConfig = {
      id: editingImageId || 'test',
      provider: imgFormProvider,
      baseURL: imgFormBaseUrl,
      apiKey: imgFormApiKey,
      model: imgFormModel,
      defaultRatio: imgFormRatio,
      defaultSizeLevel: imgFormSizeLevel,
    };
    const result = await testImageConnectionWithResolve(config);
    if (result.success && result.resolvedBaseUrl !== undefined && result.resolvedBaseUrl !== imgFormBaseUrl) {
      imgFormBaseUrl = result.resolvedBaseUrl;
    }
    imgFormTestStatus = result.success ? 'success' : 'failed';
    setTimeout(() => { imgFormTestStatus = 'idle'; }, 3000);
  }
</script>

<div class="ai-settings">
  <!-- ══════ AI Chat Models ══════ -->
  <h3>{$t('ai.config.title')}</h3>

  {#if chatConfigs.length === 0 && !addingChat}
    <div class="empty-state">
      <p>{$t('ai.multiModel.noModels')}</p>
      <p class="empty-hint">{$t('ai.multiModel.noModelsHint')}</p>
    </div>
  {/if}

  {#each chatConfigs as config (config.id)}
    {#if editingChatId === config.id}
      <!-- Inline edit form -->
      <div class="config-form">
        <div class="setting-group">
          <label class="setting-label">{$t('ai.config.provider')}</label>
          <select class="setting-input" value={formProvider} onchange={handleChatProviderChange}>
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
          <input type="password" class="setting-input" bind:value={formApiKey}
            placeholder={formProvider === 'ollama' ? $t('ai.config.apiKeyNotRequired') : $t('ai.config.apiKeyPlaceholder', { provider: formProvider })} />
        </div>

        {#if formProvider === 'custom' || formProvider === 'ollama'}
          <div class="setting-group">
            <label class="setting-label">{$t('ai.config.baseUrl')}</label>
            <input type="text" class="setting-input" bind:value={formBaseUrl} placeholder={PROVIDER_BASE_URLS[formProvider]} />
          </div>
        {/if}

        <div class="model-tokens-row">
          <div class="setting-group" style="flex:1;min-width:0">
            <label class="setting-label">{$t('ai.config.model')}</label>
            <div class="combo-wrapper">
              <input type="text" class="setting-input" bind:value={formModel}
                onfocus={() => { if (getChatModels().length > 0) showModelDropdown = true; }}
                onblur={() => { setTimeout(() => { showModelDropdown = false; }, 150); }}
                placeholder={$t('ai.config.modelPlaceholder')} />
              {#if showModelDropdown && getChatModels().length > 0}
                <div class="model-dropdown">
                  {#each getChatModels() as m}
                    <button class="model-option" class:active={formModel === m}
                      onmousedown={(e) => { e.preventDefault(); formModel = m; showModelDropdown = false; }}
                    >{m}</button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
          <div class="setting-group" style="width:5.5rem;flex-shrink:0">
            <label class="setting-label">{$t('ai.config.maxTokens')}</label>
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
          <button class="test-btn"
            class:testing={formTestStatus === 'testing'}
            class:success={formTestStatus === 'success'}
            class:failed={formTestStatus === 'failed'}
            onclick={handleChatTest}
            disabled={formTestStatus === 'testing' || !formApiKey}>
            {#if formTestStatus === 'testing'}{$t('ai.config.testing')}
            {:else if formTestStatus === 'success'}{$t('ai.config.connected')}
            {:else if formTestStatus === 'failed'}{$t('ai.config.failed')}
            {:else}{$t('ai.config.testConnection')}{/if}
          </button>
          <div class="form-actions-right">
            <button class="btn-sm" onclick={cancelChatForm}>{$t('common.cancel')}</button>
            <button class="btn-sm primary" onclick={saveChatConfig}>{$t('common.save')}</button>
          </div>
        </div>
      </div>
    {:else}
      <!-- Config card -->
      <div class="config-item">
        <div class="config-info">
          <span class="config-provider">{$t(`ai.providers.${config.provider}`)}</span>
          <span class="config-model">{config.model}</span>
          {#if config.id === activeChatConfigId}
            <span class="default-badge">{$t('ai.multiModel.default')}</span>
          {/if}
        </div>
        <div class="config-actions">
          {#if config.id !== activeChatConfigId}
            <button class="btn-sm" onclick={() => setDefaultChat(config.id)}>{$t('ai.multiModel.setDefault')}</button>
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
        <select class="setting-input" value={formProvider} onchange={handleChatProviderChange}>
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
        <input type="password" class="setting-input" bind:value={formApiKey}
          placeholder={formProvider === 'ollama' ? $t('ai.config.apiKeyNotRequired') : $t('ai.config.apiKeyPlaceholder', { provider: formProvider })} />
      </div>

      {#if formProvider === 'custom' || formProvider === 'ollama'}
        <div class="setting-group">
          <label class="setting-label">{$t('ai.config.baseUrl')}</label>
          <input type="text" class="setting-input" bind:value={formBaseUrl} placeholder={PROVIDER_BASE_URLS[formProvider]} />
        </div>
      {/if}

      <div class="model-tokens-row">
        <div class="setting-group" style="flex:1;min-width:0">
          <label class="setting-label">{$t('ai.config.model')}</label>
          <div class="combo-wrapper">
            <input type="text" class="setting-input" bind:value={formModel}
              onfocus={() => { if (getChatModels().length > 0) showModelDropdown = true; }}
              onblur={() => { setTimeout(() => { showModelDropdown = false; }, 150); }}
              placeholder={$t('ai.config.modelPlaceholder')} />
            {#if showModelDropdown && getChatModels().length > 0}
              <div class="model-dropdown">
                {#each getChatModels() as m}
                  <button class="model-option" class:active={formModel === m}
                    onmousedown={(e) => { e.preventDefault(); formModel = m; showModelDropdown = false; }}
                  >{m}</button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
        <div class="setting-group" style="width:5.5rem;flex-shrink:0">
          <label class="setting-label">{$t('ai.config.maxTokens')}</label>
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
        <button class="test-btn"
          class:testing={formTestStatus === 'testing'}
          class:success={formTestStatus === 'success'}
          class:failed={formTestStatus === 'failed'}
          onclick={handleChatTest}
          disabled={formTestStatus === 'testing' || !formApiKey}>
          {#if formTestStatus === 'testing'}{$t('ai.config.testing')}
          {:else if formTestStatus === 'success'}{$t('ai.config.connected')}
          {:else if formTestStatus === 'failed'}{$t('ai.config.failed')}
          {:else}{$t('ai.config.testConnection')}{/if}
        </button>
        <div class="form-actions-right">
          <button class="btn-sm" onclick={cancelChatForm}>{$t('common.cancel')}</button>
          <button class="btn-sm primary" onclick={saveChatConfig}>{$t('common.save')}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if !addingChat && editingChatId === null}
    <button class="add-model-btn" onclick={startAddChat}>{$t('ai.multiModel.addModel')}</button>
  {/if}

  <!-- ══════ AI Image Models ══════ -->
  <h3>{$t('ai.imageConfig.title')}</h3>

  {#if imageConfigs.length === 0 && !addingImage}
    <div class="empty-state">
      <p>{$t('ai.multiModel.noImageModels')}</p>
      <p class="empty-hint">{$t('ai.multiModel.noImageModelsHint')}</p>
    </div>
  {/if}

  {#each imageConfigs as config (config.id)}
    {#if editingImageId === config.id}
      <div class="config-form">
        <div class="setting-group">
          <label class="setting-label">{$t('ai.imageConfig.provider')}</label>
          <select class="setting-input" value={imgFormProvider} onchange={handleImgProviderChange}>
            <option value="openai">{$t('ai.imageConfig.providerOpenai')}</option>
            <option value="grok">{$t('ai.imageConfig.providerGrok')}</option>
            <option value="custom">{$t('ai.imageConfig.providerCustom')}</option>
          </select>
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.imageConfig.apiKey')}</label>
          <input type="password" class="setting-input" bind:value={imgFormApiKey} placeholder={$t('ai.imageConfig.apiKeyPlaceholder')} />
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.imageConfig.baseUrl')}</label>
          <input type="text" class="setting-input" bind:value={imgFormBaseUrl} placeholder="https://api.openai.com/v1" />
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.imageConfig.model')}</label>
          <input type="text" class="setting-input" bind:value={imgFormModel} placeholder={$t('ai.imageConfig.modelPlaceholder')} />
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.imageConfig.ratio')}</label>
          <select class="setting-input" bind:value={imgFormRatio}>
            {#each RATIO_OPTIONS as r}
              <option value={r}>{r}</option>
            {/each}
          </select>
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.imageConfig.sizeLevel')}</label>
          <div class="setting-row">
            <select class="setting-input" style="flex:1" bind:value={imgFormSizeLevel}>
              {#each SIZE_LEVEL_OPTIONS as s}
                <option value={s}>{$t(`ai.imageConfig.size_${s}`)}</option>
              {/each}
            </select>
            <span class="setting-value">{imgFormResolvedSize}</span>
          </div>
        </div>

        <div class="form-actions">
          <button class="test-btn"
            class:testing={imgFormTestStatus === 'testing'}
            class:success={imgFormTestStatus === 'success'}
            class:failed={imgFormTestStatus === 'failed'}
            onclick={handleImgTest}
            disabled={imgFormTestStatus === 'testing' || !imgFormApiKey}>
            {#if imgFormTestStatus === 'testing'}{$t('ai.config.testing')}
            {:else if imgFormTestStatus === 'success'}{$t('ai.config.connected')}
            {:else if imgFormTestStatus === 'failed'}{$t('ai.config.failed')}
            {:else}{$t('ai.config.testConnection')}{/if}
          </button>
          <div class="form-actions-right">
            <button class="btn-sm" onclick={cancelImageForm}>{$t('common.cancel')}</button>
            <button class="btn-sm primary" onclick={saveImageConfig}>{$t('common.save')}</button>
          </div>
        </div>
      </div>
    {:else}
      <div class="config-item">
        <div class="config-info">
          <span class="config-provider">{config.provider}</span>
          <span class="config-model">{config.model}</span>
          {#if config.id === activeImageConfigId}
            <span class="default-badge">{$t('ai.multiModel.default')}</span>
          {/if}
        </div>
        <div class="config-actions">
          {#if config.id !== activeImageConfigId}
            <button class="btn-sm" onclick={() => setDefaultImage(config.id)}>{$t('ai.multiModel.setDefault')}</button>
          {/if}
          <button class="btn-sm" onclick={() => startEditImage(config)}>{$t('common.edit')}</button>
          {#if imageConfigs.length > 1}
            <button class="btn-sm danger" onclick={() => removeImageConfig(config.id)}>{$t('common.remove')}</button>
          {/if}
        </div>
      </div>
    {/if}
  {/each}

  {#if addingImage}
    <div class="config-form">
      <div class="setting-group">
        <label class="setting-label">{$t('ai.imageConfig.provider')}</label>
        <select class="setting-input" value={imgFormProvider} onchange={handleImgProviderChange}>
          <option value="openai">{$t('ai.imageConfig.providerOpenai')}</option>
          <option value="grok">{$t('ai.imageConfig.providerGrok')}</option>
          <option value="custom">{$t('ai.imageConfig.providerCustom')}</option>
        </select>
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.imageConfig.apiKey')}</label>
        <input type="password" class="setting-input" bind:value={imgFormApiKey} placeholder={$t('ai.imageConfig.apiKeyPlaceholder')} />
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.imageConfig.baseUrl')}</label>
        <input type="text" class="setting-input" bind:value={imgFormBaseUrl} placeholder="https://api.openai.com/v1" />
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.imageConfig.model')}</label>
        <input type="text" class="setting-input" bind:value={imgFormModel} placeholder={$t('ai.imageConfig.modelPlaceholder')} />
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.imageConfig.ratio')}</label>
        <select class="setting-input" bind:value={imgFormRatio}>
          {#each RATIO_OPTIONS as r}
            <option value={r}>{r}</option>
          {/each}
        </select>
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.imageConfig.sizeLevel')}</label>
        <div class="setting-row">
          <select class="setting-input" style="flex:1" bind:value={imgFormSizeLevel}>
            {#each SIZE_LEVEL_OPTIONS as s}
              <option value={s}>{$t(`ai.imageConfig.size_${s}`)}</option>
            {/each}
          </select>
          <span class="setting-value">{imgFormResolvedSize}</span>
        </div>
      </div>

      <div class="form-actions">
        <button class="test-btn"
          class:testing={imgFormTestStatus === 'testing'}
          class:success={imgFormTestStatus === 'success'}
          class:failed={imgFormTestStatus === 'failed'}
          onclick={handleImgTest}
          disabled={imgFormTestStatus === 'testing' || !imgFormApiKey}>
          {#if imgFormTestStatus === 'testing'}{$t('ai.config.testing')}
          {:else if imgFormTestStatus === 'success'}{$t('ai.config.connected')}
          {:else if imgFormTestStatus === 'failed'}{$t('ai.config.failed')}
          {:else}{$t('ai.config.testConnection')}{/if}
        </button>
        <div class="form-actions-right">
          <button class="btn-sm" onclick={cancelImageForm}>{$t('common.cancel')}</button>
          <button class="btn-sm primary" onclick={saveImageConfig}>{$t('common.save')}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if !addingImage && editingImageId === null}
    <button class="add-model-btn" onclick={startAddImage}>{$t('ai.multiModel.addModel')}</button>
  {/if}
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
    margin: 0;
  }

  .ai-settings h3 + .config-item ~ h3,
  .ai-settings h3 + .config-form ~ h3,
  .ai-settings h3 + .add-model-btn ~ h3,
  .ai-settings h3 + .empty-state ~ h3 {
    margin-top: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-light);
  }

  /* Config card */
  .config-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    gap: 0.5rem;
  }

  .config-info {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    overflow: hidden;
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

  .default-badge {
    font-size: 10px;
    padding: 0.05rem 0.35rem;
    border-radius: 8px;
    background: var(--accent-color);
    color: white;
    font-weight: 500;
    flex-shrink: 0;
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

  /* Config form */
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

  /* Empty state */
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

  /* Add model button */
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

  /* Shared form controls */
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
</style>

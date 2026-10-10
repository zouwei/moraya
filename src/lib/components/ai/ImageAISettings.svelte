<script lang="ts">
  import {
    DEFAULT_IMAGE_MODELS,
    IMAGE_PROVIDER_PRESETS,
    type ImageProvider,
    type ImageProviderConfig,
    type ImageAspectRatio,
    type ImageSizeLevel,
    resolveImageSize,
  } from '$lib/services/ai';
  import { testImageConnectionWithResolve } from '$lib/services/ai/image-service';
  import { settingsStore } from '$lib/stores/settings-store';
  import { invoke } from '@tauri-apps/api/core';
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { Select } from '$lib/components/ui';

  let imageConfigs = $state<ImageProviderConfig[]>([]);
  let activeImageConfigId = $state<string | null>(null);
  let editingImageId = $state<string | null>(null);
  let addingImage = $state(false);

  let imgFormProvider = $state<ImageProvider>('openai');
  let imgFormApiKey = $state('');
  let imgFormHasSavedKey = $state(false);
  let imgFormBaseUrl = $state('https://api.openai.com/v1');
  let imgFormModel = $state('dall-e-3');
  let imgFormRatio = $state<ImageAspectRatio>('16:9');
  let imgFormSizeLevel = $state<ImageSizeLevel>('medium');
  let imgFormTestStatus = $state<'idle' | 'testing' | 'success' | 'failed'>('idle');
  let imgFormTestError = $state('');
  let showImageModelDropdown = $state(false);
  let imgTestTimer: ReturnType<typeof setTimeout> | null = null;

  const RATIO_OPTIONS: ImageAspectRatio[] = ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'];
  const SIZE_LEVEL_OPTIONS: ImageSizeLevel[] = ['large', 'medium', 'small'];

  let imgFormResolvedSize = $derived(resolveImageSize(imgFormRatio, imgFormSizeLevel));

  const IMAGE_PROVIDER_OPTION_KEYS: ImageProvider[] = ['openai', 'grok', 'gemini', 'qwen', 'doubao', 'custom'];
  let imgProviderOptions = $derived(IMAGE_PROVIDER_OPTION_KEYS.map(p => ({ value: p, label: $t(`ai.image_config.provider_${p}`) })));
  let ratioOptions = $derived(RATIO_OPTIONS.map(r => ({ value: r, label: r })));
  let sizeLevelOptions = $derived(SIZE_LEVEL_OPTIONS.map(s => ({ value: s, label: $t(`ai.image_config.size_${s}`) })));

  // Top-level store subscriptions — do NOT wrap in $effect().
  const unsub = settingsStore.subscribe(state => {
    imageConfigs = state.imageProviderConfigs;
    activeImageConfigId = state.activeImageConfigId;
  });
  onDestroy(() => {
    unsub();
    if (imgTestTimer) clearTimeout(imgTestTimer);
  });

  function getImageModels(): string[] {
    return DEFAULT_IMAGE_MODELS[imgFormProvider] || [];
  }

  function startEditImage(config: ImageProviderConfig) {
    if (imgTestTimer) clearTimeout(imgTestTimer);
    editingImageId = config.id;
    addingImage = false;
    imgFormProvider = config.provider;
    imgFormApiKey = '';
    imgFormHasSavedKey = Boolean(config.apiKey && config.apiKey !== '***');
    if (!imgFormHasSavedKey) {
      invoke<string | null>('keychain_get', { key: `image-key:${config.id}` })
        .then(key => {
          if (editingImageId === config.id && key) imgFormHasSavedKey = true;
        })
        .catch(() => {});
    }
    imgFormBaseUrl = config.baseURL;
    imgFormModel = config.model;
    imgFormRatio = config.defaultRatio;
    imgFormSizeLevel = config.defaultSizeLevel;
    imgFormTestStatus = 'idle';
    imgFormTestError = '';
  }

  function startAddImage() {
    if (imgTestTimer) clearTimeout(imgTestTimer);
    addingImage = true;
    editingImageId = null;
    imgFormProvider = 'openai';
    imgFormApiKey = '';
    imgFormHasSavedKey = false;
    imgFormBaseUrl = 'https://api.openai.com/v1';
    imgFormModel = 'dall-e-3';
    imgFormRatio = '16:9';
    imgFormSizeLevel = 'medium';
    imgFormTestStatus = 'idle';
    imgFormTestError = '';
  }

  function cancelImageForm() {
    editingImageId = null;
    addingImage = false;
  }

  function handleImgProviderChange(value: unknown) {
    imgFormProvider = value as ImageProvider;
    const preset = IMAGE_PROVIDER_PRESETS[imgFormProvider];
    imgFormBaseUrl = preset.baseURL;
    imgFormModel = preset.model;
  }

  function saveImageConfig() {
    const existing = imageConfigs.find(c => c.id === editingImageId);
    const config: ImageProviderConfig = {
      id: editingImageId || crypto.randomUUID(),
      provider: imgFormProvider,
      baseURL: imgFormBaseUrl,
      apiKey: imgFormApiKey.trim() || existing?.apiKey || (imgFormHasSavedKey ? '***' : ''),
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
    if (imgTestTimer) clearTimeout(imgTestTimer);
    imgFormTestStatus = 'testing';
    imgFormTestError = '';
    const existing = imageConfigs.find(c => c.id === editingImageId);
    const config: ImageProviderConfig = {
      id: editingImageId || 'test',
      provider: imgFormProvider,
      baseURL: imgFormBaseUrl,
      apiKey: imgFormApiKey.trim() || existing?.apiKey || (imgFormHasSavedKey ? '***' : ''),
      model: imgFormModel,
      defaultRatio: imgFormRatio,
      defaultSizeLevel: imgFormSizeLevel,
    };
    try {
      const result = await testImageConnectionWithResolve(config);
      if (result.success && result.resolvedBaseUrl !== undefined && result.resolvedBaseUrl !== imgFormBaseUrl) {
        imgFormBaseUrl = result.resolvedBaseUrl;
      }
      imgFormTestStatus = result.success ? 'success' : 'failed';
      imgFormTestError = result.success ? '' : (result.error || $t('ai.config.test_failed'));
    } catch (error) {
      imgFormTestStatus = 'failed';
      imgFormTestError = error instanceof Error ? error.message : String(error);
    }
    if (imgFormTestStatus === 'success') {
      imgTestTimer = setTimeout(() => { imgFormTestStatus = 'idle'; }, 3000);
    }
  }
</script>

<div class="image-ai-settings gx-tab">
  <div class="section-header">
    <div>
      <h3 class="section-title">{$t('ai.sections.image_ai')}</h3>
      <p class="section-subtitle">{$t('ai.sections.image_aihint')}</p>
    </div>
  </div>

  {#if imageConfigs.length === 0 && !addingImage}
    <div class="empty-state">
      <p>{$t('ai.multi_model.no_image_models')}</p>
      <p class="empty-hint">{$t('ai.multi_model.no_image_models_hint')}</p>
    </div>
  {/if}

  {#each imageConfigs as config (config.id)}
    {#if editingImageId === config.id}
      <div class="config-form">
        <div class="setting-group">
          <label class="setting-label">{$t('ai.image_config.provider')}</label>
          <Select class="setting-input" block bind:value={imgFormProvider} options={imgProviderOptions} onchange={handleImgProviderChange} />
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.image_config.api_key')}</label>
          <input type="password" class="setting-input" bind:value={imgFormApiKey} placeholder={imgFormHasSavedKey ? '********' : $t('ai.image_config.api_key_placeholder')} />
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.image_config.base_url')}</label>
          <input type="text" class="setting-input" bind:value={imgFormBaseUrl} placeholder="https://api.openai.com/v1" />
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.image_config.model')}</label>
          <div class="combo-wrapper">
            <input type="text" class="setting-input" bind:value={imgFormModel}
              onfocus={() => { if (getImageModels().length > 0) showImageModelDropdown = true; }}
              onblur={() => { setTimeout(() => { showImageModelDropdown = false; }, 150); }}
              placeholder={$t('ai.image_config.model_placeholder')} />
            {#if showImageModelDropdown && getImageModels().length > 0}
              <div class="model-dropdown">
                {#each getImageModels() as m}
                  <button class="model-option" class:active={imgFormModel === m}
                    onmousedown={(e) => { e.preventDefault(); imgFormModel = m; showImageModelDropdown = false; }}
                  >{m}</button>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.image_config.ratio')}</label>
          <Select class="setting-input" block bind:value={imgFormRatio} options={ratioOptions} />
        </div>

        <div class="setting-group">
          <label class="setting-label">{$t('ai.image_config.size_level')}</label>
          <div class="setting-row">
            <Select class="setting-input" style="flex:1" bind:value={imgFormSizeLevel} options={sizeLevelOptions} />
            <span class="setting-value">{imgFormResolvedSize}</span>
          </div>
        </div>

        <div class="form-actions">
          <button class="test-btn"
            class:testing={imgFormTestStatus === 'testing'}
            class:success={imgFormTestStatus === 'success'}
            class:failed={imgFormTestStatus === 'failed'}
            onclick={handleImgTest}
            disabled={imgFormTestStatus === 'testing' || (!imgFormApiKey.trim() && !imgFormHasSavedKey)}>
            {#if imgFormTestStatus === 'testing'}{$t('ai.config.testing')}
            {:else if imgFormTestStatus === 'success'}{$t('ai.config.connected')}
            {:else if imgFormTestStatus === 'failed'}{$t('ai.config.failed')}
            {:else}{$t('ai.config.test_connection')}{/if}
          </button>
          <div class="form-actions-right">
            <button class="btn-sm" onclick={cancelImageForm}>{$t('common.cancel')}</button>
            <button class="btn-sm primary" onclick={saveImageConfig} disabled={!imgFormApiKey.trim() && !imgFormHasSavedKey}>{$t('common.save')}</button>
          </div>
        </div>
        {#if imgFormTestError && imgFormTestStatus === 'failed'}
          <p class="test-error">{imgFormTestError}</p>
        {/if}
      </div>
    {:else}
      <div class="config-item">
        <div class="config-info">
          <span class="config-provider">{config.provider}</span>
          <span class="config-model">{config.model}</span>
          {#if config.id === activeImageConfigId}
            <span class="default-badge">{$t('ai.multi_model.default')}</span>
          {/if}
        </div>
        <div class="config-actions">
          {#if config.id !== activeImageConfigId}
            <button class="btn-sm" onclick={() => setDefaultImage(config.id)}>{$t('ai.multi_model.set_default')}</button>
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
        <label class="setting-label">{$t('ai.image_config.provider')}</label>
        <Select class="setting-input" block bind:value={imgFormProvider} options={imgProviderOptions} onchange={handleImgProviderChange} />
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.image_config.api_key')}</label>
        <input type="password" class="setting-input" bind:value={imgFormApiKey} placeholder={$t('ai.image_config.api_key_placeholder')} />
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.image_config.base_url')}</label>
        <input type="text" class="setting-input" bind:value={imgFormBaseUrl} placeholder="https://api.openai.com/v1" />
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.image_config.model')}</label>
        <input type="text" class="setting-input" bind:value={imgFormModel} placeholder={$t('ai.image_config.model_placeholder')} />
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.image_config.ratio')}</label>
        <Select class="setting-input" block bind:value={imgFormRatio} options={ratioOptions} />
      </div>

      <div class="setting-group">
        <label class="setting-label">{$t('ai.image_config.size_level')}</label>
        <div class="setting-row">
          <Select class="setting-input" style="flex:1" bind:value={imgFormSizeLevel} options={sizeLevelOptions} />
          <span class="setting-value">{imgFormResolvedSize}</span>
        </div>
      </div>

      <div class="form-actions">
        <button class="test-btn"
          class:testing={imgFormTestStatus === 'testing'}
          class:success={imgFormTestStatus === 'success'}
          class:failed={imgFormTestStatus === 'failed'}
          onclick={handleImgTest}
          disabled={imgFormTestStatus === 'testing' || !imgFormApiKey.trim()}>
          {#if imgFormTestStatus === 'testing'}{$t('ai.config.testing')}
          {:else if imgFormTestStatus === 'success'}{$t('ai.config.connected')}
          {:else if imgFormTestStatus === 'failed'}{$t('ai.config.failed')}
          {:else}{$t('ai.config.test_connection')}{/if}
        </button>
        <div class="form-actions-right">
          <button class="btn-sm" onclick={cancelImageForm}>{$t('common.cancel')}</button>
          <button class="btn-sm primary" onclick={saveImageConfig} disabled={!imgFormApiKey.trim()}>{$t('common.save')}</button>
        </div>
      </div>
      {#if imgFormTestError && imgFormTestStatus === 'failed'}
        <p class="test-error">{imgFormTestError}</p>
      {/if}
    </div>
  {/if}

  {#if !addingImage && editingImageId === null}
    <button class="add-model-btn" onclick={startAddImage}>{$t('ai.multi_model.add_model')}</button>
  {/if}
</div>

<style>
  /* Outer layout: .gx-tab on root. */

  .config-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.55rem 0.85rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-primary);
    gap: 0.5rem;
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
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .form-actions-right {
    display: flex;
    margin-left: auto;
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
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
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

  .setting-value {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    min-width: 2rem;
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
    flex: none;
    width: 9.5rem;
    box-sizing: border-box;
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-secondary);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-xs);
    text-align: center;
    white-space: nowrap;
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .test-btn:focus:not(:focus-visible) {
    outline: none;
  }

  .test-btn:focus-visible {
    outline: 2px solid var(--accent-color);
    outline-offset: 2px;
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

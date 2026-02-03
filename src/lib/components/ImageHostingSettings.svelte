<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { ImageHostProvider, ImageHostConfig } from '$lib/services/image-hosting';
  import { uploadImage } from '$lib/services/image-hosting';

  const tr = $t;

  let provider = $state<ImageHostProvider>('custom');
  let apiToken = $state('');
  let customEndpoint = $state('');
  let customHeaders = $state('');
  let autoUpload = $state(false);
  let testStatus = $state<'idle' | 'testing' | 'success' | 'failed'>('idle');

  settingsStore.subscribe(state => {
    provider = state.imageHostConfig.provider;
    apiToken = state.imageHostConfig.apiToken;
    customEndpoint = state.imageHostConfig.customEndpoint;
    customHeaders = state.imageHostConfig.customHeaders;
    autoUpload = state.imageHostConfig.autoUpload;
  });

  function saveConfig() {
    const config: ImageHostConfig = {
      provider,
      apiToken,
      customEndpoint,
      customHeaders,
      autoUpload,
    };
    settingsStore.update({ imageHostConfig: config });
  }

  function handleProviderChange(event: Event) {
    provider = (event.target as HTMLSelectElement).value as ImageHostProvider;
    saveConfig();
  }

  function handleTokenChange(event: Event) {
    apiToken = (event.target as HTMLInputElement).value;
    saveConfig();
  }

  function handleEndpointChange(event: Event) {
    customEndpoint = (event.target as HTMLInputElement).value;
    saveConfig();
  }

  function handleHeadersChange(event: Event) {
    customHeaders = (event.target as HTMLTextAreaElement).value;
    saveConfig();
  }

  function handleAutoUploadChange(event: Event) {
    autoUpload = (event.target as HTMLInputElement).checked;
    saveConfig();
  }

  async function handleTestUpload() {
    testStatus = 'testing';
    try {
      // Create a tiny 1x1 red pixel PNG
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 1, 1);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/png')
      );

      const config: ImageHostConfig = {
        provider,
        apiToken,
        customEndpoint,
        customHeaders,
        autoUpload,
      };
      await uploadImage(blob, config);
      testStatus = 'success';
    } catch {
      testStatus = 'failed';
    }
    setTimeout(() => { testStatus = 'idle'; }, 3000);
  }
</script>

<div class="setting-section">
  <div class="section-header">{tr('imageHost.title')}</div>

  <div class="setting-group">
    <label class="setting-label">{tr('imageHost.provider')}</label>
    <select class="setting-input" value={provider} onchange={handleProviderChange}>
      <option value="smms">{tr('imageHost.smms')}</option>
      <option value="imgur">{tr('imageHost.imgur')}</option>
      <option value="custom">{tr('imageHost.custom')}</option>
    </select>
  </div>

  <div class="setting-group">
    <label class="setting-label">{tr('imageHost.apiToken')}</label>
    <input
      type="password"
      class="setting-input"
      placeholder={tr('imageHost.apiTokenPlaceholder')}
      value={apiToken}
      oninput={handleTokenChange}
    />
  </div>

  {#if provider === 'custom'}
    <div class="setting-group">
      <label class="setting-label">{tr('imageHost.customEndpoint')}</label>
      <input
        type="text"
        class="setting-input wide"
        placeholder={tr('imageHost.customEndpointPlaceholder')}
        value={customEndpoint}
        oninput={handleEndpointChange}
      />
    </div>

    <div class="setting-group">
      <label class="setting-label">{tr('imageHost.customHeaders')}</label>
      <textarea
        class="setting-textarea"
        placeholder={'{"X-Custom-Header": "value"}'}
        value={customHeaders}
        oninput={handleHeadersChange}
        rows="3"
      ></textarea>
    </div>
  {/if}

  <div class="setting-group">
    <label class="setting-label">
      <input
        type="checkbox"
        checked={autoUpload}
        onchange={handleAutoUploadChange}
      />
      {tr('imageHost.autoUpload')}
    </label>
  </div>

  <div class="setting-group">
    <button
      class="test-btn"
      class:testing={testStatus === 'testing'}
      class:success={testStatus === 'success'}
      class:failed={testStatus === 'failed'}
      onclick={handleTestUpload}
      disabled={testStatus === 'testing'}
    >
      {#if testStatus === 'testing'}
        {tr('imageHost.testing')}
      {:else if testStatus === 'success'}
        {tr('imageHost.success')}
      {:else if testStatus === 'failed'}
        {tr('imageHost.failed')}
      {:else}
        {tr('imageHost.testUpload')}
      {/if}
    </button>
  </div>
</div>

<style>
  .setting-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-header {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
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

  .setting-input.wide {
    max-width: 400px;
  }

  .setting-textarea {
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
    max-width: 400px;
    resize: vertical;
  }

  .test-btn {
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
    max-width: fit-content;
  }

  .test-btn:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .test-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .test-btn.success {
    color: #2ea043;
    border-color: #2ea043;
  }

  .test-btn.failed {
    color: #e81123;
    border-color: #e81123;
  }
</style>

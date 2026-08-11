<script lang="ts">
  import { get } from 'svelte/store';
  import { aiStore, DEFAULT_MODELS, PROVIDER_BASE_URLS, type AIProviderConfig } from '$lib/services/ai';
  import { probeOllama } from '$lib/services/ai/ollama-probe';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { t } from '$lib/i18n';

  let {
    onOpenSettings,
    onToast,
  }: {
    onOpenSettings?: () => void;
    onToast?: (text: string, type?: 'success' | 'error') => void;
  } = $props();

  type Phase = 'choice' | 'probing' | 'not_running' | 'no_models';
  let phase = $state<Phase>('choice');
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const suggestedModel = DEFAULT_MODELS.ollama?.[0] ?? 'llama3.3';
  const pullCommand = `ollama pull ${suggestedModel}`;

  async function handleOllamaClick() {
    phase = 'probing';
    const result = await probeOllama();

    if (result.status === 'unreachable') {
      phase = 'not_running';
      return;
    }
    if (result.status === 'no_models') {
      phase = 'no_models';
      return;
    }

    // result.status === 'ready' — pick the first installed model; the user
    // can switch to another one later via Settings.
    const model = result.models[0]!;
    const config: AIProviderConfig = {
      id: crypto.randomUUID(),
      provider: 'ollama',
      apiKey: '',
      baseUrl: PROVIDER_BASE_URLS.ollama,
      model,
      maxTokens: 41920,
      temperature: 0.7,
    };
    aiStore.addProviderConfig(config);
    aiStore.setActiveConfig(config.id);
    onToast?.(get(t)('ai.onboarding.ollama_ready_toast', { model }), 'success');
  }

  async function copyPullCommand() {
    try {
      await navigator.clipboard.writeText(pullCommand);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; }, 1200);
    } catch { /* clipboard denied */ }
  }
</script>

<div class="ai-onboarding">
  {#if phase === 'choice'}
    <div class="onboarding-cards">
      <div class="onboarding-card">
        <span class="card-icon" aria-hidden="true">💻</span>
        <p class="card-title">{$t('ai.onboarding.local_card_title')}</p>
        <p class="card-desc">{$t('ai.onboarding.local_card_desc')}</p>
        <button class="card-cta" onclick={handleOllamaClick}>{$t('ai.onboarding.local_card_cta')}</button>
      </div>
      <div class="onboarding-card">
        <span class="card-icon" aria-hidden="true">🔑</span>
        <p class="card-title">{$t('ai.onboarding.cloud_card_title')}</p>
        <p class="card-desc">{$t('ai.onboarding.cloud_card_desc')}</p>
        {#if onOpenSettings}
          <button class="card-cta secondary" onclick={onOpenSettings}>{$t('ai.onboarding.cloud_card_cta')}</button>
        {/if}
      </div>
    </div>
  {:else if phase === 'probing'}
    <div class="onboarding-status">
      <p>{$t('ai.onboarding.probing')}</p>
    </div>
  {:else if phase === 'not_running'}
    <div class="onboarding-status">
      <p class="status-title">{$t('ai.onboarding.not_running_title')}</p>
      <p class="status-desc">{$t('ai.onboarding.not_running_desc')}</p>
      <div class="status-actions">
        <button class="card-cta" onclick={() => openUrl('https://ollama.com/download')}>{$t('ai.onboarding.download_ollama')}</button>
        <button class="btn-text" onclick={handleOllamaClick}>{$t('ai.retry')}</button>
        <button class="btn-text" onclick={() => phase = 'choice'}>{$t('ai.onboarding.back')}</button>
      </div>
    </div>
  {:else if phase === 'no_models'}
    <div class="onboarding-status">
      <p class="status-title">{$t('ai.onboarding.no_models_title')}</p>
      <p class="status-desc">{$t('ai.onboarding.no_models_desc')}</p>
      <div class="pull-command">
        <code>{pullCommand}</code>
        <button class="btn-text" onclick={copyPullCommand}>{copied ? '✓' : $t('common.copy')}</button>
      </div>
      <div class="status-actions">
        <button class="card-cta" onclick={handleOllamaClick}>{$t('ai.onboarding.recheck')}</button>
        <button class="btn-text" onclick={() => phase = 'choice'}>{$t('ai.onboarding.back')}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .ai-onboarding {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }

  .onboarding-cards {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
    max-width: 22rem;
  }

  .onboarding-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.35rem;
    padding: 1rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-secondary);
  }

  .card-icon {
    font-size: 1.5rem;
    line-height: 1;
  }

  .card-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .card-desc {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    line-height: 1.4;
  }

  .card-cta {
    margin-top: 0.35rem;
    padding: 0.4rem 1rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--accent-color);
    color: white;
    font-size: var(--font-size-sm);
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .card-cta:hover {
    opacity: 0.85;
  }

  .card-cta.secondary {
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  .onboarding-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.5rem;
    max-width: 22rem;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .status-title {
    font-weight: 600;
    color: var(--text-primary);
  }

  .status-desc {
    font-size: var(--font-size-xs);
    line-height: 1.4;
  }

  .status-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .btn-text {
    padding: 0.4rem 0.6rem;
    border: none;
    background: none;
    color: var(--accent-color);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .btn-text:hover {
    text-decoration: underline;
  }

  .pull-command {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-secondary);
    font-size: var(--font-size-xs);
  }

  .pull-command code {
    font-family: var(--font-mono, monospace);
    color: var(--text-primary);
    white-space: nowrap;
  }
</style>

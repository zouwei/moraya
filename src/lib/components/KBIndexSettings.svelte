<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { invoke } from '@tauri-apps/api/core';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import { filesStore } from '$lib/stores/files-store';
  import { aiStore } from '$lib/services/ai/ai-service';
  import {
    getEmbeddingConfig,
    getIndexStatus,
    indexKnowledgeBase,
    deleteIndex,
  } from '$lib/services/kb';
  import { EMBEDDING_MODELS, getMaxDimension } from '$lib/services/kb/types';
  import type { IndexStatus } from '$lib/services/kb/types';

  import type { KnowledgeBase } from '$lib/stores/files-store';

  let {
    onOpenKBManager,
  }: {
    onOpenKBManager?: () => void;
  } = $props();

  let knowledgeBases = $state<KnowledgeBase[]>([]);

  const SOURCE_OPTIONS = [
    { value: 'online', labelKey: 'kb.onlineModel' },
    { value: 'local', labelKey: 'kb.localModels' },
  ];

  // Online provider list for the model dropdown
  const ONLINE_PROVIDERS = ['openai', 'gemini', 'ollama', 'glm', 'doubao', 'deepseek'];

  let embeddingSource = $state<'online' | 'local'>('online');
  let embeddingProvider = $state('');
  let embeddingModel = $state('');
  let embeddingDimensions = $state(1024);
  let autoIndexOnSave = $state(false);
  let localEmbeddingModelId = $state('');
  let showModelDropdown = $state(false);

  let indexStatus: IndexStatus | null = $state(null);
  let isIndexing = $state(false);
  let progressPhase = $state('');
  let progressCurrent = $state(0);
  let progressTotal = $state(0);
  let progressFileName = $state('');

  let activeKBPath = $state('');
  let activeKBName = $state('');

  // Effective provider (resolved from settings or AI chat)
  let effectiveProvider = $derived(
    embeddingSource === 'local' ? 'local' : (embeddingProvider || aiStore.getActiveConfig()?.provider || 'openai'),
  );

  // Available models for the effective provider
  let availableModels = $derived(EMBEDDING_MODELS[effectiveProvider] || []);

  // Whether the current provider supports embedding
  let providerSupportsEmbedding = $derived(availableModels.length > 0);

  // Filter models by current input for smart suggestions
  let filteredModels = $derived.by(() => {
    if (!embeddingModel) return availableModels;
    const q = embeddingModel.toLowerCase();
    const matched = availableModels.filter((m) => m.model.toLowerCase().includes(q));
    return matched.length > 0 ? matched : availableModels;
  });

  // Max dimension warning
  let maxDim = $derived(getMaxDimension(effectiveProvider, embeddingModel));
  let showDimWarning = $derived(embeddingDimensions > maxDim);
  let effectiveDim = $derived(Math.min(embeddingDimensions, maxDim));

  // Load settings
  const unsubSettings = settingsStore.subscribe((s) => {
    embeddingSource = s.embeddingProvider === 'local' ? 'local' : 'online';
    embeddingProvider = (s.embeddingProvider && s.embeddingProvider !== 'local') ? s.embeddingProvider : '';
    embeddingDimensions = s.embeddingDimensions || 1024;
    autoIndexOnSave = s.autoIndexOnSave || false;
    localEmbeddingModelId = s.localEmbeddingModelId || '';
    // Auto-fill model with provider default if empty
    if (s.embeddingModel) {
      embeddingModel = s.embeddingModel;
    } else {
      const p = s.embeddingProvider || aiStore.getActiveConfig()?.provider || 'openai';
      const presets = EMBEDDING_MODELS[p];
      embeddingModel = presets?.[0]?.model || '';
    }
  });

  const unsubFiles = filesStore.subscribe((s) => {
    knowledgeBases = s.knowledgeBases;
    const kb = s.knowledgeBases.find((k) => k.id === s.activeKnowledgeBaseId);
    const newPath = kb?.path || '';
    const newName = kb?.name || '';
    if (newPath !== activeKBPath) {
      activeKBPath = newPath;
      activeKBName = newName;
      if (newPath) loadStatus();
    }
  });

  async function loadStatus() {
    if (!activeKBPath) {
      indexStatus = null;
      return;
    }
    try {
      indexStatus = await getIndexStatus(activeKBPath);
    } catch {
      indexStatus = null;
    }
  }

  function handleProviderChange(e: Event) {
    const val = (e.target as HTMLSelectElement).value;
    // Auto-fill default model for the new provider
    const newProvider = val || aiStore.getActiveConfig()?.provider || 'openai';
    const presets = EMBEDDING_MODELS[newProvider];
    const defaultModel = presets?.[0]?.model || '';
    settingsStore.update({ embeddingProvider: val || null, embeddingModel: defaultModel });
    embeddingModel = defaultModel;
  }

  function handleModelChange(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    settingsStore.update({ embeddingModel: val });
  }

  function handleDimensionsChange(e: Event) {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    if (!isNaN(val) && val >= 64 && val <= 4096) {
      settingsStore.update({ embeddingDimensions: val });
    }
  }

  function handleAutoIndexChange(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    settingsStore.update({ autoIndexOnSave: checked });
  }

  async function handleReindex() {
    if (!activeKBPath || isIndexing) return;
    const config = getEmbeddingConfig();
    if (!config) return;

    isIndexing = true;
    try {
      indexStatus = await indexKnowledgeBase(activeKBPath, config);
    } catch (e) {
      console.error('[KB] Indexing failed:', e);
    } finally {
      isIndexing = false;
    }
  }

  async function handleDeleteIndex() {
    if (!activeKBPath) return;
    try {
      await deleteIndex(activeKBPath);
      indexStatus = null;
      await loadStatus();
    } catch (e) {
      console.error('[KB] Delete failed:', e);
    }
  }

  let progressUnlisten: UnlistenFn | null = null;

  function handleWindowClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    // Close dropdown when clicking outside .model-combo, but not on inline download buttons
    if (!target.closest('.model-combo') && !target.closest('.btn-inline-dl')) {
      showModelDropdown = false;
    }
  }

  onMount(async () => {
    window.addEventListener('click', handleWindowClick);
    loadStatus();
    progressUnlisten = await listen<{
      phase: string;
      current: number;
      total: number;
      file_name: string;
    }>('kb-index-progress', (event) => {
      progressPhase = event.payload.phase;
      progressCurrent = event.payload.current;
      progressTotal = event.payload.total;
      progressFileName = event.payload.file_name;
    });
    loadModels();
    downloadUnlisten = await listen<{
      model_id: string; received: number; total: number; progress: number;
    }>('model-download-progress', (event) => {
      if (event.payload.model_id === downloadingModelId) {
        downloadProgress = event.payload.progress;
      }
    });
  });

  // --------------- Local models ---------------
  interface LocalModel {
    id: string;
    name: string;
    dimensions: number;
    size: number;
    language: string;
    description: string;
    downloaded: boolean;
  }
  let localModels: LocalModel[] = $state([]);
  let downloadingModelId = $state('');
  let downloadProgress = $state(0);
  let downloadUnlisten: UnlistenFn | null = null;

  async function loadModels() {
    try {
      localModels = await invoke<LocalModel[]>('kb_list_local_models');
    } catch { /* ignore */ }
  }

  async function handleDownloadModel(modelId: string) {
    downloadingModelId = modelId;
    downloadProgress = 0;
    try {
      await invoke<string>('kb_download_model', { modelId });
      await loadModels();
    } catch (e: any) {
      console.error('[KB] Model download failed:', e);
    } finally {
      downloadingModelId = '';
      downloadProgress = 0;
    }
  }

  async function handleDeleteModel(modelId: string) {
    try {
      await invoke('kb_delete_model', { modelId });
      await loadModels();
    } catch (e: any) {
      console.error('[KB] Model delete failed:', e);
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }

  onDestroy(() => {
    unsubSettings();
    unsubFiles();
    progressUnlisten?.();
    downloadUnlisten?.();
    window.removeEventListener('click', handleWindowClick);
  });
</script>

<div class="kb-settings gx-tab">
  <!-- Knowledge Base Management -->
  <div class="kb-manage-section">
    <div class="kb-manage-row">
      <button class="kb-manage-btn" onclick={() => onOpenKBManager?.()}>
        {$t('knowledgeBase.manage')}
      </button>
      <span class="kb-count">{knowledgeBases.length} {$t('knowledgeBase.title').toLowerCase()}</span>
    </div>
  </div>

  <div class="section-divider"></div>

  <div class="setting-group">
    <label class="setting-label" for="kb-provider">{$t('kb.provider')}</label>
    <select id="kb-provider" class="setting-input" value={embeddingSource} onchange={(e) => {
      const val = (e.target as HTMLSelectElement).value as 'online' | 'local';
      embeddingSource = val;
      settingsStore.update({ embeddingProvider: val === 'local' ? 'local' : (embeddingProvider || null) });
    }}>
      {#each SOURCE_OPTIONS as opt}
        <option value={opt.value}>{$t(opt.labelKey)}</option>
      {/each}
    </select>
  </div>

  <div class="setting-group">
    <label class="setting-label" for="kb-model">{$t('kb.model')}</label>
    <div class="model-combo">
      <input
        id="kb-model"
        class="setting-input model-input"
        type="text"
        value={embeddingSource === 'local' ? (localModels.find(m => m.id === localEmbeddingModelId)?.name || '') : embeddingModel}
        placeholder={embeddingSource === 'local' ? $t('kb.selectLocalModel') : (availableModels[0]?.model || 'text-embedding-3-small')}
        onfocus={() => showModelDropdown = true}
        onblur={() => { setTimeout(() => { if (!document.activeElement?.closest('.model-combo')) showModelDropdown = false; }, 200); }}
        oninput={(e) => {
          if (embeddingSource !== 'local') {
            embeddingModel = (e.target as HTMLInputElement).value;
          }
          showModelDropdown = true;
        }}
        onchange={(e) => {
          if (embeddingSource !== 'local') handleModelChange(e);
        }}
        onkeydown={(e) => { if (e.key === 'Escape') showModelDropdown = false; }}
        readonly={embeddingSource === 'local'}
      />
      {#if showModelDropdown}
        <div class="model-dropdown">
          {#if embeddingSource === 'local'}
            <!-- Local models: downloaded ones selectable, others show download button -->
            {#each localModels as m}
              {#if m.downloaded}
                <button
                  class="model-option"
                  class:active={localEmbeddingModelId === m.id}
                  onmousedown={(e) => {
                    e.preventDefault();
                    localEmbeddingModelId = m.id;
                    settingsStore.update({ localEmbeddingModelId: m.id });
                    showModelDropdown = false;
                  }}
                >
                  <span class="model-name">{m.name}</span>
                  <span class="model-dim">{m.dimensions}d · ✓</span>
                </button>
              {:else}
                <div class="model-option model-not-downloaded">
                  <span class="model-name">{m.name}</span>
                  {#if downloadingModelId === m.id}
                    <span class="model-dim">{downloadProgress}%</span>
                  {:else}
                    <button class="btn-inline-dl" onmousedown={(e) => { e.preventDefault(); e.stopPropagation(); handleDownloadModel(m.id); }}>
                      {$t('kb.downloadModel')} ({formatSize(m.size)})
                    </button>
                  {/if}
                </div>
              {/if}
            {/each}
          {:else}
            <!-- Online models: grouped by provider -->
            {#each ONLINE_PROVIDERS as prov}
              {#if EMBEDDING_MODELS[prov]}
                <div class="model-group-label">{prov}</div>
                {#each EMBEDDING_MODELS[prov] as m}
                  <button
                    class="model-option"
                    class:active={embeddingModel === m.model && embeddingProvider === prov}
                    onmousedown={(e) => {
                      e.preventDefault();
                      embeddingModel = m.model;
                      embeddingProvider = prov;
                      settingsStore.update({ embeddingModel: m.model, embeddingProvider: prov });
                      showModelDropdown = false;
                    }}
                  >
                    <span class="model-name">{m.model}</span>
                    <span class="model-dim">max {m.maxDim}d</span>
                  </button>
                {/each}
              {/if}
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  </div>

  {#if embeddingSource !== 'local'}
  <div class="setting-group">
    <label class="setting-label" for="kb-dimensions">{$t('kb.dimensions')}</label>
    <input
      id="kb-dimensions"
      class="setting-input"
      type="number"
      min="64"
      max="4096"
      step="64"
      value={embeddingDimensions}
      onchange={handleDimensionsChange}
    />
    {#if showDimWarning}
      <div class="dim-warning">
        {$t('kb.dimensionWarning').replace('{max}', String(maxDim)).replace('{actual}', String(effectiveDim))}
      </div>
    {/if}
  </div>
  {/if}

  <div class="setting-group">
    <label class="setting-label setting-checkbox">
      <input type="checkbox" checked={autoIndexOnSave} onchange={handleAutoIndexChange} />
      {$t('kb.autoIndex')}
    </label>
  </div>

  {#if activeKBPath}
    <div class="kb-status-section">
      <div class="section-title">{activeKBName}</div>

      {#if indexStatus?.indexed}
        <div class="status-text">
          {$t('kb.status.indexed')
            .replace('{chunks}', String(indexStatus.chunkCount))
            .replace('{files}', String(indexStatus.fileCount))}
        </div>
        {#if indexStatus.lastUpdated}
          <div class="status-meta">{new Date(indexStatus.lastUpdated).toLocaleString()}</div>
        {/if}
        {#if indexStatus.staleFiles.length > 0}
          <div class="status-stale">
            {$t('kb.status.stale').replace('{count}', String(indexStatus.staleFiles.length))}
          </div>
        {/if}
      {:else}
        <div class="status-text">{$t('kb.status.notIndexed')}</div>
      {/if}

      {#if isIndexing}
        <div class="progress-section">
          <div class="progress-text">
            {#if progressPhase === 'scanning'}
              {$t('kb.progress.scanning')}
            {:else if progressPhase === 'chunking'}
              {$t('kb.progress.chunking').replace('{current}', String(progressCurrent)).replace('{total}', String(progressTotal))}
            {:else if progressPhase === 'embedding'}
              {$t('kb.progress.embedding').replace('{current}', String(progressCurrent)).replace('{total}', String(progressTotal))}
            {:else if progressPhase === 'indexing'}
              {$t('kb.progress.indexing')}
            {:else if progressPhase === 'done'}
              {$t('kb.progress.done')}
            {/if}
          </div>
          {#if progressTotal > 0}
            <div class="progress-bar">
              <div class="progress-fill" style="width: {(progressCurrent / progressTotal) * 100}%"></div>
            </div>
          {/if}
        </div>
      {/if}

      <div class="action-buttons">
        <button class="btn btn-primary" onclick={handleReindex} disabled={isIndexing}>
          {$t('kb.reindexAll')}
        </button>
        {#if indexStatus?.indexed}
          <button class="btn btn-danger" onclick={handleDeleteIndex} disabled={isIndexing}>
            {$t('kb.deleteIndex')}
          </button>
        {/if}
      </div>
    </div>
  {/if}

  {#if localModels.length > 0}
    <div class="section-divider"></div>
    <div class="local-models-section">
      <div class="section-title">{$t('kb.localModels')}</div>
      {#each localModels as model}
        <div class="model-row">
          <div class="model-info">
            <div class="model-name-row">
              <span class="model-model-name">{model.name}</span>
              <span class="model-lang-tag" class:lang-multilingual={model.language === 'multilingual'} class:lang-chinese={model.language === 'chinese'} class:lang-english={model.language === 'english'}>
                {model.language}
              </span>
            </div>
            <div class="model-meta">{model.dimensions}d · {formatSize(model.size)}</div>
          </div>
          <div class="model-actions">
            {#if model.downloaded}
              <span class="model-installed">✓</span>
              <button class="btn-icon btn-delete-model" onclick={() => handleDeleteModel(model.id)} title={$t('kb.deleteModel')}>✕</button>
            {:else if downloadingModelId === model.id}
              <div class="model-dl-progress">
                <div class="model-dl-bar">
                  <div class="model-dl-fill" style="width: {downloadProgress}%"></div>
                </div>
                <span class="model-dl-pct">{downloadProgress}%</span>
              </div>
            {:else}
              <button class="btn btn-sm" onclick={() => handleDownloadModel(model.id)}>{$t('kb.downloadModel')}</button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Outer layout: .gx-tab on root. */

  .kb-manage-section {
    display: flex;
    align-items: center;
  }

  .kb-manage-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .kb-manage-btn {
    padding: 4px 12px;
    border: 1px solid var(--border-color);
    border-radius: 5px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: inherit;
    cursor: pointer;
    transition: background 0.1s ease, border-color 0.1s ease;
  }

  .kb-manage-btn:hover {
    background: var(--bg-hover);
  }

  .kb-count {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }

  .section-divider {
    height: 1px;
    background: var(--border-color);
    margin: 4px 0;
  }

  .model-combo {
    position: relative;
  }

  .model-input {
    width: 100%;
    box-sizing: border-box;
  }

  .model-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 2px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 10;
    max-height: 180px;
    overflow-y: auto;
  }

  .model-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 6px 10px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    text-align: left;
  }

  .model-option:hover,
  .model-option.active {
    background: var(--bg-hover);
  }

  .model-name {
    font-family: monospace;
  }

  .model-dim {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    flex-shrink: 0;
    margin-left: 8px;
  }

  .model-group-label {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 6px 10px 2px;
    letter-spacing: 0.5px;
  }

  .model-not-downloaded {
    opacity: 0.7;
    cursor: default;
  }

  .btn-inline-dl {
    border: 1px solid var(--accent-color, #4a9eff);
    background: transparent;
    color: var(--accent-color, #4a9eff);
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 3px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .btn-inline-dl:hover {
    background: var(--accent-color, #4a9eff);
    color: white;
  }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .setting-label {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  .setting-input {
    padding: 6px 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }

  .setting-checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .dim-warning {
    font-size: var(--font-size-xs);
    color: var(--text-warning, #e0a800);
    margin-top: 4px;
  }

  .kb-status-section {
    margin-top: 8px;
    padding: 12px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .section-title {
    font-weight: 600;
    font-size: var(--font-size-sm);
    margin-bottom: 8px;
  }

  .status-text {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }

  .status-meta {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    margin-top: 2px;
  }

  .status-stale {
    font-size: var(--font-size-xs);
    color: var(--text-warning, #e0a800);
    margin-top: 4px;
  }

  .progress-section {
    margin-top: 8px;
  }

  .progress-text {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    margin-bottom: 4px;
  }

  .progress-bar {
    height: 4px;
    background: var(--border-color);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent-color, #4a9eff);
    transition: width 0.3s ease;
  }

  .action-buttons {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .btn {
    padding: 6px 14px;
    border: none;
    border-radius: 4px;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--accent-color, #4a9eff);
    color: white;
  }

  .btn-danger {
    background: transparent;
    border: 1px solid var(--text-danger, #e53e3e);
    color: var(--text-danger, #e53e3e);
  }

  .local-models-section {
    margin-top: 4px;
  }

  .model-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--border-light, #eee);
    gap: 8px;
  }

  .model-info {
    flex: 1;
    min-width: 0;
  }

  .model-name-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .model-model-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
  }

  .model-lang-tag {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .lang-multilingual { background: #e8f5e9; color: #2e7d32; }
  .lang-chinese { background: #fff3e0; color: #e65100; }
  .lang-english { background: #e3f2fd; color: #1565c0; }

  .model-meta {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    margin-top: 2px;
  }

  .model-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .model-installed {
    color: var(--color-success, #38a169);
    font-size: 14px;
    font-weight: bold;
  }

  .btn-icon {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 12px;
    color: var(--text-secondary);
    padding: 2px 4px;
    border-radius: 3px;
  }

  .btn-icon:hover {
    background: var(--bg-hover);
    color: var(--text-danger, #e53e3e);
  }

  .btn-sm {
    padding: 3px 10px;
    border: 1px solid var(--accent-color, #4a9eff);
    border-radius: 4px;
    background: transparent;
    color: var(--accent-color, #4a9eff);
    font-size: var(--font-size-xs);
    cursor: pointer;
  }

  .btn-sm:hover {
    background: var(--accent-color, #4a9eff);
    color: white;
  }

  .model-dl-progress {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .model-dl-bar {
    width: 60px;
    height: 4px;
    background: var(--border-light);
    border-radius: 2px;
    overflow: hidden;
  }

  .model-dl-fill {
    height: 100%;
    background: var(--accent-color, #4a9eff);
    transition: width 0.3s ease;
  }

  .model-dl-pct {
    font-size: 10px;
    color: var(--text-secondary);
    min-width: 30px;
  }
</style>

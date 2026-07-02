<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import { aiStore } from '$lib/services/ai';
  import type { PublishTarget } from '$lib/services/publish/types';
  import type { SEOData, AIProviderConfig } from '$lib/services/ai/types';
  import { generateSEOData } from '$lib/services/ai/seo-service';

  let {
    onClose,
    onConfirm,
    currentSEOData,
    onSEODataChange,
    documentContent = '',
  }: {
    onClose: () => void;
    onConfirm: (targetIds: string[]) => void;
    currentSEOData?: SEOData | null;
    onSEODataChange?: (data: SEOData) => void;
    documentContent?: string;
  } = $props();

  const tr = $t;

  let targets = $state<PublishTarget[]>([]);
  let selectedIds = $state<Set<string>>(new Set());

  // SEO state
  // svelte-ignore state_referenced_locally
  let enableSEO = $state(!!currentSEOData);
  let stage = $state<'targets' | 'seo'>('targets');
  // svelte-ignore state_referenced_locally
  let seoData = $state<SEOData>(currentSEOData ?? {
    titles: [],
    selectedTitle: '',
    excerpt: '',
    tags: [],
    metaDescription: '',
    slug: '',
  });
  let seoLoading = $state(false);
  let seoError = $state<string | null>(null);
  let tagInput = $state('');

  // Top-level store subscription — do NOT wrap in $effect().
  settingsStore.subscribe(state => {
    targets = state.publishTargets || [];
  });

  function toggleTarget(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    selectedIds = next;
  }

  function handleNext() {
    if (selectedIds.size === 0) return;
    if (enableSEO) {
      stage = 'seo';
      if (seoData.titles.length === 0 && !seoLoading) {
        handleGenerateSEO();
      }
    } else {
      onConfirm(Array.from(selectedIds));
    }
  }

  function handleBack() {
    stage = 'targets';
  }

  let aiProviderConfig = $state<AIProviderConfig | null>(null);
  aiStore.subscribe(state => {
    aiProviderConfig = state.providerConfigs.find(c => c.id === state.activeConfigId) || null;
  });

  async function handleGenerateSEO() {
    seoLoading = true;
    seoError = null;
    try {
      if (!aiProviderConfig || !aiProviderConfig.apiKey) {
        seoError = tr('publish.seoNoProvider');
        return;
      }
      const data = await generateSEOData(aiProviderConfig, documentContent);
      seoData = data;
    } catch (e) {
      seoError = e instanceof Error ? e.message : String(e);
    } finally {
      seoLoading = false;
    }
  }

  function handlePublish() {
    if (enableSEO) {
      onSEODataChange?.(seoData);
    }
    onConfirm(Array.from(selectedIds));
  }

  function selectTitle(title: string) {
    seoData = { ...seoData, selectedTitle: title };
  }

  function addTag() {
    const tag = tagInput.trim();
    if (tag && !seoData.tags.includes(tag)) {
      seoData = { ...seoData, tags: [...seoData.tags, tag] };
    }
    tagInput = '';
  }

  function removeTag(tag: string) {
    seoData = { ...seoData, tags: seoData.tags.filter(t => t !== tag) };
  }

  function handleTagKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag();
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onclick={onClose}>
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    {#if stage === 'targets'}
      <!-- Stage 1: Select publish targets -->
      <div class="dialog-header">
        <h3>{tr('workflow.selectTargets')}</h3>
        <button class="close-btn" onclick={onClose}>×</button>
      </div>

      <div class="dialog-body">
        {#if targets.length === 0}
          <div class="empty-state">
            <p>{tr('publish.settingsEmpty')}</p>
            <p class="hint">{tr('publish.settingsHint')}</p>
          </div>
        {:else}
          <div class="target-list">
            {#each targets as target (target.id)}
              <label class="target-item" for="target-{target.id}">
                <input
                  type="checkbox"
                  id="target-{target.id}"
                  checked={selectedIds.has(target.id)}
                  onchange={() => toggleTarget(target.id)}
                />
                <span class="target-icon">
                  {target.type === 'github' ? '🔵' : '🟣'}
                </span>
                <div class="target-info">
                  <span class="target-name">{target.name || '(unnamed)'}</span>
                  <span class="target-type">
                    {target.type === 'github' ? tr('publish.github') : tr('publish.customApi')}
                  </span>
                </div>
              </label>
            {/each}
          </div>

          <div class="seo-toggle">
            <label class="seo-checkbox" for="seo-enable">
              <input type="checkbox" id="seo-enable" bind:checked={enableSEO} />
              <span>{tr('publish.enableSEO')}</span>
            </label>
            <span class="seo-hint">{tr('publish.enableSEOHint')}</span>
          </div>
        {/if}
      </div>

      <div class="dialog-footer">
        <button class="btn btn-secondary" onclick={onClose}>{tr('common.cancel')}</button>
        <button
          class="btn btn-primary"
          onclick={handleNext}
          disabled={selectedIds.size === 0}
        >
          {enableSEO ? tr('publish.nextSEO') : tr('workflow.confirmPublish')}
        </button>
      </div>
    {:else}
      <!-- Stage 2: SEO form -->
      <div class="dialog-header">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span class="back-btn" onclick={handleBack}>← {tr('publish.backToTargets')}</span>
        <h3>{tr('menu.seoOptimization')}</h3>
        <button class="close-btn" onclick={onClose}>×</button>
      </div>

      <div class="dialog-body seo-body">
        {#if seoLoading}
          <div class="seo-loading">
            <span class="spinner"></span>
            <span>{tr('ai.generating')}</span>
          </div>
        {:else if seoError}
          <div class="seo-error">
            <p>{seoError}</p>
            <button class="btn btn-secondary" onclick={handleGenerateSEO}>{tr('common.retry')}</button>
          </div>
        {:else}
          <!-- Title suggestions -->
          <div class="seo-field">
            <label class="field-label" for="seo-titles">{tr('seo.titles')}</label>
            {#each seoData.titles as title, i}
              <label class="title-option" for="seo-title-{i}">
                <input
                  type="radio"
                  id="seo-title-{i}"
                  name="seo-title"
                  checked={seoData.selectedTitle === title}
                  onchange={() => selectTitle(title)}
                />
                <span>{title}</span>
              </label>
            {/each}
            <input
              type="text"
              class="form-input"
              id="seo-titles"
              placeholder={tr('seo.customTitle')}
              value={seoData.selectedTitle}
              oninput={(e) => { seoData = { ...seoData, selectedTitle: (e.target as HTMLInputElement).value }; }}
            />
          </div>

          <!-- Excerpt -->
          <div class="seo-field">
            <label class="field-label" for="seo-excerpt">{tr('seo.excerpt')}</label>
            <textarea
              class="form-input seo-textarea"
              id="seo-excerpt"
              maxlength="120"
              value={seoData.excerpt}
              oninput={(e) => { seoData = { ...seoData, excerpt: (e.target as HTMLTextAreaElement).value }; }}
            ></textarea>
            <span class="char-count">{seoData.excerpt.length}/120</span>
          </div>

          <!-- Tags -->
          <div class="seo-field">
            <label class="field-label" for="seo-tags">{tr('seo.tags')}</label>
            <div class="tags-container">
              {#each seoData.tags as tag}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span class="tag">
                  {tag}
                  <span class="tag-remove" onclick={() => removeTag(tag)}>×</span>
                </span>
              {/each}
              <input
                type="text"
                class="tag-input"
                id="seo-tags"
                placeholder={tr('seo.addTag')}
                bind:value={tagInput}
                onkeydown={handleTagKeydown}
              />
            </div>
          </div>

          <!-- Slug -->
          <div class="seo-field">
            <label class="field-label" for="seo-slug">{tr('seo.slug')}</label>
            <input
              type="text"
              class="form-input"
              id="seo-slug"
              value={seoData.slug}
              oninput={(e) => { seoData = { ...seoData, slug: (e.target as HTMLInputElement).value }; }}
            />
          </div>

          <!-- Meta Description -->
          <div class="seo-field">
            <label class="field-label" for="seo-meta">{tr('seo.metaDescription')}</label>
            <textarea
              class="form-input seo-textarea"
              id="seo-meta"
              maxlength="160"
              value={seoData.metaDescription}
              oninput={(e) => { seoData = { ...seoData, metaDescription: (e.target as HTMLTextAreaElement).value }; }}
            ></textarea>
            <span class="char-count">{seoData.metaDescription.length}/160</span>
          </div>
        {/if}
      </div>

      <div class="dialog-footer">
        <button class="btn btn-secondary" onclick={handleGenerateSEO} disabled={seoLoading}>
          {tr('seo.regenerate')}
        </button>
        <button
          class="btn btn-primary"
          onclick={handlePublish}
          disabled={seoLoading}
        >
          {tr('workflow.confirmPublish')}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    width: 420px;
    max-height: 80vh;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }

  .dialog-header h3 {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
  }

  .close-btn {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1.1rem;
  }

  .back-btn {
    font-size: var(--font-size-xs);
    color: var(--accent-color);
    cursor: pointer;
    white-space: nowrap;
  }

  .back-btn:hover {
    text-decoration: underline;
  }

  .dialog-body {
    padding: 0.75rem 1rem;
    max-height: 300px;
    overflow-y: auto;
    flex: 1;
  }

  .seo-body {
    max-height: 50vh;
  }

  .empty-state {
    text-align: center;
    padding: 1.5rem;
    color: var(--text-muted);
  }

  .empty-state p {
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .empty-state .hint {
    font-size: var(--font-size-xs);
    margin-top: 0.5rem;
  }

  .target-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .target-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color var(--transition-fast);
  }

  .target-item:hover {
    border-color: var(--accent-color);
  }

  .target-item input[type="checkbox"] {
    accent-color: var(--accent-color);
  }

  .target-icon {
    font-size: 0.85rem;
  }

  .target-info {
    display: flex;
    flex-direction: column;
  }

  .target-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
  }

  .target-type {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  /* SEO toggle */
  .seo-toggle {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-light);
  }

  .seo-checkbox {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .seo-checkbox input {
    accent-color: var(--accent-color);
  }

  .seo-hint {
    display: block;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-top: 0.2rem;
    margin-left: 1.4rem;
  }

  /* SEO form fields */
  .seo-field {
    margin-bottom: 0.75rem;
  }

  .field-label {
    display: block;
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 0.25rem;
  }

  .form-input {
    width: 100%;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    box-sizing: border-box;
  }

  .seo-textarea {
    min-height: 48px;
    resize: vertical;
    font-family: inherit;
  }

  .char-count {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    text-align: right;
    display: block;
    margin-top: 0.15rem;
  }

  .title-option {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--font-size-sm);
    padding: 0.2rem 0;
    cursor: pointer;
  }

  .title-option input[type="radio"] {
    accent-color: var(--accent-color);
  }

  /* Tags */
  .tags-container {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    padding: 0.3rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    min-height: 32px;
    align-items: center;
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    padding: 0.1rem 0.4rem;
    background: var(--bg-hover);
    border-radius: 3px;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }

  .tag-remove {
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .tag-remove:hover {
    color: var(--text-primary);
  }

  .tag-input {
    flex: 1;
    min-width: 60px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    outline: none;
    padding: 0.1rem;
  }

  /* Loading / Error */
  .seo-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-color);
    border-top-color: var(--accent-color);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .seo-error {
    text-align: center;
    padding: 1rem;
    color: var(--color-error, #e53e3e);
    font-size: var(--font-size-sm);
  }

  .seo-error p {
    margin: 0 0 0.5rem;
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .btn {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-sm);
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .btn-secondary {
    background: var(--bg-primary);
    color: var(--text-secondary);
  }

  .btn-primary {
    background: var(--accent-color);
    color: white;
    border-color: var(--accent-color);
  }

  .btn-primary:disabled,
  .btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

<script lang="ts">
  import { t } from '$lib/i18n';
  import { aiStore } from '$lib/services/ai';
  import { generateSEOData } from '$lib/services/ai/seo-service';
  import type { SEOData, AIProviderConfig } from '$lib/services/ai/types';
  import { editorStore } from '$lib/stores/editor-store';

  let {
    onClose,
    onApply,
  }: {
    onClose: () => void;
    onApply: (data: SEOData) => void;
  } = $props();

  const tr = $t;

  let seoData = $state<SEOData | null>(null);
  let isLoading = $state(false);
  let error = $state<string | null>(null);
  let providerConfig = $state<AIProviderConfig | null>(null);

  aiStore.subscribe(state => {
    providerConfig = state.providerConfigs.find(c => c.id === state.activeConfigId) || null;
  });

  async function generate() {
    if (!providerConfig || !providerConfig.apiKey) {
      error = tr('errors.aiNotConfigured');
      return;
    }

    const content = editorStore.getState().content;
    if (!content || content.trim().length < 50) {
      error = tr('seo.contentTooShort');
      return;
    }

    isLoading = true;
    error = null;

    try {
      seoData = await generateSEOData(providerConfig, content);
    } catch (e) {
      error = e instanceof Error ? e.message : 'SEO generation failed';
    } finally {
      isLoading = false;
    }
  }

  function handleTitleSelect(title: string) {
    if (!seoData) return;
    seoData = { ...seoData, selectedTitle: title };
  }

  function handleCustomTitle(event: Event) {
    if (!seoData) return;
    seoData = { ...seoData, selectedTitle: (event.target as HTMLInputElement).value };
  }

  function removeTag(tag: string) {
    if (!seoData) return;
    seoData = { ...seoData, tags: seoData.tags.filter(t => t !== tag) };
  }

  function addTag(event: KeyboardEvent) {
    if (event.key !== 'Enter' || !seoData) return;
    const input = event.target as HTMLInputElement;
    const tag = input.value.trim();
    if (tag && !seoData.tags.includes(tag)) {
      seoData = { ...seoData, tags: [...seoData.tags, tag] };
      input.value = '';
    }
  }

  function handleApply() {
    if (seoData) {
      onApply(seoData);
    }
  }

  // Auto-generate on mount
  generate();
</script>

<div class="seo-panel">
  <div class="panel-header">
    <h3>{tr('seo.title')}</h3>
    <button class="close-btn" onclick={onClose} aria-label="Close">
      <svg width="12" height="12" viewBox="0 0 10 10">
        <path fill="currentColor" d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z"/>
      </svg>
    </button>
  </div>

  <div class="panel-body">
    {#if isLoading}
      <div class="loading-state">
        <span class="spinner"></span>
        <span>{tr('seo.generating')}</span>
      </div>
    {:else if error}
      <div class="error-state">
        <p>{error}</p>
        <button class="btn btn-retry" onclick={generate}>{tr('seo.retry')}</button>
      </div>
    {:else if seoData}
      <!-- Titles -->
      <div class="seo-section">
        <label class="section-label" for="seo-custom-title">{tr('seo.titles')}</label>
        <div class="title-options">
          {#each seoData.titles as title, i}
            <label class="title-option">
              <input
                type="radio"
                name="seo-title"
                checked={seoData.selectedTitle === title}
                onchange={() => handleTitleSelect(title)}
              />
              <span>{title}</span>
            </label>
          {/each}
          <input
            id="seo-custom-title"
            type="text"
            class="custom-title-input"
            value={seoData.selectedTitle}
            oninput={handleCustomTitle}
            placeholder={tr('seo.customTitle')}
          />
        </div>
      </div>

      <!-- Excerpt -->
      <div class="seo-section">
        <label class="section-label" for="seo-excerpt">
          {tr('seo.excerpt')}
          <span class="char-count">{seoData.excerpt.length}/120</span>
        </label>
        <textarea
          id="seo-excerpt"
          class="seo-textarea"
          bind:value={seoData.excerpt}
          rows="2"
          maxlength="120"
        ></textarea>
      </div>

      <!-- Tags -->
      <div class="seo-section">
        <label class="section-label" for="seo-tag-input">{tr('seo.tags')}</label>
        <div class="tags-container">
          {#each seoData.tags as tag}
            <span class="tag-chip">
              {tag}
              <button class="tag-remove" onclick={() => removeTag(tag)}>×</button>
            </span>
          {/each}
          <input
            id="seo-tag-input"
            type="text"
            class="tag-input"
            placeholder={tr('seo.addTag')}
            onkeydown={addTag}
          />
        </div>
      </div>

      <!-- Slug -->
      <div class="seo-section">
        <label class="section-label" for="seo-slug">{tr('seo.slug')}</label>
        <input id="seo-slug" type="text" class="seo-input" bind:value={seoData.slug} />
      </div>

      <!-- Meta Description -->
      <div class="seo-section">
        <label class="section-label" for="seo-meta-desc">
          {tr('seo.metaDescription')}
          <span class="char-count">{seoData.metaDescription.length}/160</span>
        </label>
        <textarea
          id="seo-meta-desc"
          class="seo-textarea"
          bind:value={seoData.metaDescription}
          rows="2"
          maxlength="160"
        ></textarea>
      </div>
    {/if}
  </div>

  {#if seoData && !isLoading}
    <div class="panel-footer">
      <button class="btn btn-secondary" onclick={generate}>
        ↻ {tr('seo.regenerate')}
      </button>
      <button class="btn btn-primary" onclick={handleApply}>
        {tr('seo.apply')}
      </button>
    </div>
  {/if}
</div>

<style>
  .seo-panel {
    position: fixed;
    bottom: 28px; /* above StatusBar */
    left: 0;
    right: 0;
    max-height: 50vh;
    background: var(--bg-primary);
    border-top: 1px solid var(--border-color);
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.1);
    z-index: 50;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.2s ease-out;
  }

  @keyframes slideUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }

  .panel-header h3 {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: 3px;
  }

  .close-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    gap: 0.75rem;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-color);
    border-top-color: var(--accent-color);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .seo-section {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .section-label {
    font-size: var(--font-size-xs);
    font-weight: 500;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .char-count {
    font-weight: 400;
    color: var(--text-muted);
  }

  .title-options {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .title-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
  }

  .title-option input[type="radio"] {
    accent-color: var(--accent-color);
  }

  .custom-title-input {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }

  .custom-title-input:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .seo-textarea {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    resize: vertical;
    font-family: var(--font-sans);
    line-height: 1.4;
  }

  .seo-textarea:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .seo-input {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: var(--font-mono, monospace);
  }

  .seo-input:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .tags-container {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
  }

  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.15rem 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-light);
    border-radius: 12px;
    font-size: var(--font-size-xs);
    color: var(--text-primary);
  }

  .tag-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.75rem;
    border-radius: 50%;
    padding: 0;
  }

  .tag-remove:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .tag-input {
    padding: 0.15rem 0.4rem;
    border: 1px dashed var(--border-color);
    border-radius: 12px;
    background: transparent;
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    width: 80px;
  }

  .tag-input:focus {
    outline: none;
    border-color: var(--accent-color);
    border-style: solid;
  }

  .panel-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .btn {
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-sm);
    transition: all var(--transition-fast);
  }

  .btn-secondary {
    background: var(--bg-primary);
    color: var(--text-secondary);
  }

  .btn-secondary:hover {
    color: var(--text-primary);
  }

  .btn-primary {
    background: var(--accent-color);
    color: white;
    border-color: var(--accent-color);
  }

  .btn-primary:hover {
    opacity: 0.9;
  }

  .btn-retry {
    background: transparent;
    color: var(--accent-color);
    border-color: var(--accent-color);
  }

  .btn-retry:hover {
    background: var(--accent-color);
    color: white;
  }
</style>

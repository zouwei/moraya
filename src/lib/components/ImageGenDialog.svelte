<script lang="ts">
  import { t } from '$lib/i18n';
  import { aiStore } from '$lib/services/ai';
  import { settingsStore } from '$lib/stores/settings-store';
  import { editorStore } from '$lib/stores/editor-store';
  import {
    generateImagePrompts,
    generateImage,
    MODE_STYLES,
    type ImagePrompt,
    type ImageStyle,
    type ImageGenerationResult,
    type ImageGenMode,
  } from '$lib/services/ai/image-service';
  import type { AIProviderConfig, ImageProviderConfig, ImageAspectRatio, ImageSizeLevel } from '$lib/services/ai/types';
  import { resolveImageSize, IMAGE_SIZE_MAP } from '$lib/services/ai/types';

  let {
    onClose,
    onInsert,
  }: {
    onClose: () => void;
    onInsert: (images: { url: string; target: number }[], mode: InsertMode) => void;
  } = $props();

  type InsertMode = 'paragraph' | 'end' | 'clipboard';

  const tr = $t;

  let step = $state(1);
  let textAIConfig = $state<AIProviderConfig | null>(null);
  let imageConfig = $state<ImageProviderConfig | null>(null);

  // Step 1 state
  let prompts = $state<ImagePrompt[]>([]);
  let imageCount = $state(3);
  let imageStyle = $state<ImageStyle>('auto');
  let imageMode = $state<ImageGenMode>('article');
  let isGeneratingPrompts = $state(false);
  let promptError = $state<string | null>(null);
  const MODE_OPTIONS: ImageGenMode[] = ['article', 'design', 'storyboard', 'product', 'moodboard'];

  // Image size overrides (default from settings, user can change per-session)
  let imgRatio = $state<ImageAspectRatio>('16:9');
  let imgSizeLevel = $state<ImageSizeLevel>('medium');
  const RATIO_OPTIONS: ImageAspectRatio[] = ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'];
  const SIZE_LEVEL_OPTIONS: ImageSizeLevel[] = ['large', 'medium', 'small'];
  let imgResolvedSize = $derived(resolveImageSize(imgRatio, imgSizeLevel));
  let imgCssAspectRatio = $derived(imgRatio.replace(':', '/'));
  let availableStyles = $derived(MODE_STYLES[imageMode] || MODE_STYLES.article);

  // Step 2 state
  let generatedImages = $state<(ImageGenerationResult & { promptIdx: number; selected: boolean; loading: boolean; error?: string })[]>([]);
  let isGeneratingImages = $state(false);

  // Step 3 state
  let insertMode = $state<InsertMode>('paragraph');

  aiStore.subscribe(state => {
    textAIConfig = state.providerConfig;
  });

  settingsStore.subscribe(state => {
    imageConfig = state.imageProviderConfig;
    if (state.imageProviderConfig) {
      imgRatio = state.imageProviderConfig.defaultRatio;
      imgSizeLevel = state.imageProviderConfig.defaultSizeLevel;
    }
  });

  // Step 1: Generate prompts
  async function handleGeneratePrompts() {
    if (!textAIConfig?.apiKey) {
      promptError = tr('errors.aiNotConfigured');
      return;
    }

    const content = editorStore.getState().content;
    if (!content || content.trim().length < 50) {
      promptError = tr('imageGen.contentTooShort');
      return;
    }

    isGeneratingPrompts = true;
    promptError = null;

    try {
      prompts = await generateImagePrompts(textAIConfig, content, imageCount, imageStyle, imageMode);
    } catch (e) {
      promptError = e instanceof Error ? e.message : 'Failed to generate prompts';
    } finally {
      isGeneratingPrompts = false;
    }
  }

  function removePrompt(idx: number) {
    prompts = prompts.filter((_, i) => i !== idx);
  }

  function goToStep2() {
    if (prompts.length === 0) return;
    step = 2;
    startImageGeneration();
  }

  // Step 2: Generate images
  async function startImageGeneration() {
    if (!imageConfig?.apiKey) return;

    generatedImages = prompts.map((_, i) => ({
      url: '',
      promptIdx: i,
      selected: true,
      loading: true,
    }));
    isGeneratingImages = true;

    // Generate images sequentially to avoid API rate limiting
    for (let i = 0; i < prompts.length; i++) {
      try {
        const result = await generateImage(imageConfig!, prompts[i].prompt, imgResolvedSize);
        generatedImages[i] = {
          ...generatedImages[i],
          url: result.url,
          revisedPrompt: result.revisedPrompt,
          loading: false,
        };
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error('[ImageGen] Image generation failed for prompt', i, errMsg, e);
        generatedImages[i] = {
          ...generatedImages[i],
          loading: false,
          error: errMsg || 'Generation failed',
        };
      }
      generatedImages = [...generatedImages];
    }

    isGeneratingImages = false;
  }

  async function regenerateImage(idx: number) {
    if (!imageConfig?.apiKey) return;
    generatedImages[idx] = { ...generatedImages[idx], loading: true, error: undefined };
    generatedImages = [...generatedImages];

    try {
      const result = await generateImage(imageConfig, prompts[idx].prompt, imgResolvedSize);
      generatedImages[idx] = {
        ...generatedImages[idx],
        url: result.url,
        revisedPrompt: result.revisedPrompt,
        loading: false,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error('[ImageGen] Regeneration failed for', idx, errMsg, e);
      generatedImages[idx] = {
        ...generatedImages[idx],
        loading: false,
        error: errMsg || 'Regeneration failed',
      };
    }
    generatedImages = [...generatedImages];
  }

  function toggleImageSelection(idx: number) {
    generatedImages[idx].selected = !generatedImages[idx].selected;
    generatedImages = [...generatedImages];
  }

  function goToStep3() {
    const hasSelected = generatedImages.some(img => img.selected && img.url);
    if (!hasSelected) return;
    step = 3;
  }

  // Step 3: Insert
  function handleInsert() {
    const selected = generatedImages
      .filter(img => img.selected && img.url)
      .map(img => ({
        url: img.url,
        target: prompts[img.promptIdx]?.target ?? 0,
      }));

    if (insertMode === 'clipboard') {
      const md = selected.map(img => `![](${img.url})`).join('\n\n');
      navigator.clipboard.writeText(md);
      onClose();
      return;
    }

    onInsert(selected, insertMode);
  }

  let hasInitialized = false;
  $effect(() => {
    // Auto-generate prompts on first mount only
    if (!hasInitialized) {
      hasInitialized = true;
      handleGeneratePrompts();
    }
  });

  const selectedCount = $derived(generatedImages.filter(img => img.selected && img.url).length);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onclick={onClose}>
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    <!-- Header -->
    <div class="dialog-header">
      <h3>{tr('imageGen.title')}</h3>
      <button class="close-btn" onclick={onClose}>×</button>
    </div>

    <!-- Step indicator -->
    <div class="step-indicator">
      <span class="step" class:active={step >= 1} class:done={step > 1}>1</span>
      <span class="step-line" class:active={step > 1}></span>
      <span class="step" class:active={step >= 2} class:done={step > 2}>2</span>
      <span class="step-line" class:active={step > 2}></span>
      <span class="step" class:active={step >= 3}>3</span>
    </div>

    <!-- Content -->
    <div class="dialog-body">
      {#if step === 1}
        <!-- Step 1: Prompts -->
        <div class="step-content">
          <!-- Row 1: Title + Mode pills + Style dropdown -->
          <div class="mode-row">
            <h4 class="mode-label">{tr('imageGen.step1Title')}</h4>
            {#each MODE_OPTIONS as m}
              <button
                class="mode-btn"
                class:active={imageMode === m}
                onclick={() => { imageMode = m; imageStyle = 'auto'; prompts = []; handleGeneratePrompts(); }}
              >
                {tr(`imageGen.mode_${m}`)}
              </button>
            {/each}
            <div class="mode-row-spacer"></div>
            <label class="mini-label">{tr('imageGen.styleLabel')}</label>
            <select class="mini-select style-select" bind:value={imageStyle} onchange={() => { prompts = []; handleGeneratePrompts(); }}>
              {#each availableStyles as s}
                <option value={s}>{tr(`imageGen.style_${s}`)}</option>
              {/each}
            </select>
          </div>

          <!-- Row 3: Ratio + Resolution + Count -->
          <div class="step-header">
            <div class="step-controls">
              <label class="mini-label">{tr('ai.imageConfig.ratio')}</label>
              <select class="mini-select" bind:value={imgRatio}>
                {#each RATIO_OPTIONS as r}
                  <option value={r}>{r}</option>
                {/each}
              </select>
              <label class="mini-label">{tr('ai.imageConfig.sizeLevel')}</label>
              <select class="mini-select" bind:value={imgSizeLevel}>
                {#each SIZE_LEVEL_OPTIONS as s}
                  <option value={s}>{tr(`ai.imageConfig.size_${s}`)}</option>
                {/each}
              </select>
              <span class="mini-hint">{imgResolvedSize}</span>
            </div>
            <div class="step-controls">
              <label class="mini-label">{tr('imageGen.countLabel')}</label>
              <select class="mini-select style-select" bind:value={imageCount} onchange={() => { prompts = []; handleGeneratePrompts(); }}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
                <option value={5}>5</option>
              </select>
            </div>
          </div>

          {#if isGeneratingPrompts}
            <div class="loading-state">
              <span class="spinner"></span>
              <span>{tr('imageGen.generatingPrompts')}</span>
            </div>
          {:else if promptError}
            <div class="error-state">
              <p>{promptError}</p>
              <button class="btn btn-retry" onclick={handleGeneratePrompts}>{tr('seo.retry')}</button>
            </div>
          {:else}
            <div class="prompt-list">
              {#each prompts as prompt, i}
                <div class="prompt-card">
                  <div class="prompt-header">
                    <span class="prompt-reason">{prompt.reason}</span>
                    <button class="prompt-remove" onclick={() => removePrompt(i)}>×</button>
                  </div>
                  <textarea
                    class="prompt-text"
                    bind:value={prompt.prompt}
                    rows="2"
                  ></textarea>
                </div>
              {/each}
            </div>
          {/if}
        </div>

      {:else if step === 2}
        <!-- Step 2: Generate images -->
        <div class="step-content">
          <h4>{tr('imageGen.step2Title')}</h4>
          <div class="image-grid">
            {#each generatedImages as img, i}
              <div class="image-card" class:selected={img.selected}>
                {#if img.loading}
                  <div class="image-placeholder" style="aspect-ratio:{imgCssAspectRatio}">
                    <span class="spinner"></span>
                  </div>
                {:else if img.error}
                  <div class="image-placeholder error" style="aspect-ratio:{imgCssAspectRatio}">
                    <span>{img.error}</span>
                  </div>
                {:else}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                  <img src={img.url} alt="Generated" style="aspect-ratio:{imgCssAspectRatio}" onclick={() => toggleImageSelection(i)} />
                {/if}
                <div class="image-actions">
                  <button class="btn-icon" onclick={() => regenerateImage(i)} title="Regenerate">↻</button>
                  <button
                    class="btn-icon"
                    class:checked={img.selected}
                    onclick={() => toggleImageSelection(i)}
                    title="Select"
                  >
                    {img.selected ? '✓' : '○'}
                  </button>
                </div>
              </div>
            {/each}
          </div>
          <div class="selected-count">{tr('imageGen.selected', { count: String(selectedCount) })}</div>
        </div>

      {:else}
        <!-- Step 3: Insert -->
        <div class="step-content">
          <h4>{tr('imageGen.step3Title')}</h4>
          <div class="insert-options">
            <label class="insert-option">
              <input type="radio" name="insert-mode" value="paragraph" bind:group={insertMode} />
              <span>{tr('imageGen.insertParagraph')}</span>
            </label>
            <label class="insert-option">
              <input type="radio" name="insert-mode" value="end" bind:group={insertMode} />
              <span>{tr('imageGen.insertEnd')}</span>
            </label>
            <label class="insert-option">
              <input type="radio" name="insert-mode" value="clipboard" bind:group={insertMode} />
              <span>{tr('imageGen.insertClipboard')}</span>
            </label>
          </div>

          <!-- Preview selected images -->
          <div class="preview-grid">
            {#each generatedImages.filter(img => img.selected && img.url) as img}
              <img src={img.url} alt="Preview" class="preview-thumb" />
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <!-- Footer -->
    <div class="dialog-footer">
      {#if step > 1}
        <button class="btn btn-secondary" onclick={() => step--}>{tr('imageGen.back')}</button>
      {/if}
      <div class="footer-spacer"></div>
      {#if step === 1}
        <button class="btn btn-secondary" onclick={handleGeneratePrompts}>↻ {tr('seo.regenerate')}</button>
        <button class="btn btn-primary" onclick={goToStep2} disabled={prompts.length === 0 || isGeneratingPrompts}>
          {tr('imageGen.next')}
        </button>
      {:else if step === 2}
        <button class="btn btn-primary" onclick={goToStep3} disabled={selectedCount === 0 || isGeneratingImages}>
          {tr('imageGen.next')}
        </button>
      {:else}
        <button class="btn btn-primary" onclick={handleInsert}>
          {tr('imageGen.insertConfirm')}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    width: 760px;
    max-height: 620px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    overflow: hidden;
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
    font-size: 1.25rem;
    line-height: 1;
    padding: 0 0.25rem;
  }

  .close-btn:hover {
    color: var(--text-primary);
  }

  /* Step indicator */
  .step-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    padding: 0.75rem 1rem;
  }

  .step {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    border: 2px solid var(--border-color);
    color: var(--text-muted);
    background: transparent;
  }

  .step.active {
    border-color: var(--accent-color);
    color: var(--accent-color);
  }

  .step.done {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: white;
  }

  .step-line {
    width: 60px;
    height: 2px;
    background: var(--border-color);
  }

  .step-line.active {
    background: var(--accent-color);
  }

  /* Body */
  .dialog-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem 1rem;
  }

  /* Mode row: title + pills + style dropdown */
  .mode-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }

  .mode-label {
    margin: 0 0.25rem 0 0;
    padding: 0.25rem 0;
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
    white-space: nowrap;
    line-height: 1;
  }

  .mode-row-spacer {
    flex: 1;
  }

  .style-select {
    min-width: 5.5rem;
  }

  .mode-btn {
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 20px;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .mode-btn:hover {
    border-color: var(--accent-color);
    color: var(--text-primary);
  }

  .mode-btn.active {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: white;
  }

  .step-content h4 {
    margin: 0 0 0.75rem;
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .step-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  .step-header h4 {
    margin: 0;
  }

  .step-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .mini-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .mini-hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .mini-select {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
  }

  .loading-state,
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
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

  /* Prompt list */
  .prompt-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .prompt-card {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0.5rem;
  }

  .prompt-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.35rem;
  }

  .prompt-reason {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .prompt-remove {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.85rem;
  }

  .prompt-remove:hover {
    color: #dc3545;
  }

  .prompt-text {
    width: 100%;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--border-light);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    font-family: var(--font-mono, monospace);
    resize: none;
  }

  .prompt-text:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  /* Image grid */
  .image-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.75rem;
  }

  .image-card {
    border: 2px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
    transition: border-color var(--transition-fast);
  }

  .image-card.selected {
    border-color: var(--accent-color);
  }

  .image-card img {
    width: 100%;
    object-fit: cover;
    display: block;
    cursor: pointer;
  }

  .image-placeholder {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    text-align: center;
    padding: 0.5rem;
  }

  .image-placeholder.error {
    color: #dc3545;
  }

  .image-actions {
    display: flex;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.35rem;
    border-top: 1px solid var(--border-light);
  }

  .btn-icon {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-light);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.75rem;
  }

  .btn-icon:hover {
    background: var(--bg-hover);
  }

  .btn-icon.checked {
    color: var(--accent-color);
    border-color: var(--accent-color);
  }

  .selected-count {
    text-align: center;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-top: 0.5rem;
  }

  /* Insert options */
  .insert-options {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .insert-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
  }

  .insert-option input[type="radio"] {
    accent-color: var(--accent-color);
  }

  .preview-grid {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .preview-thumb {
    width: 80px;
    height: 80px;
    object-fit: cover;
    border-radius: 6px;
    border: 1px solid var(--border-color);
  }

  /* Footer */
  .dialog-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .footer-spacer {
    flex: 1;
  }

  .btn {
    padding: 0.35rem 0.75rem;
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

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-retry {
    background: transparent;
    color: var(--accent-color);
    border-color: var(--accent-color);
  }
</style>

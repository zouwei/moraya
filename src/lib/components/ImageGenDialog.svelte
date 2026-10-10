<script module lang="ts">
  // Persists across dialog open/close (module scope, lives for the lifetime of the app).
  // Typed as strings to avoid importing type duplication with the instance <script>.
  // null means "not yet set — use provider default on first open".
  export const _lastSettings = {
    imageCount: 6,
    imageStyle: 'auto' as string,
    imageMode: 'article' as string,
    imgRatio: null as string | null,
    imgSizeLevel: null as string | null,
  };

  // Per-document prompt cache: persists across dialog open/close within app session.
  // Keyed by file path so each document retains its own generated prompts.
  interface CachedPromptState {
    prompts: Array<{ prompt: string; target: number; reason: string }>;
    mode: string;
    style: string;
    count: number;
  }
  export const _promptCache = new Map<string, CachedPromptState>();
</script>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { Select } from '$lib/components/ui';
  import { aiStore } from '$lib/services/ai';
  import { settingsStore } from '$lib/stores/settings-store';
  import { editorStore } from '$lib/stores/editor-store';
  import { fetchImageAsBlob, uploadImage, isImageHostTargetConfigured, type ImageHostTarget } from '$lib/services/image-hosting';
  import { targetToConfigAsync } from '$lib/services/picora/credentials';
  import { saveGeneratedImage } from '$lib/services/ai/generated-image-storage';
  import {
    generateImagePrompts,
    generateImage,
    extractImagePrompts,
    hasUnimportedDocumentImagePrompts,
    MODE_STYLES,
    STYLE_PROMPT_SUFFIXES,
    type ImagePrompt,
    type ImageStyle,
    type ImageGenerationResult,
    type ImageGenMode,
  } from '$lib/services/ai/image-service';
  import type { AIProviderConfig, ImageProviderConfig, ImageAspectRatio, ImageSizeLevel } from '$lib/services/ai/types';
  import { resolveImageSize, IMAGE_SIZE_MAP, DOUBAO_SIZE_MAP } from '$lib/services/ai/types';

  let {
    onClose,
    onInsert,
    onOpenSettings,
    onOpenImageHostSettings,
    documentContent = '',
  }: {
    onClose: () => void;
    onInsert: (images: { url: string; target: number }[], mode: InsertMode) => void;
    onOpenSettings?: () => void;
    onOpenImageHostSettings?: () => void;
    documentContent?: string;
  } = $props();

  type InsertMode = 'paragraph' | 'end' | 'replace' | 'clipboard';

  const tr = $t;

  let step = $state(1);
  let textAIConfig = $state<AIProviderConfig | null>(null);
  let imageConfig = $state<ImageProviderConfig | null>(null);

  // Step 1 state
  let prompts = $state<ImagePrompt[]>([]);
  let imageCount = $state(_lastSettings.imageCount);
  let imageStyle = $state<ImageStyle>(_lastSettings.imageStyle as ImageStyle);
  let imageMode = $state<ImageGenMode>(_lastSettings.imageMode as ImageGenMode);
  let isGeneratingPrompts = $state(false);
  let promptError = $state<string | null>(null);
  const MODE_OPTIONS: ImageGenMode[] = ['article', 'design', 'storyboard', 'product', 'moodboard', 'portrait'];

  // Image size overrides (default from settings, user can change per-session)
  let imgRatio = $state<ImageAspectRatio>((_lastSettings.imgRatio as ImageAspectRatio) ?? '16:9');
  let imgSizeLevel = $state<ImageSizeLevel>((_lastSettings.imgSizeLevel as ImageSizeLevel) ?? 'medium');
  const RATIO_OPTIONS: ImageAspectRatio[] = ['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'];
  const SIZE_LEVEL_OPTIONS: ImageSizeLevel[] = ['large', 'medium', 'small'];

  // Persist settings across dialog open/close
  $effect(() => {
    _lastSettings.imageCount = imageCount;
    _lastSettings.imageStyle = imageStyle;
    _lastSettings.imageMode = imageMode;
    _lastSettings.imgRatio = imgRatio;
    _lastSettings.imgSizeLevel = imgSizeLevel;
  });
  let imgResolvedSize = $derived(
    imageConfig?.provider === 'doubao'
      ? (DOUBAO_SIZE_MAP[imgRatio]?.[imgSizeLevel] ?? '2048x2048')
      : resolveImageSize(imgRatio, imgSizeLevel)
  );
  let imgCssAspectRatio = $derived(imgRatio.replace(':', '/'));
  let availableStyles = $derived(MODE_STYLES[imageMode] || MODE_STYLES.article);

  // Select options
  let styleOptions = $derived(availableStyles.map(s => ({ value: s, label: tr(`image_gen.style_${s}`) })));
  let ratioOptions = $derived(RATIO_OPTIONS.map(r => ({ value: r, label: r })));
  let sizeLevelOptions = $derived(SIZE_LEVEL_OPTIONS.map(s => ({ value: s, label: tr(`ai.image_config.size_${s}`) })));
  let countOptions = $derived(Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: String(i + 1) })));

  // Step 2 state
  let generatedImages = $state<(ImageGenerationResult & { promptIdx: number; selected: boolean; loading: boolean; error?: string; submittedPrompt?: string; insertUrl?: string; sourceBlob?: Blob; loadingStage?: 'uploading' | 'saving' })[]>([]);
  let isGeneratingImages = $state(false);
  let uploadToImageHost = $state(false);
  let imageHostTarget = $state<ImageHostTarget | null>(null);
  let hasConfiguredImageHost = $derived(isImageHostTargetConfigured(imageHostTarget));
  const previewBlobUrls = new Set<string>();

  // Step 3 state
  let insertMode = $state<InsertMode>('paragraph');

  // Top-level store subscriptions — do NOT wrap in $effect().
  // Svelte 5 $effect tracks reads in subscribe callbacks, causing infinite loops.
  aiStore.subscribe(state => {
    textAIConfig = state.providerConfigs.find(c => c.id === state.activeConfigId) || null;
  });
  settingsStore.subscribe(state => {
    const activeImg = state.imageProviderConfigs.find(c => c.id === state.activeImageConfigId) || null;
    imageConfig = activeImg;
    imageHostTarget = state.imageHostTargets.find(t => t.id === state.defaultImageHostId) || null;
    if (activeImg) {
      // Prefer user's last-used values; fall back to provider defaults on first open.
      imgRatio = (_lastSettings.imgRatio as ImageAspectRatio) ?? activeImg.defaultRatio;
      imgSizeLevel = (_lastSettings.imgSizeLevel as ImageSizeLevel) ?? activeImg.defaultSizeLevel;
    }
  });

  $effect(() => {
    if (!hasConfiguredImageHost && uploadToImageHost) uploadToImageHost = false;
  });

  // Detect pre-defined image prompts in the document (reactive on content changes)
  function getEffectiveDocumentContent(): string {
    // The page syncs this prop from the live editor immediately before opening.
    return documentContent ?? '';
  }

  let preDefinedPrompts = $derived(
    (() => {
      const content = getEffectiveDocumentContent();
      return content ? extractImagePrompts(content) : null;
    })()
  );
  let showPredefinedImport = $derived(hasUnimportedDocumentImagePrompts(preDefinedPrompts, prompts));

  function usePredefinedPrompts() {
    if (!preDefinedPrompts) return;
    prompts = preDefinedPrompts.map(p => ({ ...p }));
    imageCount = preDefinedPrompts.length;
    hasGenerated = true;
    savePromptsToCache();
  }

  // Step 1: Generate prompts
  async function handleGeneratePrompts() {
    if (!textAIConfig?.apiKey) {
      promptError = tr('errors.ai_not_configured');
      return;
    }

    const content = getEffectiveDocumentContent();
    if (!content || content.trim().length < 50) {
      promptError = tr('image_gen.content_too_short');
      return;
    }

    isGeneratingPrompts = true;
    promptError = null;

    try {
      prompts = await generateImagePrompts(textAIConfig, content, imageCount, imageStyle, imageMode);
      hasGenerated = true;
      savePromptsToCache();
    } catch (e) {
      promptError = e instanceof Error ? e.message : 'Failed to generate prompts';
    } finally {
      isGeneratingPrompts = false;
    }
  }

  function removePrompt(idx: number) {
    prompts = prompts.filter((_, i) => i !== idx);
    savePromptsToCache();
  }

  function goToStep2() {
    if (prompts.length === 0 || (uploadToImageHost && !hasConfiguredImageHost)) return;
    step = 2;
    startImageGeneration();
  }

  function isInputRejected(error: string | undefined): boolean {
    return !!error && /Green net check rejected text \(input\)/i.test(error);
  }

  async function prepareGeneratedImage(idx: number, result: ImageGenerationResult, finalPrompt: string, existingBlob?: Blob) {
    let blob = existingBlob;
    if (!blob) {
      try {
        blob = await fetchImageAsBlob(result.url);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`${tr('image_gen.generated_image_fetch_failed')}: ${detail}`);
      }
    }
    generatedImages[idx] = {
      ...generatedImages[idx],
      sourceBlob: blob,
      loadingStage: uploadToImageHost ? 'uploading' : 'saving',
    };
    generatedImages = [...generatedImages];

    if (uploadToImageHost) {
      if (!imageHostTarget) throw new Error(tr('context_menu.upload_no_config'));
      let uploadedUrl: string;
      try {
        const config = await targetToConfigAsync(imageHostTarget);
        uploadedUrl = (await uploadImage(blob, config)).url;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`${tr('image_gen.image_host_upload_failed')}: ${detail}`);
      }
      if (!uploadedUrl?.trim()) throw new Error(tr('image_gen.image_host_upload_failed'));
      return { ...result, url: uploadedUrl, insertUrl: uploadedUrl, submittedPrompt: finalPrompt, sourceBlob: undefined, loadingStage: undefined };
    }

    const insertUrl = await saveGeneratedImage(blob, editorStore.getState().currentFilePath || null);
    const previewUrl = URL.createObjectURL(blob);
    previewBlobUrls.add(previewUrl);
    return { ...result, url: previewUrl, insertUrl, submittedPrompt: finalPrompt, sourceBlob: undefined, loadingStage: undefined };
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

    // Append style suffix directly to prompts so the image API receives style keywords,
    // independent of whether the text AI embedded them during prompt generation.
    const styleSuffix = imageStyle !== 'auto' ? STYLE_PROMPT_SUFFIXES[imageStyle] : undefined;

    // Generate images sequentially to avoid API rate limiting
    for (let i = 0; i < prompts.length; i++) {
      const finalPrompt = styleSuffix ? `${prompts[i].prompt}, ${styleSuffix}` : prompts[i].prompt;
      try {
        const result = await generateImage(imageConfig!, finalPrompt, imgResolvedSize);
        const prepared = await prepareGeneratedImage(i, result, finalPrompt);
        generatedImages[i] = {
          ...generatedImages[i],
          ...prepared,
          loading: false,
        };
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error('[ImageGen] Image generation failed for prompt', i, errMsg, e);
        generatedImages[i] = {
          ...generatedImages[i],
          submittedPrompt: finalPrompt,
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
    const previous = generatedImages[idx];
    const styleSuffix = imageStyle !== 'auto' ? STYLE_PROMPT_SUFFIXES[imageStyle] : undefined;
    const finalPrompt = previous.submittedPrompt
      ?? (styleSuffix ? `${prompts[idx].prompt}, ${styleSuffix}` : prompts[idx].prompt);
    generatedImages[idx] = { ...generatedImages[idx], submittedPrompt: finalPrompt, loading: true, error: undefined };
    generatedImages = [...generatedImages];

    try {
      const result = previous.sourceBlob
        ? { url: previous.url, revisedPrompt: previous.revisedPrompt }
        : await generateImage(imageConfig, finalPrompt, imgResolvedSize);
      const prepared = await prepareGeneratedImage(idx, result, finalPrompt, previous.sourceBlob);
      generatedImages[idx] = {
        ...generatedImages[idx],
        ...prepared,
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
    const hasSelected = generatedImages.some(img => img.selected && !img.error && !img.loading && img.insertUrl);
    if (!hasSelected) return;
    step = 3;
  }

  // Step 3: Insert
  function handleInsert() {
    const selected = generatedImages
      .filter(img => img.selected && !img.error && !img.loading && img.insertUrl)
      .map(img => ({
        url: img.insertUrl ?? img.url,
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

  let hasGenerated = $state(false);

  // --- Per-document prompt cache ---
  function getDocCacheKey(): string {
    return editorStore.getState().currentFilePath || '';
  }

  function savePromptsToCache() {
    if (!hasGenerated) return;
    const key = getDocCacheKey();
    if (!key) return;
    _promptCache.set(key, {
      prompts: prompts.map(p => ({ prompt: p.prompt, target: p.target, reason: p.reason })),
      mode: imageMode,
      style: imageStyle,
      count: imageCount,
    });
  }

  // Restore cached prompts for current document on dialog open
  {
    const docKey = getDocCacheKey();
    const cached = docKey ? _promptCache.get(docKey) : null;
    if (cached) {
      imageMode = cached.mode as ImageGenMode;
      imageStyle = cached.style as ImageStyle;
      prompts = cached.prompts.map(p => ({ ...p }));
      imageCount = cached.count;
      hasGenerated = true;
    }
  }

  // Save cache on dialog close (captures textarea edits)
  onDestroy(() => {
    savePromptsToCache();
    for (const url of previewBlobUrls) URL.revokeObjectURL(url);
  });

  let isTextAIReady = $derived(!!(textAIConfig && textAIConfig.apiKey));
  let isImageAIReady = $derived(!!(imageConfig && imageConfig.apiKey));
  let isBothReady = $derived(isTextAIReady && isImageAIReady);

  const selectedCount = $derived(generatedImages.filter(img => img.selected && !img.error && !img.loading && img.insertUrl).length);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onclick={onClose}>
  <div class="dialog" onclick={(e) => e.stopPropagation()}>
    <!-- Header -->
    <div class="dialog-header">
      <h3>{tr('image_gen.title')}</h3>
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
          {#if preDefinedPrompts && showPredefinedImport}
            <div class="predefined-banner">
              <span>{tr('image_gen.pre_defined_detected').replace('{count}', String(preDefinedPrompts.length))}</span>
              <button class="use-predefined-btn" onclick={usePredefinedPrompts}>
                {tr('image_gen.use_predefined')}
              </button>
            </div>
          {/if}
          <!-- Row 1: Title + Mode pills + Style dropdown -->
          <div class="mode-row">
            <h4 class="mode-label">{tr('image_gen.step1_title')}</h4>
            {#each MODE_OPTIONS as m}
              <button
                class="mode-btn"
                class:active={imageMode === m}
                onclick={() => { imageMode = m; imageStyle = 'auto'; if (!preDefinedPrompts || !hasGenerated) { prompts = []; } }}
              >
                {tr(`image_gen.mode_${m}`)}
              </button>
            {/each}
            <div class="mode-row-spacer"></div>
            <label class="mini-label" for="imggen-style">{tr('image_gen.style_label')}</label>
            <Select id="imggen-style" class="mini-select style-select" size="sm" bind:value={imageStyle} options={styleOptions} onchange={() => { if (!preDefinedPrompts || !hasGenerated) { prompts = []; } }} />
          </div>

          <!-- Row 3: Ratio + Resolution + Count -->
          <div class="step-header">
            <div class="step-controls">
              <label class="mini-label" for="imggen-ratio">{tr('ai.image_config.ratio')}</label>
              <Select id="imggen-ratio" class="mini-select" size="sm" bind:value={imgRatio} options={ratioOptions} />
              <label class="mini-label" for="imggen-size-level">{tr('ai.image_config.size_level')}</label>
              <Select id="imggen-size-level" class="mini-select" size="sm" bind:value={imgSizeLevel} options={sizeLevelOptions} />
              <span class="mini-hint">{imgResolvedSize}</span>
            </div>
            <div class="step-controls">
              <label class="mini-label" for="imggen-count">{tr('image_gen.count_label')}</label>
              <Select id="imggen-count" class="mini-select style-select" size="sm" bind:value={imageCount} options={countOptions} onchange={() => { if (!preDefinedPrompts || !hasGenerated) { prompts = []; } }} />
            </div>
          </div>

          {#if !isBothReady}
            <div class="config-status">
              <div class="config-item" class:ready={isTextAIReady} class:missing={!isTextAIReady}>
                <span>{isTextAIReady ? '✓' : '✗'}</span>
                <span>{tr('ai.text_ai_label')}</span>
              </div>
              <div class="config-item" class:ready={isImageAIReady} class:missing={!isImageAIReady}>
                <span>{isImageAIReady ? '✓' : '✗'}</span>
                <span>{tr('ai.image_ai_label')}</span>
              </div>
              <p class="config-hint">{tr('ai.unconfigured_hint', { shortcut: navigator.platform.includes('Mac') ? 'Cmd+,' : 'Ctrl+,' })}</p>
              {#if onOpenSettings}
                <button class="btn btn-settings" onclick={onOpenSettings}>
                  {!isImageAIReady && isTextAIReady ? tr('ai.open_image_settings') : tr('ai.open_settings')}
                </button>
              {/if}
            </div>
          {:else if isGeneratingPrompts}
            <div class="loading-state">
              <span class="spinner"></span>
              <span>{tr('image_gen.generating_prompts')}</span>
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
                    aria-label={tr('image_gen.step1_title')}
                  ></textarea>
                </div>
              {/each}
            </div>
          {/if}
        </div>

      {:else if step === 2}
        <!-- Step 2: Generate images -->
        <div class="step-content">
          <h4>{tr('image_gen.step2_title')}</h4>
          <div class="image-grid">
            {#each generatedImages as img, i}
              <div class="image-card" class:selected={img.selected}>
                {#if img.loading}
                  <div class="image-placeholder" style="aspect-ratio:{imgCssAspectRatio}">
                    <span class="spinner"></span>
                    {#if img.loadingStage === 'uploading'}<span>{tr('image_gen.uploading_to_host')}</span>{/if}
                  </div>
                {:else if img.error}
                  <div class="image-placeholder error" style="aspect-ratio:{imgCssAspectRatio}">
                    {#if isInputRejected(img.error)}
                      <div class="rejection-message">
                        <strong>{tr('image_gen.input_rejected_title')}</strong>
                        <span>{tr('image_gen.input_rejected_hint')}</span>
                      </div>
                    {:else}
                      <span>{img.error}</span>
                    {/if}
                  </div>
                  {#if isInputRejected(img.error)}
                    <div class="rejected-prompt">
                      <label for={`retry-prompt-${i}`}>{tr('image_gen.retry_prompt_label')}</label>
                      <textarea
                        id={`retry-prompt-${i}`}
                        class="prompt-text"
                        rows="4"
                        value={img.submittedPrompt ?? prompts[img.promptIdx]?.prompt ?? ''}
                        oninput={(event) => {
                          generatedImages[i].submittedPrompt = event.currentTarget.value;
                          generatedImages = [...generatedImages];
                        }}
                      ></textarea>
                      <details class="error-details">
                        <summary>{tr('image_gen.error_details')}</summary>
                        <p>{img.error}</p>
                      </details>
                    </div>
                  {/if}
                {:else}
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                  <img src={img.url} alt="Generated" style="aspect-ratio:{imgCssAspectRatio}" onclick={() => toggleImageSelection(i)} />
                {/if}
                <div class="image-actions">
                  <button class="btn-icon" onclick={() => regenerateImage(i)} title={img.sourceBlob ? tr('seo.retry') : tr('seo.regenerate')} disabled={img.loading || !(img.submittedPrompt ?? prompts[img.promptIdx]?.prompt)?.trim()}>↻</button>
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
          <div class="selected-count">{tr('image_gen.selected', { count: String(selectedCount) })}</div>
        </div>

      {:else}
        <!-- Step 3: Insert -->
        <div class="step-content">
          <h4>{tr('image_gen.step3_title')}</h4>
          <div class="insert-options">
            <label class="insert-option">
              <input type="radio" name="insert-mode" value="paragraph" bind:group={insertMode} />
              <span>{tr('image_gen.insert_paragraph')}</span>
            </label>
            <label class="insert-option">
              <input type="radio" name="insert-mode" value="end" bind:group={insertMode} />
              <span>{tr('image_gen.insert_end')}</span>
            </label>
            <label class="insert-option">
              <input type="radio" name="insert-mode" value="replace" bind:group={insertMode} />
              <span>{tr('image_gen.insert_replace')}</span>
            </label>
            <label class="insert-option">
              <input type="radio" name="insert-mode" value="clipboard" bind:group={insertMode} />
              <span>{tr('image_gen.insert_clipboard')}</span>
            </label>
          </div>

          <!-- Preview selected images -->
          <div class="preview-grid">
            {#each generatedImages.filter(img => img.selected && !img.error && img.insertUrl) as img}
              <img src={img.url} alt="Preview" class="preview-thumb" />
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <!-- Footer -->
    <div class="dialog-footer">
      {#if step > 1}
        <button class="btn btn-secondary" onclick={() => step--}>{tr('image_gen.back')}</button>
      {/if}
      <div class="footer-spacer"></div>
      {#if step === 1}
        {#if hasGenerated}
          <label class="auto-upload-option" class:disabled={!hasConfiguredImageHost} title={!hasConfiguredImageHost ? tr('context_menu.upload_no_config') : undefined}>
            <input type="checkbox" bind:checked={uploadToImageHost} disabled={!hasConfiguredImageHost} />
            {tr('image_gen.upload_to_host_after_generation')}
          </label>
          {#if !hasConfiguredImageHost && onOpenImageHostSettings}
            <button class="image-host-settings-link" onclick={onOpenImageHostSettings}>
              {tr('image_gen.configure_image_host')}
            </button>
          {/if}
          <button class="btn btn-secondary" onclick={handleGeneratePrompts} disabled={isGeneratingPrompts || !isBothReady}>↻ {tr('seo.regenerate')}</button>
          <button class="btn btn-primary" onclick={goToStep2} disabled={prompts.length === 0 || isGeneratingPrompts || (uploadToImageHost && !hasConfiguredImageHost)}>
            {tr('image_gen.next')}
          </button>
        {:else}
          <button class="btn btn-primary" onclick={handleGeneratePrompts} disabled={isGeneratingPrompts || !isBothReady}>
            {tr('image_gen.generate')}
          </button>
        {/if}
      {:else if step === 2}
        <button class="btn btn-primary" onclick={goToStep3} disabled={selectedCount === 0 || isGeneratingImages}>
          {tr('image_gen.next')}
        </button>
      {:else}
        <button class="btn btn-primary" onclick={handleInsert}>
          {tr('image_gen.insert_confirm')}
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
    width: 860px;
    max-height: 720px;
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

  .mode-btn {
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 20px;
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    cursor: pointer;
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
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
    gap: 0.5rem;
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
    min-height: 9rem;
    overflow-wrap: anywhere;
    overflow: auto;
  }

  .rejection-message {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    line-height: 1.5;
  }

  .rejection-message strong {
    font-size: var(--font-size-sm);
  }

  .rejected-prompt {
    padding: 0.4rem 0.5rem;
  }

  .rejected-prompt label {
    display: block;
    margin-bottom: 0.25rem;
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
  }

  .rejected-prompt .prompt-text {
    box-sizing: border-box;
    resize: vertical;
  }

  .error-details {
    margin-top: 0.35rem;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
  }

  .error-details summary {
    cursor: pointer;
  }

  .error-details p {
    margin: 0.25rem 0 0;
    overflow-wrap: anywhere;
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

  .btn-icon:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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

  .auto-upload-option {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    cursor: pointer;
  }

  .auto-upload-option input {
    accent-color: var(--accent-color);
  }

  .auto-upload-option.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .image-host-settings-link {
    border: none;
    background: transparent;
    color: var(--accent-color);
    font-size: var(--font-size-xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .image-host-settings-link:hover {
    text-decoration: underline;
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

  .config-status {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.5rem;
    align-items: center;
  }

  .config-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: var(--font-size-sm);
  }

  .config-item.missing {
    color: var(--text-muted);
  }

  .config-item.ready {
    color: var(--accent-color);
  }

  .config-hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    text-align: center;
  }

  .btn-settings {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .btn-settings:hover {
    background: var(--bg-hover);
  }

  .predefined-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: var(--bg-hover);
    border: 1px solid var(--accent-color);
    border-radius: 6px;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    margin-bottom: 0.75rem;
  }

  .use-predefined-btn {
    padding: 0.25rem 0.75rem;
    border: none;
    background: var(--accent-color);
    color: white;
    border-radius: 4px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    white-space: nowrap;
  }

  .use-predefined-btn:hover {
    opacity: 0.9;
  }
</style>

<script lang="ts">
  import { t } from '$lib/i18n';
  import type { AITemplate } from '$lib/services/ai';

  let {
    template,
    onExecute,
    onCancel,
  }: {
    template: AITemplate;
    onExecute: (params: Record<string, string>, input: string) => void;
    onCancel: () => void;
  } = $props();

  let paramValues = $state<Record<string, string>>({});
  let inputText = $state('');

  // Initialize param defaults
  $effect(() => {
    const defaults: Record<string, string> = {};
    for (const p of template.params ?? []) {
      defaults[p.key] = p.default;
    }
    paramValues = defaults;
  });

  function handleSubmit() {
    onExecute(paramValues, inputText.trim());
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
    if (event.key === 'Escape') {
      onCancel();
    }
  }
</script>

<div class="param-panel">
  <div class="param-header">
    <span class="param-icon">{template.icon}</span>
    <span class="param-title">{$t(template.nameKey)}</span>
    <button class="close-btn" onclick={onCancel}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
        <path d="M9.5 2.5l-7 7m0-7l7 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      </svg>
    </button>
  </div>

  {#if template.params && template.params.length > 0}
    <div class="params-body">
      {#each template.params as param}
        <div class="param-group">
          <label class="param-label">{$t(param.labelKey)}</label>
          {#if param.type === 'select'}
            <select
              class="param-select"
              value={paramValues[param.key]}
              onchange={(e) => { paramValues[param.key] = (e.target as HTMLSelectElement).value; }}
            >
              {#each param.options as opt}
                <option value={opt.value}>{$t(opt.labelKey)}</option>
              {/each}
            </select>
          {:else}
            <div class="radio-group">
              {#each param.options as opt}
                <label class="radio-item">
                  <input
                    type="radio"
                    name={param.key}
                    value={opt.value}
                    checked={paramValues[param.key] === opt.value}
                    onchange={() => { paramValues[param.key] = opt.value; }}
                  />
                  <span>{$t(opt.labelKey)}</span>
                </label>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if template.inputHintKey}
    <div class="input-section">
      <textarea
        class="param-input"
        bind:value={inputText}
        onkeydown={handleKeydown}
        placeholder={$t(template.inputHintKey)}
        rows={3}
      ></textarea>
    </div>
  {/if}

  <div class="param-actions">
    <button class="cancel-btn" onclick={onCancel}>{$t('templates.gallery.back')}</button>
    <button class="execute-btn" onclick={handleSubmit}>{$t('templates.gallery.start')}</button>
  </div>
</div>

<style>
  .param-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
  }

  .param-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .param-icon {
    font-size: 1.2rem;
  }

  .param-title {
    flex: 1;
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

  .params-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .param-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .param-label {
    font-size: var(--font-size-xs);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .param-select {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    cursor: pointer;
    outline: none;
  }

  .param-select:focus {
    border-color: var(--accent-color);
  }

  .radio-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .radio-item {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--font-size-xs);
    color: var(--text-primary);
    cursor: pointer;
  }

  .radio-item input[type="radio"] {
    margin: 0;
    accent-color: var(--accent-color);
  }

  .input-section {
    margin-top: 0.25rem;
  }

  .param-input {
    width: 100%;
    resize: none;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0.4rem 0.5rem;
    font-size: var(--font-size-xs);
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
    line-height: 1.4;
    outline: none;
    box-sizing: border-box;
  }

  .param-input:focus {
    border-color: var(--accent-color);
  }

  .param-input::placeholder {
    color: var(--text-muted);
  }

  .param-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .cancel-btn {
    padding: 0.3rem 0.75rem;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 6px;
    font-size: var(--font-size-xs);
    cursor: pointer;
  }

  .cancel-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .execute-btn {
    padding: 0.3rem 0.75rem;
    border: none;
    background: var(--accent-color);
    color: white;
    border-radius: 6px;
    font-size: var(--font-size-xs);
    cursor: pointer;
    font-weight: 500;
  }

  .execute-btn:hover {
    opacity: 0.85;
  }
</style>

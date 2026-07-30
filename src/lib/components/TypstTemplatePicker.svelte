<script lang="ts">
  /**
   * Typst Universe template picker.
   *
   * A thumbnail grid rather than a list: a template IS its look, and 749 of
   * them cannot be told apart by name. The registry renders a preview image for
   * every one, so the grid costs nothing to populate.
   *
   * Creation runs the engine's own `typst init`, so the desktop needs none of
   * the browser build's archive handling.
   */
  import { t } from '$lib/i18n';
  import {
    filterTemplates,
    templateCategories,
    templateThumbnailUrl,
    type TypstTemplate,
  } from '@moraya/core/typst'

  let {
    open = $bindable(false),
    onPick,
    onClose,
  }: {
    open?: boolean
    onPick: (template: TypstTemplate) => void | Promise<void>
    onClose?: () => void
  } = $props();

  let templates = $state<TypstTemplate[]>([])
  let loading = $state(false)
  let query = $state('')
  let category = $state<string | null>(null)
  /** Name of the template being created, so its card can show progress. */
  let picking = $state<string | null>(null)

  // Load on first open. Rust holds a 24h on-disk cache, so reopening is cheap.
  $effect(() => {
    if (!open || templates.length > 0 || loading) return;
    loading = true;
    void import('$lib/services/typst-templates')
      .then(({ loadTemplates }) => loadTemplates())
      .then((list) => { templates = list; })
      .finally(() => { loading = false; });
  });

  const categories = $derived(templateCategories(templates).slice(0, 10))
  const visible = $derived(
    filterTemplates(templates, { query, ...(category ? { category } : {}) }),
  )

  async function pick(template: TypstTemplate) {
    if (picking) return
    picking = template.name
    try {
      await onPick(template)
    } finally {
      picking = null
    }
  }

  function close() {
    open = false
    onClose?.()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
  }
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tpl-backdrop" role="presentation" onclick={close}>
    <!-- Stops a click inside the panel from reaching the backdrop's close
         handler. Not an interactive element itself — hence the tabindex the
         dialog role requires, and no keyboard handler (Escape is on window). -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="tpl-panel"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      aria-label={$t('typst.templates.title')}
      onclick={(e) => e.stopPropagation()}
    >
      <header class="tpl-head">
        <h2>{$t('typst.templates.title')}</h2>
        <button class="tpl-close" onclick={close} aria-label={$t('common.close')}>×</button>
      </header>

      <div class="tpl-controls">
        <input
          class="tpl-search"
          type="search"
          bind:value={query}
          placeholder={$t('typst.templates.search')}
          aria-label={$t('typst.templates.search')}
        />
        <div class="tpl-cats">
          <button class="tpl-cat" class:active={category === null} onclick={() => { category = null }}>
            {$t('typst.templates.all')}
          </button>
          {#each categories as c (c.name)}
            <button
              class="tpl-cat"
              class:active={category === c.name}
              onclick={() => { category = category === c.name ? null : c.name }}
            >{c.name} <span class="tpl-count">{c.count}</span></button>
          {/each}
        </div>
      </div>

      <div class="tpl-body">
        {#if loading}
          <p class="tpl-note">{$t('common.loading')}</p>
        {:else if templates.length === 0}
          <p class="tpl-note">{$t('typst.templates.unavailable')}</p>
        {:else if visible.length === 0}
          <p class="tpl-note">{$t('typst.templates.no_match')}</p>
        {:else}
          <ul class="tpl-grid">
            {#each visible as tpl (tpl.name)}
              <li>
                <button
                  class="tpl-card"
                  disabled={picking !== null}
                  onclick={() => pick(tpl)}
                  title={tpl.description}
                >
                  <span class="tpl-thumb">
                    {#if templateThumbnailUrl(tpl)}
                      <!-- Lazy: 749 thumbnails at ~500 KB each must not all load. -->
                      <img src={templateThumbnailUrl(tpl)} alt="" loading="lazy" decoding="async" />
                    {/if}
                    {#if picking === tpl.name}
                      <span class="tpl-spinner" aria-hidden="true"></span>
                    {/if}
                  </span>
                  <span class="tpl-name">{tpl.name}</span>
                  <span class="tpl-desc">{tpl.description}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .tpl-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    z-index: 9000;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(2px);
  }
  .tpl-panel {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 14px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.18);
    width: 900px;
    max-width: 94vw;
    height: 620px;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .tpl-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border-color);
  }
  .tpl-head h2 {
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
  }
  .tpl-close {
    border: none;
    background: none;
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    color: var(--text-secondary);
    padding: 0 4px;
  }
  .tpl-controls {
    padding: 12px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-bottom: 1px solid var(--border-color);
  }
  .tpl-search {
    width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .tpl-cats {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tpl-cat {
    border: 1px solid var(--border-color);
    background: none;
    border-radius: 999px;
    padding: 3px 10px;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .tpl-cat.active {
    background: var(--typst-accent-color);
    border-color: var(--typst-accent-color);
    color: #fff;
  }
  .tpl-count { opacity: 0.65; }

  .tpl-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px 20px;
  }
  .tpl-note {
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    text-align: center;
    margin-top: 40px;
  }
  .tpl-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 14px;
  }
  .tpl-card {
    width: 100%;
    text-align: left;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-primary);
    padding: 0 0 10px;
    cursor: pointer;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  .tpl-card:hover:not(:disabled) {
    border-color: var(--typst-accent-color);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
  }
  .tpl-card:disabled { cursor: default; }

  .tpl-thumb {
    position: relative;
    display: block;
    /* A4-ish, so cards keep a stable height before the images arrive. */
    aspect-ratio: 1 / 1.35;
    background: var(--bg-secondary);
    overflow: hidden;
  }
  .tpl-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top center;
    display: block;
  }
  .tpl-spinner {
    position: absolute;
    inset: 0;
    background: rgba(255, 255, 255, 0.6);
  }
  .tpl-name {
    padding: 8px 10px 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tpl-desc {
    padding: 0 10px;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  :global([data-theme='dark']) .tpl-spinner { background: rgba(0, 0, 0, 0.45); }
</style>

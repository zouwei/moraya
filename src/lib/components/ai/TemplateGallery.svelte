<script lang="ts">
  import { t } from '$lib/i18n';
  import {
    getCategories,
    getTemplatesByCategory,
    getAllTemplates,
    type AITemplate,
    type AITemplateCategory,
  } from '$lib/services/ai';

  let {
    onSelectTemplate,
  }: {
    onSelectTemplate: (template: AITemplate) => void;
  } = $props();

  let view = $state<'categories' | 'list'>('categories');
  let selectedCategory = $state<AITemplateCategory | null>(null);
  let searchQuery = $state('');

  const categories = getCategories();

  let displayTemplates = $derived.by(() => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return getAllTemplates().filter(tpl => {
        const name = $t(tpl.nameKey).toLowerCase();
        const desc = $t(tpl.descKey).toLowerCase();
        const tags = tpl.tags?.join(' ').toLowerCase() ?? '';
        return name.includes(q) || desc.includes(q) || tags.includes(q);
      });
    }
    if (selectedCategory) {
      return getTemplatesByCategory(selectedCategory.id);
    }
    return [];
  });

  function handleCategoryClick(cat: AITemplateCategory) {
    selectedCategory = cat;
    view = 'list';
    searchQuery = '';
  }

  function handleBack() {
    view = 'categories';
    selectedCategory = null;
    searchQuery = '';
  }

  function handleSearchInput() {
    if (searchQuery.trim()) {
      view = 'list';
      selectedCategory = null;
    } else if (!selectedCategory) {
      view = 'categories';
    }
  }
</script>

<div class="template-gallery">
  <div class="gallery-header">
    {#if view === 'list' && !searchQuery.trim()}
      <button class="back-btn" onclick={handleBack}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <path d="M9.5 1L3.5 7l6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
        </svg>
        <span>{$t('templates.gallery.back')}</span>
      </button>
      <span class="category-title">{selectedCategory?.icon} {selectedCategory ? $t(selectedCategory.nameKey) : ''}</span>
    {:else}
      <span class="gallery-title">{$t('templates.gallery.title')}</span>
    {/if}
  </div>

  <div class="search-bar">
    <svg class="search-icon" width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <path d="M10 6.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zm-.7 3.5a5 5 0 1 1 .7-.7l3.4 3.3-.7.7L9.3 10z"/>
    </svg>
    <input
      type="text"
      bind:value={searchQuery}
      oninput={handleSearchInput}
      placeholder={$t('templates.gallery.search')}
    />
  </div>

  <div class="gallery-content">
    {#if view === 'categories' && !searchQuery.trim()}
      <div class="category-grid">
        {#each categories as cat}
          <button class="category-card" onclick={() => handleCategoryClick(cat)}>
            <span class="cat-icon">{cat.icon}</span>
            <span class="cat-name">{$t(cat.nameKey)}</span>
            <span class="cat-desc">{$t(cat.descKey)}</span>
          </button>
        {/each}
      </div>
    {:else}
      <div class="template-list">
        {#each displayTemplates as tpl}
          <button class="template-item" onclick={() => onSelectTemplate(tpl)}>
            <span class="tpl-icon">{tpl.icon}</span>
            <div class="tpl-info">
              <span class="tpl-name">{$t(tpl.nameKey)}</span>
              <span class="tpl-desc">{$t(tpl.descKey)}</span>
            </div>
            <span class="tpl-arrow">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                <path d="M3 1l5 4-5 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
              </svg>
            </span>
          </button>
        {/each}
        {#if displayTemplates.length === 0}
          <div class="empty-state">{$t('templates.gallery.search')}...</div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .template-gallery {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .gallery-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0.75rem 0.25rem;
    min-height: 1.75rem;
  }

  .gallery-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    color: var(--text-primary);
  }

  .back-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    border: none;
    background: none;
    color: var(--accent-color);
    cursor: pointer;
    font-size: var(--font-size-xs);
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
  }

  .back-btn:hover {
    background: var(--bg-hover);
  }

  .category-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .search-bar {
    position: relative;
    padding: 0.5rem 0.75rem;
  }

  .search-bar input {
    width: 100%;
    padding: 0.4rem 0.5rem 0.4rem 1.8rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    outline: none;
    box-sizing: border-box;
  }

  .search-bar input:focus {
    border-color: var(--accent-color);
  }

  .search-bar input::placeholder {
    color: var(--text-muted);
  }

  .search-icon {
    position: absolute;
    left: 1.2rem;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-muted);
    pointer-events: none;
  }

  .gallery-content {
    flex: 1;
    overflow-y: auto;
    padding: 0 0.75rem 0.75rem;
  }

  .category-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .category-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    padding: 0.75rem 0.5rem;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color var(--transition-fast), background var(--transition-fast);
    text-align: center;
  }

  .category-card:hover {
    border-color: var(--accent-color);
    background: var(--bg-hover);
  }

  .cat-icon {
    font-size: 1.5rem;
    line-height: 1;
  }

  .cat-name {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-primary);
  }

  .cat-desc {
    font-size: 10px;
    color: var(--text-muted);
    line-height: 1.3;
  }

  .template-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .template-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border: 1px solid transparent;
    background: transparent;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    width: 100%;
    transition: background var(--transition-fast);
  }

  .template-item:hover {
    background: var(--bg-hover);
    border-color: var(--border-color);
  }

  .tpl-icon {
    font-size: 1.1rem;
    flex-shrink: 0;
    width: 1.5rem;
    text-align: center;
  }

  .tpl-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .tpl-name {
    font-size: var(--font-size-xs);
    font-weight: 500;
    color: var(--text-primary);
  }

  .tpl-desc {
    font-size: 10px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tpl-arrow {
    flex-shrink: 0;
    color: var(--text-muted);
  }

  .empty-state {
    text-align: center;
    padding: 2rem 1rem;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
  }
</style>

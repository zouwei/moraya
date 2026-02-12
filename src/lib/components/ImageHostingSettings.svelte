<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { ImageHostTarget, ImageHostProvider, ImageHostConfig, GitHubCdnMode } from '$lib/services/image-hosting';
  import { createDefaultImageHostTarget, targetToConfig, uploadImage } from '$lib/services/image-hosting';

  const tr = $t;

  let targets = $state<ImageHostTarget[]>([]);
  let defaultId = $state('');
  let editingTarget = $state<ImageHostTarget | null>(null);
  let showAddMenu = $state(false);
  let testStatus = $state<Record<string, 'idle' | 'testing' | 'success' | 'failed'>>({});

  // Publish targets for quick import (GitHub only)
  let publishTargets = $state<Array<{ type: string; name: string; repoUrl?: string; branch?: string; token?: string }>>([]);

  settingsStore.subscribe(state => {
    targets = state.imageHostTargets || [];
    defaultId = state.defaultImageHostId || '';
    publishTargets = (state.publishTargets || [])
      .filter((t: { type: string }) => t.type === 'github')
      .map((t: { type: string; name: string; repoUrl?: string; branch?: string; token?: string }) => ({
        type: t.type,
        name: t.name,
        repoUrl: t.repoUrl,
        branch: t.branch,
        token: t.token,
      }));
  });

  const PROVIDER_ICONS: Record<ImageHostProvider, string> = {
    smms: '🟠',
    imgur: '🟢',
    github: '🔵',
    custom: '🟣',
  };

  function addTarget(provider: ImageHostProvider) {
    editingTarget = createDefaultImageHostTarget(provider);
    showAddMenu = false;
  }

  function editTarget(target: ImageHostTarget) {
    editingTarget = JSON.parse(JSON.stringify(target));
  }

  function deleteTarget(id: string) {
    const updated = targets.filter(t => t.id !== id);
    // Deep clone to strip Svelte 5 $state proxies
    const patch: Record<string, unknown> = { imageHostTargets: JSON.parse(JSON.stringify(updated)) };
    // If deleting the default, auto-set first remaining as default
    if (id === defaultId) {
      patch.defaultImageHostId = updated.length > 0 ? updated[0].id : '';
    }
    settingsStore.update(patch);
  }

  function saveTarget() {
    if (!editingTarget) return;
    const existing = targets.findIndex(t => t.id === editingTarget!.id);
    let updated: ImageHostTarget[];
    if (existing >= 0) {
      updated = [...targets];
      updated[existing] = editingTarget;
    } else {
      updated = [...targets, editingTarget];
    }
    // Deep clone entire array to strip Svelte 5 $state proxies before passing to store
    const patch: Record<string, unknown> = { imageHostTargets: JSON.parse(JSON.stringify(updated)) };
    // Auto-set as default if it's the first target
    if (!defaultId && updated.length > 0) {
      patch.defaultImageHostId = editingTarget.id;
    }
    settingsStore.update(patch);
    editingTarget = null;
  }

  function cancelEdit() {
    editingTarget = null;
  }

  function setDefault(id: string) {
    settingsStore.update({ defaultImageHostId: id });
  }

  function importFromPublishTarget(target: { repoUrl?: string; branch?: string; token?: string }) {
    if (!editingTarget) return;
    if (target.repoUrl) editingTarget.githubRepoUrl = target.repoUrl;
    if (target.branch) editingTarget.githubBranch = target.branch;
    if (target.token) editingTarget.githubToken = target.token;
  }

  async function handleTestUpload(target: ImageHostTarget) {
    testStatus[target.id] = 'testing';
    testStatus = { ...testStatus };
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 1, 1);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/png')
      );
      await uploadImage(blob, targetToConfig(target));
      testStatus[target.id] = 'success';
    } catch {
      testStatus[target.id] = 'failed';
    }
    testStatus = { ...testStatus };
    setTimeout(() => {
      testStatus[target.id] = 'idle';
      testStatus = { ...testStatus };
    }, 3000);
  }
</script>

<div class="imghost-settings">
  {#if editingTarget}
    <!-- Edit form -->
    <div class="edit-form">
      <div class="form-header">
        <h4>{PROVIDER_ICONS[editingTarget.provider]} {tr(`imageHost.${editingTarget.provider === 'smms' ? 'smms' : editingTarget.provider === 'imgur' ? 'imgur' : editingTarget.provider === 'github' ? 'github' : 'custom'}`)}</h4>
      </div>

      <div class="setting-group">
        <label class="setting-label" for="imghost-target-name">{tr('imageHost.targetName')}</label>
        <input
          id="imghost-target-name"
          type="text"
          class="setting-input"
          bind:value={editingTarget.name}
          placeholder={tr('imageHost.targetNamePlaceholder')}
        />
      </div>

      {#if editingTarget.provider === 'smms' || editingTarget.provider === 'imgur'}
        <div class="setting-group">
          <label class="setting-label" for="imghost-api-token">{tr('imageHost.apiToken')}</label>
          <input
            id="imghost-api-token"
            type="password"
            class="setting-input"
            bind:value={editingTarget.apiToken}
            placeholder={tr('imageHost.apiTokenPlaceholder')}
          />
        </div>
      {/if}

      {#if editingTarget.provider === 'github'}
        {#if publishTargets.length > 0}
          <div class="setting-group">
            <span class="setting-label">{tr('imageHost.importFromPublish')}</span>
            <div class="import-targets">
              {#each publishTargets as target}
                <button
                  class="import-btn"
                  onclick={() => importFromPublishTarget(target)}
                >
                  {target.name || target.repoUrl || 'GitHub'}
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="setting-group">
          <label class="setting-label" for="imghost-github-repo">{tr('imageHost.githubRepoUrl')}</label>
          <input
            id="imghost-github-repo"
            type="text"
            class="setting-input"
            bind:value={editingTarget.githubRepoUrl}
            placeholder={tr('imageHost.githubRepoUrlPlaceholder')}
          />
        </div>

        <div class="setting-group">
          <label class="setting-label" for="imghost-github-branch">{tr('imageHost.githubBranch')}</label>
          <input
            id="imghost-github-branch"
            type="text"
            class="setting-input"
            bind:value={editingTarget.githubBranch}
            placeholder="main"
          />
        </div>

        <div class="setting-group">
          <label class="setting-label" for="imghost-github-dir">{tr('imageHost.githubDir')}</label>
          <input
            id="imghost-github-dir"
            type="text"
            class="setting-input"
            bind:value={editingTarget.githubDir}
            placeholder="images/"
          />
        </div>

        <div class="setting-group">
          <label class="setting-label" for="imghost-github-token">{tr('imageHost.githubToken')}</label>
          <input
            id="imghost-github-token"
            type="password"
            class="setting-input"
            bind:value={editingTarget.githubToken}
            placeholder={tr('imageHost.githubTokenPlaceholder')}
          />
        </div>

        <div class="setting-group">
          <label class="setting-label" for="imghost-github-cdn">{tr('imageHost.githubCdn')}</label>
          <select id="imghost-github-cdn" class="setting-input" bind:value={editingTarget.githubCdn}>
            <option value="raw">{tr('imageHost.githubCdnRaw')}</option>
            <option value="jsdelivr">{tr('imageHost.githubCdnJsdelivr')}</option>
          </select>
        </div>
      {/if}

      {#if editingTarget.provider === 'custom'}
        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-token">{tr('imageHost.apiToken')}</label>
          <input
            id="imghost-custom-token"
            type="password"
            class="setting-input"
            bind:value={editingTarget.apiToken}
            placeholder={tr('imageHost.apiTokenPlaceholder')}
          />
        </div>

        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-endpoint">{tr('imageHost.customEndpoint')}</label>
          <input
            id="imghost-custom-endpoint"
            type="text"
            class="setting-input"
            bind:value={editingTarget.customEndpoint}
            placeholder={tr('imageHost.customEndpointPlaceholder')}
          />
        </div>

        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-headers">{tr('imageHost.customHeaders')}</label>
          <textarea
            id="imghost-custom-headers"
            class="setting-textarea"
            bind:value={editingTarget.customHeaders}
            placeholder={'{"X-Custom-Header": "value"}'}
            rows="3"
          ></textarea>
        </div>
      {/if}

      <div class="setting-group">
        <label class="setting-label">
          <input
            type="checkbox"
            bind:checked={editingTarget.autoUpload}
          />
          {tr('imageHost.autoUpload')}
        </label>
      </div>

      <div class="form-actions">
        <button class="btn btn-secondary" onclick={cancelEdit}>{tr('common.cancel')}</button>
        <button class="btn btn-primary" onclick={saveTarget} disabled={!editingTarget.name}>
          {tr('common.save')}
        </button>
      </div>
    </div>
  {:else}
    <!-- Target list -->
    {#if targets.length === 0}
      <div class="empty-state">
        <p>{tr('imageHost.settingsEmpty')}</p>
        <p class="hint">{tr('imageHost.settingsHint')}</p>
      </div>
    {:else}
      <div class="target-list">
        {#each targets as target (target.id)}
          <div class="target-card">
            <div class="target-info">
              <span class="target-icon">
                {PROVIDER_ICONS[target.provider]}
              </span>
              <div class="target-details">
                <span class="target-name">
                  {target.name || '(unnamed)'}
                  {#if target.id === defaultId}
                    <span class="default-badge">{tr('imageHost.default')}</span>
                  {/if}
                </span>
                <span class="target-type">
                  {tr(`imageHost.${target.provider === 'smms' ? 'smms' : target.provider === 'imgur' ? 'imgur' : target.provider === 'github' ? 'github' : 'custom'}`)}
                </span>
              </div>
            </div>
            <div class="target-actions">
              <button
                class="action-btn"
                class:is-default={target.id === defaultId}
                onclick={() => setDefault(target.id)}
                title={tr('imageHost.setDefault')}
              >
                {target.id === defaultId ? '★' : '☆'}
              </button>
              <button
                class="action-btn"
                class:testing={testStatus[target.id] === 'testing'}
                class:success={testStatus[target.id] === 'success'}
                class:failed={testStatus[target.id] === 'failed'}
                onclick={() => handleTestUpload(target)}
                disabled={testStatus[target.id] === 'testing'}
              >
                {#if testStatus[target.id] === 'testing'}
                  ...
                {:else if testStatus[target.id] === 'success'}
                  ✓
                {:else if testStatus[target.id] === 'failed'}
                  ✗
                {:else}
                  ⚡
                {/if}
              </button>
              <button class="action-btn" onclick={() => editTarget(target)}>✎</button>
              <button class="action-btn danger" onclick={() => deleteTarget(target.id)}>✕</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Add button -->
    <div class="add-section">
      {#if showAddMenu}
        <div class="add-menu">
          <button class="add-option" onclick={() => addTarget('smms')}>
            🟠 {tr('imageHost.smms')}
          </button>
          <button class="add-option" onclick={() => addTarget('imgur')}>
            🟢 {tr('imageHost.imgur')}
          </button>
          <button class="add-option" onclick={() => addTarget('github')}>
            🔵 {tr('imageHost.github')}
          </button>
          <button class="add-option" onclick={() => addTarget('custom')}>
            🟣 {tr('imageHost.custom')}
          </button>
        </div>
      {/if}
      <button class="btn btn-add" onclick={() => showAddMenu = !showAddMenu}>
        + {tr('imageHost.addTarget')}
      </button>
    </div>
  {/if}
</div>

<style>
  .imghost-settings {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    color: var(--text-muted);
    text-align: center;
    gap: 0.5rem;
  }

  .empty-state p {
    margin: 0;
    font-size: var(--font-size-sm);
  }

  .empty-state .hint {
    font-size: var(--font-size-xs);
  }

  /* Target list */
  .target-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .target-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
  }

  .target-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .target-icon {
    font-size: 0.85rem;
  }

  .target-details {
    display: flex;
    flex-direction: column;
  }

  .target-name {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .default-badge {
    font-size: var(--font-size-xs);
    font-weight: 500;
    color: var(--accent-color);
    background: color-mix(in srgb, var(--accent-color) 12%, transparent);
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
  }

  .target-type {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .target-actions {
    display: flex;
    gap: 0.25rem;
  }

  .action-btn {
    width: 1.75rem;
    height: 1.75rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-light);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.75rem;
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .action-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .action-btn.is-default {
    color: var(--accent-color);
    border-color: var(--accent-color);
  }

  .action-btn.danger:hover {
    border-color: #dc3545;
    color: #dc3545;
  }

  .action-btn.testing {
    color: var(--accent-color);
    border-color: var(--accent-color);
  }

  .action-btn.success {
    color: #28a745;
    border-color: #28a745;
  }

  .action-btn.failed {
    color: #dc3545;
    border-color: #dc3545;
  }

  /* Add section */
  .add-section {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .add-menu {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .add-option {
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: var(--font-size-sm);
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .add-option:hover {
    border-color: var(--accent-color);
    color: var(--text-primary);
  }

  .btn {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-sm);
    transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .btn-add {
    background: transparent;
    color: var(--accent-color);
    border-color: var(--accent-color);
  }

  .btn-add:hover {
    background: var(--accent-color);
    color: white;
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

  /* Edit form */
  .edit-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .form-header h4 {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .setting-label {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .setting-input {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: var(--font-sans);
  }

  .setting-input:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .setting-textarea {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-xs);
    font-family: var(--font-mono, monospace);
    resize: vertical;
    line-height: 1.5;
  }

  .setting-textarea:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .import-targets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .import-btn {
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--accent-color, #0969da);
    border-radius: 12px;
    background: transparent;
    color: var(--accent-color, #0969da);
    font-size: var(--font-size-xs);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .import-btn:hover {
    background: var(--accent-color, #0969da);
    color: #fff;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-light);
  }
</style>

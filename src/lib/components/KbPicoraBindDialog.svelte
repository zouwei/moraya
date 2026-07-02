<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import { filesStore, type KnowledgeBase } from '$lib/stores/files-store';
  import { onDestroy } from 'svelte';
  import type { ImageHostTarget } from '$lib/services/image-hosting/types';
  import type { PicoraKb, KbBinding, SyncStrategy } from '$lib/services/kb-sync/types';
  import { DEFAULT_SYNC_STRATEGY } from '$lib/services/kb-sync/types';
  import { listKbs, createKb, picoraApiBase, dryRunSync } from '$lib/services/kb-sync/sync-service';
  import type { DiffResult } from '$lib/services/kb-sync/types';

  let { kb, onClose, onBound }: {
    kb: KnowledgeBase;
    onClose: () => void;
    onBound: (binding: KbBinding) => void;
  } = $props();

  let step = $state(1);
  let picoraTargets = $state<ImageHostTarget[]>([]);
  let selectedTargetId = $state('');
  let remoteKbs = $state<PicoraKb[]>([]);
  let loadingKbs = $state(false);
  let kbsError = $state('');
  let createMode = $state(true);
  // svelte-ignore state_referenced_locally
  let newKbName = $state(kb.name);
  // svelte-ignore state_referenced_locally
  let newKbSlug = $state(slugify(kb.name));
  let selectedRemoteKbId = $state('');
  let strategy = $state<SyncStrategy>({ ...DEFAULT_SYNC_STRATEGY });
  let dryRunResult = $state<DiffResult | null>(null);
  let dryRunLoading = $state(false);
  let dryRunError = $state('');
  let userConfirmed = $state(false);
  let submitting = $state(false);

  function slugify(name: string): string {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // All-CJK / non-ASCII names strip to empty — fall back to a unique slug so
    // repeated bind attempts don't collide on the server-side auto-slug.
    if (!base) {
      const ts = Math.floor(Date.now() / 1000).toString(36);
      return `kb-${ts}`;
    }
    return base;
  }

  const unsubSettings = settingsStore.subscribe(state => {
    picoraTargets = state.imageHostTargets.filter(t => t.provider === 'picora');
    if (!selectedTargetId && picoraTargets.length > 0) {
      selectedTargetId = picoraTargets[0].id;
    }
  });
  onDestroy(() => { unsubSettings(); });

  async function loadRemoteKbs() {
    const target = picoraTargets.find(t => t.id === selectedTargetId);
    if (!target) return;
    loadingKbs = true;
    kbsError = '';
    try {
      const base = picoraApiBase(target.picoraApiUrl);
      const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
      const apiKey = await getPicoraApiKey(target);
      remoteKbs = await listKbs(base, apiKey);
    } catch (e) {
      kbsError = typeof e === 'string' ? e : 'Failed to load Knowledge Bases';
    } finally {
      loadingKbs = false;
    }
  }

  async function goToStep2() {
    await loadRemoteKbs();
    // Stay on step 1 if the KB list failed — surface the error inline so the
    // user can fix credentials / endpoint before advancing. Empty list is OK
    // (user creates a new KB on step 2).
    if (kbsError) return;
    step = 2;
  }

  async function goToStep4() {
    dryRunLoading = true;
    dryRunError = '';
    dryRunResult = null;
    try {
      const target = picoraTargets.find(t => t.id === selectedTargetId)!;
      const picoraKbId = createMode ? '__preview__' : selectedRemoteKbId;
      const tempBinding: KbBinding = {
        localKbId: kb.id,
        picoraTargetId: selectedTargetId,
        picoraKbId,
        picoraKbName: createMode ? newKbName : (remoteKbs.find(k => k.id === selectedRemoteKbId)?.name ?? ''),
        strategy,
        lastSyncAt: null,
        lastSyncReport: null,
        lastSyncError: null,
      };
      if (!createMode) {
        const result = await dryRunSync(tempBinding, kb, target);
        dryRunResult = result.diff ?? null;
      }
      step = 4;
    } catch (e) {
      dryRunError = typeof e === 'string' ? e : 'Failed to preview sync';
    } finally {
      dryRunLoading = false;
    }
  }

  /** True iff the most recent create-kb error is a duplicate name/slug. */
  let conflictRecoverable = $state(false);

  async function confirmBind() {
    if (!userConfirmed) return;
    submitting = true;
    conflictRecoverable = false;
    try {
      const target = picoraTargets.find(t => t.id === selectedTargetId)!;
      const base = picoraApiBase(target.picoraApiUrl);
      const { getPicoraApiKey } = await import('$lib/services/picora/credentials');
      const apiKey = await getPicoraApiKey(target);

      let picoraKbId: string;
      let picoraKbName: string;
      if (createMode) {
        const created = await createKb(base, apiKey, newKbName, newKbSlug || undefined);
        picoraKbId = created.id;
        picoraKbName = created.name;
      } else {
        const selected = remoteKbs.find(k => k.id === selectedRemoteKbId)!;
        picoraKbId = selected.id;
        picoraKbName = selected.name;
      }

      const binding: KbBinding = {
        localKbId: kb.id,
        picoraTargetId: selectedTargetId,
        picoraKbId,
        picoraKbName,
        strategy,
        lastSyncAt: null,
        lastSyncReport: null,
        lastSyncError: null,
      };

      filesStore.setKbBinding(kb.id, binding);
      onBound(binding);
      onClose();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Binding failed');
      dryRunError = msg;
      // Detect "create-kb" + (409 already exists / 422 validation / "exists" / "duplicate" / "conflict")
      // → offer to switch to link-existing mode and refresh the remote KB list.
      if (createMode && /create-kb/i.test(msg) && /exist|duplicat|conflict|already/i.test(msg)) {
        conflictRecoverable = true;
      }
    } finally {
      submitting = false;
    }
  }

  /** Recovery: switch to link-existing mode, reload the remote KB list,
   * pre-select the KB whose name matches the one the user tried to create. */
  async function switchToLinkExisting() {
    conflictRecoverable = false;
    dryRunError = '';
    createMode = false;
    await loadRemoteKbs();
    const match = remoteKbs.find(k => k.name === newKbName.trim());
    if (match) selectedRemoteKbId = match.id;
    step = 2;
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onkeydown={(e) => e.key === 'Escape' && onClose()} onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="bind-dialog" onclick={(e) => e.stopPropagation()}>
    <div class="dialog-header">
      <span class="dialog-icon">☁</span>
      <h3>{$t('kbSync.bindDialog.title').replace('{name}', kb.name)}</h3>
      <button class="close-btn" onclick={onClose}>&times;</button>
    </div>

    <div class="step-indicator">
      {#each [1,2,3,4] as s}
        <span class="step-dot" class:active={step >= s}></span>
      {/each}
      <span class="step-label">{$t('kbSync.bindDialog.step').replace('{current}', String(step)).replace('{total}', '4')}</span>
    </div>

    <div class="dialog-body">
      {#if step === 1}
        <h4>{$t('kbSync.bindDialog.step1Title')}</h4>
        {#if picoraTargets.length === 0}
          <p class="hint-text">{$t('kbSync.bindDialog.noPicora')}</p>
        {:else}
          <div class="target-list">
            {#each picoraTargets as target}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="target-item"
                class:selected={selectedTargetId === target.id}
                onclick={() => { selectedTargetId = target.id; }}
              >
                <span class="target-email">{target.picoraUserEmail || target.name}</span>
                <span class="target-url">{picoraApiBase(target.picoraApiUrl)}</span>
              </div>
            {/each}
          </div>
          {#if loadingKbs}
            <p class="hint-text">{$t('kbSync.bindDialog.loadingKbs')}</p>
          {:else if kbsError}
            <p class="error-text">{kbsError}</p>
          {/if}
        {/if}

      {:else if step === 2}
        <h4>{$t('kbSync.bindDialog.step2Title')}</h4>
        {#if loadingKbs}
          <p class="hint-text">{$t('kbSync.bindDialog.loadingKbs')}</p>
        {:else if kbsError}
          <p class="error-text">{kbsError}</p>
        {:else}
          <div class="radio-group">
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <label class="radio-item">
              <input type="radio" bind:group={createMode} value={true} />
              <span>{$t('kbSync.bindDialog.createNew')}</span>
            </label>
            {#if createMode}
              <div class="radio-sub">
                <label class="field-label">{$t('kbSync.bindDialog.kbName')}
                  <input class="text-input" bind:value={newKbName} oninput={() => { newKbSlug = slugify(newKbName); }} />
                </label>
                <label class="field-label">{$t('kbSync.bindDialog.kbSlug')}
                  <input class="text-input" bind:value={newKbSlug} />
                </label>
              </div>
            {/if}
          </div>
          <div class="radio-group">
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <label class="radio-item">
              <input type="radio" bind:group={createMode} value={false} />
              <span>{$t('kbSync.bindDialog.linkExisting')}</span>
            </label>
            {#if !createMode}
              <div class="radio-sub">
                <select class="select-input" bind:value={selectedRemoteKbId}>
                  <option value="">{$t('kbSync.bindDialog.selectKb')}</option>
                  {#each remoteKbs as rKb}
                    <option value={rKb.id}>{rKb.name} · {rKb.docCount} docs</option>
                  {/each}
                </select>
              </div>
            {/if}
          </div>
        {/if}

      {:else if step === 3}
        <h4>{$t('kbSync.bindDialog.step3Title')}</h4>
        <div class="form-section">
          <label class="form-label" for="kb-strategy-mode">{$t('kbSync.strategy.mode')}</label>
          <select id="kb-strategy-mode" class="select-input" bind:value={strategy.mode}>
            <option value="manual">{$t('kbSync.strategy.modeManual')}</option>
            <option value="on-save">{$t('kbSync.strategy.modeOnSave')}</option>
            <option value="interval">{$t('kbSync.strategy.modeInterval')}</option>
            <option value="on-startup-and-close">{$t('kbSync.strategy.modeStartup')}</option>
          </select>
          {#if strategy.mode === 'interval'}
            <select class="select-input" bind:value={strategy.intervalSecs}>
              <option value={60}>{$t('kbSync.strategy.interval60')}</option>
              <option value={300}>{$t('kbSync.strategy.interval300')}</option>
              <option value={900}>{$t('kbSync.strategy.interval900')}</option>
              <option value={1800}>{$t('kbSync.strategy.interval1800')}</option>
            </select>
          {/if}
        </div>
        <div class="form-section">
          <label class="form-label" for="kb-strategy-scope">{$t('kbSync.strategy.scope')}</label>
          <select id="kb-strategy-scope" class="select-input" bind:value={strategy.scope}>
            <option value="markdown-only">{$t('kbSync.strategy.scopeMdOnly')}</option>
            <option value="markdown-plus-rules">{$t('kbSync.strategy.scopeMdRules')}</option>
            <option value="all-including-hidden">{$t('kbSync.strategy.scopeAll')}</option>
          </select>
        </div>
        <div class="form-section">
          <label class="form-label" for="kb-strategy-conflict">{$t('kbSync.strategy.conflict')}</label>
          <select id="kb-strategy-conflict" class="select-input" bind:value={strategy.conflictPolicy}>
            <option value="prompt">{$t('kbSync.strategy.conflictPrompt')}</option>
            <option value="prefer-local">{$t('kbSync.strategy.conflictLocal')}</option>
            <option value="prefer-remote">{$t('kbSync.strategy.conflictRemote')}</option>
          </select>
        </div>

      {:else if step === 4}
        <h4>{$t('kbSync.bindDialog.step4Title')}</h4>
        {#if dryRunLoading}
          <p class="hint-text">{$t('kbSync.bindDialog.previewing')}</p>
        {:else if dryRunError}
          <p class="error-text">{dryRunError}</p>
          {#if conflictRecoverable}
            <button class="btn btn-ghost recovery-btn" onclick={switchToLinkExisting}>
              {$t('kbSync.bindDialog.linkExistingInstead')}
            </button>
          {/if}
        {:else if dryRunResult}
          <div class="dry-run-list">
            <div class="dry-run-item upload">↑ {$t('kbSync.bindDialog.willUpload').replace('{n}', String(dryRunResult.uploadPaths.length))}</div>
            <div class="dry-run-item download">↓ {$t('kbSync.bindDialog.willDownload').replace('{n}', String(dryRunResult.downloadPaths.length))}</div>
            <div class="dry-run-item delete">⊘ {$t('kbSync.bindDialog.willDelete').replace('{n}', String(dryRunResult.deleteLocalPaths.length + dryRunResult.deleteRemotePaths.length))}</div>
            {#if dryRunResult.skippedLarge.length > 0}
              <div class="dry-run-item skip">⚠ {$t('kbSync.bindDialog.skipped').replace('{n}', String(dryRunResult.skippedLarge.length))}</div>
              {#each dryRunResult.skippedLarge.slice(0, 3) as s}
                <div class="dry-run-sub">{s.relativePath} ({formatBytes(s.sizeBytes)})</div>
              {/each}
            {/if}
          </div>
        {:else}
          <p class="hint-text">{$t('kbSync.bindDialog.firstBindHint')}</p>
        {/if}
        <label class="confirm-check">
          <input type="checkbox" bind:checked={userConfirmed} />
          {$t('kbSync.bindDialog.confirmLabel')}
        </label>
      {/if}
    </div>

    <div class="dialog-footer">
      {#if step > 1}
        <button class="btn btn-ghost" onclick={() => { step -= 1; }}>{$t('kbSync.bindDialog.back')}</button>
      {:else}
        <button class="btn btn-ghost" onclick={onClose}>{$t('common.cancel')}</button>
      {/if}

      {#if step < 3}
        <button
          class="btn btn-primary"
          disabled={
            step === 1
              ? (!selectedTargetId || loadingKbs)
              : (createMode ? !newKbName.trim() : !selectedRemoteKbId)
          }
          onclick={step === 1 ? goToStep2 : () => { step = 3; }}
        >
          {step === 1 && loadingKbs
            ? $t('kbSync.bindDialog.loadingKbs')
            : $t('kbSync.bindDialog.next')}
        </button>
      {:else if step === 3}
        <button class="btn btn-primary" onclick={goToStep4} disabled={dryRunLoading}>
          {$t('kbSync.bindDialog.next')}
        </button>
      {:else}
        <button
          class="btn btn-primary"
          disabled={!userConfirmed || submitting}
          onclick={confirmBind}
        >
          {submitting ? $t('kbSync.bindDialog.binding') : $t('kbSync.bindDialog.startSync')}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }

  .bind-dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    width: 520px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 12px 40px rgba(0,0,0,0.25);
  }

  .dialog-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }

  .dialog-icon { font-size: 1.1rem; }

  .dialog-header h3 {
    margin: 0;
    flex: 1;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0 0.25rem;
    line-height: 1;
  }

  .step-indicator {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }

  .step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border-color);
    transition: background 0.2s;
  }

  .step-dot.active {
    background: var(--accent-color);
  }

  .step-label {
    margin-left: 0.5rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .dialog-body {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
  }

  .dialog-body h4 {
    margin: 0 0 0.75rem;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .hint-text {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .error-text {
    color: var(--color-error, #e53e3e);
    font-size: var(--font-size-sm);
  }

  .recovery-btn {
    margin-top: 0.5rem;
    align-self: flex-start;
  }

  .target-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .target-item {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }

  .target-item.selected {
    border-color: var(--accent-color);
    background: color-mix(in srgb, var(--accent-color) 8%, transparent);
  }

  .target-email {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .target-url {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .radio-group {
    margin-bottom: 0.75rem;
  }

  .radio-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
  }

  .radio-sub {
    margin: 0.5rem 0 0 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .field-label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .text-input, .select-input {
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    width: 100%;
  }

  .text-input:focus, .select-input:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .form-section {
    margin-bottom: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .form-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-weight: 600;
  }

  .dry-run-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 1rem;
  }

  .dry-run-item {
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    font-size: var(--font-size-sm);
  }

  .dry-run-item.upload { background: color-mix(in srgb, #3b82f6 10%, transparent); color: #3b82f6; }
  .dry-run-item.download { background: color-mix(in srgb, #10b981 10%, transparent); color: #10b981; }
  .dry-run-item.delete { background: color-mix(in srgb, #ef4444 10%, transparent); color: #ef4444; }
  .dry-run-item.skip { background: color-mix(in srgb, #f59e0b 10%, transparent); color: #f59e0b; }

  .dry-run-sub {
    padding: 0.1rem 0.6rem;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .confirm-check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    cursor: pointer;
    margin-top: 0.5rem;
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-light);
  }

  .btn {
    padding: 0.4rem 1rem;
    border-radius: 5px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    border: 1px solid transparent;
    transition: opacity 0.15s;
  }

  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-ghost {
    background: transparent;
    border-color: var(--border-color);
    color: var(--text-secondary);
  }

  .btn-primary {
    background: var(--accent-color);
    color: white;
  }

  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
</style>

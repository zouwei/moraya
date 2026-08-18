<script lang="ts">
  import { onDestroy } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { ask } from '$lib/utils/native-dialog';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { ImageHostTarget } from '$lib/services/image-hosting';

  const tr = $t;
  const PICORA_DEFAULT_API_BASE = 'https://api.picora.me';

  let picoraTargets = $state<ImageHostTarget[]>([]);
  let defaultPicoraId = $state('');

  const unsub = settingsStore.subscribe(s => {
    picoraTargets = (s.imageHostTargets || []).filter(t => t.provider === 'picora');
    defaultPicoraId = s.defaultPicoraAccountId || '';
  });
  onDestroy(() => { unsub(); });

  let defaultTarget = $derived(picoraTargets.find(t => t.id === defaultPicoraId) ?? picoraTargets[0]);

  let loading = $state(false);
  let loadError = $state('');
  let enabled = $state(false);
  let maxVersions = $state(10);
  let revisionCount = $state<number | null>(null);
  let revisionBytes = $state<number | null>(null);
  let saving = $state(false);
  let clearing = $state(false);
  let clearResult = $state('');

  let loadedForTargetId = '';

  function apiBaseFor(target: ImageHostTarget): string {
    const url = (target.picoraApiUrl || '').trim();
    if (!url) return PICORA_DEFAULT_API_BASE;
    return url.replace(/\/v1\/images\/?$/, '').replace(/\/$/, '') || PICORA_DEFAULT_API_BASE;
  }

  async function credsFor(target: ImageHostTarget): Promise<{ apiBase: string; apiKey: string }> {
    const { getPicoraApiKeyOrEmpty } = await import('$lib/services/picora/credentials');
    return { apiBase: apiBaseFor(target), apiKey: await getPicoraApiKeyOrEmpty(target) };
  }

  async function load(target: ImageHostTarget) {
    loading = true;
    loadError = '';
    clearResult = '';
    try {
      const { apiBase, apiKey } = await credsFor(target);
      const [user, quota] = await Promise.all([
        invoke<{ docVersioningEnabled?: boolean; docVersioningMax?: number }>(
          'verify_picora_token', { apiBase, apiKey }
        ),
        invoke<{ docs?: { revisionCount?: number; revisionBytes?: number } | null }>(
          'picora_get_quota', { apiBase, apiKey }
        ).catch(() => null),
      ]);
      enabled = user.docVersioningEnabled === true;
      maxVersions = user.docVersioningMax ?? 10;
      revisionCount = quota?.docs?.revisionCount ?? null;
      revisionBytes = quota?.docs?.revisionBytes ?? null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
    loading = false;
  }

  // Auto-load once per selected account (schedule, don't await — UI renders immediately)
  $effect(() => {
    const target = defaultTarget;
    if (target && loadedForTargetId !== target.id) {
      loadedForTargetId = target.id;
      setTimeout(() => load(target), 0);
    }
  });

  async function saveSettings(patch: { docVersioningEnabled?: boolean; docVersioningMax?: number }) {
    if (!defaultTarget) return;
    saving = true;
    try {
      const { apiBase, apiKey } = await credsFor(defaultTarget);
      await invoke('picora_update_user_settings', { apiBase, apiKey, ...patch });
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      // Reload to re-align UI with the server state after a failed write
      await load(defaultTarget);
    }
    saving = false;
  }

  function handleToggle(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    enabled = checked;
    saveSettings({ docVersioningEnabled: checked });
  }

  function handleMaxChange(e: Event) {
    const val = parseInt((e.target as HTMLInputElement).value, 10);
    if (Number.isNaN(val) || val < 1 || val > 500) return;
    maxVersions = val;
    saveSettings({ docVersioningMax: val });
  }

  async function handleClear() {
    if (!defaultTarget || clearing) return;
    const confirmed = await ask(tr('settings.picora.doc_versioning.clear_confirm'), {
      title: tr('settings.picora.doc_versioning.clear'),
      kind: 'warning',
    });
    if (!confirmed) return;
    clearing = true;
    clearResult = '';
    try {
      const { apiBase, apiKey } = await credsFor(defaultTarget);
      const result = await invoke<{ deleted: number; freedBytes: number }>(
        'picora_clear_doc_revisions', { apiBase, apiKey }
      );
      clearResult = tr('settings.picora.doc_versioning.cleared', {
        count: String(result.deleted),
        size: formatBytes(result.freedBytes),
      });
      revisionCount = 0;
      revisionBytes = 0;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
    clearing = false;
  }

  function formatBytes(bytes: number | null): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<section class="docver-section">
  <header class="section-header">
    <h3>{tr('settings.picora.doc_versioning.title')}</h3>
  </header>
  <p class="hint">{tr('settings.picora.doc_versioning.desc')}</p>

  {#if !defaultTarget}
    <p class="hint">{tr('settings.picora.doc_versioning.no_account')}</p>
  {:else if loading}
    <p class="hint">…</p>
  {:else}
    {#if loadError}
      <p class="error">{loadError}</p>
    {/if}

    <label class="toggle-row">
      <input type="checkbox" checked={enabled} disabled={saving} onchange={handleToggle} />
      <span>{tr('settings.picora.doc_versioning.enable')}</span>
    </label>
    <p class="hint hint-indent">{tr('settings.picora.doc_versioning.enable_hint')}</p>

    {#if enabled}
      <div class="field-inline">
        <label for="picora-docver-max">{tr('settings.picora.doc_versioning.max')}</label>
        <input
          id="picora-docver-max"
          type="number"
          min="1" max="500"
          value={maxVersions}
          disabled={saving}
          onchange={handleMaxChange}
        />
      </div>
    {/if}

    <div class="usage-row">
      <span class="usage-label">{tr('settings.picora.doc_versioning.usage')}</span>
      <span class="usage-value">
        {revisionCount ?? '—'} · {formatBytes(revisionBytes)}
      </span>
      <button class="btn-clear" onclick={handleClear} disabled={clearing || (revisionCount ?? 0) === 0}>
        {clearing ? '…' : tr('settings.picora.doc_versioning.clear')}
      </button>
    </div>
    {#if clearResult}
      <p class="hint">{clearResult}</p>
    {/if}
  {/if}
</section>

<style>
  .docver-section { display: flex; flex-direction: column; gap: 0.6rem; }
  .section-header h3 { margin: 0; font-size: var(--font-size-base); font-weight: 600; color: var(--text-primary); }
  .hint { margin: 0; font-size: var(--font-size-xs); color: var(--text-muted); }
  .hint-indent { margin-left: 1.6rem; }
  .error { margin: 0; font-size: var(--font-size-xs); color: var(--color-error, #e53e3e); word-break: break-all; }
  .toggle-row { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: var(--font-size-sm); color: var(--text-secondary); }
  .field-inline { display: flex; align-items: center; gap: 0.5rem; margin-left: 1.6rem; }
  .field-inline label { font-size: var(--font-size-xs); color: var(--text-muted); }
  .field-inline input {
    width: 5.5rem;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }
  .usage-row { display: flex; align-items: center; gap: 0.6rem; font-size: var(--font-size-sm); }
  .usage-label { color: var(--text-muted); font-size: var(--font-size-xs); }
  .usage-value { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .btn-clear {
    padding: 0.2rem 0.6rem;
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-muted);
    border-radius: 4px;
    cursor: pointer;
    font-size: var(--font-size-xs);
  }
  .btn-clear:hover:not(:disabled) { color: var(--color-error, #e53e3e); border-color: var(--color-error, #e53e3e); }
  .btn-clear:disabled { opacity: 0.5; cursor: default; }
</style>

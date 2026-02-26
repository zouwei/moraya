<script lang="ts">
  import { settingsStore } from '$lib/stores/settings-store';
  import { t } from '$lib/i18n';
  import { invoke } from '@tauri-apps/api/core';
  import { testSpeechConnection } from '$lib/services/voice/speech-service';
  import {
    SPEECH_PROVIDER_MODELS,
    SPEECH_PROVIDER_NAMES,
    SPEECH_PROVIDER_BASE_URLS,
    type SpeechProvider,
    type SpeechProviderConfig,
  } from '$lib/services/ai/types';
  import type { VoiceProfile } from '$lib/services/voice/types';

  // ── State ──────────────────────────────────────────────────────────────────

  let configs = $derived($settingsStore.speechProviderConfigs ?? []);
  let activeId = $derived($settingsStore.activeSpeechConfigId);
  let voiceProfiles = $derived($settingsStore.voiceProfiles ?? []);
  let recordingBackupDir = $derived($settingsStore.recordingBackupDir);
  let voiceSyncDir = $derived($settingsStore.voiceSyncDir);

  // ── Default directory paths (loaded async from Tauri APIs) ──────────────
  let defaultSyncDir = $state('');
  let defaultRecordingDir = $state('');

  $effect(() => {
    import('@tauri-apps/api/path').then(async ({ appDataDir, documentDir }) => {
      const [appData, docs] = await Promise.all([appDataDir(), documentDir()]);
      const sep = (p: string) => (p.endsWith('/') || p.endsWith('\\') ? '' : '/');
      defaultSyncDir = appData + sep(appData) + 'voice-profiles';
      defaultRecordingDir = docs + sep(docs) + 'Moraya Recordings';
    });
  });

  // ── Recording backup toggle ────────────────────────────────────────────
  let backupEnabled = $derived(recordingBackupDir !== null);

  async function toggleBackup(enabled: boolean) {
    if (enabled) {
      let dir = defaultRecordingDir;
      if (!dir) {
        const { documentDir } = await import('@tauri-apps/api/path');
        const d = await documentDir();
        dir = d + (d.endsWith('/') || d.endsWith('\\') ? '' : '/') + 'Moraya Recordings';
        defaultRecordingDir = dir;
      }
      settingsStore.update({ recordingBackupDir: dir });
    } else {
      settingsStore.update({ recordingBackupDir: null });
    }
  }

  async function changeBackupDir() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true });
    if (dir) settingsStore.update({ recordingBackupDir: dir as string });
  }

  // ── Voice sync directory (with file migration) ─────────────────────────
  let migrating = $state(false);
  let migrationError = $state('');

  async function changeSyncDir() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const newDir = await open({ directory: true });
    if (!newDir) return;

    const oldDir = voiceSyncDir ?? defaultSyncDir;
    migrating = true;
    migrationError = '';

    try {
      await invoke('migrate_voice_profiles_dir', { oldDir, newDir: newDir as string });

      // Update samplePath in each profile to reflect the new directory prefix.
      const normOld = oldDir.replace(/\\/g, '/').replace(/\/$/, '');
      const normNew = (newDir as string).replace(/\\/g, '/').replace(/\/$/, '');
      const updatedProfiles = ($settingsStore.voiceProfiles ?? []).map(p => {
        const normSample = p.samplePath.replace(/\\/g, '/');
        if (normSample.startsWith(normOld + '/')) {
          return { ...p, samplePath: normNew + normSample.slice(normOld.length), updatedAt: Date.now() };
        }
        return p;
      });

      settingsStore.update({ voiceSyncDir: newDir as string, voiceProfiles: updatedProfiles });
    } catch (e) {
      migrationError = e instanceof Error ? e.message : String(e);
    } finally {
      migrating = false;
    }
  }

  // Form for adding/editing a config
  let editingId = $state<string | null>(null);
  let form = $state<Omit<SpeechProviderConfig, 'id'>>({
    provider: 'deepgram',
    apiKey: '',
    baseUrl: '',
    model: 'nova-3',
    language: 'zh',
    region: '',
    awsAccessKey: '',
    awsSecretKey: '',
  });
  let showAddForm = $state(false);
  let testStatus = $state<'idle' | 'testing' | 'ok' | 'error'>('idle');
  let testError = $state('');

  const PROVIDERS: { value: SpeechProvider; label: string }[] = [
    { value: 'deepgram', label: 'Deepgram' },
    { value: 'gladia', label: 'Gladia' },
    { value: 'assemblyai', label: 'AssemblyAI' },
    { value: 'azure-speech', label: 'Azure Speech' },
    { value: 'aws-transcribe', label: 'AWS Transcribe' },
    { value: 'custom', label: $t('settings.voice.custom') },
  ];

  const LANGUAGES = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
    { value: 'auto', label: $t('settings.voice.langAuto') },
    { value: 'multi', label: $t('settings.voice.langMulti') },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
    { value: 'fr', label: 'Français' },
    { value: 'de', label: 'Deutsch' },
    { value: 'es', label: 'Español' },
  ];

  let availableModels = $derived(SPEECH_PROVIDER_MODELS[form.provider] ?? []);

  function onProviderChange() {
    const models = SPEECH_PROVIDER_MODELS[form.provider];
    form.model = models[0] ?? '';
    form.baseUrl = '';
    testStatus = 'idle';
  }

  // ── CRUD operations ────────────────────────────────────────────────────────

  function startAdd() {
    editingId = null;
    form = {
      provider: 'deepgram',
      apiKey: '',
      baseUrl: '',
      model: 'nova-3',
      language: 'zh',
      region: '',
      awsAccessKey: '',
      awsSecretKey: '',
    };
    showAddForm = true;
    testStatus = 'idle';
    testError = '';
  }

  function startEdit(cfg: SpeechProviderConfig) {
    editingId = cfg.id;
    form = {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl ?? '',
      model: cfg.model,
      language: cfg.language,
      region: cfg.region ?? '',
      awsAccessKey: cfg.awsAccessKey ?? '',
      awsSecretKey: cfg.awsSecretKey ?? '',
    };
    showAddForm = true;
    testStatus = 'idle';
    testError = '';
  }

  function cancelForm() {
    showAddForm = false;
    editingId = null;
    testStatus = 'idle';
    testError = '';
  }

  function saveConfig() {
    if (!form.apiKey.trim() && form.provider !== 'custom') return;

    const existing = $settingsStore.speechProviderConfigs ?? [];

    if (editingId) {
      // Update existing
      const updated = existing.map(c =>
        c.id === editingId ? { ...c, ...form } : c,
      );
      settingsStore.update({ speechProviderConfigs: updated });
    } else {
      // Add new
      const newCfg: SpeechProviderConfig = {
        id: crypto.randomUUID(),
        ...form,
      };
      const updated = [...existing, newCfg];
      settingsStore.update({
        speechProviderConfigs: updated,
        activeSpeechConfigId: $settingsStore.activeSpeechConfigId ?? newCfg.id,
      });
    }

    cancelForm();
  }

  function deleteConfig(id: string) {
    const updated = ($settingsStore.speechProviderConfigs ?? []).filter(c => c.id !== id);
    const newActive = $settingsStore.activeSpeechConfigId === id
      ? (updated[0]?.id ?? null)
      : $settingsStore.activeSpeechConfigId;
    settingsStore.update({ speechProviderConfigs: updated, activeSpeechConfigId: newActive });
  }

  function setActive(id: string) {
    settingsStore.update({ activeSpeechConfigId: id });
  }

  // ── Test connection ────────────────────────────────────────────────────────

  async function testConnection() {
    if (!form.apiKey.trim()) return;
    testStatus = 'testing';
    testError = '';

    // Build a temporary config with the current form values for connection testing.
    // The actual API key is written to Keychain inside testSpeechConnection.
    const testCfg: SpeechProviderConfig = { id: '__test__', ...form };

    try {
      await testSpeechConnection(testCfg);
      testStatus = 'ok';
    } catch (e: unknown) {
      testStatus = 'error';
      testError = e instanceof Error ? e.message : String(e);
    }
  }

  // ── Voice profiles ─────────────────────────────────────────────────────────

  let editingProfileId = $state<string | null>(null);
  let editingNickname = $state('');
  let playingProfileId = $state<string | null>(null);
  let currentAudio: HTMLAudioElement | null = null;

  async function playSample(profile: VoiceProfile) {
    if (!profile.samplePath) return;

    // Toggle: if same profile is already playing, stop it
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (playingProfileId === profile.id) {
      playingProfileId = null;
      return;
    }

    try {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const data = await readFile(profile.samplePath);
      const blob = new Blob([data], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      playingProfileId = profile.id;
      currentAudio = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        playingProfileId = null;
        currentAudio = null;
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        playingProfileId = null;
        currentAudio = null;
      };
      await audio.play();
    } catch {
      playingProfileId = null;
      currentAudio = null;
    }
  }

  function startEditProfile(p: VoiceProfile) {
    editingProfileId = p.id;
    editingNickname = p.nickname;
  }

  function saveProfileNickname(id: string) {
    const updated = ($settingsStore.voiceProfiles ?? []).map(p =>
      p.id === id ? { ...p, nickname: editingNickname, updatedAt: Date.now() } : p,
    );
    settingsStore.update({ voiceProfiles: updated });
    editingProfileId = null;
  }

  function deleteProfile(id: string) {
    const updated = ($settingsStore.voiceProfiles ?? []).filter(p => p.id !== id);
    settingsStore.update({ voiceProfiles: updated });
  }
</script>

<div class="voice-settings">
  <!-- ── Speech Provider Section ─────────────────────────────────────────── -->
  <section class="settings-section">
    <div class="section-header">
      <h3 class="section-title">{$t('settings.voice.providers')}</h3>
      <button class="add-btn" onclick={startAdd}>+ {$t('settings.voice.addProvider')}</button>
    </div>

    {#if configs.length === 0 && !showAddForm}
      <p class="empty-hint">{$t('settings.voice.noProviders')}</p>
    {/if}

    {#each configs as cfg (cfg.id)}
      {#if editingId === cfg.id}
        <!-- Edit form replaces the card inline (same pattern as AI settings) -->
        <div class="config-form">
          <div class="field">
            <label>{$t('settings.voice.provider')}</label>
            <select bind:value={form.provider} onchange={onProviderChange}>
              {#each PROVIDERS as p}
                <option value={p.value}>{p.label}</option>
              {/each}
            </select>
          </div>
          <div class="field">
            <label>{$t('settings.voice.apiKey')}</label>
            <input
              type="password"
              bind:value={form.apiKey}
              placeholder={form.provider === 'aws-transcribe' ? $t('settings.voice.apiKeyOptional') : ''}
            />
          </div>
          {#if form.provider === 'aws-transcribe'}
            <div class="field">
              <label>{$t('settings.voice.awsAccessKey')}</label>
              <input type="password" bind:value={form.awsAccessKey} />
            </div>
            <div class="field">
              <label>{$t('settings.voice.awsSecretKey')}</label>
              <input type="password" bind:value={form.awsSecretKey} />
            </div>
          {/if}
          {#if form.provider === 'azure-speech' || form.provider === 'aws-transcribe'}
            <div class="field">
              <label>{$t('settings.voice.region')}</label>
              <input
                type="text"
                bind:value={form.region}
                placeholder={form.provider === 'azure-speech' ? 'eastus' : 'us-east-1'}
              />
            </div>
          {/if}
          <div class="field">
            <label>{$t('settings.voice.model')}</label>
            <input
              list="voice-model-list-{form.provider}"
              type="text"
              bind:value={form.model}
              placeholder={$t('settings.voice.modelPlaceholder')}
            />
            <datalist id="voice-model-list-{form.provider}">
              {#each availableModels as m}
                <option value={m} />
              {/each}
            </datalist>
          </div>
          <div class="field">
            <label>{$t('settings.voice.language')}</label>
            <select bind:value={form.language}>
              {#each LANGUAGES as lang}
                <option value={lang.value}>{lang.label}</option>
              {/each}
            </select>
          </div>
          {#if form.provider === 'custom'}
            <div class="field">
              <label>{$t('settings.voice.baseUrl')}</label>
              <input type="text" bind:value={form.baseUrl} placeholder="wss://..." />
            </div>
          {/if}
          <div class="form-footer">
            <div class="test-row">
              <button
                class="test-btn"
                onclick={testConnection}
                disabled={testStatus === 'testing' || (!form.apiKey.trim() && form.provider !== 'custom')}
              >
                {testStatus === 'testing' ? $t('settings.voice.testing') : $t('settings.voice.testConnection')}
              </button>
              {#if testStatus === 'ok'}
                <span class="test-ok">✓ {$t('settings.voice.testOk')}</span>
              {:else if testStatus === 'error'}
                <span class="test-error">✕ {testError || $t('settings.voice.testFailed')}</span>
              {/if}
            </div>
            <div class="form-actions">
              <button class="cancel-btn" onclick={cancelForm}>{$t('common.cancel')}</button>
              <button class="save-btn" onclick={saveConfig}>{$t('common.save')}</button>
            </div>
          </div>
        </div>
      {:else}
        <div class="config-card" class:active={cfg.id === activeId}>
          <div class="config-card-header">
            <div class="config-info">
              <span class="provider-name">{SPEECH_PROVIDER_NAMES[cfg.provider] ?? cfg.provider}</span>
              <span class="model-tag">{cfg.model}</span>
              <span class="lang-tag">{cfg.language}</span>
            </div>
            <div class="config-actions">
              {#if cfg.id !== activeId}
                <button class="btn-sm" onclick={() => setActive(cfg.id)}>{$t('settings.voice.setActive')}</button>
              {:else}
                <span class="active-badge">{$t('settings.voice.active')}</span>
              {/if}
              <button class="icon-btn" onclick={() => startEdit(cfg)} title={$t('common.edit')}>✎</button>
              <button class="icon-btn danger" onclick={() => deleteConfig(cfg.id)} title={$t('common.delete')}>✕</button>
            </div>
          </div>
        </div>
      {/if}
    {/each}

    <!-- Add new provider form (shown after list) -->
    {#if showAddForm && !editingId}
      <div class="config-form">
        <div class="field">
          <label>{$t('settings.voice.provider')}</label>
          <select bind:value={form.provider} onchange={onProviderChange}>
            {#each PROVIDERS as p}
              <option value={p.value}>{p.label}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label>{$t('settings.voice.apiKey')}</label>
          <input
            type="password"
            bind:value={form.apiKey}
            placeholder={form.provider === 'aws-transcribe' ? $t('settings.voice.apiKeyOptional') : ''}
          />
        </div>
        {#if form.provider === 'aws-transcribe'}
          <div class="field">
            <label>{$t('settings.voice.awsAccessKey')}</label>
            <input type="password" bind:value={form.awsAccessKey} />
          </div>
          <div class="field">
            <label>{$t('settings.voice.awsSecretKey')}</label>
            <input type="password" bind:value={form.awsSecretKey} />
          </div>
        {/if}
        {#if form.provider === 'azure-speech' || form.provider === 'aws-transcribe'}
          <div class="field">
            <label>{$t('settings.voice.region')}</label>
            <input
              type="text"
              bind:value={form.region}
              placeholder={form.provider === 'azure-speech' ? 'eastus' : 'us-east-1'}
            />
          </div>
        {/if}
        <div class="field">
          <label>{$t('settings.voice.model')}</label>
          {#if availableModels.length > 0}
            <select bind:value={form.model}>
              {#each availableModels as m}
                <option value={m}>{m}</option>
              {/each}
            </select>
          {:else}
            <input type="text" bind:value={form.model} placeholder={$t('settings.voice.modelPlaceholder')} />
          {/if}
        </div>
        <div class="field">
          <label>{$t('settings.voice.language')}</label>
          <select bind:value={form.language}>
            {#each LANGUAGES as lang}
              <option value={lang.value}>{lang.label}</option>
            {/each}
          </select>
        </div>
        {#if form.provider === 'custom'}
          <div class="field">
            <label>{$t('settings.voice.baseUrl')}</label>
            <input type="text" bind:value={form.baseUrl} placeholder="wss://..." />
          </div>
        {/if}
        <div class="form-footer">
          <div class="test-row">
            <button
              class="test-btn"
              onclick={testConnection}
              disabled={testStatus === 'testing' || (!form.apiKey.trim() && form.provider !== 'custom')}
            >
              {testStatus === 'testing' ? $t('settings.voice.testing') : $t('settings.voice.testConnection')}
            </button>
            {#if testStatus === 'ok'}
              <span class="test-ok">✓ {$t('settings.voice.testOk')}</span>
            {:else if testStatus === 'error'}
              <span class="test-error">✕ {testError || $t('settings.voice.testFailed')}</span>
            {/if}
          </div>
          <div class="form-actions">
            <button class="cancel-btn" onclick={cancelForm}>{$t('common.cancel')}</button>
            <button class="save-btn" onclick={saveConfig}>{$t('common.save')}</button>
          </div>
        </div>
      </div>
    {/if}
  </section>

  <!-- ── Storage Settings ────────────────────────────────────────────────── -->
  <section class="settings-section">
    <h3 class="section-title">{$t('settings.voice.storage')}</h3>

    <!-- Recording Backup: toggle (default off) + conditional directory row -->
    <div class="field">
      <div class="toggle-row">
        <div class="toggle-text">
          <span class="field-label">{$t('settings.voice.recordingBackupDir')}</span>
          <p class="field-hint">{$t('settings.voice.recordingBackupHint')}</p>
        </div>
        <label class="toggle-switch">
          <input
            type="checkbox"
            checked={backupEnabled}
            onchange={(e) => toggleBackup((e.target as HTMLInputElement).checked)}
          />
          <span class="toggle-track"></span>
        </label>
      </div>
      {#if backupEnabled}
        <div class="path-row sub-row">
          <span class="path-text">{recordingBackupDir || defaultRecordingDir || '...'}</span>
          <button class="path-btn" onclick={changeBackupDir}>{$t('common.browse')}</button>
        </div>
      {/if}
    </div>

    <!-- Voice Sync Dir: always shown, Change migrates files to new location -->
    <div class="field">
      <label>{$t('settings.voice.voiceSyncDir')}</label>
      <div class="path-row">
        <span class="path-text">{voiceSyncDir || defaultSyncDir || $t('settings.voice.syncDefault')}</span>
        <button class="path-btn" onclick={changeSyncDir} disabled={migrating}>
          {migrating ? $t('settings.voice.migratingProfiles') : $t('common.browse')}
        </button>
        {#if voiceSyncDir}
          <button class="path-btn danger" onclick={() => settingsStore.update({ voiceSyncDir: null })}>
            {$t('common.clear')}
          </button>
        {/if}
      </div>
      {#if migrationError}
        <p class="field-hint error">{$t('settings.voice.migrationFailed')}: {migrationError}</p>
      {:else}
        <p class="field-hint">{$t('settings.voice.voiceSyncHint')}</p>
      {/if}
    </div>
  </section>

  <!-- ── Voice Profiles Section ──────────────────────────────────────────── -->
  <section class="settings-section">
    <h3 class="section-title">{$t('settings.voice.profiles')}</h3>

    {#if voiceProfiles.length === 0}
      <p class="empty-hint">{$t('settings.voice.noProfiles')}</p>
    {:else}
      {#each voiceProfiles as profile (profile.id)}
        <div class="profile-card">
          <span class="profile-dot" style="background: {profile.color}"></span>
          <div class="profile-info">
            {#if editingProfileId === profile.id}
              <input
                class="nickname-input"
                bind:value={editingNickname}
                onkeydown={(e) => e.key === 'Enter' && saveProfileNickname(profile.id)}
              />
              <button class="icon-btn small" onclick={() => saveProfileNickname(profile.id)}>✓</button>
              <button class="icon-btn small" onclick={() => editingProfileId = null}>✕</button>
            {:else}
              <span class="profile-nickname">{profile.nickname || profile.autoName}</span>
              <span class="profile-auto">{profile.autoName}</span>
              <span class="profile-gender">{profile.gender}</span>
              {#if profile.samplePath}
                <button
                  class="icon-btn small"
                  class:playing={playingProfileId === profile.id}
                  onclick={() => playSample(profile)}
                  title={playingProfileId === profile.id ? $t('common.stop') : $t('common.play')}
                >
                  {playingProfileId === profile.id ? '■' : '▶'}
                </button>
              {/if}
              <button class="icon-btn small" onclick={() => startEditProfile(profile)} title={$t('common.edit')}>✎</button>
              <button class="icon-btn danger small" onclick={() => deleteProfile(profile.id)} title={$t('common.delete')}>✕</button>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </section>
</div>

<style>
  .voice-settings {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 0.5rem 0;
  }

  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .section-title {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-secondary);
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* Provider card */
  .config-card {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
    background: var(--bg-primary);
  }

  .config-card.active {
    border-color: var(--accent-color);
  }

  .config-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .config-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .provider-name {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .model-tag,
  .lang-tag {
    font-size: 10px;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    background: var(--bg-hover);
    color: var(--text-muted);
  }

  .config-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .active-badge {
    font-size: 10px;
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    background: var(--accent-color);
    color: white;
  }

  /* Inline config form (add / edit) — matches AISettings .config-form style */
  .config-form {
    border: 1px solid var(--accent-color);
    border-radius: 8px;
    padding: 0.75rem;
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .form-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field label {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    font-weight: 500;
  }

  .field input,
  .field select {
    padding: 0.3rem 0.5rem;
    font-size: var(--font-size-sm);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    outline: none;
  }

  .field input:focus,
  .field select:focus {
    border-color: var(--accent-color);
  }

  .field-hint {
    font-size: 10px;
    color: var(--text-muted);
    margin: 0;
  }

  .test-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .test-btn {
    padding: 0.25rem 0.75rem;
    font-size: var(--font-size-xs);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .test-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .test-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .test-ok {
    font-size: var(--font-size-xs);
    color: #38a169;
  }

  .test-error {
    font-size: var(--font-size-xs);
    color: #e53e3e;
  }

  .form-actions {
    display: flex;
    gap: 0.25rem;
  }

  .save-btn {
    padding: 0.3rem 0.75rem;
    font-size: var(--font-size-sm);
    border: none;
    border-radius: 6px;
    background: var(--accent-color);
    color: white;
    cursor: pointer;
  }

  .save-btn:hover {
    opacity: 0.85;
  }

  .cancel-btn {
    padding: 0.3rem 0.75rem;
    font-size: var(--font-size-sm);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .cancel-btn:hover {
    background: var(--bg-hover);
  }

  .add-btn {
    padding: 0.2rem 0.6rem;
    font-size: var(--font-size-xs);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .add-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .empty-hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin: 0;
    padding: 0.5rem 0;
  }

  /* Text buttons (matches AI settings style) */
  .btn-sm {
    padding: 0.2rem 0.45rem;
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-secondary);
    border-radius: 4px;
    font-size: var(--font-size-xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-sm:hover {
    border-color: var(--accent-color);
    color: var(--text-primary);
  }

  /* Icon buttons */
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
    transition: background var(--transition-fast);
  }

  .icon-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .icon-btn.danger:hover {
    border-color: #e53e3e;
    color: #e53e3e;
  }

  .icon-btn.playing {
    border-color: var(--accent-color);
    color: var(--accent-color);
  }

  .icon-btn.small {
    width: 1.25rem;
    height: 1.25rem;
    font-size: 10px;
  }

  /* Path row */
  .path-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .path-text {
    flex: 1;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .path-btn {
    padding: 0.2rem 0.5rem;
    font-size: var(--font-size-xs);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }

  .path-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .path-btn.danger:hover {
    border-color: #e53e3e;
    color: #e53e3e;
  }

  /* Voice profile cards */
  .profile-card {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
  }

  .profile-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .profile-info {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }

  .profile-nickname {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .profile-auto,
  .profile-gender {
    font-size: 10px;
    color: var(--text-muted);
    background: var(--bg-hover);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }

  .nickname-input {
    flex: 1;
    padding: 0.15rem 0.35rem;
    font-size: var(--font-size-sm);
    border: 1px solid var(--accent-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    outline: none;
  }

  /* Toggle switch (Recording Backup enable/disable) */
  .toggle-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .toggle-text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .field-label {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    font-weight: 500;
  }

  .toggle-switch {
    position: relative;
    display: inline-block;
    width: 32px;
    height: 18px;
    flex-shrink: 0;
    margin-top: 1px;
    cursor: pointer;
  }

  .toggle-switch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-track {
    position: absolute;
    inset: 0;
    background: var(--border-color);
    border-radius: 18px;
    transition: background var(--transition-fast);
  }

  .toggle-track::before {
    content: '';
    position: absolute;
    width: 12px;
    height: 12px;
    left: 3px;
    bottom: 3px;
    background: white;
    border-radius: 50%;
    transition: transform var(--transition-fast);
  }

  .toggle-switch input:checked + .toggle-track {
    background: var(--accent-color);
  }

  .toggle-switch input:checked + .toggle-track::before {
    transform: translateX(14px);
  }

  /* Directory row shown when backup is enabled */
  .sub-row {
    margin-top: 0.35rem;
  }

  /* Error state for field hint */
  .field-hint.error {
    color: #e53e3e;
  }
</style>

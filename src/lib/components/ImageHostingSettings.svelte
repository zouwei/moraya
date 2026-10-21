<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { PICORA_KEY_MASK, hasStoredPicoraApiKey } from '$lib/services/picora/credentials';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { ImageHostTarget, ImageHostProvider, GitHubCdnMode } from '$lib/services/image-hosting';
  import { createDefaultImageHostTarget, targetToConfig, uploadImage, isObjectStorageProvider } from '$lib/services/image-hosting';
  import { invoke } from '@tauri-apps/api/core';
  import { PICORA_DEFAULT_API_BASE } from '$lib/services/image-hosting';
  import { Select } from '$lib/components/ui';

  let { onImportPicora, onJumpToPicora }: { onImportPicora?: () => void; onJumpToPicora?: () => void } = $props();

  const tr = $t;

  let targets = $state<ImageHostTarget[]>([]);
  let defaultId = $state('');
  let editingTarget = $state<ImageHostTarget | null>(null);
  let showAddMenu = $state(false);
  let showOtherProviders = $state(false);
  let testStatus = $state<Record<string, 'idle' | 'testing' | 'success' | 'failed'>>({});
  let testError = $state<Record<string, string>>({});

  // Publish targets for quick import (GitHub only)
  let publishTargets = $state<Array<{ type: string; name: string; repoUrl?: string; branch?: string; token?: string }>>([]);

  // Top-level store subscription — do NOT wrap in $effect().
  // Svelte 5 $effect tracks reads in subscribe callbacks, causing infinite loops.
  const unsubSettings = settingsStore.subscribe(state => {
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
  onDestroy(() => { unsubSettings(); });

  const PROVIDER_ICONS: Record<ImageHostProvider, string> = {
    picora: '⭐',
    smms: '🟠',
    imgur: '🟢',
    github: '🔵',
    gitlab: '🟤',
    'git-custom': '⚪',
    custom: '🟣',
    qiniu: '🟡',
    'aliyun-oss': '🔴',
    'tencent-cos': '🔵',
    'aws-s3': '⬛',
    'google-gcs': '🌐',
  };

  /** Sorted view: featured / Picora targets pinned to the top, rest in insertion order. */
  const sortedTargets = $derived(
    [...targets].sort((a, b) => {
      const aFeatured = a.featured || a.provider === 'picora' ? 0 : 1;
      const bFeatured = b.featured || b.provider === 'picora' ? 0 : 1;
      return aFeatured - bFeatured;
    })
  );

  function providerLabel(provider: ImageHostProvider): string {
    return tr(`image_host.${provider.replace(/-/g, '_')}`);
  }

  function addTarget(provider: ImageHostProvider) {
    editingTarget = createDefaultImageHostTarget(provider);
    showAddMenu = false;
  }

  /** Whether a Picora key is really stored for the target being edited (null = checking / n.a.). */
  let editingKeyStored = $state<boolean | null>(null);

  function editTarget(target: ImageHostTarget) {
    editingTarget = JSON.parse(JSON.stringify(target));
    editingKeyStored = null;
    if (target.provider !== 'picora' || target.picoraAuthRef?.kind === 'oauth' || target.picoraApiKey) return;
    void hasStoredPicoraApiKey(target).then(stored => {
      if (editingTarget?.id !== target.id) return;
      editingKeyStored = stored;
      // Fill a masked placeholder so a saved key is visibly present.
      if (stored && !editingTarget.picoraApiKey) editingTarget = { ...editingTarget, picoraApiKey: PICORA_KEY_MASK };
    });
  }

  function deleteTarget(id: string) {
    const updated = targets.filter(t => t.id !== id);
    const patch: Record<string, unknown> = { imageHostTargets: JSON.parse(JSON.stringify(updated)) };
    if (id === defaultId) {
      patch.defaultImageHostId = updated.length > 0 ? updated[0].id : '';
    }
    settingsStore.update(patch);
  }

  async function saveTarget() {
    if (!editingTarget) return;
    // Untouched mask = keep the stored key; it must never be saved as a key.
    if (editingTarget.picoraApiKey === PICORA_KEY_MASK) editingTarget = { ...editingTarget, picoraApiKey: '' };
    const targetId = editingTarget.id;
    const picoraKeyChanged = editingTarget.provider === 'picora' && !!editingTarget.picoraApiKey;
    // v0.69.0: for Picora targets, push the entered key into the OS keychain
    // and clear the inline field before it's persisted to disk.
    if (editingTarget.provider === 'picora' && editingTarget.picoraApiKey) {
      try {
        const { setPicoraApiKey } = await import('$lib/services/picora/credentials');
        await setPicoraApiKey(editingTarget.id, editingTarget.picoraApiKey);
        editingTarget = { ...editingTarget, picoraApiKey: '', picoraKeyMigratedV069: true };
      } catch {
        // Keychain unavailable — fall back to inline storage (legacy behavior).
      }
    }
    const existing = targets.findIndex(t => t.id === editingTarget!.id);
    let updated: ImageHostTarget[];
    if (existing >= 0) {
      updated = [...targets];
      updated[existing] = editingTarget;
    } else {
      updated = [...targets, editingTarget];
    }
    const patch: Record<string, unknown> = { imageHostTargets: JSON.parse(JSON.stringify(updated)) };
    if (!defaultId && updated.length > 0) {
      patch.defaultImageHostId = editingTarget.id;
    }
    settingsStore.update(patch);
    if (picoraKeyChanged) {
      // New key: drop the stale plan + failed-sync state so KB sync re-enables.
      const { onPicoraCredentialChanged } = await import('$lib/services/kb-sync/manual-sync');
      await onPicoraCredentialChanged(targetId);
    }
    editingTarget = null;
  }

  function cancelEdit() {
    editingTarget = null;
  }

  function setDefault(id: string) {
    settingsStore.update({ defaultImageHostId: id });
  }

  const REGION_OPTIONS: Record<string, { value: string; label: string }[]> = {
    qiniu: [
      { value: 'z0', label: 'z0 — 华东（浙江）' },
      { value: 'z1', label: 'z1 — 华北（河北）' },
      { value: 'z2', label: 'z2 — 华南（广东）' },
      { value: 'na0', label: 'na0 — 北美（洛杉矶）' },
      { value: 'as0', label: 'as0 — 东南亚（新加坡）' },
    ],
    'aliyun-oss': [
      { value: 'cn-hangzhou',     label: 'cn-hangzhou — 华东1（杭州）' },
      { value: 'cn-shanghai',     label: 'cn-shanghai — 华东2（上海）' },
      { value: 'cn-nanjing',      label: 'cn-nanjing — 华东5（南京）' },
      { value: 'cn-beijing',      label: 'cn-beijing — 华北2（北京）' },
      { value: 'cn-zhangjiakou',  label: 'cn-zhangjiakou — 华北3（张家口）' },
      { value: 'cn-huhehaote',    label: 'cn-huhehaote — 华北5（呼和浩特）' },
      { value: 'cn-wulanchabu',   label: 'cn-wulanchabu — 华北6（乌兰察布）' },
      { value: 'cn-shenzhen',     label: 'cn-shenzhen — 华南1（深圳）' },
      { value: 'cn-guangzhou',    label: 'cn-guangzhou — 华南3（广州）' },
      { value: 'cn-chengdu',      label: 'cn-chengdu — 西南1（成都）' },
      { value: 'cn-hongkong',     label: 'cn-hongkong — 中国香港' },
      { value: 'ap-southeast-1',  label: 'ap-southeast-1 — 新加坡' },
      { value: 'ap-southeast-2',  label: 'ap-southeast-2 — 悉尼' },
      { value: 'ap-northeast-1',  label: 'ap-northeast-1 — 日本' },
      { value: 'ap-south-1',      label: 'ap-south-1 — 孟买' },
      { value: 'us-east-1',       label: 'us-east-1 — 美东（弗吉尼亚）' },
      { value: 'us-west-1',       label: 'us-west-1 — 美西（硅谷）' },
      { value: 'eu-west-1',       label: 'eu-west-1 — 伦敦' },
      { value: 'eu-central-1',    label: 'eu-central-1 — 法兰克福' },
    ],
    'tencent-cos': [
      { value: 'ap-beijing',          label: 'ap-beijing — 华北（北京）' },
      { value: 'ap-nanjing',          label: 'ap-nanjing — 华东（南京）' },
      { value: 'ap-shanghai',         label: 'ap-shanghai — 华东（上海）' },
      { value: 'ap-guangzhou',        label: 'ap-guangzhou — 华南（广州）' },
      { value: 'ap-chengdu',          label: 'ap-chengdu — 西南（成都）' },
      { value: 'ap-chongqing',        label: 'ap-chongqing — 西南（重庆）' },
      { value: 'ap-hongkong',         label: 'ap-hongkong — 港澳台（香港）' },
      { value: 'ap-singapore',        label: 'ap-singapore — 东南亚（新加坡）' },
      { value: 'ap-jakarta',          label: 'ap-jakarta — 东南亚（雅加达）' },
      { value: 'ap-mumbai',           label: 'ap-mumbai — 南亚（孟买）' },
      { value: 'ap-seoul',            label: 'ap-seoul — 东北亚（首尔）' },
      { value: 'ap-tokyo',            label: 'ap-tokyo — 东北亚（东京）' },
      { value: 'ap-bangkok',          label: 'ap-bangkok — 东南亚（曼谷）' },
      { value: 'na-ashburn',          label: 'na-ashburn — 北美东部（弗吉尼亚）' },
      { value: 'na-siliconvalley',    label: 'na-siliconvalley — 北美西部（硅谷）' },
      { value: 'na-toronto',          label: 'na-toronto — 北美（多伦多）' },
      { value: 'eu-frankfurt',        label: 'eu-frankfurt — 欧洲（法兰克福）' },
    ],
    'aws-s3': [
      { value: 'us-east-1',       label: 'us-east-1 — US East (N. Virginia)' },
      { value: 'us-east-2',       label: 'us-east-2 — US East (Ohio)' },
      { value: 'us-west-1',       label: 'us-west-1 — US West (N. California)' },
      { value: 'us-west-2',       label: 'us-west-2 — US West (Oregon)' },
      { value: 'ca-central-1',    label: 'ca-central-1 — Canada (Central)' },
      { value: 'eu-west-1',       label: 'eu-west-1 — Europe (Ireland)' },
      { value: 'eu-west-2',       label: 'eu-west-2 — Europe (London)' },
      { value: 'eu-west-3',       label: 'eu-west-3 — Europe (Paris)' },
      { value: 'eu-central-1',    label: 'eu-central-1 — Europe (Frankfurt)' },
      { value: 'eu-north-1',      label: 'eu-north-1 — Europe (Stockholm)' },
      { value: 'ap-east-1',       label: 'ap-east-1 — Asia Pacific (Hong Kong)' },
      { value: 'ap-southeast-1',  label: 'ap-southeast-1 — Asia Pacific (Singapore)' },
      { value: 'ap-southeast-2',  label: 'ap-southeast-2 — Asia Pacific (Sydney)' },
      { value: 'ap-southeast-3',  label: 'ap-southeast-3 — Asia Pacific (Jakarta)' },
      { value: 'ap-northeast-1',  label: 'ap-northeast-1 — Asia Pacific (Tokyo)' },
      { value: 'ap-northeast-2',  label: 'ap-northeast-2 — Asia Pacific (Seoul)' },
      { value: 'ap-south-1',      label: 'ap-south-1 — Asia Pacific (Mumbai)' },
      { value: 'sa-east-1',       label: 'sa-east-1 — South America (São Paulo)' },
      { value: 'me-south-1',      label: 'me-south-1 — Middle East (Bahrain)' },
      { value: 'af-south-1',      label: 'af-south-1 — Africa (Cape Town)' },
    ],
    'google-gcs': [
      { value: 'us-central1',                 label: 'us-central1 — Iowa' },
      { value: 'us-east1',                    label: 'us-east1 — South Carolina' },
      { value: 'us-east4',                    label: 'us-east4 — Northern Virginia' },
      { value: 'us-west1',                    label: 'us-west1 — Oregon' },
      { value: 'us-west2',                    label: 'us-west2 — Los Angeles' },
      { value: 'northamerica-northeast1',     label: 'northamerica-northeast1 — Montréal' },
      { value: 'northamerica-northeast2',     label: 'northamerica-northeast2 — Toronto' },
      { value: 'southamerica-east1',          label: 'southamerica-east1 — São Paulo' },
      { value: 'europe-west1',                label: 'europe-west1 — Belgium' },
      { value: 'europe-west2',                label: 'europe-west2 — London' },
      { value: 'europe-west3',                label: 'europe-west3 — Frankfurt' },
      { value: 'europe-west4',                label: 'europe-west4 — Netherlands' },
      { value: 'europe-west6',                label: 'europe-west6 — Zürich' },
      { value: 'europe-north1',               label: 'europe-north1 — Finland' },
      { value: 'asia-east1',                  label: 'asia-east1 — Taiwan' },
      { value: 'asia-east2',                  label: 'asia-east2 — Hong Kong' },
      { value: 'asia-northeast1',             label: 'asia-northeast1 — Tokyo' },
      { value: 'asia-northeast2',             label: 'asia-northeast2 — Osaka' },
      { value: 'asia-northeast3',             label: 'asia-northeast3 — Seoul' },
      { value: 'asia-south1',                 label: 'asia-south1 — Mumbai' },
      { value: 'asia-southeast1',             label: 'asia-southeast1 — Singapore' },
      { value: 'asia-southeast2',             label: 'asia-southeast2 — Jakarta' },
      { value: 'australia-southeast1',        label: 'australia-southeast1 — Sydney' },
    ],
  };

  function getRegionOptions(provider: ImageHostProvider): { value: string; label: string }[] {
    return REGION_OPTIONS[provider] ?? [];
  }

  let githubCdnOptions = $derived([
    { value: 'raw', label: tr('image_host.github_cdn_raw') },
    { value: 'jsdelivr', label: tr('image_host.github_cdn_jsdelivr') },
  ]);

  function importFromPublishTarget(target: { repoUrl?: string; branch?: string; token?: string }) {
    if (!editingTarget) return;
    if (target.repoUrl) editingTarget.githubRepoUrl = target.repoUrl;
    if (target.branch) editingTarget.githubBranch = target.branch;
    if (target.token) editingTarget.githubToken = target.token;
  }

  function picoraApiBaseFromTarget(target: ImageHostTarget): string {
    const url = (target.picoraApiUrl || '').trim();
    if (!url) return PICORA_DEFAULT_API_BASE;
    return url.replace(/\/v1\/images\/?$/, '').replace(/\/$/, '') || PICORA_DEFAULT_API_BASE;
  }

  async function handleTestUpload(target: ImageHostTarget) {
    testStatus[target.id] = 'testing';
    testError[target.id] = '';
    testStatus = { ...testStatus };
    try {
      if (target.provider === 'picora') {
        const { getPicoraApiKeyOrEmpty } = await import('$lib/services/picora/credentials');
        await invoke('test_picora_connection', {
          apiBase: picoraApiBaseFromTarget(target),
          apiKey: await getPicoraApiKeyOrEmpty(target),
        });
      } else {
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
      }
      testStatus[target.id] = 'success';
    } catch (e: unknown) {
      testStatus[target.id] = 'failed';
      testError[target.id] = typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Upload failed');
    }
    testStatus = { ...testStatus };
    setTimeout(() => {
      testStatus[target.id] = 'idle';
      testError[target.id] = '';
      testStatus = { ...testStatus };
    }, 5000);
  }
</script>

<div class="imghost-settings gx-tab">
  {#if editingTarget}
    <!-- Edit form -->
    <div class="edit-form">
      <div class="form-header">
        <h4>{PROVIDER_ICONS[editingTarget.provider]} {providerLabel(editingTarget.provider)}</h4>
      </div>

      <div class="setting-group">
        <label class="setting-label" for="imghost-target-name">{tr('image_host.target_name')}</label>
        <input
          id="imghost-target-name"
          type="text"
          class="setting-input"
          bind:value={editingTarget.name}
          placeholder={tr('image_host.target_name_placeholder')}
        />
      </div>

      {#if editingTarget.provider === 'smms' || editingTarget.provider === 'imgur'}
        <div class="setting-group">
          <label class="setting-label" for="imghost-api-token">{tr('image_host.api_token')}</label>
          <input id="imghost-api-token" type="password" class="setting-input"
            bind:value={editingTarget.apiToken} placeholder={tr('image_host.api_token_placeholder')} />
        </div>
      {/if}

      {#if editingTarget.provider === 'github'}
        {#if publishTargets.length > 0}
          <div class="setting-group">
            <span class="setting-label">{tr('image_host.import_from_publish')}</span>
            <div class="import-targets">
              {#each publishTargets as target}
                <button class="import-btn" onclick={() => importFromPublishTarget(target)}>
                  {target.name || target.repoUrl || 'GitHub'}
                </button>
              {/each}
            </div>
          </div>
        {/if}
        <div class="setting-group">
          <label class="setting-label" for="imghost-github-repo">{tr('image_host.github_repo_url')}</label>
          <input id="imghost-github-repo" type="text" class="setting-input"
            bind:value={editingTarget.githubRepoUrl} placeholder={tr('image_host.github_repo_url_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-github-branch">{tr('image_host.github_branch')}</label>
          <input id="imghost-github-branch" type="text" class="setting-input"
            bind:value={editingTarget.githubBranch} placeholder="main" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-github-dir">{tr('image_host.github_dir')}</label>
          <input id="imghost-github-dir" type="text" class="setting-input"
            bind:value={editingTarget.githubDir} placeholder="images/" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-github-token">{tr('image_host.github_token')}</label>
          <input id="imghost-github-token" type="password" class="setting-input"
            bind:value={editingTarget.githubToken} placeholder={tr('image_host.github_token_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-github-cdn">{tr('image_host.github_cdn')}</label>
          <Select id="imghost-github-cdn" class="setting-input" block bind:value={editingTarget.githubCdn} options={githubCdnOptions} />
        </div>
      {/if}

      {#if editingTarget.provider === 'gitlab'}
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitlab-repo">{tr('image_host.gitlab_repo_url')}</label>
          <input id="imghost-gitlab-repo" type="text" class="setting-input"
            bind:value={editingTarget.gitlabRepoUrl} placeholder="https://gitlab.com/user/images" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitlab-branch">{tr('image_host.gitlab_branch')}</label>
          <input id="imghost-gitlab-branch" type="text" class="setting-input"
            bind:value={editingTarget.gitlabBranch} placeholder="main" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitlab-dir">{tr('image_host.gitlab_dir')}</label>
          <input id="imghost-gitlab-dir" type="text" class="setting-input"
            bind:value={editingTarget.gitlabDir} placeholder="images/" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitlab-token">{tr('image_host.gitlab_token')}</label>
          <input id="imghost-gitlab-token" type="password" class="setting-input"
            bind:value={editingTarget.gitlabToken} placeholder="glpat-xxxxxxxxxxxx" />
        </div>
      {/if}

      {#if editingTarget.provider === 'git-custom'}
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitcustom-repo">{tr('image_host.git_custom_repo_url')}</label>
          <input id="imghost-gitcustom-repo" type="text" class="setting-input"
            bind:value={editingTarget.gitCustomRepoUrl} placeholder="https://git.example.com/user/images" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitcustom-branch">{tr('image_host.git_custom_branch')}</label>
          <input id="imghost-gitcustom-branch" type="text" class="setting-input"
            bind:value={editingTarget.gitCustomBranch} placeholder="main" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitcustom-dir">{tr('image_host.git_custom_dir')}</label>
          <input id="imghost-gitcustom-dir" type="text" class="setting-input"
            bind:value={editingTarget.gitCustomDir} placeholder="images/" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitcustom-token">{tr('image_host.git_custom_token')}</label>
          <input id="imghost-gitcustom-token" type="password" class="setting-input"
            bind:value={editingTarget.gitCustomToken} placeholder={tr('image_host.git_custom_token_placeholder')} />
        </div>
      {/if}

      {#if editingTarget.provider === 'picora'}
        {#if editingTarget.picoraUserEmail}
          <div class="setting-group">
            <span class="setting-label">{tr('image_host.picora_user_email')}</span>
            <input type="text" class="setting-input" value={editingTarget.picoraUserEmail} readonly />
          </div>
        {/if}
        <div class="setting-group">
          <label class="setting-label" for="imghost-picora-api-url">{tr('image_host.picora_api_url')}</label>
          <input id="imghost-picora-api-url" type="text" class="setting-input"
            bind:value={editingTarget.picoraApiUrl}
            placeholder={tr('image_host.picora_api_url_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-picora-img-domain">{tr('image_host.picora_img_domain')}</label>
          <input id="imghost-picora-img-domain" type="text" class="setting-input"
            bind:value={editingTarget.picoraImgDomain}
            placeholder={tr('image_host.picora_img_domain_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-picora-key">{tr('image_host.picora_api_key')}</label>
          <input id="imghost-picora-key" type="password" class="setting-input"
            bind:value={editingTarget.picoraApiKey}
            onfocus={(e) => { if (editingTarget?.picoraApiKey === PICORA_KEY_MASK) e.currentTarget.select(); }}
            placeholder={editingKeyStored !== false && editingTarget.picoraKeyMigratedV069
              ? tr('image_host.picora_api_key_keychain')
              : tr('image_host.picora_api_key_placeholder')} />
        </div>
      {/if}

      {#if editingTarget.provider === 'custom'}
        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-token">{tr('image_host.api_token')}</label>
          <input id="imghost-custom-token" type="password" class="setting-input"
            bind:value={editingTarget.apiToken} placeholder={tr('image_host.api_token_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-endpoint">{tr('image_host.custom_endpoint')}</label>
          <input id="imghost-custom-endpoint" type="text" class="setting-input"
            bind:value={editingTarget.customEndpoint} placeholder={tr('image_host.custom_endpoint_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-headers">{tr('image_host.custom_headers')}</label>
          <textarea id="imghost-custom-headers" class="setting-textarea"
            bind:value={editingTarget.customHeaders}
            placeholder={'{"X-Custom-Header": "value"}'}
            rows="3"
          ></textarea>
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-url-template">{tr('image_host.custom_url_template')}</label>
          <input id="imghost-custom-url-template" type="text" class="setting-input"
            bind:value={editingTarget.customUrlTemplate}
            placeholder={tr('image_host.custom_url_template_placeholder')} />
          <p class="setting-hint">{tr('image_host.custom_url_template_hint')}</p>
        </div>
      {/if}

      {#if isObjectStorageProvider(editingTarget.provider)}
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-ak">{tr('image_host.oss_access_key')}</label>
          <input id="imghost-oss-ak" type="password" class="setting-input"
            bind:value={editingTarget.ossAccessKey} placeholder={tr('image_host.oss_access_key_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-sk">{tr('image_host.oss_secret_key')}</label>
          <input id="imghost-oss-sk" type="password" class="setting-input"
            bind:value={editingTarget.ossSecretKey} placeholder={tr('image_host.oss_secret_key_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-bucket">{tr('image_host.oss_bucket')}</label>
          <input id="imghost-oss-bucket" type="text" class="setting-input"
            bind:value={editingTarget.ossBucket} placeholder={tr('image_host.oss_bucket_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-region">{tr('image_host.oss_region')}</label>
          <input id="imghost-oss-region" type="text" class="setting-input"
            list="oss-region-datalist"
            bind:value={editingTarget.ossRegion}
            placeholder={tr('image_host.oss_region_placeholder')} />
          <datalist id="oss-region-datalist">
            {#each getRegionOptions(editingTarget.provider) as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </datalist>
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-endpoint">{tr('image_host.oss_endpoint')}</label>
          <input id="imghost-oss-endpoint" type="text" class="setting-input"
            bind:value={editingTarget.ossEndpoint} placeholder={tr('image_host.oss_endpoint_placeholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-cdn">
            {tr('image_host.oss_cdn_domain')}
            {#if editingTarget.provider === 'qiniu'}
              <span class="required-badge">* {tr('image_host.required')}</span>
            {/if}
          </label>
          <input id="imghost-oss-cdn" type="text" class="setting-input"
            class:input-required={editingTarget.provider === 'qiniu' && !editingTarget.ossCdnDomain}
            bind:value={editingTarget.ossCdnDomain} placeholder={tr('image_host.oss_cdn_domain_placeholder')} />
          {#if editingTarget.provider === 'qiniu' && !editingTarget.ossCdnDomain}
            <p class="field-hint field-hint-error">{tr('image_host.qiniu_cdn_required')}</p>
          {/if}
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-prefix">{tr('image_host.oss_path_prefix')}</label>
          <input id="imghost-oss-prefix" type="text" class="setting-input"
            bind:value={editingTarget.ossPathPrefix} placeholder={tr('image_host.oss_path_prefix_placeholder')} />
        </div>
      {/if}

      <div class="setting-group">
        <label class="setting-label">
          <input type="checkbox" bind:checked={editingTarget.autoUpload} />
          {tr('image_host.auto_upload')}
        </label>
      </div>

      <div class="form-actions">
        <button
          class="btn btn-test"
          class:testing={testStatus[editingTarget.id] === 'testing'}
          class:success={testStatus[editingTarget.id] === 'success'}
          class:failed={testStatus[editingTarget.id] === 'failed'}
          onclick={() => handleTestUpload(editingTarget!)}
          disabled={testStatus[editingTarget.id] === 'testing' || !editingTarget.name}
        >
          {#if testStatus[editingTarget.id] === 'testing'}
            {tr('image_host.testing')}
          {:else if testStatus[editingTarget.id] === 'success'}
            ✓ {tr('image_host.test')}
          {:else if testStatus[editingTarget.id] === 'failed'}
            ✗ {tr('image_host.test')}
          {:else}
            {tr('image_host.test')}
          {/if}
        </button>
        <div class="form-actions-right">
          <button class="btn btn-secondary" onclick={cancelEdit}>{tr('common.cancel')}</button>
          <button class="btn btn-primary" onclick={saveTarget} disabled={!editingTarget.name}>
            {tr('common.save')}
          </button>
        </div>
      </div>
      {#if testError[editingTarget.id] && testStatus[editingTarget.id] === 'failed'}
        <p class="test-upload-error">{testError[editingTarget.id]}</p>
      {/if}
    </div>
  {:else}
    <!-- Target list -->
    {#if targets.length === 0}
      <div class="empty-state">
        <p>{tr('image_host.settings_empty')}</p>
        <p class="hint">{tr('image_host.settings_hint')}</p>
      </div>
    {:else}
      <div class="target-list">
        {#each sortedTargets as target (target.id)}
          <div class="target-card" class:is-featured={target.featured || target.provider === 'picora'}>
            <div class="target-card-row">
              <div class="target-info">
                <span class="target-icon">{PROVIDER_ICONS[target.provider]}</span>
                <div class="target-details">
                  <span class="target-name">
                    {target.name || '(unnamed)'}
                    {#if target.featured || target.provider === 'picora'}
                      <span class="featured-badge">{tr('image_host.picora_featured_badge')}</span>
                    {/if}
                    {#if target.id === defaultId}
                      <span class="default-badge">{tr('image_host.default')}</span>
                    {/if}
                  </span>
                  <span class="target-type">
                    {providerLabel(target.provider)}
                    {#if target.provider === 'picora' && target.picoraUserEmail}
                      <span class="picora-summary"> · {target.picoraUserEmail}</span>
                    {/if}
                  </span>
                </div>
              </div>
              <div class="target-actions">
                <button class="action-btn" class:is-default={target.id === defaultId}
                  onclick={() => setDefault(target.id)} title={tr('image_host.set_default')}>
                  {target.id === defaultId ? '★' : '☆'}
                </button>
                {#if target.provider !== 'picora'}
                  <button class="action-btn"
                    class:testing={testStatus[target.id] === 'testing'}
                    class:success={testStatus[target.id] === 'success'}
                    class:failed={testStatus[target.id] === 'failed'}
                    onclick={() => handleTestUpload(target)}
                    disabled={testStatus[target.id] === 'testing'}>
                    {#if testStatus[target.id] === 'testing'}...
                    {:else if testStatus[target.id] === 'success'}✓
                    {:else if testStatus[target.id] === 'failed'}✗
                    {:else}⚡{/if}
                  </button>
                  <button class="action-btn" onclick={() => editTarget(target)}>✎</button>
                  <button class="action-btn danger" onclick={() => deleteTarget(target.id)}>✕</button>
                {/if}
              </div>
            </div>
            {#if target.provider === 'picora'}
              <div class="picora-moved-hint">
                <span class="info-icon">ⓘ</span>
                <span class="hint-text">{tr('settings.image_host.picora.moved_hint')}</span>
                {#if onJumpToPicora}
                  <button class="jump-btn" onclick={onJumpToPicora}>
                    → {tr('settings.image_host.picora.jump_to_tab')}
                  </button>
                {/if}
              </div>
            {/if}
            {#if testError[target.id] && testStatus[target.id] === 'failed'}
              <p class="test-upload-error">{testError[target.id]}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- Add button with grouped menu -->
    <div class="add-section">
      {#if showAddMenu}
        <div class="add-menu">
          <!-- Hero: Picora featured entry. Visually separated from the grid below. -->
          <button
            class="picora-hero"
            onclick={() => { showAddMenu = false; onImportPicora?.(); }}>
            <span class="picora-hero-icon">⭐</span>
            <span class="picora-hero-body">
              <span class="picora-hero-title">
                {tr('image_host.picora')}
                <span class="picora-hero-badge">{tr('image_host.picora_featured_badge')}</span>
              </span>
              <span class="picora-hero-subtitle">{tr('image_host.picora_hero_desc')}</span>
            </span>
            <span class="picora-hero-cta">{tr('image_host.picora_one_click')} →</span>
          </button>

          <!-- Collapsible "Other providers" dropdown — collapsed by default to emphasize Picora. -->
          <button
            class="other-providers-toggle"
            class:is-open={showOtherProviders}
            aria-expanded={showOtherProviders}
            onclick={() => (showOtherProviders = !showOtherProviders)}>
            <span class="chevron" aria-hidden="true">▶</span>
            <span class="other-providers-label">{tr('image_host.other_providers')}</span>
          </button>

          {#if showOtherProviders}
            <div class="other-providers-body">
              <div class="add-group">
                <span class="add-group-label">{tr('image_host.group_api')}</span>
                <button class="add-option" onclick={() => addTarget('custom')}>🟣 {tr('image_host.custom')}</button>
              </div>
              <div class="add-group">
                <span class="add-group-label">{tr('image_host.group_git')}</span>
                <button class="add-option" onclick={() => addTarget('github')}>🔵 {tr('image_host.github')}</button>
                <button class="add-option" onclick={() => addTarget('gitlab')}>🟤 {tr('image_host.gitlab')}</button>
                <button class="add-option" onclick={() => addTarget('git-custom')}>⚪ {tr('image_host.git_custom')}</button>
              </div>
              <div class="add-group">
                <span class="add-group-label">{tr('image_host.group_oss')}</span>
                <button class="add-option" onclick={() => addTarget('qiniu')}>🟡 {tr('image_host.qiniu')}</button>
                <button class="add-option" onclick={() => addTarget('aliyun-oss')}>🔴 {tr('image_host.aliyun_oss')}</button>
                <button class="add-option" onclick={() => addTarget('tencent-cos')}>🟤 {tr('image_host.tencent_cos')}</button>
                <button class="add-option" onclick={() => addTarget('aws-s3')}>⬛ {tr('image_host.aws_s3')}</button>
                <button class="add-option" onclick={() => addTarget('google-gcs')}>🌐 {tr('image_host.google_gcs')}</button>
              </div>
            </div>
          {/if}
        </div>
      {/if}
      <button class="btn btn-add" onclick={() => showAddMenu = !showAddMenu}>
        + {tr('image_host.add_target')}
      </button>
    </div>
  {/if}
</div>

<style>
  /* Layout overridden by .gx-tab on the root for consistent outer spacing. */

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

  .target-list { gap: 0.4rem; }
  .target-card {
    display: flex;
    flex-direction: column;
    padding: 0.65rem 0.9rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-primary);
  }

  .target-card.is-featured {
    border-color: transparent;
    background:
      linear-gradient(var(--bg-primary), var(--bg-primary)) padding-box,
      linear-gradient(135deg,
        color-mix(in srgb, var(--accent-color) 65%, transparent),
        color-mix(in srgb, var(--accent-color) 25%, transparent)
      ) border-box;
    border: 1px solid transparent;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-color) 20%, transparent);
  }

  .featured-badge {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg, var(--accent-color), color-mix(in srgb, var(--accent-color) 65%, #ff8a00));
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    letter-spacing: 0.02em;
  }

  .target-card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }

  .add-group {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }

  .add-group-label {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    width: 100%;
    padding: 0.1rem 0;
    border-bottom: 1px solid var(--border-light);
    margin-bottom: 0.1rem;
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

  /* Picora hero card — featured entry in add-menu */
  .picora-hero {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.85rem 1rem;
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    border: 2px solid transparent;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, var(--accent-color) 8%, var(--bg-primary)),
        color-mix(in srgb, #ff8a00 5%, var(--bg-primary))
      ) padding-box,
      linear-gradient(135deg,
        var(--accent-color),
        color-mix(in srgb, var(--accent-color) 50%, #ff8a00)
      ) border-box;
    transition: transform 0.15s ease, box-shadow 0.2s ease;
  }

  .picora-hero:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 16px color-mix(in srgb, var(--accent-color) 22%, transparent);
  }

  .picora-hero-icon {
    font-size: 1.6rem;
    flex-shrink: 0;
    line-height: 1;
  }

  .picora-hero-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .picora-hero-title {
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .picora-hero-badge {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: #fff;
    background: linear-gradient(135deg,
      var(--accent-color),
      color-mix(in srgb, var(--accent-color) 65%, #ff8a00));
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    letter-spacing: 0.02em;
  }

  .picora-hero-subtitle {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    line-height: 1.4;
  }

  .picora-hero-cta {
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--accent-color);
    white-space: nowrap;
  }

  .picora-hero:hover .picora-hero-cta {
    color: color-mix(in srgb, var(--accent-color) 80%, #000);
  }

  /* Dropdown toggle for collapsed "Other providers" section */
  .other-providers-toggle {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    padding: 0.4rem 0.1rem;
    margin-top: 0.3rem;
    background: transparent;
    border: none;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    cursor: pointer;
    user-select: none;
  }

  .other-providers-toggle:hover {
    color: var(--text-secondary);
  }

  .other-providers-toggle .chevron {
    display: inline-block;
    font-size: 0.65rem;
    transition: transform 0.18s ease;
    color: var(--text-muted);
  }

  .other-providers-toggle.is-open .chevron {
    transform: rotate(90deg);
  }

  .other-providers-label {
    flex: 1;
    text-align: left;
  }

  .other-providers-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.2rem;
    animation: other-providers-in 0.18s ease-out;
  }

  @keyframes other-providers-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
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
    background: var(--bg-hover);
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
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .setting-input {
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    box-sizing: border-box;
  }

  .setting-input:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .setting-textarea {
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: monospace;
    resize: vertical;
    box-sizing: border-box;
  }

  .setting-textarea:focus {
    outline: none;
    border-color: var(--accent-color);
  }

  .setting-hint {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    line-height: 1.4;
    margin: 0.2rem 0 0;
  }

  .form-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.25rem;
  }

  .form-actions-right {
    display: flex;
    gap: 0.5rem;
  }

  .btn-test {
    background: transparent;
    color: var(--text-secondary);
    border-color: var(--border-color);
  }

  .btn-test:hover:not(:disabled) {
    border-color: var(--accent-color);
    color: var(--accent-color);
  }

  .btn-test.testing {
    color: var(--accent-color);
    border-color: var(--accent-color);
  }

  .btn-test.success {
    color: #28a745;
    border-color: #28a745;
  }

  .btn-test.failed {
    color: #dc3545;
    border-color: #dc3545;
  }

  .btn-test:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .import-targets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .import-btn {
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: var(--font-size-xs);
  }

  .import-btn:hover {
    border-color: var(--accent-color);
    color: var(--text-primary);
  }

  .test-upload-error {
    margin: 4px 0 0 0;
    font-size: var(--font-size-xs);
    color: #dc3545;
    word-break: break-all;
  }

  .required-badge {
    font-size: var(--font-size-xs);
    color: #dc3545;
    font-weight: 600;
  }

  .field-hint {
    margin: 2px 0 0 0;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }

  .field-hint-error {
    color: #dc3545;
  }

  .input-required {
    border-color: #dc3545;
  }

  .input-required:focus {
    border-color: #dc3545;
  }

  /* v0.37.0: Picora card "moved to Picora tab" hint */
  .picora-moved-hint {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.4rem;
    padding: 0.35rem 0.5rem;
    background: color-mix(in srgb, var(--accent-color) 6%, transparent);
    border-radius: 4px;
    font-size: var(--font-size-xs);
  }
  .info-icon { color: var(--accent-color); }
  .hint-text { flex: 1; color: var(--text-secondary); }
  .jump-btn {
    background: transparent;
    border: none;
    color: var(--accent-color);
    cursor: pointer;
    padding: 0;
    font-size: var(--font-size-xs);
  }
  .jump-btn:hover { text-decoration: underline; }
  .picora-summary { color: var(--text-muted); font-family: var(--font-mono, monospace); }
</style>

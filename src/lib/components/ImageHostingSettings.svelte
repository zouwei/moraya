<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import type { ImageHostTarget, ImageHostProvider, GitHubCdnMode } from '$lib/services/image-hosting';
  import { createDefaultImageHostTarget, targetToConfig, uploadImage, isObjectStorageProvider } from '$lib/services/image-hosting';

  const tr = $t;

  let targets = $state<ImageHostTarget[]>([]);
  let defaultId = $state('');
  let editingTarget = $state<ImageHostTarget | null>(null);
  let showAddMenu = $state(false);
  let testStatus = $state<Record<string, 'idle' | 'testing' | 'success' | 'failed'>>({});
  let testError = $state<Record<string, string>>({});

  // Publish targets for quick import (GitHub only)
  let publishTargets = $state<Array<{ type: string; name: string; repoUrl?: string; branch?: string; token?: string }>>([]);

  $effect(() => {
    const unsub = settingsStore.subscribe(state => {
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
    return unsub;
  });

  const PROVIDER_ICONS: Record<ImageHostProvider, string> = {
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

  function providerLabel(provider: ImageHostProvider): string {
    return tr(`imageHost.${provider.replace(/-/g, '_')}`);
  }

  function addTarget(provider: ImageHostProvider) {
    editingTarget = createDefaultImageHostTarget(provider);
    showAddMenu = false;
  }

  function editTarget(target: ImageHostTarget) {
    editingTarget = JSON.parse(JSON.stringify(target));
  }

  function deleteTarget(id: string) {
    const updated = targets.filter(t => t.id !== id);
    const patch: Record<string, unknown> = { imageHostTargets: JSON.parse(JSON.stringify(updated)) };
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
    const patch: Record<string, unknown> = { imageHostTargets: JSON.parse(JSON.stringify(updated)) };
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

  function importFromPublishTarget(target: { repoUrl?: string; branch?: string; token?: string }) {
    if (!editingTarget) return;
    if (target.repoUrl) editingTarget.githubRepoUrl = target.repoUrl;
    if (target.branch) editingTarget.githubBranch = target.branch;
    if (target.token) editingTarget.githubToken = target.token;
  }

  async function handleTestUpload(target: ImageHostTarget) {
    testStatus[target.id] = 'testing';
    testError[target.id] = '';
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

<div class="imghost-settings">
  {#if editingTarget}
    <!-- Edit form -->
    <div class="edit-form">
      <div class="form-header">
        <h4>{PROVIDER_ICONS[editingTarget.provider]} {providerLabel(editingTarget.provider)}</h4>
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
          <input id="imghost-api-token" type="password" class="setting-input"
            bind:value={editingTarget.apiToken} placeholder={tr('imageHost.apiTokenPlaceholder')} />
        </div>
      {/if}

      {#if editingTarget.provider === 'github'}
        {#if publishTargets.length > 0}
          <div class="setting-group">
            <span class="setting-label">{tr('imageHost.importFromPublish')}</span>
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
          <label class="setting-label" for="imghost-github-repo">{tr('imageHost.githubRepoUrl')}</label>
          <input id="imghost-github-repo" type="text" class="setting-input"
            bind:value={editingTarget.githubRepoUrl} placeholder={tr('imageHost.githubRepoUrlPlaceholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-github-branch">{tr('imageHost.githubBranch')}</label>
          <input id="imghost-github-branch" type="text" class="setting-input"
            bind:value={editingTarget.githubBranch} placeholder="main" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-github-dir">{tr('imageHost.githubDir')}</label>
          <input id="imghost-github-dir" type="text" class="setting-input"
            bind:value={editingTarget.githubDir} placeholder="images/" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-github-token">{tr('imageHost.githubToken')}</label>
          <input id="imghost-github-token" type="password" class="setting-input"
            bind:value={editingTarget.githubToken} placeholder={tr('imageHost.githubTokenPlaceholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-github-cdn">{tr('imageHost.githubCdn')}</label>
          <select id="imghost-github-cdn" class="setting-input" bind:value={editingTarget.githubCdn}>
            <option value="raw">{tr('imageHost.githubCdnRaw')}</option>
            <option value="jsdelivr">{tr('imageHost.githubCdnJsdelivr')}</option>
          </select>
        </div>
      {/if}

      {#if editingTarget.provider === 'gitlab'}
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitlab-repo">{tr('imageHost.gitlabRepoUrl')}</label>
          <input id="imghost-gitlab-repo" type="text" class="setting-input"
            bind:value={editingTarget.gitlabRepoUrl} placeholder="https://gitlab.com/user/images" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitlab-branch">{tr('imageHost.gitlabBranch')}</label>
          <input id="imghost-gitlab-branch" type="text" class="setting-input"
            bind:value={editingTarget.gitlabBranch} placeholder="main" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitlab-dir">{tr('imageHost.gitlabDir')}</label>
          <input id="imghost-gitlab-dir" type="text" class="setting-input"
            bind:value={editingTarget.gitlabDir} placeholder="images/" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitlab-token">{tr('imageHost.gitlabToken')}</label>
          <input id="imghost-gitlab-token" type="password" class="setting-input"
            bind:value={editingTarget.gitlabToken} placeholder="glpat-xxxxxxxxxxxx" />
        </div>
      {/if}

      {#if editingTarget.provider === 'git-custom'}
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitcustom-repo">{tr('imageHost.gitCustomRepoUrl')}</label>
          <input id="imghost-gitcustom-repo" type="text" class="setting-input"
            bind:value={editingTarget.gitCustomRepoUrl} placeholder="https://git.example.com/user/images" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitcustom-branch">{tr('imageHost.gitCustomBranch')}</label>
          <input id="imghost-gitcustom-branch" type="text" class="setting-input"
            bind:value={editingTarget.gitCustomBranch} placeholder="main" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitcustom-dir">{tr('imageHost.gitCustomDir')}</label>
          <input id="imghost-gitcustom-dir" type="text" class="setting-input"
            bind:value={editingTarget.gitCustomDir} placeholder="images/" />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-gitcustom-token">{tr('imageHost.gitCustomToken')}</label>
          <input id="imghost-gitcustom-token" type="password" class="setting-input"
            bind:value={editingTarget.gitCustomToken} placeholder={tr('imageHost.gitCustomTokenPlaceholder')} />
        </div>
      {/if}

      {#if editingTarget.provider === 'custom'}
        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-token">{tr('imageHost.apiToken')}</label>
          <input id="imghost-custom-token" type="password" class="setting-input"
            bind:value={editingTarget.apiToken} placeholder={tr('imageHost.apiTokenPlaceholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-endpoint">{tr('imageHost.customEndpoint')}</label>
          <input id="imghost-custom-endpoint" type="text" class="setting-input"
            bind:value={editingTarget.customEndpoint} placeholder={tr('imageHost.customEndpointPlaceholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-custom-headers">{tr('imageHost.customHeaders')}</label>
          <textarea id="imghost-custom-headers" class="setting-textarea"
            bind:value={editingTarget.customHeaders}
            placeholder={'{"X-Custom-Header": "value"}'}
            rows="3"
          ></textarea>
        </div>
      {/if}

      {#if isObjectStorageProvider(editingTarget.provider)}
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-ak">{tr('imageHost.ossAccessKey')}</label>
          <input id="imghost-oss-ak" type="password" class="setting-input"
            bind:value={editingTarget.ossAccessKey} placeholder={tr('imageHost.ossAccessKeyPlaceholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-sk">{tr('imageHost.ossSecretKey')}</label>
          <input id="imghost-oss-sk" type="password" class="setting-input"
            bind:value={editingTarget.ossSecretKey} placeholder={tr('imageHost.ossSecretKeyPlaceholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-bucket">{tr('imageHost.ossBucket')}</label>
          <input id="imghost-oss-bucket" type="text" class="setting-input"
            bind:value={editingTarget.ossBucket} placeholder={tr('imageHost.ossBucketPlaceholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-region">{tr('imageHost.ossRegion')}</label>
          <input id="imghost-oss-region" type="text" class="setting-input"
            list="oss-region-datalist"
            bind:value={editingTarget.ossRegion}
            placeholder={tr('imageHost.ossRegionPlaceholder')} />
          <datalist id="oss-region-datalist">
            {#each getRegionOptions(editingTarget.provider) as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </datalist>
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-endpoint">{tr('imageHost.ossEndpoint')}</label>
          <input id="imghost-oss-endpoint" type="text" class="setting-input"
            bind:value={editingTarget.ossEndpoint} placeholder={tr('imageHost.ossEndpointPlaceholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-cdn">{tr('imageHost.ossCdnDomain')}</label>
          <input id="imghost-oss-cdn" type="text" class="setting-input"
            bind:value={editingTarget.ossCdnDomain} placeholder={tr('imageHost.ossCdnDomainPlaceholder')} />
        </div>
        <div class="setting-group">
          <label class="setting-label" for="imghost-oss-prefix">{tr('imageHost.ossPathPrefix')}</label>
          <input id="imghost-oss-prefix" type="text" class="setting-input"
            bind:value={editingTarget.ossPathPrefix} placeholder={tr('imageHost.ossPathPrefixPlaceholder')} />
        </div>
      {/if}

      <div class="setting-group">
        <label class="setting-label">
          <input type="checkbox" bind:checked={editingTarget.autoUpload} />
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
            <div class="target-card-row">
              <div class="target-info">
                <span class="target-icon">{PROVIDER_ICONS[target.provider]}</span>
                <div class="target-details">
                  <span class="target-name">
                    {target.name || '(unnamed)'}
                    {#if target.id === defaultId}
                      <span class="default-badge">{tr('imageHost.default')}</span>
                    {/if}
                  </span>
                  <span class="target-type">{providerLabel(target.provider)}</span>
                </div>
              </div>
              <div class="target-actions">
                <button class="action-btn" class:is-default={target.id === defaultId}
                  onclick={() => setDefault(target.id)} title={tr('imageHost.setDefault')}>
                  {target.id === defaultId ? '★' : '☆'}
                </button>
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
              </div>
            </div>
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
          <div class="add-group">
            <span class="add-group-label">{tr('imageHost.groupApi')}</span>
            <button class="add-option" onclick={() => addTarget('smms')}>🟠 {tr('imageHost.smms')}</button>
            <button class="add-option" onclick={() => addTarget('imgur')}>🟢 {tr('imageHost.imgur')}</button>
            <button class="add-option" onclick={() => addTarget('custom')}>🟣 {tr('imageHost.custom')}</button>
          </div>
          <div class="add-group">
            <span class="add-group-label">{tr('imageHost.groupGit')}</span>
            <button class="add-option" onclick={() => addTarget('github')}>🔵 {tr('imageHost.github')}</button>
            <button class="add-option" onclick={() => addTarget('gitlab')}>🟤 {tr('imageHost.gitlab')}</button>
            <button class="add-option" onclick={() => addTarget('git-custom')}>⚪ {tr('imageHost.git_custom')}</button>
          </div>
          <div class="add-group">
            <span class="add-group-label">{tr('imageHost.groupOss')}</span>
            <button class="add-option" onclick={() => addTarget('qiniu')}>🟡 {tr('imageHost.qiniu')}</button>
            <button class="add-option" onclick={() => addTarget('aliyun-oss')}>🔴 {tr('imageHost.aliyun_oss')}</button>
            <button class="add-option" onclick={() => addTarget('tencent-cos')}>🟤 {tr('imageHost.tencent_cos')}</button>
            <button class="add-option" onclick={() => addTarget('aws-s3')}>⬛ {tr('imageHost.aws_s3')}</button>
            <button class="add-option" onclick={() => addTarget('google-gcs')}>🌐 {tr('imageHost.google_gcs')}</button>
          </div>
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
    flex-direction: column;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
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

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.25rem;
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
</style>

<script lang="ts">
  import { t } from '$lib/i18n';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import {
    updateStore,
    checkForUpdate,
    downloadAndInstall,
    formatBytes,
    type UpdateCheckStatus,
    type DownloadStatus,
    type UpdateInfo,
  } from '$lib/services/update-service';

  let { onClose }: { onClose: () => void } = $props();

  const tr = $t;

  let checkStatus = $state<UpdateCheckStatus>('idle');
  let downloadStatus = $state<DownloadStatus>('idle');
  let updateInfo = $state<UpdateInfo | null>(null);
  let downloadProgress = $state(0);
  let error = $state<string | null>(null);

  updateStore.subscribe(state => {
    checkStatus = state.checkStatus;
    downloadStatus = state.downloadStatus;
    updateInfo = state.updateInfo;
    downloadProgress = state.downloadProgress;
    error = state.error;
  });

  // Auto-check when dialog opens if idle
  $effect(() => {
    if (checkStatus === 'idle') {
      checkForUpdate().catch(() => {});
    }
  });

  function handleRetry() {
    checkForUpdate().catch(() => {});
  }

  function handleRetryDownload() {
    downloadAndInstall().catch(() => {});
  }

  function handleUpgrade() {
    downloadAndInstall().catch(() => {});
  }

  function handleViewRelease() {
    if (updateInfo?.releaseUrl) {
      openUrl(updateInfo.releaseUrl);
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog-panel" onclick={(e) => e.stopPropagation()}>
    <div class="dialog-header">
      <h3>{tr('update.title')}</h3>
      <!-- svelte-ignore a11y_consider_explicit_label -->
      <button class="close-btn" onclick={onClose}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path fill="currentColor" d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z"/>
        </svg>
      </button>
    </div>

    <div class="dialog-body">
      <!-- Current version -->
      <div class="version-row">
        <span class="version-label">{tr('update.currentVersion')}</span>
        <span class="version-value">v{__APP_VERSION__}</span>
      </div>

      {#if checkStatus === 'checking'}
        <div class="status-message">
          <span class="spinner"></span>
          {tr('update.checking')}
        </div>

      {:else if checkStatus === 'error'}
        <div class="status-message error">
          <span>{tr('update.checkFailed')}</span>
          {#if error}
            <span class="error-detail">{error}</span>
          {/if}
        </div>

      {:else if checkStatus === 'latest'}
        <div class="status-message success">
          {tr('update.upToDate')}
        </div>

      {:else if checkStatus === 'available' && updateInfo}
        <div class="version-row">
          <span class="version-label">{tr('update.latestVersion')}</span>
          <span class="version-value new-version">v{updateInfo.latestVersion}</span>
        </div>

        {#if updateInfo.releaseNotes}
          <div class="release-notes">
            <div class="notes-label">{tr('update.releaseNotes')}</div>
            <div class="notes-content">{updateInfo.releaseNotes.slice(0, 500)}{updateInfo.releaseNotes.length > 500 ? '...' : ''}</div>
          </div>
        {/if}

        {#if downloadStatus === 'downloading'}
          <div class="progress-container">
            <div class="progress-bar">
              <div class="progress-fill" style="width: {downloadProgress}%"></div>
            </div>
            <span class="progress-text">{downloadProgress}%</span>
          </div>
        {:else if downloadStatus === 'completed'}
          <div class="status-message success">
            {tr('update.installLaunched')}
          </div>
        {:else if downloadStatus === 'error'}
          <div class="status-message error">
            <span>{tr('update.downloadFailed')}</span>
            {#if error}
              <span class="error-detail">{error}</span>
            {/if}
          </div>
        {/if}

        {#if !updateInfo.downloadUrl}
          <div class="status-message warning">
            {tr('update.noAsset')}
          </div>
        {/if}
      {/if}
    </div>

    <div class="dialog-footer">
      {#if checkStatus === 'available' && updateInfo?.releaseUrl}
        <button class="btn btn-secondary" onclick={handleViewRelease}>
          {tr('update.viewRelease')}
        </button>
      {/if}

      {#if checkStatus === 'error'}
        <button class="btn btn-primary" onclick={handleRetry}>
          {tr('update.retry')}
        </button>
      {:else if downloadStatus === 'error'}
        <button class="btn btn-primary" onclick={handleRetryDownload}>
          {tr('update.retry')}
        </button>
      {:else if checkStatus === 'available' && updateInfo?.downloadUrl && downloadStatus === 'idle'}
        <button class="btn btn-primary" onclick={handleUpgrade}>
          {tr('update.upgrade')} {updateInfo.assetSize > 0 ? formatBytes(updateInfo.assetSize) : ''}
        </button>
      {:else if checkStatus === 'latest' || downloadStatus === 'completed'}
        <button class="btn btn-secondary" onclick={onClose}>
          {tr('common.close')}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog-panel {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    width: 420px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border-light);
  }

  .dialog-header h3 {
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 4px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  /* macOS: close button on the left, consistent with macOS window controls */
  :global(.platform-macos) .dialog-header {
    justify-content: flex-start;
    gap: 0.75rem;
  }
  :global(.platform-macos) .dialog-header .close-btn {
    order: -1;
  }

  .dialog-body {
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    overflow-y: auto;
  }

  .version-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .version-label {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  .version-value {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
    font-family: var(--font-mono);
  }

  .version-value.new-version {
    color: var(--accent-color, #0969da);
  }

  .status-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 1rem;
    border-radius: 6px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    background: var(--bg-secondary);
    text-align: center;
  }

  .status-message.success {
    color: #2ea043;
  }

  .status-message.error {
    color: #e81123;
  }

  .status-message.warning {
    color: #d29922;
  }

  .error-detail {
    font-size: var(--font-size-xs);
    opacity: 0.8;
    word-break: break-word;
  }

  .spinner {
    display: inline-block;
    width: 16px;
    height: 16px;
    border: 2px solid var(--border-color);
    border-top-color: var(--accent-color, #0969da);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .release-notes {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .notes-label {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .notes-content {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    line-height: 1.5;
    max-height: 200px;
    overflow-y: auto;
    background: var(--bg-secondary);
    padding: 0.75rem;
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .progress-container {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .progress-bar {
    flex: 1;
    height: 6px;
    background: var(--bg-secondary);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent-color, #0969da);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .progress-text {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    min-width: 32px;
    text-align: right;
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    border-top: 1px solid var(--border-light);
  }

  .btn {
    padding: 0.4rem 0.75rem;
    border-radius: 4px;
    font-size: var(--font-size-sm);
    cursor: pointer;
    transition: background var(--transition-fast);
    border: 1px solid var(--border-color);
  }

  .btn-primary {
    background: var(--accent-color, #0969da);
    color: #fff;
    border-color: var(--accent-color, #0969da);
  }

  .btn-primary:hover {
    opacity: 0.9;
  }

  .btn-secondary {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .btn-secondary:hover {
    background: var(--bg-hover);
  }
</style>

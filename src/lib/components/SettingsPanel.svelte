<script lang="ts">
  import { settingsStore, type Theme } from '../stores/settings-store';

  let {
    onClose,
  }: {
    onClose: () => void;
  } = $props();

  let theme = $state<Theme>('system');
  let fontSize = $state(16);
  let autoSave = $state(true);
  let autoSaveInterval = $state(30);

  settingsStore.subscribe(state => {
    theme = state.theme;
    fontSize = state.fontSize;
    autoSave = state.autoSave;
    autoSaveInterval = state.autoSaveInterval / 1000;
  });

  function handleThemeChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value as Theme;
    settingsStore.setTheme(value);
  }

  function handleFontSizeChange(event: Event) {
    const value = parseInt((event.target as HTMLInputElement).value);
    settingsStore.update({ fontSize: value });
    document.documentElement.style.setProperty('--font-size-base', `${value}px`);
  }

  function handleAutoSaveChange(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    settingsStore.update({ autoSave: checked });
  }

  function handleIntervalChange(event: Event) {
    const value = parseInt((event.target as HTMLInputElement).value);
    settingsStore.update({ autoSaveInterval: value * 1000 });
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="settings-overlay" onclick={onClose}>
  <div class="settings-panel" onclick={(e) => e.stopPropagation()}>
    <div class="settings-header">
      <h2>Settings</h2>
      <button class="close-btn" onclick={onClose}>
        <svg width="14" height="14" viewBox="0 0 10 10">
          <path fill="currentColor" d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4z"/>
        </svg>
      </button>
    </div>

    <div class="settings-body">
      <div class="setting-group">
        <label class="setting-label">Theme</label>
        <select class="setting-input" value={theme} onchange={handleThemeChange}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <div class="setting-group">
        <label class="setting-label">Font Size</label>
        <div class="setting-row">
          <input
            type="range"
            min="12"
            max="24"
            value={fontSize}
            oninput={handleFontSizeChange}
            class="setting-range"
          />
          <span class="setting-value">{fontSize}px</span>
        </div>
      </div>

      <div class="setting-group">
        <label class="setting-label">
          <input
            type="checkbox"
            checked={autoSave}
            onchange={handleAutoSaveChange}
          />
          Auto Save
        </label>
      </div>

      {#if autoSave}
        <div class="setting-group">
          <label class="setting-label">Auto Save Interval</label>
          <div class="setting-row">
            <input
              type="range"
              min="5"
              max="120"
              step="5"
              value={autoSaveInterval}
              oninput={handleIntervalChange}
              class="setting-range"
            />
            <span class="setting-value">{autoSaveInterval}s</span>
          </div>
        </div>
      {/if}
    </div>

    <div class="settings-footer">
      <span class="version">Inkra v0.1.0</span>
    </div>
  </div>
</div>

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .settings-panel {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    width: 420px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  }

  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border-light);
  }

  .settings-header h2 {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
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

  .settings-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .setting-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .setting-label {
    font-size: var(--font-size-sm);
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
  }

  .setting-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .setting-range {
    flex: 1;
    accent-color: var(--accent-color);
  }

  .setting-value {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    min-width: 3rem;
    text-align: right;
  }

  .settings-footer {
    padding: 0.75rem 1.25rem;
    border-top: 1px solid var(--border-light);
    text-align: center;
  }

  .version {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }
</style>

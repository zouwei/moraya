<script lang="ts">
  /**
   * Picker modal for adding a new MCP tool shortcut to the user's
   * `settings.mcpToolShortcuts` list. The picker UI here only chooses
   * the (server, tool) target — recording a key combo happens after
   * the entry is added (see `ShortcutsPanel.handleAddMCPTool`).
   */
  import { t } from '$lib/i18n';
  import type { MCPServerConfig, MCPTool } from '$lib/services/mcp/types';
  import type { MCPToolShortcutRef } from '$lib/shortcuts/catalog';

  let {
    servers,
    tools,
    existing,
    onClose,
    onAdd,
  }: {
    servers: MCPServerConfig[];
    tools: MCPTool[];
    existing: MCPToolShortcutRef[];
    onClose: () => void;
    onAdd: (payload: { serverId: string; toolName: string }) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let serverId = $state(servers[0]?.id ?? '');
  let toolName = $state('');

  // Tools available for the selected server only — keeps the picker simple
  // and avoids surfacing tool name collisions across servers.
  let serverTools = $derived(tools.filter(t => t.serverId === serverId));

  let duplicate = $derived(
    !!serverId && !!toolName &&
    existing.some(r => r.serverId === serverId && r.toolName === toolName)
  );
  let canAdd = $derived(!!serverId && !!toolName && !duplicate);

  function handleSubmit() {
    if (!canAdd) return;
    onAdd({ serverId, toolName });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dialog-overlay" onclick={onClose}>
  <div class="dialog" role="dialog" aria-modal="true" tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <header class="dialog-head">
      <h3>{$t('shortcuts.mcp.dialog.title')}</h3>
      <button class="close-btn" onclick={onClose} type="button" aria-label="Close">✕</button>
    </header>

    <div class="dialog-body">
      <div class="field">
        <label class="field-label" for="mcp-shortcut-server">{$t('shortcuts.mcp.dialog.serverLabel')}</label>
        <select id="mcp-shortcut-server" class="gx-select" bind:value={serverId}>
          {#each servers as s (s.id)}
            <option value={s.id}>{s.name}</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <label class="field-label" for="mcp-shortcut-tool">{$t('shortcuts.mcp.dialog.toolLabel')}</label>
        {#if serverTools.length === 0}
          <p class="hint">{$t('shortcuts.mcp.dialog.noToolsForServer')}</p>
        {:else}
          <select id="mcp-shortcut-tool" class="gx-select" bind:value={toolName}>
            <option value="" disabled>{$t('shortcuts.mcp.dialog.toolPlaceholder')}</option>
            {#each serverTools as tool (tool.name)}
              <option value={tool.name}>{tool.name}</option>
            {/each}
          </select>
          {#if toolName}
            {@const sel = serverTools.find(tt => tt.name === toolName)}
            {#if sel?.description}
              <p class="hint">{sel.description}</p>
            {/if}
          {/if}
        {/if}
      </div>

      {#if duplicate}
        <p class="error">{$t('shortcuts.mcp.dialog.duplicateError')}</p>
      {/if}
    </div>

    <footer class="dialog-foot">
      <button class="gx-btn" onclick={onClose} type="button">
        {$t('shortcuts.mcp.dialog.cancel')}
      </button>
      <button class="gx-btn gx-btn-primary" onclick={handleSubmit} disabled={!canAdd} type="button">
        {$t('shortcuts.mcp.dialog.add')}
      </button>
    </footer>
  </div>
</div>

<style>
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 220;
  }
  .dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    width: 420px;
    max-width: 92vw;
    display: flex;
    flex-direction: column;
    box-shadow: 0 10px 36px rgba(0, 0, 0, 0.2);
  }
  .dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-light);
  }
  .dialog-head h3 {
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
  }
  .close-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
    width: 24px;
    height: 24px;
    border-radius: 5px;
  }
  .close-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .dialog-body {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .field-label {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    font-weight: 500;
  }
  .hint {
    margin: 0;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    line-height: 1.45;
  }
  .error {
    margin: 0;
    font-size: var(--font-size-xs);
    color: #c62828;
  }
  .dialog-foot {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-light);
  }
</style>

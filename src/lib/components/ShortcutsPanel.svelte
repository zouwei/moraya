<script lang="ts">
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings-store';
  import { isMacOS } from '$lib/utils/platform';
  import {
    CATEGORY_LABEL_KEYS,
    SCOPE_LABEL_KEYS,
    SCOPE_ORDER,
    scopeOf,
    displayShortcut,
    effectiveBinding,
    eventToBinding,
    findBindingConflict,
    getRuntimeCatalog,
    resolveAIChatBindings,
    type ShortcutCategory,
    type ShortcutEntry,
  } from '$lib/shortcuts/catalog';
  import { mcpStore } from '$lib/services/mcp/mcp-manager';
  import AddMCPShortcutDialog from './AddMCPShortcutDialog.svelte';

  // ── Runtime catalog: static entries + dynamic MCP entries ──────────
  let mcpState = $derived($mcpStore);
  let userToolShortcuts = $derived($settingsStore.mcpToolShortcuts ?? []);
  let catalog = $derived(getRuntimeCatalog(
    mcpState.servers,
    mcpState.tools,
    userToolShortcuts,
  ));

  // Two-level grouping (v0.46.0): document flavor → category.
  //
  // Moraya edits Markdown and Typst documents. Actions that exist in both keep
  // one binding and are listed under "shared"; the rest are grouped under the
  // format they apply to, so the panel makes it obvious which bindings carry
  // over between formats and which do not. Categories keep the menu's order
  // within each section.
  let scopeGroups = $derived.by(() => {
    const order: ShortcutCategory[] = ['file', 'edit', 'paragraph', 'format', 'view', 'workflow', 'aiChat', 'mcp'];
    return SCOPE_ORDER
      .map(scope => {
        const map = new Map<ShortcutCategory, ShortcutEntry[]>();
        for (const c of order) map.set(c, []);
        for (const entry of catalog) {
          if (scopeOf(entry) !== scope) continue;
          map.get(entry.category)?.push(entry);
        }
        const categories = order
          .map(c => ({ category: c, entries: map.get(c) ?? [] }))
          // The MCP section keeps its empty-state + "add tool" row, but only in
          // the shared group (MCP shortcuts are flavor-independent).
          .filter(g => g.entries.length > 0 || (g.category === 'mcp' && scope === 'shared'));
        return { scope, categories };
      })
      .filter(g => g.categories.length > 0);
  });

  let behavior = $derived($settingsStore.aiChatEnterBehavior);
  let aiBindings = $derived(resolveAIChatBindings(behavior, isMacOS));
  let overrides = $derived($settingsStore.shortcutOverrides ?? {});

  function setBehavior(value: 'modEnterSend' | 'enterSend') {
    settingsStore.update({ aiChatEnterBehavior: value });
  }

  /** Whether this row supports inline keystroke recording. */
  function isEditable(entry: ShortcutEntry): boolean {
    // AI chat bindings are driven by the radio above — don't double-expose.
    if (entry.id === 'aiChat.send' || entry.id === 'aiChat.newline') return false;
    // Stale MCP entries get a "remove" affordance instead of recording.
    if (entry.stale) return false;
    return entry.customizable;
  }

  /** Whether this entry has been overridden by the user. */
  function isOverridden(entry: ShortcutEntry): boolean {
    return entry.customizable && !!overrides[entry.id];
  }

  /** Resolved label for a row — dynamic entries use `entry.label`, static use i18n. */
  function rowLabel(entry: ShortcutEntry): string {
    if (entry.label) return entry.label;
    return $t(entry.labelKey);
  }

  function rowBinding(entry: ShortcutEntry): string {
    if (entry.id === 'aiChat.send') return aiBindings.sendDisplay;
    if (entry.id === 'aiChat.newline') return aiBindings.newlineDisplay;
    return effectiveBinding(entry, isMacOS, overrides);
  }

  // ── Recording state ─────────────────────────────────────────────
  let recordingId: string | null = $state(null);
  let recordedBinding: string | null = $state(null);
  let recordError: string | null = $state(null);

  function startRecording(entry: ShortcutEntry) {
    if (!isEditable(entry)) return;
    recordingId = entry.id;
    recordedBinding = null;
    recordError = null;
  }

  function cancelRecording() {
    recordingId = null;
    recordedBinding = null;
    recordError = null;
  }

  function captureKeydown(event: KeyboardEvent) {
    if (!recordingId) return;
    event.preventDefault();
    event.stopPropagation();
    // Esc cancels.
    if (event.key === 'Escape' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      cancelRecording();
      return;
    }
    const binding = eventToBinding(event, isMacOS);
    if (!binding) return; // user only pressed a modifier — wait for real key
    // Require at least one modifier so we don't accidentally grab letters.
    const parts = binding.split('+');
    if (parts.length < 2) {
      recordedBinding = binding;
      recordError = 'shortcuts.editor.needs_modifier';
      return;
    }
    const conflict = findBindingConflict(binding, recordingId, isMacOS, overrides, catalog);
    if (conflict && conflict.id !== recordingId) {
      recordedBinding = binding;
      recordError = 'shortcuts.editor.conflict';
      return;
    }
    recordedBinding = binding;
    recordError = null;
  }

  /** Surfaces async menu-sync failures next to the affected row. */
  let syncErrorId = $state<string | null>(null);

  async function saveRecording() {
    if (!recordingId || !recordedBinding || recordError) return;
    const id = recordingId;
    const newBinding = recordedBinding;
    const next = { ...overrides, [id]: newBinding };
    // Write settings first so the panel re-renders immediately with the new chip.
    settingsStore.update({ shortcutOverrides: next });
    cancelRecording();

    // Push to the native menu. If it fails, roll back the settings so the
    // panel + the menu stay in sync (single source of truth).
    const { applySingleOverride } = await import('$lib/services/menu-sync');
    const result = await applySingleOverride(id, newBinding);
    if (!result.ok) {
      const rollback = { ...next };
      delete rollback[id];
      settingsStore.update({ shortcutOverrides: rollback });
      syncErrorId = id;
      setTimeout(() => { syncErrorId = null; }, 4000);
      console.warn('[ShortcutsPanel] menu sync failed:', result.reason);
    }
  }

  async function resetRecording(entry: ShortcutEntry) {
    if (!overrides[entry.id]) return;
    // A7: re-check conflict — recovering to default might collide with a
    // different user-set override (e.g. user moved format.bold to Cmd+J,
    // then set paragraph.h1 to Cmd+B; resetting bold back to Cmd+B now
    // clashes with h1's override).
    const defaultBinding = displayShortcut(entry, isMacOS);
    if (defaultBinding) {
      const remaining = { ...overrides };
      delete remaining[entry.id];
      const conflict = findBindingConflict(defaultBinding, entry.id, isMacOS, remaining, catalog);
      if (conflict) {
        recordError = 'shortcuts.editor.reset_conflict';
        recordedBinding = defaultBinding;
        recordingId = entry.id; // open the recorder so user can pick a new combo
        return;
      }
    }
    const next = { ...overrides };
    delete next[entry.id];
    settingsStore.update({ shortcutOverrides: next });
    cancelRecording();

    const { applySingleOverride } = await import('$lib/services/menu-sync');
    const result = await applySingleOverride(entry.id, null);
    if (!result.ok) {
      // Restore the override since we couldn't reset the menu accel.
      settingsStore.update({ shortcutOverrides: overrides });
      syncErrorId = entry.id;
      setTimeout(() => { syncErrorId = null; }, 4000);
      console.warn('[ShortcutsPanel] menu reset failed:', result.reason);
    }
  }

  /** Number of entries currently overridden — drives the "Reset all" button. */
  let overrideCount = $derived(Object.keys(overrides).length);

  // ── MCP shortcut management ───────────────────────────────────────
  let showAddMCPDialog = $state(false);

  function removeMCPToolShortcut(catalogId: string) {
    const next = (userToolShortcuts ?? []).filter(r => r.catalogId !== catalogId);
    const nextOverrides = { ...overrides };
    delete nextOverrides[catalogId];
    settingsStore.update({
      mcpToolShortcuts: next,
      shortcutOverrides: nextOverrides,
    });
  }

  function handleAddMCPTool(payload: { serverId: string; toolName: string }) {
    const catalogId = `mcp.tool.${payload.serverId}.${payload.toolName}.prompt`;
    if ((userToolShortcuts ?? []).some(r => r.catalogId === catalogId)) {
      showAddMCPDialog = false;
      return;
    }
    settingsStore.update({
      mcpToolShortcuts: [...(userToolShortcuts ?? []), {
        catalogId,
        serverId: payload.serverId,
        toolName: payload.toolName,
      }],
    });
    showAddMCPDialog = false;
    // Open the recorder immediately so the user can bind a combo without
    // a second click — the runtime catalog will include the new entry by
    // the time Svelte re-renders.
    queueMicrotask(() => {
      const entry = catalog.find(e => e.id === catalogId);
      if (entry) startRecording(entry);
    });
  }

  /** Reset every customized shortcut back to its catalog default. */
  async function resetAllToDefaults() {
    if (overrideCount === 0) return;
    const msg = $t('shortcuts.editor.reset_all_confirm', { count: String(overrideCount) });
    if (!confirm(msg)) return;
    const before = overrides;
    settingsStore.update({ shortcutOverrides: {} });
    const { pushOverridesToMenu } = await import('$lib/services/menu-sync');
    const result = await pushOverridesToMenu({});
    if (result.failed.length > 0) {
      // Roll back if the menu push partially failed — keep the panel + menu aligned.
      settingsStore.update({ shortcutOverrides: before });
      console.warn('[ShortcutsPanel] reset-all menu sync failed:', result.failed);
    }
  }

  // Map textual modifier names to macOS glyphs when relevant. Keeps Windows /
  // Linux readable ("Ctrl"), gives mac users the iconic key caps they expect.
  const MAC_GLYPHS: Record<string, string> = {
    Cmd: '⌘', Command: '⌘',
    Shift: '⇧',
    Alt: '⌥', Option: '⌥',
    Ctrl: '⌃', Control: '⌃',
    Enter: '↵', Return: '↵',
    Tab: '⇥',
    Esc: '⎋', Escape: '⎋',
    Backspace: '⌫', Delete: '⌫',
    Space: '␣',
    Up: '↑', Down: '↓', Left: '←', Right: '→',
  };

  /** Split a binding string like "Cmd+Shift+N" or "Cmd+/" into per-key chunks. */
  function splitBinding(binding: string): string[] {
    if (!binding) return [];
    // Preserve "+" as its own chunk when it's the literal key (e.g. "Cmd++")
    return binding.split('+').map(s => s.trim()).filter(Boolean);
  }

  /** What to render inside a single <kbd>. Maps to glyph on mac when known. */
  function keyDisplay(token: string): string {
    if (isMacOS && MAC_GLYPHS[token]) return MAC_GLYPHS[token];
    return token;
  }

  /** Visually wider kbd for word tokens (Enter, Shift) vs symbol tokens (⌘). */
  function isWordKey(token: string): boolean {
    const display = keyDisplay(token);
    return display.length > 1;
  }
</script>

<div class="shortcuts-panel">
  <header class="panel-intro">
    <div class="page-title-row">
      <h2 class="page-title">{$t('shortcuts.title')}</h2>
      {#if overrideCount > 0}
        <button
          type="button"
          class="reset-all-btn"
          onclick={resetAllToDefaults}
          title={$t('shortcuts.editor.reset_all_hint')}
        >
          ↺ {$t('shortcuts.editor.reset_all')}
          <span class="reset-all-count">{overrideCount}</span>
        </button>
      {/if}
    </div>
  </header>

  <!-- AI chat behavior — selectable option cards -->
  <section class="settings-section">
    <div class="section-head">
      <h3 class="section-title">{$t('shortcuts.ai_chat_behavior.title')}</h3>
      <p class="section-desc">{$t('shortcuts.ai_chat_behavior.intro')}</p>
    </div>

    <div class="option-cards" role="radiogroup" aria-label={$t('shortcuts.ai_chat_behavior.title')}>
      <label class="option-card" class:selected={behavior === 'modEnterSend'}>
        <input
          type="radio"
          name="ai-chat-enter"
          value="modEnterSend"
          checked={behavior === 'modEnterSend'}
          onchange={() => setBehavior('modEnterSend')}
        />
        <div class="option-radio" aria-hidden="true">
          <span class="radio-dot"></span>
        </div>
        <div class="option-body">
          <div class="option-label">
            <span class="option-label-text">{$t('shortcuts.ai_chat_behavior.mod_enter_send.label')}</span>
            <span class="default-badge" aria-label={$t('shortcuts.ai_chat_behavior.default_badge')}>{$t('shortcuts.ai_chat_behavior.default_badge')}</span>
          </div>
          <div class="option-mappings">
            <div class="mapping">
              <span class="mapping-keys">
                {#each splitBinding(isMacOS ? 'Cmd+Enter' : 'Ctrl+Enter') as token, i (i)}
                  {#if i > 0}<span class="key-plus">+</span>{/if}
                  <kbd class:word={isWordKey(token)}>{keyDisplay(token)}</kbd>
                {/each}
              </span>
              <span class="mapping-arrow">→</span>
              <span class="mapping-action">{$t('shortcuts.ai_chat_behavior.sends_action')}</span>
            </div>
            <div class="mapping">
              <span class="mapping-keys">
                <kbd class="word">{keyDisplay('Enter')}</kbd>
              </span>
              <span class="mapping-arrow">→</span>
              <span class="mapping-action">{$t('shortcuts.ai_chat_behavior.newline_action')}</span>
            </div>
          </div>
        </div>
      </label>

      <label class="option-card" class:selected={behavior === 'enterSend'}>
        <input
          type="radio"
          name="ai-chat-enter"
          value="enterSend"
          checked={behavior === 'enterSend'}
          onchange={() => setBehavior('enterSend')}
        />
        <div class="option-radio" aria-hidden="true">
          <span class="radio-dot"></span>
        </div>
        <div class="option-body">
          <div class="option-label">{$t('shortcuts.ai_chat_behavior.enter_send.label')}</div>
          <div class="option-mappings">
            <div class="mapping">
              <span class="mapping-keys">
                <kbd class="word">{keyDisplay('Enter')}</kbd>
              </span>
              <span class="mapping-arrow">→</span>
              <span class="mapping-action">{$t('shortcuts.ai_chat_behavior.sends_action')}</span>
            </div>
            <div class="mapping">
              <span class="mapping-keys">
                {#each splitBinding('Shift+Enter') as token, i (i)}
                  {#if i > 0}<span class="key-plus">+</span>{/if}
                  <kbd class:word={isWordKey(token)}>{keyDisplay(token)}</kbd>
                {/each}
              </span>
              <span class="mapping-arrow">→</span>
              <span class="mapping-action">{$t('shortcuts.ai_chat_behavior.newline_action')}</span>
            </div>
          </div>
        </div>
      </label>
    </div>
  </section>

  <!-- Full shortcut catalog, grouped by document flavor then category -->
  {#each scopeGroups as scopeGroup (scopeGroup.scope)}
    <div class="scope-group">
      <div class="scope-head">
        <h3 class="scope-title">{$t(SCOPE_LABEL_KEYS[scopeGroup.scope])}</h3>
        <p class="scope-desc">{$t(`shortcuts.scopes.${scopeGroup.scope}_desc`)}</p>
      </div>
    {#each scopeGroup.categories as group (group.category)}
    {@const tokens = (entry: ShortcutEntry) => splitBinding(rowBinding(entry))}
    {@const isMCP = group.category === 'mcp'}
    <section class="settings-section">
      <div class="section-head">
        <h4 class="section-title">{$t(CATEGORY_LABEL_KEYS[group.category])}</h4>
        {#if isMCP}
          <p class="section-desc">{$t('shortcuts.mcp.intro')}</p>
        {/if}
      </div>
      <div class="shortcut-card">
        {#if isMCP && group.entries.length === 0}
          <div class="shortcut-row mcp-empty">
            <span class="mcp-empty-text">{$t('shortcuts.mcp.empty')}</span>
          </div>
        {/if}
        {#each group.entries as entry, i (entry.id)}
          {@const recording = recordingId === entry.id}
          {@const editable = isEditable(entry)}
          {@const overridden = isOverridden(entry)}
          <div class="shortcut-row" class:first={i === 0} class:last={i === group.entries.length - 1 && !isMCP} class:recording>
            <span class="shortcut-label">
              <span class="label-text">{rowLabel(entry)}</span>
              {#if entry.dynamicKind === 'mcp.server'}
                <span class="mcp-kind-pill mcp-kind-server" title={$t('shortcuts.mcp.server_kind_hint')}>{$t('shortcuts.mcp.server_kind_short')}</span>
              {:else if entry.dynamicKind === 'mcp.tool'}
                <span class="mcp-kind-pill mcp-kind-tool" title={$t('shortcuts.mcp.tool_kind_hint')}>{$t('shortcuts.mcp.tool_kind_short')}</span>
              {/if}
              {#if entry.stale}
                <span class="mcp-stale-pill" title={$t('shortcuts.mcp.stale_hint')}>{$t('shortcuts.mcp.stale_short')}</span>
              {/if}
              {#if overridden && !recording && !entry.stale}
                <span class="overridden-pill" title={$t('shortcuts.editor.customized')}>{$t('shortcuts.editor.customized_short')}</span>
              {/if}
              {#if syncErrorId === entry.id}
                <span class="sync-error-pill" title={$t('shortcuts.editor.sync_failed')}>{$t('shortcuts.editor.sync_failed_short')}</span>
              {/if}
            </span>
            <span class="shortcut-binding">
              {#if recording}
                <span class="recorder">
                  {#if recordedBinding}
                    <span class="key-group recorder-keys" class:invalid={!!recordError}>
                      {#each splitBinding(recordedBinding) as token, j (j)}
                        {#if j > 0}<span class="key-plus">+</span>{/if}
                        <kbd class:word={isWordKey(token)}>{keyDisplay(token)}</kbd>
                      {/each}
                    </span>
                    {#if recordError}
                      <span class="recorder-error">{$t(recordError)}</span>
                    {/if}
                  {:else}
                    <span class="recorder-prompt">{$t('shortcuts.editor.prompt')}</span>
                  {/if}
                  <button
                    type="button"
                    class="recorder-btn save"
                    onclick={saveRecording}
                    disabled={!recordedBinding || !!recordError}
                    title={$t('shortcuts.editor.save')}
                    aria-label={$t('shortcuts.editor.save')}
                  >✓</button>
                  <button
                    type="button"
                    class="recorder-btn cancel"
                    onclick={cancelRecording}
                    title={$t('shortcuts.editor.cancel')}
                    aria-label={$t('shortcuts.editor.cancel')}
                  >✕</button>
                </span>
              {:else if entry.stale}
                <button
                  type="button"
                  class="reset-btn danger"
                  onclick={() => removeMCPToolShortcut(entry.id)}
                  title={$t('shortcuts.mcp.remove_stale')}
                  aria-label={$t('shortcuts.mcp.remove_stale')}
                >✕ <span class="reset-btn-text">{$t('shortcuts.mcp.remove_stale_short')}</span></button>
              {:else}
                {#if editable}
                  <button
                    type="button"
                    class="key-trigger"
                    class:unbound={tokens(entry).length === 0}
                    onclick={() => startRecording(entry)}
                    title={$t('shortcuts.editor.edit_hint')}
                    aria-label={$t('shortcuts.editor.edit_hint')}
                  >
                    {#if tokens(entry).length === 0}
                      <span class="unbound-placeholder">{$t('shortcuts.editor.unbound')}</span>
                    {:else}
                      <span class="key-group">
                        {#each tokens(entry) as token, j (j)}
                          {#if j > 0}<span class="key-plus">+</span>{/if}
                          <kbd class:word={isWordKey(token)}>{keyDisplay(token)}</kbd>
                        {/each}
                      </span>
                    {/if}
                    <span class="edit-icon" aria-hidden="true">✎</span>
                  </button>
                  {#if overridden && entry.dynamicKind === 'mcp.tool'}
                    <button
                      type="button"
                      class="reset-btn"
                      onclick={() => removeMCPToolShortcut(entry.id)}
                      title={$t('shortcuts.mcp.remove_tool')}
                      aria-label={$t('shortcuts.mcp.remove_tool')}
                    >✕ <span class="reset-btn-text">{$t('shortcuts.mcp.remove_tool_short')}</span></button>
                  {:else if overridden}
                    <button
                      type="button"
                      class="reset-btn"
                      onclick={() => resetRecording(entry)}
                      title={$t('shortcuts.editor.reset_to_default')}
                      aria-label={$t('shortcuts.editor.reset_to_default')}
                    >↺ <span class="reset-btn-text">{$t('shortcuts.editor.reset_short')}</span></button>
                  {/if}
                {:else}
                  <span class="key-group">
                    {#each tokens(entry) as token, j (j)}
                      {#if j > 0}<span class="key-plus">+</span>{/if}
                      <kbd class:word={isWordKey(token)}>{keyDisplay(token)}</kbd>
                    {/each}
                  </span>
                {/if}
              {/if}
            </span>
          </div>
        {/each}
        {#if isMCP}
          <div class="shortcut-row mcp-add-row">
            <button
              type="button"
              class="mcp-add-btn"
              onclick={() => { showAddMCPDialog = true; }}
              disabled={mcpState.servers.length === 0}
              title={mcpState.servers.length === 0 ? $t('shortcuts.mcp.empty') : $t('shortcuts.mcp.add_tool')}
            >
              + {$t('shortcuts.mcp.add_tool')}
            </button>
          </div>
        {/if}
      </div>
    </section>
    {/each}
    </div>
  {/each}

</div>

{#if showAddMCPDialog}
  <AddMCPShortcutDialog
    servers={mcpState.servers}
    tools={mcpState.tools}
    existing={userToolShortcuts}
    onClose={() => { showAddMCPDialog = false; }}
    onAdd={handleAddMCPTool}
  />
{/if}

<svelte:window onkeydown={captureKeydown} />

<style>
  .shortcuts-panel {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding-bottom: 0.5rem;
  }

  /* ── Page intro ───────────────────────────────────────────────── */
  .panel-intro {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .page-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .page-title {
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }
  .reset-all-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 3px 10px;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.1s ease, color 0.1s ease, border-color 0.1s ease;
  }
  .reset-all-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--text-muted);
  }
  .reset-all-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 16px;
    padding: 0 5px;
    font-size: 10px;
    font-weight: 600;
    color: white;
    background: var(--accent-color);
    border-radius: 999px;
  }

  /* ── Section (label above + card) ─────────────────────────────── */
  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .section-head {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0 0.1rem;
  }
  .section-title {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .section-desc {
    margin: 0;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    line-height: 1.45;
  }

  /* ── Option cards (AI behavior) ───────────────────────────────── */
  .option-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }
  /* Fall back to a single column if the panel becomes too narrow
     (rare — settings content area is normally ~520px). */
  @media (max-width: 540px) {
    .option-cards { grid-template-columns: 1fr; }
  }
  .option-card {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.65rem;
    align-items: flex-start;
    padding: 0.7rem 0.85rem;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.12s ease, background 0.12s ease, box-shadow 0.12s ease;
    min-width: 0; /* allow keys row to wrap if needed inside narrow card */
  }
  .option-card:hover:not(.selected) {
    border-color: var(--text-muted);
    background: var(--bg-secondary);
  }
  .option-card.selected {
    border-color: var(--accent-color);
    background: color-mix(in srgb, var(--accent-color) 5%, var(--bg-primary));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 12%, transparent);
  }
  .option-card input[type='radio'] {
    /* hidden — using custom radio visualization */
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .option-radio {
    margin-top: 0.15rem;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1.5px solid var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: border-color 0.12s ease;
  }
  .option-card.selected .option-radio {
    border-color: var(--accent-color);
  }
  .radio-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-color);
    transform: scale(0);
    transition: transform 0.15s ease;
  }
  .option-card.selected .radio-dot { transform: scale(1); }
  .option-body { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
  .option-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .option-label-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  /* Watermark-style "Default" pill — subtle so it doesn't compete with the
     title, and small enough to never push the title onto a second line. */
  .default-badge {
    flex-shrink: 0;
    display: inline-block;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 500;
    line-height: 1.4;
    letter-spacing: 0.02em;
    color: var(--text-muted);
    background: var(--bg-secondary);
    border: 1px solid var(--border-light);
    border-radius: 999px;
    text-transform: uppercase;
  }
  .option-card.selected .default-badge {
    color: var(--accent-color);
    background: color-mix(in srgb, var(--accent-color) 10%, transparent);
    border-color: color-mix(in srgb, var(--accent-color) 30%, transparent);
  }
  .option-mappings {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .mapping {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem 0.55rem;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }
  .mapping-keys {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
  }
  .mapping-arrow {
    color: var(--text-muted);
    font-size: 0.9em;
  }
  .mapping-action { color: var(--text-secondary); }

  /* ── Document-flavor group (shared / Markdown / Typst) ────────── */
  .scope-group {
    margin-bottom: 1.5rem;
  }
  .scope-head {
    margin: 0 0 0.5rem;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--border-color);
  }
  .scope-title {
    margin: 0;
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
  }
  .scope-desc {
    margin: 0.15rem 0 0;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }

  /* ── Shortcut card (grouped rows) ─────────────────────────────── */
  .shortcut-card {
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
  }
  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.55rem 0.9rem;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    border-top: 1px solid var(--border-light);
    transition: background 0.08s ease;
  }
  .shortcut-row.first { border-top: none; }
  .shortcut-row:hover { background: var(--bg-secondary); }
  .shortcut-label {
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .shortcut-binding {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }
  /* ── Editable row affordance ──────────────────────────────────── */
  /* Always-visible affordance so users can find the entry point without
     hovering. Subtle dashed border + persistent pencil icon make the row
     read as a control at rest. */
  .key-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: color-mix(in srgb, var(--accent-color) 4%, transparent);
    border: 1px dashed color-mix(in srgb, var(--accent-color) 40%, var(--border-color));
    border-radius: 6px;
    padding: 2px 8px 2px 5px;
    cursor: pointer;
    color: inherit;
    font: inherit;
    transition: background 0.1s ease, border-color 0.1s ease, box-shadow 0.1s ease;
  }
  .key-trigger:hover {
    background: color-mix(in srgb, var(--accent-color) 10%, transparent);
    border-style: solid;
    border-color: var(--accent-color);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 10%, transparent);
  }
  .key-trigger:focus-visible {
    outline: none;
    border-style: solid;
    border-color: var(--accent-color);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 18%, transparent);
  }
  .edit-icon {
    font-size: 11px;
    color: var(--accent-color);
    opacity: 0.7;
    transition: opacity 0.1s ease;
  }
  .key-trigger:hover .edit-icon { opacity: 1; }
  .key-trigger.unbound {
    background: transparent;
    border-style: dashed;
    border-color: var(--border-color);
  }
  .unbound-placeholder {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    font-style: italic;
    padding: 0 2px;
  }
  .reset-btn {
    margin-left: 2px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 22px;
    padding: 0 8px;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 5px;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
    transition: background 0.1s ease, color 0.1s ease, border-color 0.1s ease;
  }
  .reset-btn-text {
    font-weight: 500;
  }
  .reset-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--text-muted);
  }
  .sync-error-pill {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 1px 6px;
    background: color-mix(in srgb, #dc3545 14%, transparent);
    color: #c62828;
    font-size: 10px;
    font-weight: 600;
    border-radius: 999px;
    letter-spacing: 0.02em;
    vertical-align: 1px;
  }
  .overridden-pill {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 1px 6px;
    background: color-mix(in srgb, var(--accent-color) 14%, transparent);
    color: var(--accent-color);
    font-size: 10px;
    font-weight: 600;
    border-radius: 999px;
    letter-spacing: 0.02em;
    vertical-align: 1px;
  }

  /* ── MCP section ──────────────────────────────────────────────── */
  .mcp-kind-pill {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 600;
    border-radius: 999px;
    letter-spacing: 0.02em;
    vertical-align: 1px;
  }
  .mcp-kind-server {
    background: color-mix(in srgb, #2e7d32 12%, transparent);
    color: #1b5e20;
  }
  .mcp-kind-tool {
    background: color-mix(in srgb, #6a1b9a 12%, transparent);
    color: #6a1b9a;
  }
  .mcp-stale-pill {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 1px 6px;
    background: color-mix(in srgb, #dc3545 14%, transparent);
    color: #c62828;
    font-size: 10px;
    font-weight: 600;
    border-radius: 999px;
    letter-spacing: 0.02em;
    vertical-align: 1px;
  }
  .mcp-empty,
  .mcp-add-row {
    justify-content: center;
  }
  .mcp-empty-text {
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    font-style: italic;
  }
  .mcp-add-btn {
    padding: 4px 12px;
    font-size: var(--font-size-xs);
    color: var(--accent-color);
    background: transparent;
    border: 1px dashed color-mix(in srgb, var(--accent-color) 50%, var(--border-color));
    border-radius: 6px;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.1s ease, border-color 0.1s ease;
  }
  .mcp-add-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent-color) 8%, transparent);
    border-color: var(--accent-color);
  }
  .mcp-add-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .reset-btn.danger {
    border-color: #e57373;
    color: #c62828;
  }
  .reset-btn.danger:hover {
    background: color-mix(in srgb, #dc3545 8%, transparent);
  }

  /* ── Recording mode (per-row) ─────────────────────────────────── */
  .shortcut-row.recording {
    background: color-mix(in srgb, var(--accent-color) 6%, var(--bg-primary));
    box-shadow: inset 0 0 0 1px var(--accent-color);
  }
  .recorder {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .recorder-prompt {
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    font-style: italic;
  }
  .recorder-keys.invalid kbd {
    border-color: #e57373;
    color: #c62828;
  }
  .recorder-error {
    color: #c62828;
    font-size: 11px;
  }
  .recorder-btn {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 5px;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    color: var(--text-secondary);
    transition: background 0.1s ease, color 0.1s ease;
  }
  .recorder-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .recorder-btn.save:not(:disabled) {
    background: var(--accent-color);
    color: white;
    border-color: var(--accent-color);
  }
  .recorder-btn.save:not(:disabled):hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .recorder-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ── Key cap styling (kbd) ────────────────────────────────────── */
  .key-group {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-bottom-width: 2px;
    border-radius: 5px;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-primary);
    line-height: 1;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
  }
  /* Word keys (Enter, Shift, Tab) get more horizontal padding. */
  kbd.word {
    min-width: auto;
    padding: 0 8px;
    font-size: 11px;
    letter-spacing: 0.01em;
  }
  /* Single-glyph keys (⌘ ⇧ ⌥ ⌃) get tighter width and slightly larger glyph. */
  kbd:not(.word) {
    font-size: 13px;
    font-weight: 500;
  }
  .key-plus {
    color: var(--text-muted);
    font-size: 10px;
    margin: 0 1px;
    user-select: none;
  }

</style>

<script lang="ts">
  import { settingsStore } from '$lib/stores/settings-store';
  import { startTranscription, stopTranscription } from '$lib/services/voice/speech-service';
  import { t, resolveAllLocales } from '$lib/i18n';
  import type { TranscriptSegment, NewProfileProposal, VoiceProfile } from '$lib/services/voice/types';
  import type { SpeechProviderConfig } from '$lib/services/ai/types';

  let {
    onSendToAI,
    onBack,
    onInsert,
    onOpenSettings,
  }: {
    onSendToAI?: (transcript: string) => void;
    onBack?: () => void;
    onInsert?: (text: string) => void;
    onOpenSettings?: () => void;
  } = $props();

  // ── State ──────────────────────────────────────────────────────────────────

  type RecordingState = 'idle' | 'connecting' | 'recording' | 'paused' | 'stopping';

  let recordingState = $state<RecordingState>('idle');
  let sessionId = $state<string | null>(null);
  let segments = $state<TranscriptSegment[]>([]);
  let elapsedMs = $state(0);
  let error = $state<string | null>(null);
  let transcriptEl = $state<HTMLDivElement | undefined>(undefined);
  let autoScroll = $state(true);

  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let startTime = 0;

  // Active speech config from settings
  let speechConfig = $derived.by((): SpeechProviderConfig | null => {
    const s = $settingsStore;
    if (!s.activeSpeechConfigId || !s.speechProviderConfigs?.length) return null;
    return s.speechProviderConfigs.find(c => c.id === s.activeSpeechConfigId) ?? null;
  });

  let voiceProfiles = $derived($settingsStore.voiceProfiles ?? []);

  // Default voice-profiles directory (appDataDir/voice-profiles) — computed once
  let defaultSyncDir = $state('');
  $effect(() => {
    import('@tauri-apps/api/path').then(async ({ appDataDir }) => {
      const d = await appDataDir();
      const sep = d.endsWith('/') || d.endsWith('\\') ? '' : '/';
      defaultSyncDir = d + sep + 'voice-profiles';
    });
  });

  // ── Computed ───────────────────────────────────────────────────────────────

  let elapsedFormatted = $derived.by(() => {
    const total = Math.floor(elapsedMs / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  });

  // Only use utterance-final segments for export / AI summary.
  // Interim and mid-utterance segments are only for live UI display.
  let finalSegments = $derived(segments.filter(seg => seg.isFinal));

  let fullTranscript = $derived(
    finalSegments.map(seg => `${seg.displayName}: ${seg.text}`).join('\n\n')
  );

  // Speaker color palette
  const SPEAKER_COLORS = [
    '#4A90E2', '#7ED321', '#D0021B', '#F5A623', '#9013FE',
    '#50E3C2', '#B8E986', '#FF6B6B', '#4ECDC4', '#C7B42C',
  ];
  const speakerColorMap = new Map<string, string>();

  function getSpeakerColor(displayName: string): string {
    if (!speakerColorMap.has(displayName)) {
      speakerColorMap.set(
        displayName,
        SPEAKER_COLORS[speakerColorMap.size % SPEAKER_COLORS.length],
      );
    }
    return speakerColorMap.get(displayName)!;
  }

  function formatSegmentTime(ms: number): string {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ── Recording control ──────────────────────────────────────────────────────

  async function startRecording() {
    if (!speechConfig) {
      error = $t('transcription.noSpeechConfig');
      return;
    }
    error = null;
    segments = [];
    speakerColorMap.clear();
    recordingState = 'connecting';

    try {
      const sid = await startTranscription(
        speechConfig,
        voiceProfiles,
        (seg) => {
          if (segments.length > 0) {
            const last = segments[segments.length - 1];
            if (!last.isFinal && last.speakerId === seg.speakerId) {
              // Replace the last segment whether the incoming is interim OR final.
              // This prevents duplicate entries when a final follows an interim for
              // the same utterance (both share the same startMs + speakerId).
              segments = [...segments.slice(0, -1), seg];
            } else {
              segments = [...segments, seg];
            }
          } else {
            segments = [...segments, seg];
          }
          if (autoScroll && transcriptEl) {
            requestAnimationFrame(() => {
              transcriptEl!.scrollTop = transcriptEl!.scrollHeight;
            });
          }
        },
        (msg) => {
          // Called by the service when the server sends an error event.
          // The service already stopped the mic; just update UI state.
          error = msg;
          sessionId = null;
          recordingState = 'idle';
          stopTimer();
        },
      );

      // If an error fired during startTranscription (e.g. during mic setup),
      // recordingState will already be 'idle' — bail out without entering recording.
      if (recordingState !== 'connecting') return;

      sessionId = sid;
      recordingState = 'recording';
      startTime = Date.now();
      startTimer();
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : String(e);
      recordingState = 'idle';
    }
  }

  function stopRecording() {
    if (!sessionId) return;
    const sid = sessionId;
    // Reset state immediately so UI responds at once
    sessionId = null;
    recordingState = 'idle';
    stopTimer();
    // Cleanup + save WAV + save profiles in background (non-blocking)
    const sampleDir = $settingsStore.voiceSyncDir || defaultSyncDir || undefined;
    const backupDir = $settingsStore.recordingBackupDir ?? null;
    stopTranscription(sid, { sampleDir, backupDir })
      .then(({ profiles }) => saveNewProfiles(profiles))
      .catch(() => { /* ignore */ });
  }

  // Speaker color palette (same as the panel display colors)
  const PROFILE_COLORS = [
    '#4A90E2', '#7ED321', '#D0021B', '#F5A623', '#9013FE',
    '#50E3C2', '#B8E986', '#FF6B6B', '#4ECDC4', '#C7B42C',
  ];

  function saveNewProfiles(proposals: NewProfileProposal[]) {
    if (!proposals.length) return;
    const existing = $settingsStore.voiceProfiles ?? [];

    // Update existing profiles when a longer voice sample is available (up to 30 s cap).
    // Replace samplePath only when: new speaking time > current stored duration AND
    // current stored duration < 30 000 ms (once we have 30 s we stop updating).
    const MAX_SAMPLE_MS = 30_000;
    let changed = false;
    const updated: VoiceProfile[] = existing.map(p => {
      const match = proposals.find(pr => pr.autoName === p.autoName);
      if (
        match?.samplePath &&
        match.sampleDurationMs > p.sampleDurationMs &&
        p.sampleDurationMs < MAX_SAMPLE_MS
      ) {
        changed = true;
        return {
          ...p,
          samplePath: match.samplePath,
          sampleDurationMs: Math.min(match.sampleDurationMs, MAX_SAMPLE_MS),
          updatedAt: Date.now(),
        };
      }
      return p;
    });

    // Add brand-new profiles for speakers not yet in the list.
    // Gendered names are stable across sessions → dedup by autoName.
    // Fallback names (Speaker N / 说话人N) can't be matched across sessions → always create new.
    const speakerPrefixes = resolveAllLocales('settings.voice.naming.speaker', { n: '' }).map(s => s.trim());
    const existingNames = new Set(updated.map((p: VoiceProfile) => p.autoName));
    const newProfiles: VoiceProfile[] = [];
    let colorIdx = updated.length;
    for (const proposal of proposals) {
      const isFallback = speakerPrefixes.some(prefix => proposal.autoName.startsWith(prefix));
      if (!isFallback && existingNames.has(proposal.autoName)) continue;
      const color = PROFILE_COLORS[colorIdx % PROFILE_COLORS.length];
      colorIdx++;
      newProfiles.push({
        id: crypto.randomUUID(),
        speakerId: proposal.speakerId,
        autoName: proposal.autoName,
        nickname: '',
        gender: proposal.gender,
        samplePath: proposal.samplePath,
        sampleDurationMs: proposal.sampleDurationMs,
        color,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
    if (changed || newProfiles.length > 0) {
      settingsStore.update({ voiceProfiles: [...updated, ...newProfiles] });
    }
  }

  function togglePause() {
    if (recordingState === 'recording') {
      recordingState = 'paused';
      stopTimer();
    } else if (recordingState === 'paused') {
      recordingState = 'recording';
      startTime = Date.now() - elapsedMs;
      startTimer();
    }
  }

  function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      elapsedMs = Date.now() - startTime;
    }, 500);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // ── Bottom actions ─────────────────────────────────────────────────────────

  function handleSendToAI() {
    if (!fullTranscript.trim()) return;
    // Build a summarization request
    const prompt = `${$t('transcription.summarizePrompt')}\n\n${fullTranscript}`;
    onSendToAI?.(prompt);
  }

  function handleSaveAsDoc() {
    if (!fullTranscript.trim()) return;
    const md = buildMarkdown();
    onInsert?.(md);
    onBack?.();
  }

  function buildMarkdown(): string {
    const lines: string[] = [
      `# ${$t('transcription.title')}`,
      '',
      `> ${new Date().toLocaleString()}`,
      '',
    ];
    // Use only utterance-final segments; each is a complete sentence / turn.
    // Each segment gets its own speaker label + blank line so Markdown renders
    // them as separate paragraphs (single \n within a paragraph collapses to space).
    for (const seg of finalSegments) {
      lines.push(`**${seg.displayName}** *(${formatSegmentTime(seg.startMs)})*`);
      lines.push('');
      lines.push(seg.text);
      lines.push('');
    }
    return lines.join('\n');
  }

  // Cleanup on unmount
  $effect(() => {
    return () => {
      stopTimer();
      if (sessionId) {
        const sid = sessionId;
        stopTranscription(sid)
          .then(({ profiles }) => saveNewProfiles(profiles))
          .catch(() => { /* ignore */ });
      }
    };
  });
</script>

<div class="transcription-panel">
  <!-- ── Transcript area ────────────────────────────────────────────────── -->
  <div
    class="transcript-body"
    bind:this={transcriptEl}
    onscroll={() => {
      if (!transcriptEl) return;
      const atBottom = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 40;
      autoScroll = atBottom;
    }}
  >
    {#if !speechConfig && recordingState === 'idle'}
      <!-- No config: full-area guidance card -->
      <div class="no-config-card">
        <div class="no-config-icon">🎤</div>
        <p class="no-config-title">{$t('transcription.noSpeechConfig')}</p>
        <p class="no-config-hint">{$t('transcription.noSpeechConfigHint')}</p>
        {#if onOpenSettings}
          <button class="no-config-btn" onclick={onOpenSettings}>
            {$t('transcription.goToVoiceSettings')}
          </button>
        {/if}
      </div>
    {:else if segments.length === 0}
      <div class="transcript-empty">
        {recordingState === 'idle' ? $t('transcription.emptyIdle') : $t('transcription.emptyWaiting')}
      </div>
    {/if}
    {#each segments as seg, i (i)}
      <div class="segment">
        <div class="segment-header">
          <span
            class="speaker-dot"
            style="background: {getSpeakerColor(seg.displayName)}"
          ></span>
          <span class="speaker-name">{seg.displayName}</span>
          <span class="segment-time">{formatSegmentTime(seg.startMs)}</span>
        </div>
        <p class="segment-text">{seg.text}</p>
      </div>
    {/each}

    {#if recordingState === 'recording'}
      <div class="recording-indicator">
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
      </div>
    {/if}
  </div>

  <!-- ── Error message ─────────────────────────────────────────────────────── -->
  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <!-- ── Bottom action bar (shown when there are segments) ─────────────── -->
  {#if segments.length > 0}
    <div class="transcription-footer">
      <button
        class="footer-btn primary"
        onclick={handleSendToAI}
        disabled={!fullTranscript.trim()}
      >
        {$t('transcription.summarizeWithAI')} →
      </button>
      <button
        class="footer-btn"
        onclick={handleSaveAsDoc}
        disabled={!fullTranscript.trim()}
      >
        {$t('transcription.saveAsDoc')}
      </button>
    </div>
  {/if}

  <!-- ── Controls bar (always at bottom) ──────────────────────────────── -->
  <div class="transcription-controls">
    <div class="controls-left">
      {#if recordingState === 'recording'}
        <span class="recording-dot"></span>
        <span class="status-text">{$t('transcription.recording')}</span>
      {:else if recordingState === 'connecting'}
        <span class="status-text muted">{$t('transcription.connecting')}</span>
      {:else if recordingState === 'paused'}
        <span class="status-text muted">{$t('transcription.paused')}</span>
      {:else if recordingState === 'stopping'}
        <span class="status-text muted">{$t('transcription.stopping')}</span>
      {:else}
        <span class="status-text muted">{$t('transcription.idle')}</span>
      {/if}
      {#if elapsedMs > 0}
        <span class="elapsed">{elapsedFormatted}</span>
      {/if}
    </div>
    <div class="controls-right">
      {#if recordingState === 'idle'}
        <button class="ctrl-btn primary" onclick={startRecording} disabled={!speechConfig}>
          {$t('transcription.start')}
        </button>
      {:else if recordingState === 'connecting'}
        <span class="spinner"></span>
      {:else if recordingState === 'recording' || recordingState === 'paused'}
        <button class="ctrl-btn" onclick={togglePause}>
          {recordingState === 'recording' ? $t('transcription.pause') : $t('transcription.resume')}
        </button>
        <button class="ctrl-btn danger" onclick={stopRecording}>
          {$t('transcription.stop')}
        </button>
      {/if}
      <button class="ctrl-btn icon" onclick={onBack} title={$t('transcription.back')}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M10 6H2M5 3L2 6l3 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </div>
</div>

<style>
  .transcription-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ── Controls bar (bottom) ───────────────────────────────────────────────── */
  .transcription-controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border-light);
    flex-shrink: 0;
  }

  .controls-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .controls-right {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .recording-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e53e3e;
    animation: pulse-dot 1s infinite;
    flex-shrink: 0;
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .status-text {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-primary);
  }

  .status-text.muted {
    color: var(--text-muted);
  }

  .elapsed {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .ctrl-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.2rem 0.6rem;
    font-size: var(--font-size-xs);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .ctrl-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .ctrl-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ctrl-btn.primary {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: white;
  }

  .ctrl-btn.primary:hover:not(:disabled) {
    opacity: 0.85;
    background: var(--accent-color);
  }

  .ctrl-btn.danger {
    border-color: #e53e3e;
    color: #e53e3e;
  }

  .ctrl-btn.danger:hover:not(:disabled) {
    background: rgba(229, 62, 62, 0.08);
  }

  .ctrl-btn.icon {
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--border-color);
    border-top-color: var(--accent-color);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Error ───────────────────────────────────────────────────────────────── */
  .error-banner {
    padding: 0.4rem 0.75rem;
    background: rgba(229, 62, 62, 0.08);
    border-bottom: 1px solid rgba(229, 62, 62, 0.2);
    color: #e53e3e;
    font-size: var(--font-size-xs);
    flex-shrink: 0;
  }

  /* ── No config card (centered in transcript body) ───────────────────────── */
  .no-config-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 1.5rem;
    text-align: center;
    flex: 1;
  }

  .no-config-icon {
    font-size: 2rem;
    line-height: 1;
    margin-bottom: 0.25rem;
  }

  .no-config-title {
    margin: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .no-config-hint {
    margin: 0;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    line-height: 1.5;
  }

  .no-config-btn {
    margin-top: 0.5rem;
    padding: 0.4rem 1rem;
    font-size: var(--font-size-xs);
    border: 1px solid var(--accent-color);
    border-radius: 6px;
    background: var(--accent-color);
    color: white;
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .no-config-btn:hover {
    opacity: 0.85;
  }

  /* ── Transcript body ─────────────────────────────────────────────────────── */
  .transcript-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .transcript-empty {
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    padding: 2rem 1rem;
  }

  .segment {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .segment-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .speaker-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .speaker-name {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .segment-time {
    font-size: 10px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .segment-text {
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    line-height: 1.5;
    padding-left: 1rem;
  }

  /* Recording waiting indicator */
  .recording-indicator {
    display: flex;
    gap: 4px;
    padding: 0.25rem 1rem;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-color);
    animation: bounce 1.4s infinite ease-in-out;
  }

  .dot:nth-child(1) { animation-delay: 0s; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes bounce {
    0%, 80%, 100% { transform: translateY(0); }
    40% { transform: translateY(-5px); }
  }

  /* ── Footer ──────────────────────────────────────────────────────────────── */
  .transcription-footer {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border-light);
    flex-shrink: 0;
  }

  .footer-btn {
    flex: 1;
    padding: 0.4rem 0.5rem;
    font-size: var(--font-size-xs);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast);
    white-space: nowrap;
  }

  .footer-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .footer-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .footer-btn.primary {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: white;
  }

  .footer-btn.primary:hover:not(:disabled) {
    opacity: 0.85;
  }
</style>

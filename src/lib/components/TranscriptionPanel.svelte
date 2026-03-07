<script lang="ts">
  import { settingsStore } from '$lib/stores/settings-store';
  import { startTranscription, stopTranscription, setMicMuted } from '$lib/services/voice/speech-service';
  import { aiStore, sendAIRequest } from '$lib/services/ai';
  import { t, resolveAllLocales } from '$lib/i18n';
  import { isMacOS, isTauri } from '$lib/utils/platform';
  import type {
    TranscriptSegment,
    NewProfileProposal,
    VoiceProfile,
    VoiceInputSourceMode,
    VoiceSessionMode,
  } from '$lib/services/voice/types';
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
  type SourceStatusLevel = 'info' | 'warning';
  type InterviewRow =
    | {
      id: string;
      side: 'left';
      speaker: string;
      text: string;
      timestamp: number;
    }
    | {
      id: string;
      side: 'right';
      text: string;
      timestamp: number;
      status: 'pending' | 'done' | 'failed';
    };

  let recordingState = $state<RecordingState>('idle');
  let sessionId = $state<string | null>(null);
  let micMuted = $state(false);
  let segments = $state<TranscriptSegment[]>([]);
  let sourceMode = $state<VoiceInputSourceMode>('mic');
  let sessionMode = $state<VoiceSessionMode>('transcription');
  let interviewRows = $state<InterviewRow[]>([]);
  let interviewBusy = $state(false);
  let interviewCursor = $state(0); // final segment cursor for delta forwarding
  let interviewPendingContext = $state('');
  let interviewLastQuestionKey = $state('');
  let systemSourceUnsupported = $state(false);
  let sourceStatusMessage = $state<string | null>(null);
  let sourceStatusLevel = $state<SourceStatusLevel>('info');
  let elapsedMs = $state(0);
  let error = $state<string | null>(null);
  let transcriptEl = $state<HTMLDivElement | undefined>(undefined);
  let autoScroll = $state(true);

  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let interviewSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  let startTime = 0;
  const INTERVIEW_SILENCE_MS = 3000;
  const INTERVIEW_MIN_DELTA_CHARS = 4;
  const INTERVIEW_MIN_SEGMENT_CHARS = 4;
  const INTERVIEW_MIN_CONFIDENCE = 0.55;
  const INTERVIEW_MAX_BUFFER_CHARS = 900;
  const INTERVIEW_CONTEXT_WINDOW_CHARS = 520;
  const INTERVIEW_QUESTION_WINDOW_CHARS = 220;
  const QUESTION_CUE_RE = /[?？]|(什么|为何|为什么|怎么|如何|请问|是否|能否|可否|哪(里|个|些)?|多少|几|吗|呢|么|原理|区别|步骤|原因|方案|怎么做|介绍(?:一下|下)?|讲(?:一下|下)?|说(?:一下|下)?|请解释|帮我|给我|总结|分析)|\b(what|why|how|when|where|which|who|whom|whose|can|could|would|should|is|are|do|does|did|explain|tell me|walk me through|compare)\b/i;
  const FILLER_ONLY_RE = /^(嗯+|呃+|啊+|额+|噢+|哦+|唉+|呀+|诶+|uh+|um+|er+|ah+|eh+|hmm+|mm+)([，。！？?!、~…\s]*)$/i;

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

  let showInformationalHints = $derived(recordingState === 'idle');
  let interviewModeHint = $derived.by(() => (
    usesNativeMacSystemSource(sourceMode)
      ? $t('transcription.interviewNativeSystemHint')
      : $t('transcription.interviewSystemShareHint')
  ));
  let shouldShowSourceStatusHint = $derived(
    !!sourceStatusMessage
      && (
        sourceStatusLevel === 'warning'
        || (
          showInformationalHints
          && !(sessionMode === 'interview' && sourceStatusLevel === 'info')
        )
      )
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

  function scrollTranscriptToBottom(force = false) {
    if (!transcriptEl) return;
    if (!force && !autoScroll) return;
    requestAnimationFrame(() => {
      if (!transcriptEl) return;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    });
  }

  function lineKey(text: string): string {
    return text
      .toLowerCase()
      .replace(/[\s\.,!?，。！？:：;；'"`~\-_/\\()[\]{}<>]/g, '');
  }

  function sanitizeInterviewLine(text: string): string {
    return text
      .replace(/^[\s【\[]?(?:speaker\s*\d+|说话人\s*\d+|路人\d*|passerby\d*|unknown|user|assistant|ai|面试官|候选人)\s*[:：]\s*/i, '')
      .replace(/\s+/g, ' ')
      .replace(/([，。！？?!])\1+/g, '$1')
      .trim();
  }

  function isLikelyNoiseLine(
    line: string,
    confidence: number,
    hasReliableConfidence: boolean,
  ): boolean {
    if (!line) return true;
    if (line.length < INTERVIEW_MIN_SEGMENT_CHARS) return true;
    if (FILLER_ONLY_RE.test(line)) return true;
    if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(line)) return true;
    if (hasReliableConfidence && Number.isFinite(confidence) && confidence < INTERVIEW_MIN_CONFIDENCE) {
      return true;
    }
    const compact = line.replace(/\s+/g, '');
    if (compact.length >= 6 && new Set(compact.toLowerCase()).size <= 2) return true;
    return false;
  }

  function appendInterviewBuffer(deltaText: string) {
    if (!deltaText.trim()) return;
    const next = interviewPendingContext
      ? `${interviewPendingContext}\n${deltaText}`
      : deltaText;
    interviewPendingContext = next.length > INTERVIEW_MAX_BUFFER_CHARS
      ? next.slice(-INTERVIEW_MAX_BUFFER_CHARS)
      : next;
  }

  function extractInterviewQuestion(buffer: string): { focus: string; support: string } | null {
    const normalized = buffer.trim();
    if (!normalized) return null;

    const parts = normalized
      .split(/[\n。！？?!]/)
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;

    const candidates = parts.filter(part => QUESTION_CUE_RE.test(part));
    const focusRaw = (candidates.length > 0
      ? candidates.slice(-2).join('；')
      : parts[parts.length - 1]
    ).trim();
    if (!focusRaw) return null;

    const fallbackFocus = parts.slice(-2).join('；').trim() || parts[parts.length - 1];
    return {
      focus: (focusRaw || fallbackFocus).slice(-INTERVIEW_QUESTION_WINDOW_CHARS),
      support: normalized.slice(-INTERVIEW_CONTEXT_WINDOW_CHARS),
    };
  }

  function questionSignature(text: string): string {
    return lineKey(text).slice(-160);
  }

  // ── Recording control ──────────────────────────────────────────────────────

  function clearInterviewSilenceTimer() {
    if (interviewSilenceTimer) {
      clearTimeout(interviewSilenceTimer);
      interviewSilenceTimer = null;
    }
  }

  function scheduleInterviewAnswerBySilence() {
    if (sessionMode !== 'interview' || recordingState === 'idle' || recordingState === 'connecting') return;
    clearInterviewSilenceTimer();
    interviewSilenceTimer = setTimeout(() => {
      triggerInterviewAnswer().catch((e) => {
        console.error('[Voice] interview answer trigger failed:', e);
      });
    }, INTERVIEW_SILENCE_MS);
  }

  function resetInterviewContext(cursorAtEnd = false) {
    interviewRows = [];
    clearInterviewSilenceTimer();
    interviewBusy = false;
    interviewPendingContext = '';
    interviewLastQuestionKey = '';
    if (cursorAtEnd) {
      interviewCursor = finalSegments.length;
    } else {
      interviewCursor = 0;
    }
  }

  function usesNativeMacSystemSource(mode: VoiceInputSourceMode): boolean {
    return isTauri && isMacOS && (mode === 'system' || mode === 'mixed');
  }

  function requiresUserGestureSource(mode: VoiceInputSourceMode): boolean {
    return (mode === 'system' || mode === 'mixed') && !usesNativeMacSystemSource(mode);
  }

  function setSourceStatus(message: string | null, level: SourceStatusLevel = 'info') {
    sourceStatusMessage = message;
    sourceStatusLevel = level;
  }

  function refreshSourceStatus() {
    if (systemSourceUnsupported) {
      setSourceStatus(null);
      return;
    }
    if (usesNativeMacSystemSource(sourceMode)) {
      setSourceStatus(
        $t(
          sourceMode === 'mixed'
            ? 'transcription.systemSourceNativeMixedHint'
            : 'transcription.systemSourceNativeHint',
        ),
        'info',
      );
      return;
    }
    setSourceStatus(null);
  }

  function applySourceError(rawMsg: string, mode: VoiceInputSourceMode): boolean {
    const normalized = rawMsg.toLowerCase();

    if (requiresUserGestureSource(mode) && /user gesture|user activation|must be called from/i.test(rawMsg)) {
      error = null;
      setSourceStatus($t('transcription.systemSourceClickStartHint'), 'warning');
      return true;
    }

    if (
      /system_audio_track_missing|no system audio track|no system audio track was captured|no audio track/i.test(rawMsg)
    ) {
      if (!usesNativeMacSystemSource(mode)) {
        systemSourceUnsupported = true;
        sourceMode = 'mic';
        setSourceStatus(null);
      } else {
        setSourceStatus($t('transcription.systemSourceNoAudioTrackHint'), 'warning');
      }
      error = null;
      return true;
    }

    if (
      /notallowederror|permission denied|denied permission|permission was denied|cancelled|canceled|not permitted|privacy/i.test(normalized)
    ) {
      error = $t(
        usesNativeMacSystemSource(mode)
          ? 'transcription.systemSourceNativePermissionDenied'
          : 'transcription.systemSourcePermissionDenied',
      );
      setSourceStatus(null);
      return true;
    }

    if (
      usesNativeMacSystemSource(mode)
      && /objective-c exception|unrecognized selector|!obj|bad object|native system audio capture is only available|unsupported process tap|runtime/i.test(normalized)
    ) {
      error = $t('transcription.systemSourceRuntimeIncompatible');
      setSourceStatus(null);
      return true;
    }

    if (
      !usesNativeMacSystemSource(mode)
      && /environment does not expose|auto-fallback to mic|auto-fallen back to mic|unsupported/i.test(normalized)
    ) {
      systemSourceUnsupported = true;
      sourceMode = 'mic';
      error = null;
      setSourceStatus(null);
      return true;
    }

    return false;
  }

  async function startRecording(opts?: { preserveSegments?: boolean; preserveElapsed?: boolean }) {
    if (!speechConfig) {
      error = $t('transcription.noSpeechConfig');
      return;
    }
    error = null;
    refreshSourceStatus();
    if (!opts?.preserveSegments) {
      segments = [];
      speakerColorMap.clear();
      resetInterviewContext(false);
    } else if (sessionMode === 'interview') {
      // Preserve prior transcript but only answer on newly-added context.
      resetInterviewContext(true);
    } else {
      clearInterviewSilenceTimer();
    }
    recordingState = 'connecting';

    try {
      const effectiveSourceMode: VoiceInputSourceMode = sourceMode;
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

          if (sessionMode === 'interview' && seg.isFinal) {
            interviewRows = [
              ...interviewRows,
              {
                id: crypto.randomUUID(),
                side: 'left',
                speaker: seg.displayName,
                text: seg.text,
                timestamp: Date.now(),
              },
            ];
            scheduleInterviewAnswerBySilence();
          }

          scrollTranscriptToBottom(sessionMode === 'interview');
        },
        (msg) => {
          // Called by the service when the server sends an error event.
          // The service already stopped the mic; just update UI state.
          if (!applySourceError(msg, sourceMode)) {
            setSourceStatus(null);
            error = msg;
          }
          sessionId = null;
          recordingState = 'idle';
          stopTimer();
          clearInterviewSilenceTimer();
        },
        { sourceMode: effectiveSourceMode },
      );

      // If an error fired during startTranscription (e.g. during mic setup),
      // recordingState will already be 'idle' — bail out without entering recording.
      if (recordingState !== 'connecting') return;

      sessionId = sid;
      recordingState = 'recording';
      refreshSourceStatus();
      if (opts?.preserveElapsed) {
        startTime = Date.now() - elapsedMs;
      } else {
        elapsedMs = 0;
        startTime = Date.now();
      }
      startTimer();
    } catch (e: unknown) {
      const rawMsg = e instanceof Error ? e.message : String(e);
      if (!applySourceError(rawMsg, sourceMode)) {
        setSourceStatus(null);
        error = rawMsg;
      }
      recordingState = 'idle';
      clearInterviewSilenceTimer();
    }
  }

  async function restartRecordingForCurrentMode() {
    if (!sessionId) return;
    const sid = sessionId;
    sessionId = null;
    recordingState = 'connecting';
    stopTimer();
    clearInterviewSilenceTimer();

    const sampleDir = $settingsStore.voiceSyncDir || defaultSyncDir || undefined;
    const backupDir = $settingsStore.recordingBackupDir ?? null;
    await stopTranscription(sid, { sampleDir, backupDir })
      .then(({ profiles }) => saveNewProfiles(profiles))
      .catch(() => { /* ignore */ });

    await startRecording({ preserveSegments: true, preserveElapsed: true });
  }

  function toggleMicMute() {
    if (!sessionId) return;
    micMuted = !micMuted;
    setMicMuted(sessionId, micMuted);
  }

  async function stopRecording() {
    if (!sessionId) return;
    const sid = sessionId;
    // Reset state immediately so UI responds at once
    sessionId = null;
    recordingState = 'idle';
    micMuted = false;
    stopTimer();
    clearInterviewSilenceTimer();
    // Cleanup + save WAV + save profiles in background (non-blocking)
    const sampleDir = $settingsStore.voiceSyncDir || defaultSyncDir || undefined;
    const backupDir = $settingsStore.recordingBackupDir ?? null;
    await stopTranscription(sid, { sampleDir, backupDir })
      .then(({ profiles }) => saveNewProfiles(profiles))
      .catch(() => { /* ignore */ });
  }

  async function handleModeChange(event: Event) {
    const next = (event.target as HTMLSelectElement).value as VoiceSessionMode;
    if (next === sessionMode) return;

    const wasActive = recordingState === 'recording' || recordingState === 'paused';
    sessionMode = next;

    if (next === 'interview') {
      // In interview mode, answer only for newly added context.
      resetInterviewContext(true);
    } else {
      clearInterviewSilenceTimer();
    }

    if (wasActive && sessionId) {
      if (requiresUserGestureSource(sourceMode)) {
        await stopRecording();
        error = $t('transcription.systemSourceRestartHint');
      } else {
        await restartRecordingForCurrentMode();
      }
    }
  }

  async function handleSourceModeChange(event: Event) {
    const next = (event.target as HTMLSelectElement).value as VoiceInputSourceMode;
    if (next === sourceMode) return;
    if (systemSourceUnsupported && requiresUserGestureSource(next)) {
      // Keep this as non-fatal warning state only.
      error = null;
      setSourceStatus(null);
      return;
    }
    sourceMode = next;
    error = null;
    refreshSourceStatus();

    const wasActive = recordingState === 'recording' || recordingState === 'paused';
    if (wasActive && sessionId) {
      if (requiresUserGestureSource(next)) {
        await stopRecording();
        error = $t('transcription.systemSourceRestartHint');
      } else {
        await restartRecordingForCurrentMode();
      }
    }
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
      clearInterviewSilenceTimer();
    } else if (recordingState === 'paused') {
      recordingState = 'recording';
      startTime = Date.now() - elapsedMs;
      startTimer();
      if (sessionMode === 'interview') scheduleInterviewAnswerBySilence();
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

  async function requestInterviewAnswer(questionFocus: string, supportContext: string): Promise<string> {
    const active = aiStore.getActiveConfig();
    if (!active || !active.apiKey) {
      throw new Error($t('transcription.interviewNoAIConfig'));
    }

    const maxTokens = Math.min($settingsStore.aiMaxTokens || active.maxTokens || 1024, 768);
    const config = { ...active, maxTokens, temperature: Math.min(active.temperature ?? 0.2, 0.3) };
    const now = Date.now();

    const response = await sendAIRequest(config, {
      messages: [
        {
          role: 'system',
          content: 'You are an interview copilot. Every request is the latest transcript delta captured after about 3 seconds of silence. Treat it as the newest interview turn and answer directly even if the wording is incomplete. The ASR transcript may contain recognition errors; infer likely intent and avoid overfitting to noisy words. Focus on the core question first, then give a concise practical answer in Markdown bullet points.',
          timestamp: now,
        },
        {
          role: 'user',
          content: `Question focus:\n${questionFocus}\n\nRecent transcript snippets (may contain ASR mistakes):\n${supportContext}\n\nPlease output:\n1) Direct answer first.\n2) If key terms may be misrecognized, list 1-2 likely corrected terms.\n3) Keep total length under 8 bullets.`,
          timestamp: now + 1,
        },
      ],
    });

    const text = response.content?.trim();
    if (!text) throw new Error($t('transcription.interviewEmptyAnswer'));
    return text;
  }

  async function triggerInterviewAnswer() {
    if (sessionMode !== 'interview' || interviewBusy) return;

    const finals = finalSegments;
    if (finals.length <= interviewCursor) return;

    const deltaSegs = finals.slice(interviewCursor);
    const cursorEnd = finals.length;
    interviewCursor = cursorEnd;

    const hasReliableConfidence = deltaSegs.some(
      seg => Number.isFinite(seg.confidence) && seg.confidence > 0.05,
    );
    const cleanedLines: string[] = [];
    let lastLineKey = '';
    for (const seg of deltaSegs) {
      const line = sanitizeInterviewLine(seg.text);
      if (isLikelyNoiseLine(line, seg.confidence, hasReliableConfidence)) continue;
      const key = lineKey(line);
      if (!key || key === lastLineKey) continue;
      lastLineKey = key;
      cleanedLines.push(line);
    }
    if (cleanedLines.length === 0) return;

    appendInterviewBuffer(cleanedLines.join('\n'));
    if (interviewPendingContext.length < INTERVIEW_MIN_DELTA_CHARS) return;

    const extracted = extractInterviewQuestion(interviewPendingContext);
    if (!extracted) return;

    const questionKey = questionSignature(extracted.focus);
    if (questionKey && questionKey === interviewLastQuestionKey) {
      interviewPendingContext = '';
      return;
    }
    interviewLastQuestionKey = questionKey;

    const rowId = crypto.randomUUID();
    const pendingSnapshot = interviewPendingContext;
    interviewPendingContext = '';

    interviewRows = [
      ...interviewRows,
      {
        id: rowId,
        side: 'right',
        text: $t('transcription.interviewAnswerPending'),
        timestamp: Date.now(),
        status: 'pending',
      },
    ];

    interviewBusy = true;
    try {
      const answer = await requestInterviewAnswer(extracted.focus, extracted.support);
      interviewRows = interviewRows.map(row => (
        row.id === rowId && row.side === 'right'
          ? { ...row, text: answer, status: 'done' as const }
          : row
      ));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : $t('transcription.interviewAnswerFailed');
      // Restore pending context once on failure so next silence-trigger can retry with new additions.
      interviewPendingContext = pendingSnapshot.length > INTERVIEW_MAX_BUFFER_CHARS
        ? pendingSnapshot.slice(-INTERVIEW_MAX_BUFFER_CHARS)
        : pendingSnapshot;
      interviewRows = interviewRows.map(row => (
        row.id === rowId && row.side === 'right'
          ? { ...row, text: msg, status: 'failed' as const }
          : row
      ));
    } finally {
      interviewBusy = false;
    }
  }

  // ── Bottom actions ─────────────────────────────────────────────────────────

  function handleSendToAI() {
    if (!fullTranscript.trim()) return;
    // Build a summarization request
    const prompt = `${$t(sessionMode === 'interview' ? 'transcription.interviewSummarizePrompt' : 'transcription.summarizePrompt')}\n\n${fullTranscript}`;
    onSendToAI?.(prompt);
  }

  function handleSaveAsDoc() {
    if (!fullTranscript.trim()) return;
    const md = buildMarkdown();
    onInsert?.(md);
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
      clearInterviewSilenceTimer();
      if (sessionId) {
        const sid = sessionId;
        stopTranscription(sid)
          .then(({ profiles }) => saveNewProfiles(profiles))
          .catch(() => { /* ignore */ });
      }
    };
  });

  $effect(() => {
    sourceMode;
    systemSourceUnsupported;
    error;
    if (error) return;
    refreshSourceStatus();
  });

  // Interview mode always keeps the latest row visible.
  $effect(() => {
    const mode = sessionMode;
    const rows = interviewRows;
    if (mode !== 'interview' || rows.length === 0) return;
    scrollTranscriptToBottom(true);
  });
</script>

<div class="transcription-panel">
  <div class="transcription-topbar">
    <div class="top-status">
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
    <div class="top-controls">
      <label class="top-field">
        <span class="top-label">{$t('transcription.sourceLabel')}</span>
        <select
          class="top-select"
          value={sourceMode}
          onchange={handleSourceModeChange}
          disabled={recordingState === 'connecting'}
        >
          <option value="mic">{$t('transcription.sourceMic')}</option>
          <option value="system" disabled={systemSourceUnsupported}>{$t('transcription.sourceSystem')}</option>
          <option value="mixed" disabled={systemSourceUnsupported}>{$t('transcription.sourceMixed')}</option>
        </select>
      </label>
      <label class="top-field">
        <span class="top-label">{$t('transcription.modeLabel')}</span>
        <select
          class="top-select"
          value={sessionMode}
          onchange={handleModeChange}
          disabled={recordingState === 'connecting'}
        >
          <option value="transcription">{$t('transcription.modeTranscription')}</option>
          <option value="interview">{$t('transcription.modeInterview')}</option>
        </select>
      </label>
      <button class="ctrl-btn icon" onclick={onBack} title={$t('transcription.back')}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M10 6H2M5 3L2 6l3 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </div>
  {#if sessionMode === 'interview' && showInformationalHints}
    <div class="mode-hint">{interviewModeHint}</div>
  {/if}
  {#if systemSourceUnsupported}
    <div class="mode-hint warning">{$t('transcription.systemSourceUnsupportedHint')}</div>
  {/if}
  {#if shouldShowSourceStatusHint}
    <div class="mode-hint" class:warning={sourceStatusLevel === 'warning'} class:info={sourceStatusLevel === 'info'}>
      {sourceStatusMessage}
    </div>
  {/if}

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
    {:else if sessionMode === 'interview'}
      {#if interviewRows.length === 0}
        <div class="transcript-empty">
          {recordingState === 'idle' ? $t('transcription.emptyIdle') : $t('transcription.emptyWaiting')}
        </div>
      {/if}
      {#each interviewRows as row (row.id)}
        {#if row.side === 'left'}
          <div class="segment interview-left">
            <div class="segment-header">
              <span class="speaker-dot" style="background: {getSpeakerColor(row.speaker)}"></span>
              <span class="speaker-name">{row.speaker}</span>
            </div>
            <p class="segment-text">{row.text}</p>
          </div>
        {:else}
          <div class="interview-answer" class:failed={row.status === 'failed'}>
            <div class="answer-label">AI</div>
            <p class="answer-text">{row.text}</p>
          </div>
        {/if}
      {/each}
    {:else}
      {#if segments.length === 0}
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
    {/if}
  </div>

  <!-- ── Error message ─────────────────────────────────────────────────────── -->
  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <div class="recording-main-action">
    {#if recordingState === 'connecting'}
      <span class="spinner"></span>
    {:else}
      {#if recordingState === 'idle' || sourceMode !== 'mic'}
        <button
          class="mic-main-btn"
          class:mic-muted={micMuted}
          onclick={recordingState === 'idle' ? () => startRecording() : toggleMicMute}
          disabled={!speechConfig}
          title={
            recordingState === 'idle'
              ? $t('transcription.start')
              : micMuted
                ? $t('transcription.unmuteMic')
                : $t('transcription.muteMic')
          }
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="9" y="3" width="6" height="12" rx="3" stroke="currentColor" stroke-width="2"/>
            <path d="M6 11a6 6 0 0 0 12 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M8 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            {#if micMuted}
              <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            {/if}
          </svg>
        </button>
      {/if}
      {#if recordingState === 'recording' || recordingState === 'paused'}
        <button class="mic-main-btn mic-stop-btn" onclick={stopRecording} title={$t('transcription.stop')}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
          </svg>
        </button>
      {/if}
    {/if}
  </div>

  <!-- ── Bottom action bar (shown when there are segments) ─────────────── -->
  {#if segments.length > 0}
    <div class="transcription-footer">
      <button
        class="footer-btn primary"
        onclick={handleSendToAI}
        disabled={!fullTranscript.trim()}
      >
        {sessionMode === 'interview' ? $t('transcription.summarizeInterview') : $t('transcription.summarizeWithAI')} →
      </button>
      <button
        class="footer-btn"
        onclick={handleSaveAsDoc}
        disabled={!fullTranscript.trim()}
      >
        {$t('transcription.toDocumentAppend')}
      </button>
    </div>
  {/if}
</div>

<style>
  .transcription-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .transcription-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--border-light);
    flex-shrink: 0;
    gap: 0.75rem;
  }

  .top-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .top-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .mode-hint {
    padding: 0.35rem 0.75rem 0.45rem;
    border-bottom: 1px solid var(--border-light);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .mode-hint.info {
    color: #1d4ed8;
    background: rgba(59, 130, 246, 0.08);
    border-bottom: 1px solid rgba(59, 130, 246, 0.2);
  }

  .mode-hint.warning {
    color: #b45309;
    background: rgba(245, 158, 11, 0.08);
    border-bottom: 1px solid rgba(245, 158, 11, 0.25);
  }

  .top-field {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-width: 0;
  }

  .top-label {
    font-size: 10px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .top-select {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-primary);
    padding: 0.15rem 0.35rem;
    min-width: 88px;
  }

  .top-select:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .recording-main-action {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    padding: 0.65rem 0.75rem;
    border-top: 1px solid var(--border-light);
    flex-shrink: 0;
  }

  .mic-main-btn {
    width: 3.1rem;
    height: 3.1rem;
    border-radius: 999px;
    border: 1px solid var(--border-color);
    background: var(--bg-primary);
    color: var(--text-secondary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast);
  }

  .mic-main-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
    transform: translateY(-1px);
  }

  .mic-main-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .mic-muted {
    background: var(--bg-tertiary);
    color: var(--text-muted);
    border-color: var(--border-color);
  }

  .mic-muted:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .mic-stop-btn {
    background: #e53e3e;
    border-color: #e53e3e;
    color: #fff;
  }

  .mic-stop-btn:hover:not(:disabled) {
    background: #c53030;
    border-color: #c53030;
    color: #fff;
    transform: translateY(-1px);
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
    -webkit-user-select: text !important;
    user-select: text !important;
  }

  .transcript-body :global(*) {
    -webkit-user-select: text;
    user-select: text;
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

  .segment.interview-left {
    max-width: 84%;
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

  .interview-answer {
    align-self: flex-end;
    max-width: 84%;
    background: var(--bg-primary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 0.5rem 0.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .interview-answer.failed {
    border-color: rgba(229, 62, 62, 0.35);
    background: rgba(229, 62, 62, 0.06);
  }

  .answer-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent-color);
    text-align: right;
  }

  .answer-text {
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    line-height: 1.5;
    white-space: pre-wrap;
    text-align: left;
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

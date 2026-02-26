/**
 * Voice / Speech transcription service for Moraya v0.15.0
 *
 * Architecture:
 *   Mic (getUserMedia + AudioWorklet)
 *     → PCM 16kHz/16-bit chunks (every ~250ms)
 *     → Rust speech_proxy_send_audio (Tauri IPC binary)
 *     → tokio-tungstenite WebSocket → STT provider
 *     → JSON response → Tauri Channel → onSpeechEvent
 *     → speaker naming → TranscriptSegment callback
 */

import { invoke } from '@tauri-apps/api/core';
import { Channel } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { t } from '$lib/i18n';
import { SPEECH_PROVIDER_BASE_URLS, type SpeechProviderConfig } from '$lib/services/ai/types';
import type {
  TranscriptSegment,
  SessionSpeaker,
  SpeechEvent,
  VoiceProfile,
  NewProfileProposal,
} from './types';

// ---------------------------------------------------------------------------
// Pitch / gender detection constants
// ---------------------------------------------------------------------------

/** F0 threshold: below = male, at-or-above = female */
const PITCH_GENDER_THRESHOLD_HZ = 165;

/** Min total speaking time (ms) before a speaker gets a gendered name */
const MIN_SPEAKING_MS_FOR_GENDER_NAME = 5_000;

/** Speakers below this total time get "路人NNN" names */
const BYSTANDER_THRESHOLD_MS = 8_000;

/**
 * Minimum speaking time (ms) for a speaker to get a saved voice profile.
 * Lower than BYSTANDER_THRESHOLD_MS so even brief speakers leave a profile
 * (named 说话人N if gender unknown, or 男/女N号 once enough time has passed).
 */
const MIN_PROFILE_THRESHOLD_MS = 1_000;

/** Cap on voice sample duration stored in VoiceProfile.sampleDurationMs */
const MAX_SAMPLE_DURATION_MS = 30_000;

/**
 * Max PCM buffer size for WAV recording (90 seconds × 16 kHz × 2 bytes = ~2.8 MB).
 * Chunks beyond this limit are dropped to prevent unbounded memory growth.
 */
const MAX_PCM_BUFFER_BYTES = 90 * 16_000 * 2;

/**
 * After speech_final=true fires, wait this long before committing the segment.
 * If more words arrive from the same speaker within this window, they are merged
 * into the same sentence. This prevents brief intra-sentence pauses (Deepgram VAD
 * firing early) from splitting one sentence into multiple rows.
 */
const MERGE_WINDOW_MS = 1000;

interface PendingCommit {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionState {
  configId: string;
  speakers: Map<string, SessionSpeaker>;
  segments: TranscriptSegment[];
  maleCount: number;
  femaleCount: number;
  bystanderSuffix: number;
  onSegment: (seg: TranscriptSegment) => void;
  onError: (msg: string) => void;
  /** Per-speaker merge window timers (debounces rapid speech_final events) */
  mergeTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Text buffered during merge window, waiting to be committed or absorbed */
  pendingCommit: Map<string, PendingCommit>;
  /** Raw PCM chunks buffered for WAV export (capped at MAX_PCM_BUFFER_BYTES) */
  pcmBuffer: Uint8Array[];
  /** Running total of buffered PCM bytes */
  pcmBufferBytes: number;
  audioContext: AudioContext | null;
  mediaStream: MediaStream | null;
  workletNode: AudioWorkletNode | null;
  analyserNode: AnalyserNode | null;
}

const sessions = new Map<string, SessionState>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new transcription session.
 * Returns the sessionId assigned by the Rust proxy.
 */
export async function startTranscription(
  config: SpeechProviderConfig,
  voiceProfiles: VoiceProfile[],
  onSegment: (seg: TranscriptSegment) => void,
  onError: (msg: string) => void,
): Promise<string> {
  const channel = new Channel<SpeechEvent>();

  // Buffer any early events before session state is ready — Rust may emit
  // events before invoke() resolves on the JS side (Tauri Channel race).
  const pendingEvents: SpeechEvent[] = [];
  channel.onmessage = (event: SpeechEvent) => pendingEvents.push(event);

  const sessionId = await invoke<string>('speech_proxy_start', {
    configId: config.id,
    provider: config.provider,
    baseUrl: config.baseUrl ?? SPEECH_PROVIDER_BASE_URLS[config.provider] ?? '',
    language: config.language,
    model: config.model,
    region: config.region ?? null,
    onEvent: channel,
  });

  const state: SessionState = {
    configId: config.id,
    speakers: new Map(),
    segments: [],
    maleCount: 0,
    femaleCount: 0,
    bystanderSuffix: Math.floor(Math.random() * 900) + 100, // start offset
    onSegment,
    onError,
    mergeTimers: new Map(),
    pendingCommit: new Map(),
    pcmBuffer: [],
    pcmBufferBytes: 0,
    audioContext: null,
    mediaStream: null,
    workletNode: null,
    analyserNode: null,
  };
  sessions.set(sessionId, state);

  // Switch to real handler and drain any buffered events
  channel.onmessage = (event: SpeechEvent) =>
    handleSpeechEvent(sessionId, event, voiceProfiles);
  for (const event of pendingEvents) {
    handleSpeechEvent(sessionId, event, voiceProfiles);
  }

  // Start mic capture
  await startMicCapture(sessionId);

  return sessionId;
}

/** Send a raw PCM chunk to the Rust proxy (called by the AudioWorklet) */
export async function sendAudioChunk(
  sessionId: string,
  chunk: ArrayBuffer,
): Promise<void> {
  // Base64-encode the binary payload before sending over Tauri IPC.
  // Sending a JSON string token is orders of magnitude faster than a JSON number
  // array in WKWebView's IPC parser.
  //
  // IMPORTANT: never use `binary += String.fromCharCode(bytes[i])` in a plain loop
  // — JavaScriptCore (WebKit) copies the whole string on every concat, making it
  // O(n²) for large buffers (~0.5 s block per 32 KB chunk → UI freeze).
  // Process in 8 KB pages so each concat is O(page_size) instead:
  const bytes = new Uint8Array(chunk);
  const PAGE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += PAGE) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + PAGE) as unknown as number[],
    );
  }
  await invoke('speech_proxy_send_audio', { sessionId, audioB64: btoa(binary) });
}

/**
 * Stop the transcription session.
 * Returns final segments collected and profile proposals for each detected speaker.
 *
 * @param opts.sampleDir  Directory to save the session WAV as a voice sample
 *                        (used for profile playback / cross-session matching).
 * @param opts.backupDir  Directory for recording backup (F6). null = disabled.
 */
export async function stopTranscription(
  sessionId: string,
  opts?: { sampleDir?: string; backupDir?: string | null },
): Promise<{ segments: TranscriptSegment[]; profiles: NewProfileProposal[] }> {
  const state = sessions.get(sessionId);
  if (!state) return { segments: [], profiles: [] };

  // Stop mic
  stopMicCapture(state);

  // Tell Rust proxy to close the WebSocket
  try {
    await invoke('speech_proxy_stop', { sessionId });
  } catch { /* ignore if already closed */ }

  // Flush any segments still waiting in merge windows
  for (const [speakerId, timer] of state.mergeTimers) {
    clearTimeout(timer);
    const commit = state.pendingCommit.get(speakerId);
    if (commit) {
      const speaker = state.speakers.get(speakerId);
      const finalSeg: TranscriptSegment = {
        speakerId,
        profileId: speaker?.profileId,
        displayName: speaker?.displayName || speakerId,
        text: commit.text,
        startMs: commit.startMs,
        endMs: commit.endMs,
        confidence: commit.confidence,
        isFinal: true,
        speechFinal: true,
      };
      state.segments.push(finalSeg);
      state.onSegment(finalSeg);
    }
  }
  state.mergeTimers.clear();
  state.pendingCommit.clear();

  const segments = [...state.segments];

  // ── WAV export ─────────────────────────────────────────────────────────────
  // Save the full session recording to disk if there is any audio buffered.
  // The same WAV is used as both the voice profile sample and the backup copy.
  let recordingPath = '';
  if (state.pcmBuffer.length > 0) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[T:.]/g, '-')
      .slice(0, 19);            // e.g. "2026-02-26-11-00-42"
    const wav = buildWav(state.pcmBuffer);

    // Voice sample (used for profile playback)
    if (opts?.sampleDir) {
      const path = joinPath(opts.sampleDir, `sample-${timestamp}.wav`);
      try {
        await saveBinaryFile(path, wav);
        recordingPath = path;
      } catch { /* non-fatal: profile created without samplePath */ }
    }

    // Recording backup (F6)
    if (opts?.backupDir) {
      const path = joinPath(opts.backupDir, `recording-${timestamp}.wav`);
      try { await saveBinaryFile(path, wav); } catch { /* non-fatal */ }
    }
  }

  // ── Profile proposals ──────────────────────────────────────────────────────
  // Propose profiles for ALL speakers who talked long enough to be "main speakers".
  // For gendered speakers (男N号/女N号) we use their stable displayName so that
  // cross-session dedup works by autoName. For speakers whose gender could not be
  // detected we fall back to "说话人N" (stable within this session; TranscriptionPanel
  // will skip dedup for these so they always create a new profile entry).
  const tr = get(t);
  const profiles: NewProfileProposal[] = [];
  let fallbackIdx = 0;
  for (const [, speaker] of state.speakers) {
    // Include anyone who spoke for at least 1 second
    if (speaker.totalSpeakingMs >= MIN_PROFILE_THRESHOLD_MS) {
      fallbackIdx++;
      // Gendered speakers (男N号 / Male N etc.) have a stable cross-session name.
      // Others (路人 bystanders) get a session-stable fallback "Speaker N" name.
      const autoName = speaker.hasGenderedName
        ? speaker.displayName
        : tr('settings.voice.naming.speaker', { n: String(fallbackIdx) });
      profiles.push({
        speakerId: speaker.speakerId,
        autoName,
        gender: speaker.gender,
        samplePath: recordingPath,
        // Cap at MAX_SAMPLE_DURATION_MS: once we have 30s of a speaker's voice
        // accumulated across sessions, we stop replacing the sample file.
        sampleDurationMs: Math.min(speaker.totalSpeakingMs, MAX_SAMPLE_DURATION_MS),
      });
    }
  }

  sessions.delete(sessionId);
  return { segments, profiles };
}

// ---------------------------------------------------------------------------
// Mic capture
// ---------------------------------------------------------------------------

async function startMicCapture(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Microphone access is unavailable. On macOS, please allow microphone access in System Settings → Privacy & Security → Microphone.',
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const audioCtx = new AudioContext({ sampleRate: 16000 });
  const source = audioCtx.createMediaStreamSource(stream);

  // Analyser for pitch detection
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  // PCM worklet for sending audio chunks to Rust
  await audioCtx.audioWorklet.addModule(
    new URL('./pcm-worklet.js', import.meta.url),
  );
  const worklet = new AudioWorkletNode(audioCtx, 'pcm-sender');
  source.connect(worklet);

  // Rate-limit IPC: only one sendAudioChunk in flight at a time.
  // If the Tauri IPC round-trip takes longer than the worklet interval (~250 ms),
  // concurrent queued calls pile up and freeze the WebView.  Dropping a chunk is
  // far better than an unresponsive UI — STT services buffer audio internally.
  let sending = false;
  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    // Buffer PCM for WAV export (voice sample + recording backup)
    const chunk = new Uint8Array(e.data);
    if (state.pcmBufferBytes + chunk.byteLength <= MAX_PCM_BUFFER_BYTES) {
      state.pcmBuffer.push(chunk);
      state.pcmBufferBytes += chunk.byteLength;
    }

    if (sending) return;
    sending = true;
    sendAudioChunk(sessionId, e.data)
      .catch(() => { /* ignore IPC errors */ })
      .finally(() => { sending = false; });
  };

  state.audioContext = audioCtx;
  state.mediaStream = stream;
  state.workletNode = worklet;
  state.analyserNode = analyser;
}

function stopMicCapture(state: SessionState): void {
  state.workletNode?.disconnect();
  state.analyserNode?.disconnect();
  state.mediaStream?.getTracks().forEach(t => t.stop());
  state.audioContext?.close().catch(() => { /* ignore */ });
  state.workletNode = null;
  state.analyserNode = null;
  state.mediaStream = null;
  state.audioContext = null;
}

// ---------------------------------------------------------------------------
// Event handling & speaker naming
// ---------------------------------------------------------------------------

function handleSpeechEvent(
  sessionId: string,
  event: SpeechEvent,
  voiceProfiles: VoiceProfile[],
): void {
  const state = sessions.get(sessionId);
  if (!state) return;

  if (event.type === 'error') {
    // Stop mic capture immediately and remove session so audio sends stop
    stopMicCapture(state);
    sessions.delete(sessionId);
    state.onError(event.error ?? 'Unknown STT error');
    return;
  }

  if (event.type !== 'transcript' || !event.segment) {
    return;
  }

  const raw = event.segment;
  const speaker = getOrCreateSpeaker(state, raw.speakerId, voiceProfiles);

  // ── Merge-window restoration ──────────────────────────────────────────────
  // If new words arrive while a merge timer is active for this speaker, cancel
  // the timer and fold the buffered sentence back into the running accumulation.
  // This covers the common case of brief intra-sentence pauses that fired
  // speech_final=true prematurely (e.g. "i ... have a big game today").
  if (state.pendingCommit.has(raw.speakerId)) {
    const pending = state.pendingCommit.get(raw.speakerId)!;
    const existingTimer = state.mergeTimers.get(raw.speakerId);
    if (existingTimer) clearTimeout(existingTimer);
    state.mergeTimers.delete(raw.speakerId);
    state.pendingCommit.delete(raw.speakerId);
    // Prepend buffered text so the continued utterance starts from the right point
    speaker.pendingText = speaker.pendingText
      ? pending.text + ' ' + speaker.pendingText
      : pending.text;
    speaker.pendingStartMs = pending.startMs;
  }

  // ── Utterance accumulation logic ────────────────────────────────────────────
  //
  // Deepgram with interim_results=true sends three kinds of messages:
  //   • is_final=false, speech_final=false  → interim (word being recognized)
  //   • is_final=true,  speech_final=false  → stable chunk but utterance continues
  //   • is_final=true,  speech_final=true   → utterance complete (VAD endpoint fired)
  //
  // We accumulate stable chunks into speaker.pendingText and only emit a final
  // TranscriptSegment when speech_final=true. This prevents mid-sentence line breaks.
  //
  // Additionally, speech_final=true goes through a MERGE_WINDOW_MS debounce: the
  // segment is emitted as isFinal=false (live preview) and only committed as truly
  // final after the timeout. If more words arrive within the window, the pending
  // commit is absorbed back into the accumulator, producing a single longer sentence.
  //
  // Other providers always set speech_final = is_final so they bypass accumulation.

  let segText: string;
  let segStartMs: number;

  if (!raw.isFinal) {
    // Interim: display accumulated stable text + current partial word(s)
    const prefix = speaker.pendingText ? speaker.pendingText + ' ' : '';
    segText = prefix + raw.text;
    segStartMs = speaker.pendingStartMs || raw.startMs;
  } else if (!raw.speechFinal) {
    // Stable chunk, utterance still in progress: accumulate silently
    speaker.pendingText = speaker.pendingText
      ? speaker.pendingText + ' ' + raw.text
      : raw.text;
    if (!speaker.pendingStartMs) speaker.pendingStartMs = raw.startMs;
    segText = speaker.pendingText;
    segStartMs = speaker.pendingStartMs;
  } else {
    // VAD endpoint fired: merge accumulated text with this final chunk, then
    // enter the merge window instead of committing immediately.
    const fullText = speaker.pendingText
      ? speaker.pendingText + ' ' + raw.text
      : raw.text;
    const startMs = speaker.pendingStartMs || raw.startMs;
    speaker.totalSpeakingMs += raw.endMs - startMs;
    // Clear accumulator for the next utterance
    speaker.pendingText = '';
    speaker.pendingStartMs = 0;

    // Pitch analysis at each VAD endpoint (utterance boundary)
    if (state.analyserNode) {
      const f0 = estimatePitch(state.analyserNode);
      if (f0 > 0) speaker.pitchSamples.push(f0);
      refineSpeakerGender(speaker);
    }

    // Merge with any already-buffered text for this speaker (rapid speech_final
    // events within the same sentence get folded into one commit)
    const prevCommit = state.pendingCommit.get(raw.speakerId);
    const mergedText = prevCommit ? prevCommit.text + ' ' + fullText : fullText;
    const mergedStartMs = prevCommit ? prevCommit.startMs : startMs;

    // Cancel the previous merge timer (if any)
    const existingTimer = state.mergeTimers.get(raw.speakerId);
    if (existingTimer) clearTimeout(existingTimer);

    // Buffer the merged text
    state.pendingCommit.set(raw.speakerId, {
      text: mergedText,
      startMs: mergedStartMs,
      endMs: raw.endMs,
      confidence: raw.confidence,
    });

    // Show a live preview (isFinal=false) — the row will keep updating in-place
    segText = mergedText;
    segStartMs = mergedStartMs;

    // Start the merge window; on expiry, commit as truly final
    const timer = setTimeout(() => {
      const commit = state.pendingCommit.get(raw.speakerId);
      if (!commit) return;
      state.pendingCommit.delete(raw.speakerId);
      state.mergeTimers.delete(raw.speakerId);
      const finalSeg: TranscriptSegment = {
        speakerId: raw.speakerId,
        profileId: speaker.profileId,
        displayName: resolveSpeakerName(state, speaker),
        text: commit.text,
        startMs: commit.startMs,
        endMs: commit.endMs,
        confidence: commit.confidence,
        isFinal: true,
        speechFinal: true,
      };
      state.segments.push(finalSeg);
      state.onSegment(finalSeg);
    }, MERGE_WINDOW_MS);
    state.mergeTimers.set(raw.speakerId, timer);
  }

  // Emit as in-progress (isFinal=false). Final segments are pushed and emitted
  // exclusively by the merge window timer callback above.
  const segment: TranscriptSegment = {
    speakerId: raw.speakerId,
    profileId: speaker.profileId,
    displayName: resolveSpeakerName(state, speaker),
    text: segText,
    startMs: segStartMs,
    endMs: raw.endMs,
    confidence: raw.confidence,
    isFinal: false,
    speechFinal: false,
  };
  state.onSegment(segment);
}

function getOrCreateSpeaker(
  state: SessionState,
  speakerId: string,
  voiceProfiles: VoiceProfile[],
): SessionSpeaker {
  if (state.speakers.has(speakerId)) {
    return state.speakers.get(speakerId)!;
  }

  // Try to match an existing voice profile (placeholder; full MFCC matching in F4)
  const profile = voiceProfiles.find(p => p.id === speakerId); // simple ID match for now

  const speaker: SessionSpeaker = {
    speakerId,
    profileId: profile?.id,
    displayName: profile?.nickname ?? profile?.autoName ?? '',
    gender: profile?.gender ?? 'unknown',
    hasGenderedName: false,
    firstSeenMs: Date.now(),
    totalSpeakingMs: 0,
    pitchSamples: [],
    pendingText: '',
    pendingStartMs: 0,
  };

  state.speakers.set(speakerId, speaker);
  return speaker;
}

function resolveSpeakerName(state: SessionState, speaker: SessionSpeaker): string {
  const tr = get(t);

  // Profile-matched speaker with a custom nickname: never change it
  if (speaker.profileId && speaker.displayName) return speaker.displayName;

  // Already has a stable gendered name: keep it (tracked by flag, not string prefix)
  if (speaker.hasGenderedName) return speaker.displayName;

  // Enough speaking time AND gender known → assign or UPGRADE to gendered name
  if (speaker.totalSpeakingMs >= MIN_SPEAKING_MS_FOR_GENDER_NAME && speaker.gender !== 'unknown') {
    if (speaker.gender === 'male') {
      state.maleCount++;
      speaker.displayName = tr('settings.voice.naming.male', { n: String(state.maleCount) });
    } else {
      state.femaleCount++;
      speaker.displayName = tr('settings.voice.naming.female', { n: String(state.femaleCount) });
    }
    speaker.hasGenderedName = true;
    return speaker.displayName;
  }

  // Below threshold or gender still unknown → bystander name (assigned once)
  if (!speaker.displayName) {
    state.bystanderSuffix++;
    speaker.displayName = tr('settings.voice.naming.bystander', {
      n: String(state.bystanderSuffix).padStart(3, '0'),
    });
  }
  return speaker.displayName;
}

// ---------------------------------------------------------------------------
// Pitch estimation via autocorrelation (Web Audio AnalyserNode)
// ---------------------------------------------------------------------------

function estimatePitch(analyser: AnalyserNode): number {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  const sampleRate = 16000;
  const SIZE = buf.length;

  // Compute RMS — skip silent frames
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return 0;

  // Autocorrelation
  let bestOffset = -1;
  let bestCorr = 0;
  let lastCorr = 1;
  let foundGoodCorr = false;
  const MIN_LAG = Math.floor(sampleRate / 400); // ~40 Hz lower bound
  const MAX_LAG = Math.floor(sampleRate / 60);  // ~60 Hz upper bound for voice (~300 Hz max)

  for (let offset = MIN_LAG; offset < MAX_LAG; offset++) {
    let corr = 0;
    for (let i = 0; i < SIZE - offset; i++) {
      corr += Math.abs(buf[i + offset] - buf[i]);
    }
    corr = 1 - corr / SIZE;
    if (corr > 0.7 && corr > lastCorr) {
      foundGoodCorr = true;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestOffset = offset;
      }
    } else if (foundGoodCorr) {
      break;
    }
    lastCorr = corr;
  }

  if (bestOffset === -1 || bestCorr < 0.7) return 0;
  return sampleRate / bestOffset;
}

function refineSpeakerGender(speaker: SessionSpeaker): void {
  if (speaker.pitchSamples.length < 2) return;
  const samples = speaker.pitchSamples.filter(f => f > 0);
  if (samples.length === 0) return;

  const median = samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  speaker.gender = median < PITCH_GENDER_THRESHOLD_HZ ? 'male' : 'female';
}

// ---------------------------------------------------------------------------
// WAV helpers (PCM → WAV encoding + file save)
// ---------------------------------------------------------------------------

/**
 * Build a standard RIFF WAV header + raw 16-bit 16 kHz mono PCM.
 * Input is an array of Uint8Array chunks; they are concatenated in-place.
 */
function buildWav(chunks: Uint8Array[]): Uint8Array {
  const totalPcm = chunks.reduce((s, c) => s + c.byteLength, 0);
  const buf = new ArrayBuffer(44 + totalPcm);
  const dv = new DataView(buf);
  const out = new Uint8Array(buf);

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, 'RIFF');
  dv.setUint32(4, 36 + totalPcm, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);   // chunk size
  dv.setUint16(20, 1, true);    // PCM format
  dv.setUint16(22, 1, true);    // mono
  dv.setUint32(24, 16_000, true); // sampleRate
  dv.setUint32(28, 32_000, true); // byteRate = 16000 * 1 * 2
  dv.setUint16(32, 2, true);    // blockAlign
  dv.setUint16(34, 16, true);   // bitsPerSample
  str(36, 'data');
  dv.setUint32(40, totalPcm, true);

  let offset = 44;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

/** Platform-safe path join (handles both / and \ separators) */
function joinPath(dir: string, filename: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[/\\]$/, '') + sep + filename;
}

/** Write binary data to a file, creating parent directories as needed. */
async function saveBinaryFile(path: string, data: Uint8Array): Promise<void> {
  const { writeFile, mkdir } = await import('@tauri-apps/plugin-fs');
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSep > 0) {
    await mkdir(path.substring(0, lastSep), { recursive: true });
  }
  await writeFile(path, data);
}

// ---------------------------------------------------------------------------
// Test connection (2s of silence → verify WebSocket handshake)
// ---------------------------------------------------------------------------

export async function testSpeechConnection(
  config: SpeechProviderConfig,
): Promise<void> {
  const TEST_ID = '__test__';

  // Temporarily write the API key to the in-memory keychain so Rust can look it up
  await invoke('keychain_set', { key: `speech-key:${TEST_ID}`, value: config.apiKey });

  const channel = new Channel<SpeechEvent>();
  let connected = false;
  let error = '';
  let sessionId = '';

  // Register channel handler BEFORE invoke to avoid Tauri Channel race condition:
  // Rust may emit the Connected event before invoke() resolves on the JS side,
  // and Tauri Channel drops messages that arrive when onmessage is null.
  const connectPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 8000);

    channel.onmessage = (event: SpeechEvent) => {
      if (event.type === 'connected') {
        connected = true;
        clearTimeout(timeout);
        resolve();
      } else if (event.type === 'error') {
        error = event.error ?? 'Connection failed';
        clearTimeout(timeout);
        reject(new Error(error));
      }
    };
  });

  try {
    sessionId = await invoke<string>('speech_proxy_start', {
      configId: TEST_ID,
      provider: config.provider,
      baseUrl: config.baseUrl ?? SPEECH_PROVIDER_BASE_URLS[config.provider] ?? '',
      language: config.language,
      model: config.model,
      region: config.region ?? null,
      onEvent: channel,
    });

    await connectPromise;
  } finally {
    if (sessionId) await invoke('speech_proxy_stop', { sessionId }).catch(() => { /* ignore */ });
    // Clean up the temporary keychain entry
    await invoke('keychain_delete', { key: `speech-key:${TEST_ID}` }).catch(() => { /* ignore */ });
  }

  if (!connected) throw new Error(error || 'Connection failed');
}

/**
 * Voice / Transcription type definitions for Moraya v0.15.0
 */

/** A speaker profile that persists across transcription sessions */
export interface VoiceProfile {
  id: string;
  speakerId?: string;         // provider-assigned ID at time of creation (e.g. "SPEAKER_0")
  nickname: string;           // user-defined: e.g. "张总"
  autoName: string;           // auto-detected: e.g. "男1号"
  gender: 'male' | 'female' | 'unknown';
  samplePath: string;         // absolute path to 15s WAV sample file ('' if not yet recorded)
  sampleDurationMs: number;
  color: string;              // hex color for transcript display
  createdAt: number;          // epoch ms
  updatedAt: number;          // epoch ms
}

/** Proposed new voice profile extracted from a finished session */
export interface NewProfileProposal {
  speakerId: string;
  autoName: string;
  gender: 'male' | 'female' | 'unknown';
  /** Absolute path to the session WAV file saved for this profile ('' if not saved) */
  samplePath: string;
  /** Total speaking time accumulated in this session (ms), capped at 30 000 ms */
  sampleDurationMs: number;
}

/** One utterance segment returned by the STT service */
export interface TranscriptSegment {
  speakerId: string;          // provider-assigned: 'SPEAKER_0', 'SPEAKER_1', etc.
  profileId?: string;         // matched VoiceProfile.id (if cross-session match found)
  displayName: string;        // '男1号', '张总', '路人338', etc.
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  /** false = still accumulating (interim or mid-utterance stable chunk); true = utterance complete */
  isFinal: boolean;
  /** true = VAD endpoint fired, utterance is complete (Deepgram speech_final) */
  speechFinal: boolean;
}

/** Speaker state tracked within a single transcription session */
export interface SessionSpeaker {
  speakerId: string;          // provider-assigned ID
  profileId?: string;
  displayName: string;
  gender: 'male' | 'female' | 'unknown';
  /** true once the speaker has been assigned a stable gendered name (男N号 / Male N etc.) */
  hasGenderedName: boolean;
  firstSeenMs: number;
  totalSpeakingMs: number;
  /** Running pitch samples for gender detection */
  pitchSamples: number[];
  /** Accumulated stable text for the current in-progress utterance */
  pendingText: string;
  /** Start timestamp (ms) of the current in-progress utterance */
  pendingStartMs: number;
}

/** Event emitted from the Rust speech proxy via Tauri Channel */
export interface SpeechEvent {
  type: 'transcript' | 'error' | 'connected' | 'disconnected';
  sessionId: string;
  /** Present when type === 'transcript' */
  segment?: {
    speakerId: string;
    text: string;
    startMs: number;
    endMs: number;
    confidence: number;
    isFinal: boolean;
    speechFinal: boolean;
  };
  /** Present when type === 'error' */
  error?: string;
}

export type {
  VoiceProfile,
  TranscriptSegment,
  SessionSpeaker,
  SpeechEvent,
  NewProfileProposal,
  VoiceInputSourceMode,
  VoiceSessionMode,
} from './types';
export {
  startTranscription,
  sendAudioChunk,
  stopTranscription,
  testSpeechConnection,
  setMicMuted,
} from './speech-service';

export type { VoiceProfile, TranscriptSegment, SessionSpeaker, SpeechEvent, NewProfileProposal } from './types';
export {
  startTranscription,
  sendAudioChunk,
  stopTranscription,
  testSpeechConnection,
} from './speech-service';

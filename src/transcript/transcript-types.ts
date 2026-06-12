export type SourceLanguage = "ko" | "en" | "unknown";
export type SegmentStatus = "STREAMING" | "FINALIZED";

export type FinalizationReason =
  | "VAD_SILENCE"
  | "NO_DELTA_TIMEOUT"
  | "MAX_DURATION"
  | "TRACK_ENDED"
  | "MEETING_ENDED"
  | "SERVER_SHUTDOWN"
  | "MANUAL_FLUSH";

export interface TranscriptSegment {
  segmentId: string;
  meetingId: string;
  sessionId: string;
  sequence: number;
  startedAtMs: number;
  endedAtMs?: number;
  language: SourceLanguage;
  text: string;
  sourceLanguage: SourceLanguage;
  sourceText: string;
  koText: string;
  enText: string;
  sourceTranscript?: string;
  sourceCandidateKo?: string;
  sourceCandidateEn?: string;
  koTargetOutput?: string;
  enTargetOutput?: string;
  status: SegmentStatus;
}

export interface ActiveTranscriptSegment {
  segmentId: string;
  meetingId: string;
  sessionId: string;
  startedAtMs: number;
  endedAtMs?: number;
  sourceTranscript: string;
  sourceCandidateKo: string;
  sourceCandidateEn: string;
  koTargetOutput: string;
  enTargetOutput: string;
  lastDeltaAtMs: number;
  speechStoppedAtMs?: number;
}

export interface FinalTranscriptPayload
  extends Pick<
    TranscriptSegment,
    | "meetingId"
    | "sessionId"
    | "segmentId"
    | "sequence"
    | "language"
    | "text"
    | "startedAtMs"
    | "endedAtMs"
  > {
  provider: "openai-realtime-transcription";
  finalizationReason: FinalizationReason;
  idempotencyKey: string;
}

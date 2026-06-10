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
  sourceLanguage: SourceLanguage;
  sourceText: string;
  koText: string;
  enText: string;
  status: SegmentStatus;
}

export interface ActiveTranscriptSegment {
  segmentId: string;
  meetingId: string;
  sessionId: string;
  startedAtMs: number;
  endedAtMs?: number;
  sourceCandidateKo: string;
  sourceCandidateEn: string;
  koTargetOutput: string;
  enTargetOutput: string;
  lastDeltaAtMs: number;
  speechStoppedAtMs?: number;
}

export interface FinalTranscriptPayload
  extends Omit<TranscriptSegment, "status"> {
  provider: "openai-realtime-translation";
  finalizationReason: FinalizationReason;
  idempotencyKey: string;
}

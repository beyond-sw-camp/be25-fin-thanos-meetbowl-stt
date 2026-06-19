/**
 * STT 엔진 및 도메인 로직에서 공통으로 사용하는 타입 및 인터페이스 정의 파일입니다.
 * 데이터의 일관성을 유지하고 타 모듈과의 계약(Contract) 역할을 수행합니다.
 */

/** 발화 언어 분류입니다. */
export type SourceLanguage = "ko" | "en" | "unknown";

/** 세그먼트의 처리 상태입니다. STREAMING(중간 결과), FINALIZED(최종 확정 결과)를 구분합니다. */
export type SegmentStatus = "STREAMING" | "FINALIZED";

/** 
 * 세그먼트가 확정된 원인을 나타냅니다.
 * - VAD_SILENCE: 발화 중 무음 구간 감지
 * - NO_DELTA_TIMEOUT: 엔진으로부터 일정 시간 데이터 수신 없음
 * - MAX_DURATION: 발화가 너무 길어 강제 분리
 * - MEETING_ENDED: 회의가 종료되어 잔여 데이터 마감
 */
export type FinalizationReason =
  | "VAD_SILENCE"
  | "NO_DELTA_TIMEOUT"
  | "MAX_DURATION"
  | "TRACK_ENDED"
  | "MEETING_ENDED"
  | "SERVER_SHUTDOWN"
  | "MANUAL_FLUSH";

/** 외부 시스템으로 전송되는 정규화된 자막 세그먼트 데이터 구조입니다. */
export interface TranscriptSegment {
  /** 세그먼트 고유 식별자 */
  segmentId: string;
  meetingId: string;
  sessionId: string;
  /** 세션 내 자막 순서를 나타내는 인덱스 */
  organizationId: string;
  participantUserIds: string[];
  sequence: number;
  /** 회의 시작 시점 대비 발화 시작 오프셋 (ms) */
  startedAtMs: number;
  /** 서버 시계 기준 발화 시작 절대 시각(epoch ms)입니다. */
  startedAtEpochMs?: number;
  /** 발화 종료 오프셋 (ms) */
  endedAtMs?: number;
  language: SourceLanguage;
  /** 최종적으로 사용자에게 표시될 최적의 텍스트 */
  text: string;
  
  // 원본 및 번역 후보군 데이터 (디버깅 및 정밀 분석용)
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

/** 현재 파이프라인에서 누적 중인 실시간 발화 객체 구조입니다. */
export interface ActiveTranscriptSegment {
  segmentId: string;
  meetingId: string;
  sessionId: string;
  organizationId: string;
  participantUserIds: string[];
  startedAtMs: number;
  startedAtEpochMs?: number;
  endedAtMs?: number;
  sourceTranscript: string;
  sourceCandidateKo: string;
  sourceCandidateEn: string;
  koTargetOutput: string;
  enTargetOutput: string;
  /** 마지막으로 텍스트 델타가 수신된 시스템 시각입니다. */
  lastDeltaAtMs: number;
  /** VAD에 의해 물리적 소리가 멈춘 시각입니다. */
  speechStoppedAtMs?: number;
}

/** RabbitMQ를 통해 meetbowl-be로 전송되는 최종 저장용 데이터 스키마입니다. */
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
  /** DB 중복 저장을 방지하기 위한 멱등성 키입니다. */
  idempotencyKey: string;
}

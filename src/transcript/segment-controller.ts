
/**
 * 발화 세그먼트(Segment)의 생성, 델타 데이터 누적 및 최종 확정을 제어하는 클래스입니다.
 * 실시간 스트리밍 중인 자막 조각들을 논리적인 문장 단위로 묶고 중복을 제거합니다.
 */
import { randomUUID } from "node:crypto";

import { buildDisplayTexts } from "./display-text-builder.js";
import type { PipelineLogger } from "../livekit/participant-audio-pipeline.js";
import type {
  CaptionPublisher,
  FinalSegmentPublisher
} from "./segment-publisher.js";
import type {
  ActiveTranscriptSegment,
  FinalizationReason,
  TranscriptSegment
} from "./transcript-types.js";

export interface SegmentControllerOptions {
  /** 현재 세그먼트가 속한 회의 ID입니다. */
  meetingId: string;
  /** 현재 세그먼트가 속한 STT 세션 ID입니다. */
  sessionId: string;
  /** STT 세션 시작 절대 시각입니다. startedAtMs를 상대 시간으로 계산할 때 사용합니다. */
  meetingStartedAtMs: number;
  /** delta가 오래 멈췄을 때 세그먼트를 마감하기 위한 타임아웃입니다. */
  noDeltaTimeoutMs: number;
  /** provider가 늦게 보내는 마지막 텍스트를 흡수하기 위해 기다리는 시간입니다. */
  translationGraceMs: number;
  /** 세그먼트가 너무 길어지는 것을 막기 위한 최대 지속 시간입니다. */
  maxSegmentDurationMs: number;
  /** 세그먼트 순번을 외부에서 공급받는 콜백입니다. */
  nextSequence: () => number;
  /** STREAMING/FINALIZED 자막을 LiveKit으로 발행하는 채널입니다. */
  captionPublisher: CaptionPublisher;
  /** FINALIZED 세그먼트를 RabbitMQ/Redis Stream으로 발행하는 채널입니다. */
  finalSegmentPublisher: FinalSegmentPublisher;
  /** 로그/이벤트 상관관계 추적용 ID입니다. */
  correlationId: string;
  /** 세그먼트 오픈/파이널라이즈 같은 핵심 상태 전이를 기록하는 최소 로거입니다. */
  logger: Pick<PipelineLogger, "info">;
  onFinalizationError?: (
    error: Error,
    segmentId: string,
    reason: FinalizationReason
  ) => void;
}

type TranscriptChannel =
  /** 원문 transcription provider가 보내는 메인 delta 버퍼입니다. */
  | "sourceTranscript"
  /** 한국어 번역 세션에서 역으로 관측한 source 후보 텍스트입니다. */
  | "sourceCandidateKo"
  /** 영어 번역 세션에서 역으로 관측한 source 후보 텍스트입니다. */
  | "sourceCandidateEn"
  /** 한국어 target 번역 결과 버퍼입니다. */
  | "koTargetOutput"
  /** 영어 target 번역 결과 버퍼입니다. */
  | "enTargetOutput";

export class SegmentController {
  /** 현재 활성화된(말하기가 진행 중인) 세그먼트 데이터입니다. */
  private active?: ActiveTranscriptSegment;
  /** 세션 내 자막 순서를 보장하기 위한 순번입니다. */
  private sequence?: number;
  
  /** delta가 한동안 멈췄을 때 강제 finalize를 예약하는 타이머입니다. */
  private noDeltaTimer?: NodeJS.Timeout;
  /** 세그먼트가 최대 길이를 넘었을 때 강제 분리를 예약하는 타이머입니다. */
  private maxDurationTimer?: NodeJS.Timeout;
  /** speech stop 이후 provider의 마지막 응답을 기다리기 위한 grace 타이머입니다. */
  private graceTimer?: NodeJS.Timeout;

  /** 확정(Finalize) 프로세스가 중복 실행되지 않도록 방지하는 플래그입니다. */
  private finalizing = false;
  /** 다중 마이크 환경에서 동일 문장이 중복 발행되는 것을 막기 위한 최근 확정 텍스트 캐시입니다. */
  private lastFinalizedText = "";
  /** 마지막 finalized 문장이 확정된 절대 시각입니다. 중복 억제 시간 창 계산에 사용합니다. */
  private lastFinalizedAtMs = 0;

  constructor(private readonly options: SegmentControllerOptions) {}

  /** [발화 시작] 새로운 세그먼트를 생성하고 시간 및 순번을 할당합니다. */
  startSpeech(nowMs = Date.now()): void {
    if (this.active) return;

    const gapFromPreviousFinalMs =
      this.lastFinalizedAtMs > 0 ? Math.max(0, nowMs - this.lastFinalizedAtMs) : undefined;
    this.sequence = this.options.nextSequence();
    this.active = {
      segmentId: randomUUID(),
      meetingId: this.options.meetingId,
      sessionId: this.options.sessionId,
      startedAtMs: Math.max(0, nowMs - this.options.meetingStartedAtMs),
      startedAtEpochMs: nowMs,
      sourceTranscript: "",
      sourceCandidateKo: "",
      sourceCandidateEn: "",
      koTargetOutput: "",
      enTargetOutput: "",
      lastDeltaAtMs: nowMs
    };
    this.options.logger.info(
      {
        meetingId: this.options.meetingId,
        sessionId: this.options.sessionId,
        segmentId: this.active.segmentId,
        sequence: this.sequence,
        gapFromPreviousFinalMs
      },
      "STT speech segment opened"
    );

    // 설정된 최대 발화 시간을 초과할 경우 강제로 세그먼트를 분리하기 위한 타이머 가동
    this.maxDurationTimer = setTimeout(() => {
      this.finalizeFromTimer("MAX_DURATION");
    }, this.options.maxSegmentDurationMs);
  }

  /** [발화 종료] VAD에 의해 무음이 감지되면 호출되며, 즉시 종료하지 않고 Grace Time 동안 엔진 응답을 대기합니다. */
  stopSpeech(nowMs = Date.now()): void {
    if (!this.active) return;

    this.active.endedAtMs = Math.max(
      this.active.startedAtMs,
      nowMs - this.options.meetingStartedAtMs
    );
    this.active.speechStoppedAtMs = nowMs;
    
    // 엔진으로부터 올 수 있는 마지막 텍스트 조각을 기다리기 위해 확정 예약
    this.scheduleGraceFinalization("VAD_SILENCE");
  }

  /** 핵심 전사 엔진의 최종 완성 문장을 수신했을 때 기존 데이터를 교체하고 스트리밍 업데이트를 보냅니다. */
  replaceSourceTranscript(transcript: string, nowMs = Date.now()): void {
    const normalized = transcript.trim();
    if (!normalized) return;
    if (!this.active) {
      // VAD보다 provider delta/completed가 먼저 오면 화면용 세그먼트를 즉시 연다.
      this.startSpeech(nowMs);
    }
    if (!this.active) return;

    this.active.sourceTranscript = mergeCompletedTranscript(
      this.active.sourceTranscript,
      normalized
    );
    this.active.lastDeltaAtMs = nowMs;
    this.refreshTimers();
    void this.publishStreaming();
  }

  /** 엔진으로부터 수신된 텍스트 델타(조각)를 해당 채널에 누적합니다. */
  appendDelta(
    channel: TranscriptChannel,
    delta: string,
    nowMs = Date.now()
  ): void {
    if (!delta) return;
    if (!this.active) {
      // 실시간 자막은 final 확정보다 빠르게 보여야 하므로 첫 delta 수신 시 세그먼트를 연다.
      this.startSpeech(nowMs);
    }
    if (!this.active) return;

    this.active[channel] += delta;
    this.active.lastDeltaAtMs = nowMs;
    this.refreshTimers();
    void this.publishStreaming();
  }

  /** 진행 중인 발화를 즉시 강제 마감합니다. */
  async flush(reason: FinalizationReason): Promise<void> {
    await this.finalize(reason);
  }

  /** 테스트와 상위 제어 로직에서 현재 발화 세그먼트 존재 여부를 확인할 때 사용합니다. */
  hasActiveSegment(): boolean {
    return this.active !== undefined;
  }

  /** 델타 수신 시 타이머들을 초기화하여 발화 중단을 방지합니다. */
  private refreshTimers(): void {
    this.scheduleNoDeltaFinalization();
    if (this.active?.speechStoppedAtMs !== undefined) {
      this.scheduleGraceFinalization("VAD_SILENCE");
    }
  }

  private scheduleNoDeltaFinalization(): void {
    if (this.noDeltaTimer) clearTimeout(this.noDeltaTimer);
    
    // 무음 상태인데 텍스트 변화도 없는 경우를 대비한 세이프 가드
    this.noDeltaTimer = setTimeout(() => {
      if (this.active?.speechStoppedAtMs !== undefined) {
        this.scheduleGraceFinalization("NO_DELTA_TIMEOUT");
      }
    }, this.options.noDeltaTimeoutMs);
  }

  private scheduleGraceFinalization(reason: FinalizationReason): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    
    const graceMs = Math.max(
      this.options.translationGraceMs,
      this.options.noDeltaTimeoutMs
    );
    this.graceTimer = setTimeout(() => {
      this.finalizeFromTimer(reason);
    }, graceMs);
  }

  /** [스트리밍 업데이트] 현재까지 누적된 데이터를 화면 표시용(STREAMING)으로 즉시 발행합니다. */
  private async publishStreaming(): Promise<void> {
    const segment = this.toTranscriptSegment("STREAMING");
    if (segment.text) {
      await this.options.captionPublisher.publishCaption(segment);
    }
  }

  /** 
   * [최종 확정] 현재 세그먼트를 마감하고 영구 저장소 및 분석 서버로 발행합니다.
   * 중복 문장 필터링 로직을 거쳐 유효한 데이터만 전송합니다.
   */
  private async finalize(reason: FinalizationReason): Promise<void> {
    if (!this.active || this.finalizing) return;

    this.finalizing = true;
    this.clearTimers();
    const segment = this.toTranscriptSegment("FINALIZED");

    try {
      if (!segment.text) {
        this.reset();
        return;
      }

      // 다중 트랙 중복 데이터 억제
      if (this.isDuplicateFinalSegment(segment.text)) {
        this.reset();
        return;
      }

      // 1. 화면 자막 고정 (LiveKit DataChannel)
      await this.options.captionPublisher.publishCaption(segment);
      // 2. 최종 저장 요청 (RabbitMQ) 및 실시간 분석(Redis Stream) 발행
      await this.options.finalSegmentPublisher.publishFinalSegment(
        segment,
        reason,
        this.options.correlationId
      );
      const elapsedMs = segment.startedAtMs === undefined
        ? undefined
        : Math.max(0, (segment.endedAtMs ?? segment.startedAtMs) - segment.startedAtMs);
      this.options.logger.info(
        {
          meetingId: segment.meetingId,
          sessionId: segment.sessionId,
          segmentId: segment.segmentId,
          sequence: segment.sequence,
          reason,
          elapsedMs
        },
        "STT segment finalized"
      );

      this.recordFinalizedText(segment.text);
      this.reset();
    } finally {
      this.finalizing = false;
    }
  }

  private reset(): void {
    // 현재 세그먼트를 완전히 비우지 않으면 다음 발화가 이전 버퍼를 이어받는 문제가 생긴다.
    this.active = undefined;
    this.sequence = undefined;
  }

  private finalizeFromTimer(reason: FinalizationReason): void {
    void this.finalize(reason).catch((error) => {
      this.options.onFinalizationError?.(
        error instanceof Error ? error : new Error(String(error)),
        this.active?.segmentId ?? "unknown",
        reason
      );
    });
  }

  /** 현재 활성 데이터를 외부 전송용 인터페이스 객체로 변환합니다. */
  private toTranscriptSegment(
    status: TranscriptSegment["status"]
  ): TranscriptSegment {
    const active = this.active;
    if (!active || this.sequence === undefined) {
      throw new Error("비활성 세그먼트에서 데이터 변환 시도");
    }

    const display = buildDisplayTexts(active);
    return {
      segmentId: active.segmentId,
      meetingId: active.meetingId,
      sessionId: active.sessionId,
      sequence: this.sequence,
      startedAtMs: active.startedAtMs,
      startedAtEpochMs: active.startedAtEpochMs,
      endedAtMs: active.endedAtMs,
      language: display.sourceLanguage,
      text: display.sourceText,
      sourceLanguage: display.sourceLanguage,
      sourceText: display.sourceText,
      koText: display.koText,
      enText: display.enText,
      sourceTranscript: active.sourceTranscript,
      sourceCandidateKo: active.sourceCandidateKo,
      sourceCandidateEn: active.sourceCandidateEn,
      koTargetOutput: active.koTargetOutput,
      enTargetOutput: active.enTargetOutput,
      status
    };
  }

  private clearTimers(): void {
    if (this.noDeltaTimer) clearTimeout(this.noDeltaTimer);
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.noDeltaTimer = undefined;
    this.maxDurationTimer = undefined;
    this.graceTimer = undefined;
  }

  private isDuplicateFinalSegment(text: string, nowMs = Date.now()): boolean {
    const normalized = normalizeForDuplicateCheck(text);
    if (!normalized) return false;
    
    // 짧은 시간(2.5초) 내에 동일한 문장이 다른 트랙에서 또 확정되는 경우 중복으로 간주
    return (
      this.lastFinalizedText === normalized &&
      nowMs - this.lastFinalizedAtMs <= 2500
    );
  }

  private recordFinalizedText(text: string, nowMs = Date.now()): void {
    this.lastFinalizedText = normalizeForDuplicateCheck(text);
    this.lastFinalizedAtMs = nowMs;
  }
}

/** 핵심 전사 엔진의 문장이 일부 누락되어 오더라도 누적 데이터와 비교하여 더 완전한 쪽을 선택합니다. */
function mergeCompletedTranscript(
  currentTranscript: string,
  completedTranscript: string
): string {
  const current = currentTranscript.trim();
  const completed = completedTranscript.trim();

  if (!current) return completed;
  if (!completed) return current;
  if (completed.includes(current)) return completed;
  if (current.includes(completed)) return current;

  return completed.length < current.length * 0.85 ? current : completed;
}

function normalizeForDuplicateCheck(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

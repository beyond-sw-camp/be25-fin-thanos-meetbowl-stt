
/**
 * 발화 세그먼트(Segment)의 생성, 델타 데이터 누적 및 최종 확정을 제어하는 클래스입니다.
 *
 * 이 클래스가 담당하는 일:
 * 1. "지금 새 문장을 열어야 하는가?"를 판단한다.
 * 2. provider가 보내는 delta/completed transcript를 현재 문장 버퍼에 누적한다.
 * 3. "언제 이 문장을 FINALIZED로 볼 것인가?"를 타이머와 VAD 신호로 결정한다.
 * 4. FINALIZED가 되면 화면용 caption과 DB 저장용 final event를 각각 발행한다.
 *
 * 중요한 점:
 * - STREAMING은 화면 표시용 중간 상태다.
 * - FINALIZED는 "이 문장을 이제 저장해도 된다"는 뜻의 최종 확정 상태다.
 * - DB에는 FINALIZED만 저장되고, STREAMING은 저장되지 않는다.
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

  /**
   * [발화 시작]
   *
   * 언제 호출되나:
   * - VAD가 "사람이 말하기 시작했다"고 본 시점
   * - 또는 VAD보다 먼저 provider delta/completed transcript가 들어온 시점
   *
   * 여기서 하는 일:
   * - 새로운 segmentId 발급
   * - sequence 확보
   * - startedAtMs / startedAtEpochMs 기록
   * - 이후 들어올 각 채널(delta/completed) 버퍼를 빈 문자열로 초기화
   * - 너무 긴 발화가 무한히 열려 있지 않도록 maxDuration 타이머 시작
   */
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

    // 설정된 최대 발화 시간을 초과할 경우 강제로 세그먼트를 분리한다.
    // 이 타이머는 "아무리 말이 계속 이어져도 한 세그먼트가 너무 길어지지 않게 하는 안전장치"다.
    this.maxDurationTimer = setTimeout(() => {
      this.finalizeFromTimer("MAX_DURATION");
    }, this.options.maxSegmentDurationMs);
  }

  /**
   * [발화 종료]
   *
   * 언제 호출되나:
   * - Energy VAD가 "마지막 음성 이후 silenceMs 만큼 조용했다"고 판단했을 때
   *
   * 여기서 바로 FINALIZED 하지 않는 이유:
   * - provider가 마지막 delta/completed transcript를 약간 늦게 보낼 수 있기 때문이다.
   * - 그래서 speechStoppedAtMs만 기록하고, grace 타이머를 걸어 조금 더 기다린다.
   *
   * 즉, "무음 감지"는 FINALIZED의 직접 조건이 아니라,
   * "이제 finalization 후보 상태로 들어간다"는 신호다.
   */
  stopSpeech(nowMs = Date.now()): void {
    if (!this.active) return;

    this.active.endedAtMs = Math.max(
      this.active.startedAtMs,
      nowMs - this.options.meetingStartedAtMs
    );
    this.active.speechStoppedAtMs = nowMs;
    
    // 엔진으로부터 뒤늦게 들어오는 마지막 텍스트 조각을 흡수하기 위해 grace 확정을 예약한다.
    this.scheduleGraceFinalization("VAD_SILENCE");
  }

  /**
   * 핵심 전사 엔진의 completed transcript를 반영한다.
   *
   * 의미:
   * - delta는 "지금까지 이렇게 들린다"는 중간 결과
   * - completed transcript는 "이번 문장은 이렇게 정리하는 게 더 정확하다"는 보정 결과
   *
   * 동작:
   * - active 세그먼트가 없으면 즉시 하나 연다.
   * - 기존 sourceTranscript보다 더 완전한 텍스트로 교체한다.
   * - 델타 타이머를 갱신하고 STREAMING caption을 다시 발행한다.
   */
  replaceSourceTranscript(transcript: string, nowMs = Date.now()): void {
    const normalized = transcript.trim();
    if (!normalized) return;
    if (!this.active) {
      // VAD보다 provider 결과가 먼저 오면, 사용자는 이미 말을 시작한 상태일 수 있다.
      // 실시간성 확보를 위해 VAD를 기다리지 않고 화면용 세그먼트를 즉시 연다.
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

  /**
   * 엔진으로부터 수신된 텍스트 delta를 해당 채널 버퍼에 누적한다.
   *
   * 채널 예시:
   * - sourceTranscript: 원문 STT delta
   * - sourceCandidateKo / sourceCandidateEn: 번역 세션이 역으로 관측한 source 후보
   * - koTargetOutput / enTargetOutput: 번역 출력
   *
   * 핵심:
   * - 어떤 채널이든 첫 delta가 오면 세그먼트는 열릴 수 있다.
   * - delta가 들어올 때마다 "아직 이 문장이 살아 있다"는 뜻이므로 타이머를 갱신한다.
   */
  appendDelta(
    channel: TranscriptChannel,
    delta: string,
    nowMs = Date.now()
  ): void {
    if (!delta) return;
    if (!this.active) {
      // 실시간 자막은 "말한 뒤 바로 보이는 것"이 중요하므로, 첫 delta만 와도 세그먼트를 연다.
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

  /**
   * delta/completed transcript가 들어왔을 때 finalization 관련 타이머를 갱신한다.
   *
   * 이유:
   * - provider가 계속 응답 중이면 아직 문장이 끝나지 않았을 수 있다.
   * - 따라서 no-delta 타이머를 다시 세팅한다.
   * - 이미 speechStoppedAtMs가 찍힌 상태라면, grace finalization도 뒤로 미룬다.
   */
  private refreshTimers(): void {
    this.scheduleNoDeltaFinalization();
    if (this.active?.speechStoppedAtMs !== undefined) {
      this.scheduleGraceFinalization("VAD_SILENCE");
    }
  }

  private scheduleNoDeltaFinalization(): void {
    if (this.noDeltaTimer) clearTimeout(this.noDeltaTimer);
    
    // noDeltaTimeout은 "provider가 한동안 아무 새 텍스트도 안 주는 상태"를 감지하는 안전장치다.
    // 단, 발화 종료 후보가 된 뒤(speechStoppedAtMs 존재)에서만 실제 finalization 쪽으로 넘긴다.
    this.noDeltaTimer = setTimeout(() => {
      if (this.active?.speechStoppedAtMs !== undefined) {
        this.scheduleGraceFinalization("NO_DELTA_TIMEOUT");
      }
    }, this.options.noDeltaTimeoutMs);
  }

  private scheduleGraceFinalization(reason: FinalizationReason): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    
    /**
     * FINALIZED 타이밍의 핵심 규칙:
     * - 무음이 감지됐다고 바로 finalize하지 않는다.
     * - provider가 늦게 보낼 마지막 completed transcript를 위해 약간 더 기다린다.
     *
     * 여기서 기다리는 시간은 translationGraceMs를 우선 사용한다.
     *
     * 이유:
     * - noDeltaTimeoutMs는 "오랫동안 텍스트 변화가 없을 때"를 잡기 위한 안전장치다.
     * - speechStoppedAtMs가 이미 찍힌 뒤에는, 문장 마감은 가능한 한 빨리 하되
     *   provider의 마지막 completed/late delta를 조금만 더 기다리는 편이 실시간성에 유리하다.
     *
     * 즉, FINALIZED 기준은 한 줄로 말하면:
     * "무음이 감지됐고, 그 뒤 grace 시간 동안 더 들어올 텍스트가 없다고 판단됐을 때"
     */
    const graceMs = Math.max(0, this.options.translationGraceMs);
    this.graceTimer = setTimeout(() => {
      this.finalizeFromTimer(reason);
    }, graceMs);
  }

  /**
   * [스트리밍 업데이트]
   *
   * 이 메서드는 DB 저장용이 아니라 화면 표시용이다.
   * 사용자는 말하는 도중에도 자막이 보이길 기대하므로,
   * delta가 들어올 때마다 현재까지의 누적 결과를 STREAMING 상태로 보낸다.
   */
  private async publishStreaming(): Promise<void> {
    const segment = this.toTranscriptSegment("STREAMING");
    if (segment.text) {
      await this.options.captionPublisher.publishCaption(segment);
    }
  }

  /**
   * [최종 확정]
   *
   * 이 메서드가 호출되는 대표 경로:
   * - stopSpeech() 이후 grace 타이머 만료
   * - noDeltaTimeout 타이머 만료
   * - maxDuration 타이머 만료
   * - 외부 flush() 강제 호출
   *
   * FINALIZED의 실질 기준:
   * 1. 현재 active 세그먼트가 존재해야 한다.
   * 2. finalizing 중이면 중복 실행하지 않는다.
   * 3. 최종적으로 조합한 segment.text가 비어 있지 않아야 한다.
   * 4. 직전 finalized와 같은 문장이 짧은 시간 창 안에 다시 나오면 중복으로 버린다.
   *
   * 통과 후 처리 순서:
   * - 먼저 화면 caption을 FINALIZED로 한 번 더 보낸다.
   * - 그 다음 RabbitMQ/Redis Stream으로 final segment를 발행한다.
   * - 이 시점부터 BE가 DB 저장을 시도할 수 있다.
   */
  private async finalize(reason: FinalizationReason): Promise<void> {
    if (!this.active || this.finalizing) return;

    this.finalizing = true;
    this.clearTimers();
    const nowMs = Date.now();
    // stopSpeech()가 호출되지 않은 경로(maxDuration, noDelta, flush 등)에서는 endedAtMs가 비어 있을 수 있다.
    // 그 경우 최종 마감 시각을 현재 시각으로 보정해 DB에 null이 남지 않도록 한다.
    if (this.active.endedAtMs === undefined) {
      this.active.endedAtMs = Math.max(
        this.active.startedAtMs,
        nowMs - this.options.meetingStartedAtMs
      );
    }
    const segment = this.trimSegmentOverlap(
      this.toTranscriptSegment("FINALIZED")
    );

    try {
      if (!segment.text) {
        this.reset();
        return;
      }

      // 같은 문장이 다른 track/source에서 거의 동시에 다시 확정되는 경우 DB와 화면 중복을 줄이기 위해 버린다.
      if (this.isDuplicateFinalSegment(segment.text)) {
        this.reset();
        return;
      }

      // 1. 화면 자막을 FINALIZED 상태로 고정한다.
      //    사용자는 이 시점부터 이 문장을 "확정 문장"으로 보게 된다.
      await this.options.captionPublisher.publishCaption(segment);
      // 2. 최종 저장 요청(RabbitMQ) 및 실시간 분석 입력(Redis Stream) 발행
      //    여기서부터는 화면 표시가 아니라 "후속 시스템이 영구 처리할 수 있는 데이터"가 된다.
      await this.options.finalSegmentPublisher.publishFinalSegment(
        segment,
        reason,
        this.options.correlationId
      );
      await this.options.captionPublisher.publishFinalSegmentDelivered?.(segment);
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
    // 현재 세그먼트를 완전히 비우지 않으면 다음 발화가 이전 텍스트 버퍼를 이어받아
    // 서로 다른 문장이 한 세그먼트처럼 합쳐지는 문제가 생긴다.
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

  /**
   * 현재 내부 active 상태를 외부 발행용 DTO(TranscriptSegment)로 변환한다.
   *
   * 여기서 buildDisplayTexts()가 최종적으로 화면/저장에 사용할 텍스트를 선택한다.
   * 즉, source/ko/en 각 버퍼를 어떻게 우선순위로 조합할지는 이 변환 시점에 확정된다.
   */
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
    // 한 세그먼트가 끝날 때 타이머를 모두 해제하지 않으면, 이미 reset된 다음 문장에
    // 예전 문장의 타이머 callback이 개입하는 race condition이 생긴다.
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
    
    // 짧은 시간(2.5초) 내에 동일한 문장이 또 FINALIZED되면,
    // 같은 공간의 여러 마이크/track가 같은 발화를 중복으로 잡은 것으로 보고 억제한다.
    // 또한 완전히 같지는 않아도 "직전 문장에 거의 포함되는 짧은 재확정"도 여기서 같이 막는다.
    const withinDuplicateWindow = nowMs - this.lastFinalizedAtMs <= 5000;
    const hasLongEnoughText = normalized.length >= 8;
    const previous = normalizeForSimilarityCheck(this.lastFinalizedText);
    const current = normalizeForSimilarityCheck(normalized);
    return (
      withinDuplicateWindow &&
      (
        this.lastFinalizedText === normalized ||
        (hasLongEnoughText &&
          (this.lastFinalizedText.includes(normalized) ||
            normalized.includes(this.lastFinalizedText))) ||
        isNearDuplicateSentence(previous, current)
      )
    );
  }

  private recordFinalizedText(text: string, nowMs = Date.now()): void {
    this.lastFinalizedText = normalizeForDuplicateCheck(text);
    this.lastFinalizedAtMs = nowMs;
  }

  /**
   * 직전 finalized 문장의 tail이 이번 문장의 head에 크게 겹치면 앞부분을 잘라낸다.
   *
   * 목적:
   * - provider가 이전 문장 일부를 다음 finalized에 다시 붙여 보내는 경우
   * - source 전환/late completed 때문에 "이전 문장 + 새 문장" 형태가 되는 경우
   *
   * 주의:
   * - 완전히 같은 문장은 isDuplicateFinalSegment()에서 먼저 걸러진다.
   * - 여기서는 "완전히 같지는 않지만 앞부분이 크게 중복되는 경우"만 정리한다.
   */
  private trimSegmentOverlap(segment: TranscriptSegment): TranscriptSegment {
    const overlap = computeOverlap(
      this.lastFinalizedText,
      segment.text
    );

    if (!overlap) {
      return segment;
    }

    return {
      ...segment,
      text: trimOverlappingPrefix(segment.text, overlap.rawPrefixLength),
      sourceText: trimOverlappingPrefix(segment.sourceText, overlap.rawPrefixLength),
      koText: trimOverlappingPrefix(segment.koText, overlap.rawPrefixLength),
      enText: trimOverlappingPrefix(segment.enText, overlap.rawPrefixLength),
      sourceTranscript: segment.sourceTranscript
        ? trimOverlappingPrefix(segment.sourceTranscript, overlap.rawPrefixLength)
        : segment.sourceTranscript,
      sourceCandidateKo: segment.sourceCandidateKo
        ? trimOverlappingPrefix(segment.sourceCandidateKo, overlap.rawPrefixLength)
        : segment.sourceCandidateKo,
      sourceCandidateEn: segment.sourceCandidateEn
        ? trimOverlappingPrefix(segment.sourceCandidateEn, overlap.rawPrefixLength)
        : segment.sourceCandidateEn,
      koTargetOutput: segment.koTargetOutput
        ? trimOverlappingPrefix(segment.koTargetOutput, overlap.rawPrefixLength)
        : segment.koTargetOutput,
      enTargetOutput: segment.enTargetOutput
        ? trimOverlappingPrefix(segment.enTargetOutput, overlap.rawPrefixLength)
        : segment.enTargetOutput
    };
  }
}

/**
 * completed transcript가 current보다 더 긴 상위 문장일 수 있으므로,
 * 둘을 비교해 더 완전한 쪽을 선택한다.
 *
 * 예:
 * - current: "오늘 배포"
 * - completed: "오늘 배포 일정"
 * -> completed 사용
 */
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

function normalizeForSimilarityCheck(text: string): string {
  return text
    .replace(/[.,!?~'"`()[\]{}:;_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type NormalizedTextWithMap = {
  normalizedText: string;
  rawPrefixLengthByNormalizedLength: number[];
};

type OverlapMatch = {
  rawPrefixLength: number;
};

function computeOverlap(
  previousText: string,
  currentText: string
): OverlapMatch | undefined {
  if (!previousText || !currentText) return undefined;

  const previous = normalizeWithMap(previousText);
  const current = normalizeWithMap(currentText);
  const normalizedOverlapLength = computeNormalizedOverlapLength(
    previous.normalizedText,
    current.normalizedText
  );

  if (!normalizedOverlapLength) {
    return undefined;
  }

  const rawPrefixLength =
    current.rawPrefixLengthByNormalizedLength[normalizedOverlapLength - 1];
  if (!rawPrefixLength) {
    return undefined;
  }

  return { rawPrefixLength };
}

function normalizeWithMap(text: string): NormalizedTextWithMap {
  let normalizedText = "";
  const rawPrefixLengthByNormalizedLength: number[] = [];
  let previousWasWhitespace = true;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (/\s/.test(character)) {
      if (previousWasWhitespace) {
        continue;
      }
      normalizedText += " ";
      rawPrefixLengthByNormalizedLength.push(index + 1);
      previousWasWhitespace = true;
      continue;
    }

    normalizedText += character;
    rawPrefixLengthByNormalizedLength.push(index + 1);
    previousWasWhitespace = false;
  }

  if (normalizedText.endsWith(" ")) {
    normalizedText = normalizedText.slice(0, -1);
    rawPrefixLengthByNormalizedLength.pop();
  }

  return {
    normalizedText,
    rawPrefixLengthByNormalizedLength
  };
}

function computeNormalizedOverlapLength(
  previousText: string,
  currentText: string
): number {
  if (!previousText || !currentText) return 0;

  const maxCandidate = Math.min(previousText.length, currentText.length);
  const minimumOverlap = Math.max(4, Math.floor(currentText.length / 2));
  for (let length = maxCandidate; length >= minimumOverlap; length -= 1) {
    if (previousText.slice(-length) === currentText.slice(0, length)) {
      return length;
    }
  }

  return 0;
}

function trimOverlappingPrefix(text: string, overlapLength: number): string {
  if (!text) return text;
  return text.slice(overlapLength).trimStart();
}

function isNearDuplicateSentence(previousText: string, currentText: string): boolean {
  if (!previousText || !currentText) return false;
  if (previousText === currentText) return true;
  if (previousText.includes(currentText) || currentText.includes(previousText)) return true;

  const overlapLength = computeNormalizedOverlapLength(previousText, currentText);
  const shorterLength = Math.min(previousText.length, currentText.length);
  if (shorterLength >= 8 && overlapLength >= Math.floor(shorterLength * 0.7)) {
    return true;
  }

  const previousTokens = previousText.split(" ");
  const currentTokens = currentText.split(" ");
  const sharedTokenCount = currentTokens.filter((token) => previousTokens.includes(token)).length;
  return currentTokens.length >= 3 && sharedTokenCount >= Math.ceil(currentTokens.length * 0.8);
}

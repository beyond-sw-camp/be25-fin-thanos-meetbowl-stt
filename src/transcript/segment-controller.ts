import { randomUUID } from "node:crypto";

import { buildDisplayTexts } from "./display-text-builder.js";
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
  meetingId: string;
  sessionId: string;
  organizationId: string;
  participantUserIds: string[];
  meetingStartedAtMs: number;
  noDeltaTimeoutMs: number;
  translationGraceMs: number;
  maxSegmentDurationMs: number;
  nextSequence: () => number;
  captionPublisher: CaptionPublisher;
  finalSegmentPublisher: FinalSegmentPublisher;
  correlationId: string;
  onFinalizationError?: (
    error: Error,
    segmentId: string,
    reason: FinalizationReason
  ) => void;
}

type TranscriptChannel =
  | "sourceTranscript"
  | "sourceCandidateKo"
  | "sourceCandidateEn"
  | "koTargetOutput"
  | "enTargetOutput";

export class SegmentController {
  // active segment는 지금 말하고 있는 한 발화를 나타낸다.
  private active?: ActiveTranscriptSegment;
  // sequence는 세션 전체에서 transcript ordering을 유지하기 위한 단조 증가 번호다.
  private sequence?: number;
  // 같은 세그먼트에 대한 streaming/final 이벤트를 너무 자주 내보내지 않기 위한 타이머들이다.
  private noDeltaTimer?: NodeJS.Timeout;
  private maxDurationTimer?: NodeJS.Timeout;
  private graceTimer?: NodeJS.Timeout;
  // finalizing 중에는 중복 flush가 들어와도 같은 segment를 두 번 내보내지 않는다.
  private finalizing = false;

  constructor(private readonly options: SegmentControllerOptions) {}

  startSpeech(nowMs = Date.now()): void {
    if (this.active) {
      return;
    }
    // 새 발화가 시작되면 segmentId/sequence를 새로 발급하고 기준 시간을 초기화한다.
    this.sequence = this.options.nextSequence();
    this.active = {
      segmentId: randomUUID(),
      meetingId: this.options.meetingId,
      sessionId: this.options.sessionId,
      organizationId: this.options.organizationId,
      participantUserIds: this.options.participantUserIds,
      startedAtMs: Math.max(0, nowMs - this.options.meetingStartedAtMs),
      sourceTranscript: "",
      sourceCandidateKo: "",
      sourceCandidateEn: "",
      koTargetOutput: "",
      enTargetOutput: "",
      lastDeltaAtMs: nowMs
    };
    // 최대 길이를 넘기면 무음이 없어도 안전하게 세그먼트를 마감한다.
    this.maxDurationTimer = setTimeout(() => {
      this.finalizeFromTimer("MAX_DURATION");
    }, this.options.maxSegmentDurationMs);
  }

  stopSpeech(nowMs = Date.now()): void {
    if (!this.active) {
      return;
    }
    // VAD가 발화 종료를 판단한 시점의 상대 시간을 기록해 finalization reason을 남긴다.
    this.active.endedAtMs = Math.max(
      this.active.startedAtMs,
      nowMs - this.options.meetingStartedAtMs
    );
    this.active.speechStoppedAtMs = nowMs;
    // 바로 종료하지 않고 grace timer를 둬 completed transcript가 뒤늦게 와도 흡수한다.
    this.scheduleGraceFinalization("VAD_SILENCE");
  }

  replaceSourceTranscript(transcript: string, nowMs = Date.now()): void {
    const normalized = transcript.trim();
    if (!normalized) {
      return;
    }
    if (!this.active) {
      // completed transcript가 먼저 오는 특이 케이스도 있으므로 발화 세그먼트를 열어준다.
      this.startSpeech(nowMs);
    }
    const active = this.active;
    if (!active) {
      return;
    }
    active.sourceTranscript = mergeCompletedTranscript(
      active.sourceTranscript,
      normalized
    );
    active.lastDeltaAtMs = nowMs;
    this.scheduleNoDeltaFinalization();
    if (active.speechStoppedAtMs !== undefined) {
      this.scheduleGraceFinalization("VAD_SILENCE");
    }
    void this.publishStreaming();
  }

  appendDelta(
    channel: TranscriptChannel,
    delta: string,
    nowMs = Date.now()
  ): void {
    if (!delta) {
      return;
    }
    if (!this.active) {
      // delta가 먼저 도착해도 같은 발화로 처리할 수 있게 세그먼트를 연다.
      this.startSpeech(nowMs);
    }
    const active = this.active;
    if (!active) {
      return;
    }
    active[channel] += delta;
    active.lastDeltaAtMs = nowMs;
    this.scheduleNoDeltaFinalization();
    if (active.speechStoppedAtMs !== undefined) {
      this.scheduleGraceFinalization("VAD_SILENCE");
    }
    void this.publishStreaming();
  }

  async flush(reason: FinalizationReason): Promise<void> {
    // 외부 stop/flush API는 여기로 모이고, 최종 발행 순서는 finalize에서 통제한다.
    await this.finalize(reason);
  }

  hasActiveSegment(): boolean {
    return this.active !== undefined;
  }

  private scheduleNoDeltaFinalization(): void {
    if (this.noDeltaTimer) {
      clearTimeout(this.noDeltaTimer);
    }
    // delta가 더 이상 오지 않는데 이미 speechStopped 상태라면 finalization을 예약한다.
    this.noDeltaTimer = setTimeout(() => {
      if (this.active?.speechStoppedAtMs !== undefined) {
        this.scheduleGraceFinalization("NO_DELTA_TIMEOUT");
      }
    }, this.options.noDeltaTimeoutMs);
  }

  private scheduleGraceFinalization(reason: FinalizationReason): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
    }
    // completed transcript가 늦게 도착하는 provider 특성을 감안해 grace 기간을 둔다.
    const graceMs = Math.max(
      this.options.translationGraceMs,
      this.options.noDeltaTimeoutMs
    );
    this.graceTimer = setTimeout(() => {
      this.finalizeFromTimer(reason);
    }, graceMs);
  }

  private async publishStreaming(): Promise<void> {
    // STREAMING은 아직 말하는 중인 화면 갱신용으로만 쓰고, text가 없으면 발행하지 않는다.
    const segment = this.toTranscriptSegment("STREAMING");
    if (segment.text) {
      await this.options.captionPublisher.publishCaption(segment);
    }
  }

  private async finalize(reason: FinalizationReason): Promise<void> {
    if (!this.active || this.finalizing) {
      return;
    }
    // finalize가 겹치면 같은 segment를 중복 발행할 수 있으므로 잠금 플래그를 건다.
    this.finalizing = true;
    this.clearTimers();
    const segment = this.toTranscriptSegment("FINALIZED");

    try {
      if (!segment.text) {
        // 실제 텍스트가 없는 segment는 버리고 상태만 초기화한다.
        this.active = undefined;
        this.sequence = undefined;
        return;
      }
      // caption.updated FINALIZED를 먼저 내보내 화면이 최종 문장으로 고정되게 한다.
      await this.options.captionPublisher.publishCaption(segment);
      // 이후 RabbitMQ/Redis 같은 final segment sink로 전달한다.
      await this.options.finalSegmentPublisher.publishFinalSegment(
        segment,
        reason,
        this.options.correlationId
      );
      this.active = undefined;
      this.sequence = undefined;
    } finally {
      this.finalizing = false;
    }
  }

  private finalizeFromTimer(reason: FinalizationReason): void {
    // timer callback에서는 throw를 직접 올리지 않고 onFinalizationError 훅으로만 전달한다.
    void this.finalize(reason).catch((error) => {
      const active = this.active;
      this.options.onFinalizationError?.(
        error instanceof Error ? error : new Error(String(error)),
        active?.segmentId ?? "unknown",
        reason
      );
    });
  }

  private toTranscriptSegment(
    status: TranscriptSegment["status"]
  ): TranscriptSegment {
    const active = this.active;
    if (!active || this.sequence === undefined) {
      throw new Error("Cannot build transcript without an active segment");
    }
    // display builder가 고른 텍스트를 primary text/sourceText에 반영하고, 원본 후보는 그대로 보존한다.
    const display = buildDisplayTexts(active);
    return {
      segmentId: active.segmentId,
      meetingId: active.meetingId,
      sessionId: active.sessionId,
      organizationId: active.organizationId,
      participantUserIds: active.participantUserIds,
      sequence: this.sequence,
      startedAtMs: active.startedAtMs,
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
    // 세그먼트가 끝나면 관련 타이머를 모두 해제해 다음 발화에 영향이 남지 않게 한다.
    if (this.noDeltaTimer) {
      clearTimeout(this.noDeltaTimer);
    }
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
    }
    this.noDeltaTimer = undefined;
    this.maxDurationTimer = undefined;
    this.graceTimer = undefined;
  }
}

function mergeCompletedTranscript(
  currentTranscript: string,
  completedTranscript: string
): string {
  const current = currentTranscript.trim();
  const completed = completedTranscript.trim();

  if (!current) {
    // 이전 delta가 없으면 completed를 그대로 사용한다.
    return completed;
  }
  if (!completed) {
    // completed가 비어 있으면 기존 누적 원문을 유지한다.
    return current;
  }
  if (completed.includes(current)) {
    // completed가 더 완전한 경우에는 completed로 교체한다.
    return completed;
  }
  if (current.includes(completed)) {
    // completed가 앞부분만 잘라서 온 경우에는 기존 원문을 유지한다.
    return current;
  }

  // Provider completion can omit a prefix already delivered through deltas.
  // 둘 다 완전하지 않으면 길이 기준으로 더 완전해 보이는 문자열을 택한다.
  return completed.length < current.length * 0.85 ? current : completed;
}

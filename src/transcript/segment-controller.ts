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
  meetingStartedAtMs: number;
  noDeltaTimeoutMs: number;
  translationGraceMs: number;
  maxSegmentDurationMs: number;
  nextSequence: () => number;
  captionPublisher: CaptionPublisher;
  finalSegmentPublisher: FinalSegmentPublisher;
  correlationId: string;
}

type TranscriptChannel =
  | "sourceCandidateKo"
  | "sourceCandidateEn"
  | "koTargetOutput"
  | "enTargetOutput";

export class SegmentController {
  private active?: ActiveTranscriptSegment;
  private sequence?: number;
  private noDeltaTimer?: NodeJS.Timeout;
  private maxDurationTimer?: NodeJS.Timeout;
  private graceTimer?: NodeJS.Timeout;
  private finalizing = false;

  constructor(private readonly options: SegmentControllerOptions) {}

  startSpeech(nowMs = Date.now()): void {
    if (this.active) {
      return;
    }
    this.sequence = this.options.nextSequence();
    this.active = {
      segmentId: randomUUID(),
      meetingId: this.options.meetingId,
      sessionId: this.options.sessionId,
      startedAtMs: Math.max(0, nowMs - this.options.meetingStartedAtMs),
      sourceCandidateKo: "",
      sourceCandidateEn: "",
      koTargetOutput: "",
      enTargetOutput: "",
      lastDeltaAtMs: nowMs
    };
    this.maxDurationTimer = setTimeout(() => {
      void this.finalize("MAX_DURATION");
    }, this.options.maxSegmentDurationMs);
  }

  stopSpeech(nowMs = Date.now()): void {
    if (!this.active) {
      return;
    }
    this.active.endedAtMs = Math.max(
      this.active.startedAtMs,
      nowMs - this.options.meetingStartedAtMs
    );
    this.active.speechStoppedAtMs = nowMs;
    this.scheduleGraceFinalization("VAD_SILENCE");
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
    await this.finalize(reason);
  }

  hasActiveSegment(): boolean {
    return this.active !== undefined;
  }

  private scheduleNoDeltaFinalization(): void {
    if (this.noDeltaTimer) {
      clearTimeout(this.noDeltaTimer);
    }
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
    this.graceTimer = setTimeout(() => {
      void this.finalize(reason);
    }, this.options.translationGraceMs);
  }

  private async publishStreaming(): Promise<void> {
    const segment = this.toTranscriptSegment("STREAMING");
    if (segment.sourceText || segment.koText || segment.enText) {
      await this.options.captionPublisher.publishCaption(segment);
    }
  }

  private async finalize(reason: FinalizationReason): Promise<void> {
    if (!this.active || this.finalizing) {
      return;
    }
    this.finalizing = true;
    this.clearTimers();
    const segment = this.toTranscriptSegment("FINALIZED");

    try {
      if (!segment.sourceText) {
        return;
      }
      await this.options.captionPublisher.publishCaption(segment);
      await this.options.finalSegmentPublisher.publishFinalSegment(
        segment,
        reason,
        this.options.correlationId
      );
    } finally {
      this.active = undefined;
      this.sequence = undefined;
      this.finalizing = false;
    }
  }

  private toTranscriptSegment(
    status: TranscriptSegment["status"]
  ): TranscriptSegment {
    const active = this.active;
    if (!active || this.sequence === undefined) {
      throw new Error("Cannot build transcript without an active segment");
    }
    const display = buildDisplayTexts(active);
    return {
      segmentId: active.segmentId,
      meetingId: active.meetingId,
      sessionId: active.sessionId,
      sequence: this.sequence,
      startedAtMs: active.startedAtMs,
      endedAtMs: active.endedAtMs,
      sourceLanguage: display.sourceLanguage,
      sourceText: display.sourceText,
      koText: display.koText,
      enText: display.enText,
      status
    };
  }

  private clearTimers(): void {
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

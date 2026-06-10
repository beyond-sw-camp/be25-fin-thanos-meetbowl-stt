import {
  AudioStream,
  type RemoteAudioTrack
} from "@livekit/rtc-node";

import type { TranslationProvider } from "../providers/translation-provider.js";
import { EnergyVad } from "../transcript/energy-vad.js";
import type {
  CaptionPublisher,
  FinalSegmentPublisher
} from "../transcript/segment-publisher.js";
import { SegmentController } from "../transcript/segment-controller.js";
import type { FinalizationReason } from "../transcript/transcript-types.js";

export interface PipelineLogger {
  info(values: Record<string, unknown>, message: string): void;
  warn(values: Record<string, unknown>, message: string): void;
  error(values: Record<string, unknown>, message: string): void;
}

export interface ParticipantAudioPipelineOptions {
  meetingId: string;
  sessionId: string;
  correlationId: string;
  participantIdentity: string;
  trackSid: string;
  track: RemoteAudioTrack;
  meetingStartedAtMs: number;
  nextSequence: () => number;
  translationProvider: TranslationProvider;
  captionPublisher: CaptionPublisher;
  finalSegmentPublisher: FinalSegmentPublisher;
  rmsThreshold: number;
  silenceMs: number;
  noDeltaTimeoutMs: number;
  translationGraceMs: number;
  maxSegmentDurationMs: number;
  logger: PipelineLogger;
}

export class ParticipantAudioPipeline {
  private readonly abortController = new AbortController();
  private readonly vad: EnergyVad;
  private readonly segmentController: SegmentController;
  private readonly koSession;
  private readonly enSession;
  private runningTask?: Promise<void>;

  constructor(private readonly options: ParticipantAudioPipelineOptions) {
    this.vad = new EnergyVad({
      rmsThreshold: options.rmsThreshold,
      silenceMs: options.silenceMs
    });
    this.segmentController = new SegmentController({
      meetingId: options.meetingId,
      sessionId: options.sessionId,
      meetingStartedAtMs: options.meetingStartedAtMs,
      noDeltaTimeoutMs: options.noDeltaTimeoutMs,
      translationGraceMs: options.translationGraceMs,
      maxSegmentDurationMs: options.maxSegmentDurationMs,
      nextSequence: options.nextSequence,
      captionPublisher: options.captionPublisher,
      finalSegmentPublisher: options.finalSegmentPublisher,
      correlationId: options.correlationId
    });
    this.koSession = options.translationProvider.createSession("ko", {
      onSourceDelta: (delta) =>
        this.segmentController.appendDelta("sourceCandidateKo", delta),
      onTranslationDelta: (delta) =>
        this.segmentController.appendDelta("koTargetOutput", delta),
      onError: (error) => this.handleProviderError("ko", error)
    });
    this.enSession = options.translationProvider.createSession("en", {
      onSourceDelta: (delta) =>
        this.segmentController.appendDelta("sourceCandidateEn", delta),
      onTranslationDelta: (delta) =>
        this.segmentController.appendDelta("enTargetOutput", delta),
      onError: (error) => this.handleProviderError("en", error)
    });
  }

  async start(): Promise<void> {
    try {
      await Promise.all([this.koSession.connect(), this.enSession.connect()]);
      this.runningTask = this.readAudio();
      this.options.logger.info(
        {
          meetingId: this.options.meetingId,
          sessionId: this.options.sessionId,
          trackSid: this.options.trackSid
        },
        "participant audio pipeline started"
      );
    } catch (error) {
      await Promise.allSettled([
        this.koSession.close(),
        this.enSession.close()
      ]);
      throw error;
    }
  }

  async stop(reason: FinalizationReason): Promise<void> {
    this.abortController.abort();
    await Promise.allSettled([this.koSession.close(), this.enSession.close()]);
    await this.runningTask;
    await this.segmentController.flush(reason);
    this.options.logger.info(
      {
        meetingId: this.options.meetingId,
        sessionId: this.options.sessionId,
        trackSid: this.options.trackSid
      },
      "participant audio pipeline stopped"
    );
  }

  async flush(reason: FinalizationReason): Promise<void> {
    await this.segmentController.flush(reason);
  }

  private async readAudio(): Promise<void> {
    const stream = new AudioStream(this.options.track, {
      sampleRate: 24000,
      numChannels: 1,
      frameSizeMs: 20
    });
    const reader = stream.getReader();
    const handleAbort = () => {
      void reader.cancel();
    };
    this.abortController.signal.addEventListener("abort", handleAbort, {
      once: true
    });

    try {
      while (!this.abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const nowMs = Date.now();
        const vad = this.vad.update(value.data, nowMs);
        if (vad.speechStarted) {
          this.segmentController.startSpeech(nowMs);
        }
        this.koSession.appendAudio(value.data);
        this.enSession.appendAudio(value.data);
        if (vad.speechStopped) {
          this.segmentController.stopSpeech(nowMs);
        }
      }
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        this.options.logger.error(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            trackSid: this.options.trackSid,
            error: error instanceof Error ? error.message : String(error)
          },
          "participant audio stream failed"
        );
      }
    } finally {
      this.abortController.signal.removeEventListener("abort", handleAbort);
      reader.releaseLock();
    }
  }

  private handleProviderError(
    targetLanguage: "ko" | "en",
    error: Error
  ): void {
    this.options.logger.warn(
      {
        meetingId: this.options.meetingId,
        sessionId: this.options.sessionId,
        trackSid: this.options.trackSid,
        targetLanguage,
        error: error.message
      },
      "translation provider degraded"
    );
  }
}

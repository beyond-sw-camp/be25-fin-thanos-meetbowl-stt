import {
  AudioStream,
  type RemoteAudioTrack
} from "@livekit/rtc-node";

import type {
  TranscriptionProvider,
  TranslationProvider
} from "../providers/translation-provider.js";
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
  transcriptionProvider: TranscriptionProvider;
  enableTranslation: boolean;
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
  private readonly transcriptionSession;
  private translationEnabled = false;
  private transcriptionEnabled = false;
  private transcriptionAudioFrames = 0;
  private translationAudioFrames = 0;
  private sawTranscriptDelta = false;
  private sawTranscriptCompleted = false;
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
      // 한국어 표시용 세션의 원문 후보를 누적한다.
      onSourceDelta: (delta) =>
        this.segmentController.appendDelta("sourceCandidateKo", delta),
      // 영어 음성을 한국어 화면 문장으로 바꿔 쌓는다.
      onTranslationDelta: (delta) =>
        this.segmentController.appendDelta("koTargetOutput", delta),
      onError: (error) => this.handleProviderError("ko", error)
    });
    this.enSession = options.translationProvider.createSession("en", {
      // 영어 표시용 세션의 원문 후보를 누적한다.
      onSourceDelta: (delta) =>
        this.segmentController.appendDelta("sourceCandidateEn", delta),
      // 한국어 음성을 영어 화면 문장으로 바꿔 쌓는다.
      onTranslationDelta: (delta) =>
        this.segmentController.appendDelta("enTargetOutput", delta),
      onError: (error) => this.handleProviderError("en", error)
    });
    this.transcriptionSession = options.transcriptionProvider.createSession({
      // transcription 전용 세션의 원문 delta를 canonical source로 누적한다.
      onTranscriptDelta: (delta) => {
        this.sawTranscriptDelta = true;
        this.segmentController.appendDelta("sourceTranscript", delta);
      },
      // completed transcript가 오면 최종 원문으로 덮어쓴다.
      onTranscriptCompleted: (transcript) => {
        this.sawTranscriptCompleted = true;
        this.segmentController.replaceSourceTranscript(transcript);
      },
      onError: (error) => this.handleProviderError("source", error)
    });
  }

  async start(): Promise<void> {
    try {
      try {
        await this.transcriptionSession.connect();
        this.transcriptionEnabled = true;
        this.options.logger.info(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            trackSid: this.options.trackSid
          },
          "source transcription session connected"
        );
      } catch (error) {
        this.transcriptionEnabled = false;
        this.options.logger.warn(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            trackSid: this.options.trackSid,
            error: error instanceof Error ? error.message : String(error)
          },
          "source transcription provider unavailable, continuing without source transcript"
        );
      }

      const shouldEnableTranslation =
        this.options.enableTranslation || !this.transcriptionEnabled;
      if (shouldEnableTranslation) {
        try {
          await Promise.all([this.koSession.connect(), this.enSession.connect()]);
          this.translationEnabled = true;
        } catch (error) {
          this.translationEnabled = false;
          this.options.logger.warn(
            {
              meetingId: this.options.meetingId,
              sessionId: this.options.sessionId,
              trackSid: this.options.trackSid,
              error: error instanceof Error ? error.message : String(error)
            },
            "translation provider unavailable, continuing without translation output"
          );
        }
      } else {
        this.translationEnabled = false;
        this.options.logger.info(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            trackSid: this.options.trackSid
          },
          "translation disabled, running in transcription-only mode"
        );
      }
      this.runningTask = this.readAudio();
      this.options.logger.info(
        {
          meetingId: this.options.meetingId,
          sessionId: this.options.sessionId,
          trackSid: this.options.trackSid,
          transcriptionEnabled: this.transcriptionEnabled,
          translationEnabled: this.translationEnabled
        },
        "participant audio pipeline started"
      );
    } catch (error) {
      await Promise.allSettled([
        this.koSession.close(),
        this.enSession.close(),
        this.transcriptionSession.close()
      ]);
      throw error;
    }
  }

  async stop(reason: FinalizationReason): Promise<void> {
    this.abortController.abort();
    if (this.transcriptionEnabled) {
      this.transcriptionSession.commitAudio();
    }
    await Promise.allSettled([
      this.koSession.close(),
      this.enSession.close(),
      this.transcriptionSession.close()
    ]);
    await this.runningTask;
    await this.segmentController.flush(reason);
    this.options.logger.info(
      {
        meetingId: this.options.meetingId,
        sessionId: this.options.sessionId,
        trackSid: this.options.trackSid,
        transcriptionEnabled: this.transcriptionEnabled,
        translationEnabled: this.translationEnabled,
        transcriptionAudioFrames: this.transcriptionAudioFrames,
        translationAudioFrames: this.translationAudioFrames,
        sawTranscriptDelta: this.sawTranscriptDelta,
        sawTranscriptCompleted: this.sawTranscriptCompleted
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
        // transcription을 우선으로 보내고, translation은 옵션으로 덧붙인다.
        const vad = this.vad.update(value.data, nowMs);
        if (vad.speechStarted) {
          this.segmentController.startSpeech(nowMs);
        }
        if (this.transcriptionEnabled) {
          if (this.transcriptionAudioFrames === 0) {
            this.options.logger.info(
              {
                meetingId: this.options.meetingId,
                sessionId: this.options.sessionId,
                trackSid: this.options.trackSid
              },
              "first audio frame forwarded to source transcription"
            );
          }
          this.transcriptionAudioFrames += 1;
          this.transcriptionSession.appendAudio(value.data);
        }
        if (this.translationEnabled) {
          if (this.translationAudioFrames === 0) {
            this.options.logger.info(
              {
                meetingId: this.options.meetingId,
                sessionId: this.options.sessionId,
                trackSid: this.options.trackSid
              },
              "first audio frame forwarded to translation"
            );
          }
          this.translationAudioFrames += 1;
          this.koSession.appendAudio(value.data);
          this.enSession.appendAudio(value.data);
        }
        if (vad.speechStopped) {
          if (this.transcriptionEnabled) {
            this.transcriptionSession.commitAudio();
          }
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
    targetLanguage: "ko" | "en" | "source",
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
      "stt provider degraded"
    );
  }
}

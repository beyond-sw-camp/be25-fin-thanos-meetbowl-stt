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
  organizationId: string;
  participantUserIds: string[];
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
  // 읽기 루프를 외부 stop 호출로 끊을 수 있도록 abort signal을 둔다.
  private readonly abortController = new AbortController();
  // VAD는 발화 경계, SegmentController는 발화 세그먼트와 event 발행 경계를 담당한다.
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
    // 에너지 기반 VAD는 "말하기 시작/멈춤"만 판단하고, 실제 텍스트는 provider가 만든다.
    this.vad = new EnergyVad({
      rmsThreshold: options.rmsThreshold,
      silenceMs: options.silenceMs
    });
    // SegmentController는 provider delta를 받아 caption.updated와 final transcript를 정리한다.
    this.segmentController = new SegmentController({
      meetingId: options.meetingId,
      sessionId: options.sessionId,
      organizationId: options.organizationId,
      participantUserIds: options.participantUserIds,
      meetingStartedAtMs: options.meetingStartedAtMs,
      noDeltaTimeoutMs: options.noDeltaTimeoutMs,
      translationGraceMs: options.translationGraceMs,
      maxSegmentDurationMs: options.maxSegmentDurationMs,
      nextSequence: options.nextSequence,
      captionPublisher: options.captionPublisher,
      finalSegmentPublisher: options.finalSegmentPublisher,
      correlationId: options.correlationId,
      onFinalizationError: (error, segmentId, reason) => {
        this.options.logger.error(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            trackSid: this.options.trackSid,
            segmentId,
            reason,
            error: error.message
          },
          "segment finalization failed; active segment retained for flush retry"
        );
      }
    });
    // 한국어 세션은 한국어 음성에 대한 원문 후보와 번역 후보를 누적한다.
    this.koSession = options.translationProvider.createSession("ko", {
      // 한국어 표시용 세션의 원문 후보를 누적한다.
      onSourceDelta: (delta) =>
        this.segmentController.appendDelta("sourceCandidateKo", delta),
      // 영어 음성을 한국어 화면 문장으로 바꿔 쌓는다.
      onTranslationDelta: (delta) =>
        this.segmentController.appendDelta("koTargetOutput", delta),
      onError: (error) => this.handleProviderError("ko", error)
    });
    // 영어 세션은 영어 음성에 대한 원문 후보와 번역 후보를 누적한다.
    this.enSession = options.translationProvider.createSession("en", {
      // 영어 표시용 세션의 원문 후보를 누적한다.
      onSourceDelta: (delta) =>
        this.segmentController.appendDelta("sourceCandidateEn", delta),
      // 한국어 음성을 영어 화면 문장으로 바꿔 쌓는다.
      onTranslationDelta: (delta) =>
        this.segmentController.appendDelta("enTargetOutput", delta),
      onError: (error) => this.handleProviderError("en", error)
    });
    // source transcription 세션은 canonical source transcript를 담당한다.
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
      // 먼저 source transcription 연결을 시도하고, 실패하면 translation-only 모드로 내려간다.
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
        // transcription이 살아 있으면 translation은 비용 절감을 위해 끈다.
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
    // 더 이상의 audio frame 유입을 막기 위해 read loop를 먼저 종료한다.
    this.abortController.abort();
    await this.runningTask;
    if (this.transcriptionEnabled) {
      // provider가 남겨둔 마지막 turn을 flush하려면 commit이 먼저 필요하다.
      this.transcriptionSession.commitAudio();
      // completed transcript가 도착할 시간을 약간 주지 않으면 마지막 발화가 잘릴 수 있다.
      await delay(this.options.translationGraceMs);
    }
    // provider close는 best-effort로 처리하고, 그 다음 최종 segment flush를 시도한다.
    // 이 순서를 지키면 provider가 늦게 내놓는 completed delta를 최대한 흡수할 수 있다.
    const providerCloseResults = await Promise.allSettled([
      this.koSession.close(),
      this.enSession.close(),
      this.transcriptionSession.close()
    ]);
    try {
      // stop 시점의 마지막 세그먼트를 final 상태로 내보낸다.
      await this.segmentController.flush(reason);
    } catch (error) {
      this.options.logger.warn(
        {
          meetingId: this.options.meetingId,
          sessionId: this.options.sessionId,
          trackSid: this.options.trackSid,
          error: error instanceof Error ? error.message : String(error)
        },
        "last segment flush failed; retrying once"
      );
      await delay(100);
      await this.segmentController.flush(reason);
    }
    const providerCloseFailures = providerCloseResults.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected"
    );
    if (providerCloseFailures.length > 0) {
      this.options.logger.warn(
        {
          meetingId: this.options.meetingId,
          sessionId: this.options.sessionId,
          trackSid: this.options.trackSid,
          failureCount: providerCloseFailures.length
        },
        "one or more STT provider sessions failed to close cleanly"
      );
    }
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
    // LiveKit 오디오 트랙을 provider가 읽기 쉬운 24kHz mono PCM 스트림으로 변환한다.
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
        // VAD는 말의 시작/끝만 판단하고, 텍스트 누적은 provider callback으로 수행한다.
        // transcription을 우선으로 보내고, translation은 옵션으로 덧붙인다.
        const vad = this.vad.update(value.data, nowMs);
        if (vad.speechStarted) {
          // 발화가 시작되면 segment를 열어 이후 delta를 같은 세그먼트로 묶는다.
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
            // 발화 종료 시 provider commit을 해 completed transcript를 유도한다.
            this.transcriptionSession.commitAudio();
          }
          // VAD 종료는 segment controller 입장에서는 발화 종료 신호다.
          // 무음이 잠깐 있어도 grace timer가 있기 때문에 바로 final은 하지 않는다.
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
    // provider 오류가 곧바로 전체 세션 종료는 아니다. degraded 상태로만 남긴다.
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * 개별 참가자의 오디오 트랙 중 실제로 STT에 전달하기로 선택된 프레임만 처리하는 파이프라인 클래스입니다.
 * 오디오 프레임 읽기는 상위 세션이 담당하며, 이 클래스는 선택된 입력만 받아 VAD(음성 활동 감지) 및 STT 엔진에 전달합니다.
 */

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
  /** 정보성 로그를 남깁니다. 정상 흐름 추적과 성능 측정에 사용합니다. */
  info(values: Record<string, unknown>, message: string): void;
  /** 경고 로그를 남깁니다. 기능은 계속 동작하지만 추적이 필요한 상태에 사용합니다. */
  warn(values: Record<string, unknown>, message: string): void;
  /** 오류 로그를 남깁니다. provider 장애나 예외 상황 기록에 사용합니다. */
  error(values: Record<string, unknown>, message: string): void;
}

export interface ParticipantAudioPipelineOptions {
  /** 현재 STT 세션이 속한 회의 ID입니다. 로그, 이벤트, 발행 payload의 공통 기준값입니다. */
  meetingId: string;
  /** 회의 안에서 현재 STT runtime 인스턴스를 식별하는 세션 ID입니다. */
  sessionId: string;
  /** FE -> BE -> STT까지 이어지는 요청 흐름 추적용 상관관계 ID입니다. */
  organizationId: string;
  participantUserIds: string[];
  correlationId: string;
  /** 회의 STT 런타임이 시작된 절대 시각입니다. 자막 startedAtMs 계산의 기준이 됩니다. */
  meetingStartedAtMs: number;
  /** 새 자막 세그먼트가 열릴 때 사용할 순번을 공급하는 콜백입니다. */
  nextSequence: () => number;
  /** 한국어/영어 번역 세션을 생성하는 translation provider 팩토리입니다. */
  translationProvider: TranslationProvider;
  /** 원문 전사 세션을 생성하는 transcription provider 팩토리입니다. */
  transcriptionProvider: TranscriptionProvider;
  /** 번역 세션을 실제로 붙일지 결정하는 플래그입니다. */
  enableTranslation: boolean;
  /** LiveKit DataChannel로 streaming/final caption을 보내는 발행기입니다. */
  captionPublisher: CaptionPublisher;
  /** finalized segment를 RabbitMQ/Redis Stream으로 내보내는 발행기입니다. */
  finalSegmentPublisher: FinalSegmentPublisher;
  /** 이 값 이상인 프레임을 "실제 말소리"로 간주하는 RMS 임계값입니다. */
  rmsThreshold: number;
  /** 마지막 목소리 이후 얼마 동안 조용해야 발화 종료로 볼지 정하는 시간(ms)입니다. */
  silenceMs: number;
  /** delta가 한동안 오지 않을 때 세그먼트를 강제로 마감하기 위한 안전장치 시간(ms)입니다. */
  noDeltaTimeoutMs: number;
  /** provider가 늦게 보내는 마지막 텍스트 조각을 흡수하기 위해 잠깐 기다리는 시간(ms)입니다. */
  translationGraceMs: number;
  /** 한 세그먼트가 너무 길어질 때 강제로 끊는 최대 길이(ms)입니다. */
  maxSegmentDurationMs: number;
  /** 파이프라인 내부 상태와 오류를 남길 로거입니다. */
  logger: PipelineLogger;
}

export class ParticipantAudioPipeline {
  /** 에너지 기반 음성 활동 감지기(VAD)입니다. 물리적 소리 크기를 분석하여 화자 활동을 감지합니다. */
  private readonly vad: EnergyVad;
  /** 자막 세그먼트의 생명주기와 텍스트 조각(Delta) 누적을 제어하는 핵심 로직 객체입니다. */
  private readonly segmentController: SegmentController;
  /** OpenAI Realtime API를 사용한 한국어 분석 세션입니다. */
  private readonly koSession;
  /** OpenAI Realtime API를 사용한 영어 분석 세션입니다. */
  private readonly enSession;
  /** 핵심 전사(STT) 결과를 추출하기 위한 메인 전사 엔진 세션입니다. */
  private readonly transcriptionSession;

  /** 번역 provider 연결이 현재 살아 있는지 나타냅니다. */
  private translationEnabled = false;
  /** 원문 transcription provider 연결이 현재 살아 있는지 나타냅니다. */
  private transcriptionEnabled = false;
  /** 세션 시작 이후 transcription provider에 넣은 오디오 프레임 개수입니다. */
  private transcriptionAudioFrames = 0;
  /** 세션 시작 이후 translation provider에 넣은 오디오 프레임 개수입니다. */
  private translationAudioFrames = 0;
  /** 현재 발화가 시작된 시스템 시각을 기록하여 분석 지연 시간을 추적합니다. */
  private activeSpeechStartedAtMs?: number;

  /** 현재 이 파이프라인이 분석 중인 참가자의 고유 식별자입니다. */
  private activeParticipantIdentity?: string;
  /** 현재 이 파이프라인에 바인딩된 오디오 트랙의 고유 SID입니다. */
  private activeTrackSid?: string;

  constructor(private readonly options: ParticipantAudioPipelineOptions) {
    this.vad = new EnergyVad({
      rmsThreshold: options.rmsThreshold,
      silenceMs: options.silenceMs
    });

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
      logger: options.logger,
      onFinalizationError: (error, segmentId, reason) => {
        this.options.logger.error(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            segmentId,
            reason,
            error: error.message
          },
          "자막 세그먼트 최종 확정 과정에서 오류 발생"
        );
      }
    });

    /**
     * 번역 세션 2개는 "원문 후보"와 "목표 언어 출력"을 각각 보조 데이터로 쌓습니다.
     *
     * 현재 화면 기준 원문 자막은 transcriptionSession이 우선이지만,
     * transcription provider가 늦거나 실패할 때는 translation source delta가 보조 근거가 됩니다.
     */
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

    /**
     * 원문 transcription 세션은 최종적으로 화면에 보여줄 `text`의 1순위 데이터 소스입니다.
     * delta는 빠른 STREAMING 표시용, completed는 더 정확한 FINALIZED 보정용으로 사용합니다.
     */
    this.transcriptionSession = options.transcriptionProvider.createSession({
      onTranscriptDelta: (delta) => {
        this.segmentController.appendDelta("sourceTranscript", delta);
      },
      onTranscriptCompleted: (transcript) => {
        this.segmentController.replaceSourceTranscript(transcript);
      },
      onError: (error) => this.handleProviderError("source", error)
    });
  }

  /**
   * [파이프라인 초기화] 외부 STT 및 번역 엔진과의 실시간 스트리밍 연결을 수립합니다.
   * 일부 엔진 연결에 실패하더라도 서비스가 중단되지 않도록 탄력적으로 구성되어 있습니다.
   */
  async start(): Promise<void> {
    try {
      // 1. 핵심 전사(Transcription) 엔진 연결 시도
      try {
        await this.transcriptionSession.connect();
        this.transcriptionEnabled = true;
      } catch (error) {
        this.transcriptionEnabled = false;
        this.options.logger.warn({ error: (error as Error).message }, "핵심 전사 엔진 연결 실패, 보조 모드로 동작합니다.");
      }

      // 2. 보조 번역(Translation) 엔진 연결 시도
      /**
       * 번역은 두 경우에 활성화합니다.
       * 1. 환경 설정상 번역 기능이 켜져 있는 경우
       * 2. 원문 transcription 연결이 실패해 source candidate라도 받아야 하는 경우
       */
      const shouldEnableTranslation = this.options.enableTranslation || !this.transcriptionEnabled;
      if (shouldEnableTranslation) {
        try {
          await Promise.all([this.koSession.connect(), this.enSession.connect()]);
          this.translationEnabled = true;
        } catch (error) {
          this.translationEnabled = false;
          this.options.logger.warn({ error: (error as Error).message }, "실시간 번역 엔진 연결 실패");
        }
      }
    } catch (error) {
      // 치명적 초기화 오류 시 생성된 모든 세션을 정리합니다.
      await Promise.allSettled([
        this.koSession.close(),
        this.enSession.close(),
        this.transcriptionSession.close()
      ]);
      throw error;
    }
  }

  /** 
   * [입력 소스 활성화] 분석 대상으로 선택된 오디오 트랙 정보를 파이프라인에 적용합니다. 
   * 이 시점부터 해당 트랙의 오디오 데이터가 STT 엔진으로 흐르게 됩니다.
   */
  async activateSource(
    participantIdentity: string,
    trackSid: string
  ): Promise<void> {
    if (this.activeTrackSid === trackSid) return;

    // 회의당 STT 세션 1개 구조에서는 source 전환이 곧 발화 종료를 의미하지 않는다.
    // 특히 같은 공간에서 여러 게스트가 동일한 음성을 publish하면 track 후보는 많아지지만,
    // 자막은 하나의 연속 스트림으로 이어져야 하므로 switch 시 commit/grace wait를 하지 않는다.
    this.activeParticipantIdentity = participantIdentity;
    this.activeTrackSid = trackSid;
  }

  /** 
   * [입력 소스 비활성화] 현재 처리 중인 오디오 소스 연결을 해제합니다.
   * @param reason 비활성화 사유
   * @param shouldFlush 진행 중인 발화 구간을 즉시 최종 데이터로 확정할지 여부
   */
  async deactivateSource(
    reason: FinalizationReason,
    shouldFlush = true
  ): Promise<void> {
    /**
     * source가 내려갈 때 transcription provider 쪽 버퍼는 먼저 commit합니다.
     * 그래야 provider 내부에 쌓여 있던 마지막 음성 조각이 텍스트로 정리될 기회를 얻습니다.
     */
    if (this.activeTrackSid && this.transcriptionEnabled) {
      this.transcriptionSession.commitAudio();
      await delay(this.options.translationGraceMs);
    }
    if (shouldFlush) {
      await this.segmentController.flush(reason);
    }
    this.activeTrackSid = undefined;
    this.activeParticipantIdentity = undefined;
    this.activeSpeechStartedAtMs = undefined;
  }

  /** 파이프라인 전체를 중단하고 할당된 모든 엔진 리소스를 해제합니다. */
  async stop(reason: FinalizationReason): Promise<void> {
    await this.deactivateSource(reason);
    
    if (this.transcriptionEnabled) {
      this.transcriptionSession.commitAudio();
      await delay(this.options.translationGraceMs);
    }

    await Promise.allSettled([
      this.koSession.close(),
      this.enSession.close(),
      this.transcriptionSession.close()
    ]);

    await this.segmentController.flush(reason);
  }

  /** 현재 분석 중인 문장이 있다면 강제로 마감하여 발행합니다. */
  async flush(reason: FinalizationReason): Promise<void> {
    await this.segmentController.flush(reason);
  }

  /**
   * [오디오 데이터 처리] 상위 세션으로부터 수신된 PCM 프레임을 엔진에 공급합니다.
   * VAD 알고리즘을 수행하여 발화 시작/종료 시점을 제어하고 엔진 버퍼에 오디오를 주입합니다.
   */
  consumeFrame(samples: Int16Array, nowMs = Date.now()): void {
    if (!this.activeTrackSid) return;

    // 1. 발화 상태 감지 임계값 업데이트
    const vad = this.vad.update(samples, nowMs);

    if (vad.speechStarted) {
      if (this.activeSpeechStartedAtMs === undefined) {
        this.activeSpeechStartedAtMs = nowMs;
        this.options.logger.info(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            participantIdentity: this.activeParticipantIdentity,
            trackSid: this.activeTrackSid
          },
          "오디오 입력에서 실제 발화 시작 감지"
        );
      }
      this.segmentController.startSpeech(nowMs);
    }

    // 2. 활성화된 엔진 세션에 오디오 프레임 주입
    /**
     * 현재 구조는 track을 여러 개 provider에 보내지 않습니다.
     * 상위 세션에서 "지금 가장 유효한 source"로 고른 프레임만 여기로 들어오고,
     * 이 메서드는 그 프레임만 provider에 전달합니다.
     */
    if (this.transcriptionEnabled) {
      this.transcriptionAudioFrames++;
      this.transcriptionSession.appendAudio(samples);
    }
    if (this.translationEnabled) {
      this.translationAudioFrames++;
      this.koSession.appendAudio(samples);
      this.enSession.appendAudio(samples);
    }

    if (vad.speechStopped) {
      if (this.transcriptionEnabled) {
        // 발화 종료 시 전사 엔진에 현재 버퍼 마감 요청 (Turn-taking)
        this.transcriptionSession.commitAudio();
      }
      this.segmentController.stopSpeech(nowMs);
    }
  }

  private handleProviderError(targetLanguage: "ko" | "en" | "source", error: Error): void {
    this.options.logger.warn(
      { targetLanguage, error: error.message },
      "STT 서비스 프로바이더 연동 중 경미한 오류 또는 응답 지연 발생"
    );
  }
}

/** provider가 마지막 텍스트를 정리할 시간을 주기 위한 짧은 대기 유틸리티입니다. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

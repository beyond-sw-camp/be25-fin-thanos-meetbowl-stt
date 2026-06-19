/**
 * 애플리케이션의 핵심 비즈니스 로직과 인프라 의존성을 통합 관리하는 런타임 클래스입니다.
 * 메시지 큐, 캐시, STT 엔진 등의 생명주기를 오케스트레이션합니다.
 */
import type { FastifyBaseLogger } from "fastify";
import { dispose } from "@livekit/rtc-node";

import type { AppConfig } from "./config/env.js";
import { RabbitMqTranscriptPublisher } from "./events/rabbitmq-transcript-publisher.js";
import { RedisFeedbackStream } from "./events/redis-feedback-stream.js";
import { OpenAiRealtimeTranscriptionProvider } from "./providers/openai-realtime-transcription-provider.js";
import { OpenAiRealtimeTranslationProvider } from "./providers/openai-realtime-translation-provider.js";
import { SttSessionService } from "./sessions/stt-session-service.js";

// cspell:ignore meetbowl

export class AppRuntime {
  /** 최종 자막 데이터를 RabbitMQ로 발행하여 meetbowl-be에 저장 요청을 보냅니다. */
  readonly rabbitPublisher: RabbitMqTranscriptPublisher;
  /** 실시간 AI 피드백 데이터를 Redis Stream을 통해 주고받습니다. */
  readonly feedbackStream: RedisFeedbackStream;
  /** 회의별 STT 세션을 생성하고 오디오 트랙을 관리하는 도메인 서비스입니다. */
  readonly sessionService: SttSessionService;

  constructor(
    readonly config: AppConfig,
    logger: FastifyBaseLogger
  ) {
    // 1. 메시징 인프라 초기화: 신뢰성 있는 전송을 위해 RabbitMQ 퍼블리셔 구성
    this.rabbitPublisher = new RabbitMqTranscriptPublisher(
      config.RABBITMQ_URL,
      config.RABBITMQ_EXCHANGE,
      logger
    );

    // 2. 실시간 피드백 스트림 초기화: 초지연 이벤트를 위해 Redis Stream 구성
    this.feedbackStream = new RedisFeedbackStream(
      config.REDIS_URL,
      config.REDIS_FEEDBACK_CONSUMER_GROUP,
      config.REDIS_FEEDBACK_CONSUMER_NAME,
      config.REDIS_STREAM_MAX_LENGTH,
      logger
    );

    // 3. 도메인 서비스 초기화: STT/번역 프로바이더 연동 및 세션 관리 로직 주입
    this.sessionService = new SttSessionService({
      config,
      rabbitPublisher: this.rabbitPublisher,
      feedbackStream: this.feedbackStream,
      translationProvider: new OpenAiRealtimeTranslationProvider({
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_REALTIME_TRANSLATION_MODEL
      }),
      transcriptionProvider: new OpenAiRealtimeTranscriptionProvider({
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_REALTIME_TRANSCRIPTION_MODEL,
        delay: config.OPENAI_REALTIME_TRANSCRIPTION_DELAY
      }),
      logger
    });
  }

  /**
   * [인프라 서비스 가동]
   * 외부 메시지 브로커(RabbitMQ, Redis)와의 네트워크 연결을 수립합니다.
   * 비동기 작업이므로 모든 연결이 완료될 때까지 Promise.all로 대기합니다.
   */
  async start(): Promise<void> {
    await Promise.all([
      this.rabbitPublisher.connect(),
      this.feedbackStream.connect()
    ]);
  }

  /**
   * [애플리케이션 정상 종료]
   * 1. 진행 중인 모든 STT 세션을 정지하고 최종 자막을 플러시(Flush)합니다.
   * 2. 외부 브로커 연결을 닫습니다.
   * 3. LiveKit 네이티브 리소스를 해제합니다.
   */
  async close(): Promise<void> {
    await this.sessionService.close();
    await Promise.allSettled([
      this.feedbackStream.close(),
      this.rabbitPublisher.close()
    ]);
    // LiveKit RTC SDK의 전역 리소스 정리
    await dispose();
  }
}

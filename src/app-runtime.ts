import type { FastifyBaseLogger } from "fastify";
import { dispose } from "@livekit/rtc-node";

import type { AppConfig } from "./config/env.js";
import { RabbitMqTranscriptPublisher } from "./events/rabbitmq-transcript-publisher.js";
import { RedisFeedbackStream } from "./events/redis-feedback-stream.js";
import { OpenAiRealtimeTranscriptionProvider } from "./providers/openai-realtime-transcription-provider.js";
import { OpenAiRealtimeTranslationProvider } from "./providers/openai-realtime-translation-provider.js";
import { SttSessionService } from "./sessions/stt-session-service.js";

export class AppRuntime {
  readonly rabbitPublisher: RabbitMqTranscriptPublisher;
  readonly feedbackStream: RedisFeedbackStream;
  readonly sessionService: SttSessionService;

  constructor(
    readonly config: AppConfig,
    logger: FastifyBaseLogger
  ) {
    // 최종 transcript 발행은 RabbitMQ, 실시간 피드백 입력은 Redis Stream으로 분리한다.
    this.rabbitPublisher = new RabbitMqTranscriptPublisher(
      config.RABBITMQ_URL,
      config.RABBITMQ_EXCHANGE,
      logger
    );
    // 세션 서비스는 브로커와 provider를 묶는 상위 조립체 역할만 한다.
    this.feedbackStream = new RedisFeedbackStream(
      config.REDIS_URL,
      config.REDIS_FEEDBACK_CONSUMER_GROUP,
      config.REDIS_FEEDBACK_CONSUMER_NAME,
      config.REDIS_STREAM_MAX_LENGTH,
      logger
    );
    // AppRuntime이 sessionService 생명주기를 책임지고, 각 세션은 여기 의존성을 주입받는다.
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

  async start(): Promise<void> {
    // 브로커 연결이 준비되어야 이후 세션 생성 시 final publish가 안전하다.
    await Promise.all([
      this.rabbitPublisher.connect(),
      this.feedbackStream.connect()
    ]);
  }

  async close(): Promise<void> {
    // 세션을 먼저 닫아 더 이상 새 transcript가 생성되지 않도록 막는다.
    await this.sessionService.close();
    await Promise.allSettled([
      this.feedbackStream.close(),
      this.rabbitPublisher.close()
    ]);
    await dispose();
  }
}

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
    this.rabbitPublisher = new RabbitMqTranscriptPublisher(
      config.RABBITMQ_URL,
      config.RABBITMQ_EXCHANGE
    );
    this.feedbackStream = new RedisFeedbackStream(
      config.REDIS_URL,
      config.REDIS_FEEDBACK_CONSUMER_GROUP,
      config.REDIS_FEEDBACK_CONSUMER_NAME,
      config.REDIS_STREAM_MAX_LENGTH
    );
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
    await Promise.all([
      this.rabbitPublisher.connect(),
      this.feedbackStream.connect()
    ]);
  }

  async close(): Promise<void> {
    await this.sessionService.close();
    await Promise.allSettled([
      this.feedbackStream.close(),
      this.rabbitPublisher.close()
    ]);
    await dispose();
  }
}

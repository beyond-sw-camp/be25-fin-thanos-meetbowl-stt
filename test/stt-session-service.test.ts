import assert from "node:assert/strict";
import test from "node:test";

import type {
  SttSessionServiceDependencies,
  SttSessionView
} from "../src/sessions/stt-session-service.js";
import { SttSessionService } from "../src/sessions/stt-session-service.js";
import type { RabbitMqTranscriptPublisher } from "../src/events/rabbitmq-transcript-publisher.js";
import type { RedisFeedbackStream } from "../src/events/redis-feedback-stream.js";

function createDependencies(): SttSessionServiceDependencies {
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {}
  };

  return {
    config: {
      LIVEKIT_URL: "http://localhost:7880",
      LIVEKIT_API_KEY: "devkey",
      LIVEKIT_API_SECRET: "local-livekit-secret",
      LIVEKIT_AGENT_IDENTITY_PREFIX: "meetbowl-stt",
      OPENAI_API_KEY: "test-key",
      OPENAI_REALTIME_TRANSLATION_MODEL: "gpt-realtime-translate",
      OPENAI_REALTIME_TRANSCRIPTION_MODEL: "gpt-realtime-whisper",
      OPENAI_REALTIME_TRANSCRIPTION_DELAY: "low",
      RABBITMQ_URL: "amqp://localhost",
      RABBITMQ_EXCHANGE: "meetbowl.topic",
      REDIS_URL: "redis://localhost:6379",
      REDIS_FEEDBACK_CONSUMER_GROUP: "stt-feedback-relay",
      REDIS_FEEDBACK_CONSUMER_NAME: "stt-test",
      REDIS_STREAM_MAX_LENGTH: 2000,
      INTERNAL_TOKEN: "internal-token",
      HOST: "127.0.0.1",
      PORT: 3000,
      ENABLE_TRANSLATION: false,
      VAD_RMS_THRESHOLD: 0.015,
      VAD_SILENCE_MS: 700,
      SEGMENT_NO_DELTA_TIMEOUT_MS: 1200,
      TRANSLATION_GRACE_MS: 500,
      MAX_SEGMENT_DURATION_MS: 15000,
      STREAMING_PUBLISH_MIN_INTERVAL_MS: 80,
      TRACK_SWITCH_GRACE_MS: 450
    },
    rabbitPublisher: {
      async connect() {},
      async close() {}
    } as RabbitMqTranscriptPublisher,
    feedbackStream: {
      async connect() {},
      async close() {}
    } as RedisFeedbackStream,
    translationProvider: {
      createSession() {
        return {
          async connect() {},
          appendAudio() {},
          async close() {}
        };
      }
    },
    transcriptionProvider: {
      createSession() {
        return {
          async connect() {},
          appendAudio() {},
          commitAudio() {},
          async close() {}
        };
      }
    },
    logger
  };
}

class TestableSttSessionService extends SttSessionService {
  readonly startedSessions: string[] = [];

  override async start(sessionId: string): Promise<SttSessionView> {
    this.startedSessions.push(sessionId);
    const sessions = Reflect.get(this as object, "sessions") as Map<
      string,
      {
        sessionId: string;
        meetingId: string;
        organizationId: string;
        roomName: string;
        status: SttSessionView["status"];
        runtime?: { isHealthy(): boolean };
      }
    >;
    const record = sessions.get(sessionId);

    if (!record) {
      throw new Error(`missing session: ${sessionId}`);
    }

    // 실제 LiveKit runtime 없이도 ensureStarted의 meeting 단위 멱등성만 검증한다.
    record.status = "RUNNING";
    record.runtime = { isHealthy: () => true };
    return {
      sessionId: record.sessionId,
      meetingId: record.meetingId,
      organizationId: record.organizationId,
      roomName: record.roomName,
      status: record.status,
      pipelineCount: 0
    };
  }
}

test("ensureStarted는 같은 meetingId에서 기존 RUNNING 세션을 재사용한다", async () => {
  const service = new TestableSttSessionService(createDependencies());

  const first = await service.ensureStarted({
    meetingId: "3ef5f58f-50b2-4f0b-97bf-42e79d91ac39",
    organizationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    roomName: "meeting-3ef5f58f-50b2-4f0b-97bf-42e79d91ac39"
  });
  const second = await service.ensureStarted({
    meetingId: "3ef5f58f-50b2-4f0b-97bf-42e79d91ac39",
    organizationId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    roomName: "meeting-3ef5f58f-50b2-4f0b-97bf-42e79d91ac39"
  });

  assert.equal(first.sessionId, second.sessionId);
  assert.equal(service.startedSessions.length, 1);
});

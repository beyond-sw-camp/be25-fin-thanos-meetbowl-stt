import {
  createClient,
  type RedisClientType
} from "redis";

import { createEventEnvelope } from "./event-envelope.js";
import type { FinalSegmentPublisher } from "../transcript/segment-publisher.js";
import type {
  FinalizationReason,
  TranscriptSegment
} from "../transcript/transcript-types.js";

interface PublisherLogger {
  info(values: Record<string, unknown>, message: string): void;
  error(values: Record<string, unknown>, message: string): void;
}

export interface FeedbackGeneratedEnvelope {
  eventType: "meeting.feedback.generated";
  payload: {
    meetingId: string;
    feedbackType: string;
    message: string;
    sources: unknown[];
    generatedAt: string;
  };
}

export class RedisFeedbackStream implements FinalSegmentPublisher {
  private readonly client: RedisClientType;
  // 같은 segment를 두 번 xadd하지 않도록 프로세스 내부에서 멱등성을 지킨다.
  private readonly publishedSegmentIds = new Set<string>();
  // meetingId별 feedback-result consumer를 한 번씩만 붙인다.
  private readonly consumers = new Map<
    string,
    { controller: AbortController; client: RedisClientType }
  >();

  constructor(
    url: string,
    private readonly consumerGroup: string,
    private readonly consumerName: string,
    private readonly maxLength: number,
    private readonly logger: PublisherLogger
  ) {
    this.client = createClient({ url });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async publishFinalSegment(
    segment: TranscriptSegment,
    _reason: FinalizationReason,
    correlationId: string
  ): Promise<void> {
    if (this.publishedSegmentIds.has(segment.segmentId)) {
      return;
    }
    // Redis Stream에는 FINALIZED segment만 넣는다.
    const envelope = createEventEnvelope(
      "meeting.feedback.segment.created",
      correlationId,
      {
        meetingId: segment.meetingId,
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        sequence: segment.sequence,
        language: segment.language,
        text: segment.text,
        isFinal: true,
        startedAtMs: segment.startedAtMs,
        endedAtMs: segment.endedAtMs
      }
    );
    try {
      // feedback-source stream은 실시간 입력용이므로 MAXLEN trim을 적용한다.
      const messageId = await this.client.xAdd(
        feedbackSourceStream(segment.meetingId),
        "*",
        { event: JSON.stringify(envelope) },
        {
          TRIM: {
            strategy: "MAXLEN",
            strategyModifier: "~",
            threshold: this.maxLength
          }
        }
      );
      this.publishedSegmentIds.add(segment.segmentId);
      this.logger.info(
        {
          ...publishLogContext(segment),
          messageId
        },
        "meeting.feedback.segment.created added to Redis Stream"
      );
    } catch (error) {
      this.logger.error(
        {
          ...publishLogContext(segment),
          error: error instanceof Error ? error.message : String(error)
        },
        "meeting.feedback.segment.created Redis Stream publish failed"
      );
      throw error;
    }
  }

  async consumeFeedback(
    meetingId: string,
    handler: (event: FeedbackGeneratedEnvelope) => Promise<void>
  ): Promise<void> {
    if (this.consumers.has(meetingId)) {
      return;
    }
    // meeting 단위 consumer group을 만들어 feedback-result를 읽는다.
    const stream = feedbackResultStream(meetingId);
    const consumerClient = this.client.duplicate();
    await consumerClient.connect();
    try {
      await consumerClient.xGroupCreate(stream, this.consumerGroup, "0", {
        MKSTREAM: true
      });
    } catch (error) {
      if (!isBusyGroupError(error)) {
        await consumerClient.quit();
        throw error;
      }
    }

    const controller = new AbortController();
    this.consumers.set(meetingId, { controller, client: consumerClient });
    // consumeLoop는 background task로 돌려 호출부를 블로킹하지 않는다.
    void this.consumeLoop(
      stream,
      consumerClient,
      controller.signal,
      handler
    );
  }

  stopFeedbackConsumer(meetingId: string): void {
    const consumer = this.consumers.get(meetingId);
    consumer?.controller.abort();
    if (consumer?.client.isOpen) {
      void consumer.client.quit();
    }
    this.consumers.delete(meetingId);
  }

  async close(): Promise<void> {
    for (const consumer of this.consumers.values()) {
      consumer.controller.abort();
      if (consumer.client.isOpen) {
        await consumer.client.quit();
      }
    }
    this.consumers.clear();
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  private async consumeLoop(
    stream: string,
    client: RedisClientType,
    signal: AbortSignal,
    handler: (event: FeedbackGeneratedEnvelope) => Promise<void>
  ): Promise<void> {
    while (!signal.aborted && client.isOpen) {
      try {
        // 새 메시지만 읽고, 처리 성공 후 ACK한다.
        const results = await client.xReadGroup(
          this.consumerGroup,
          this.consumerName,
          [{ key: stream, id: ">" }],
          { COUNT: 10, BLOCK: 1000 }
        );
        for (const result of results ?? []) {
          for (const message of result.messages) {
            const raw = message.message.event;
            if (!raw) {
              // payload가 없으면 재시도해도 의미가 없으므로 바로 ACK한다.
              await client.xAck(stream, this.consumerGroup, message.id);
              continue;
            }
            const event = JSON.parse(raw) as FeedbackGeneratedEnvelope;
            if (event.eventType !== "meeting.feedback.generated") {
              // 예상한 결과 이벤트가 아니면 막지 말고 ACK 후 넘긴다.
              await client.xAck(stream, this.consumerGroup, message.id);
              continue;
            }
            await handler(event);
            await client.xAck(stream, this.consumerGroup, message.id);
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          await delay(500);
        }
      }
    }
    if (client.isOpen) {
      await client.quit();
    }
  }
}

export function feedbackSourceStream(meetingId: string): string {
  // STT 서버가 finalized segment를 적재하는 입력 stream 이름이다.
  return `meeting:${meetingId}:feedback-source`;
}

export function feedbackResultStream(meetingId: string): string {
  // AI 서버가 생성한 결과를 다시 읽는 응답 stream 이름이다.
  return `meeting:${meetingId}:feedback-result`;
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("BUSYGROUP");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publishLogContext(segment: TranscriptSegment): Record<string, unknown> {
  return {
    meetingId: segment.meetingId,
    sessionId: segment.sessionId,
    segmentId: segment.segmentId,
    sequence: segment.sequence,
    status: segment.status
  };
}

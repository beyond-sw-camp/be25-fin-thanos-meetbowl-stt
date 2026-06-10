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
  private readonly consumers = new Map<
    string,
    { controller: AbortController; client: RedisClientType }
  >();

  constructor(
    url: string,
    private readonly consumerGroup: string,
    private readonly consumerName: string,
    private readonly maxLength: number
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
    const envelope = createEventEnvelope(
      "meeting.feedback.segment.created",
      correlationId,
      {
        meetingId: segment.meetingId,
        sessionId: segment.sessionId,
        segmentId: segment.segmentId,
        sequence: segment.sequence,
        sourceLanguage: segment.sourceLanguage,
        sourceText: segment.sourceText,
        koText: segment.koText,
        enText: segment.enText,
        startedAtMs: segment.startedAtMs,
        endedAtMs: segment.endedAtMs
      }
    );
    await this.client.xAdd(
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
  }

  async consumeFeedback(
    meetingId: string,
    handler: (event: FeedbackGeneratedEnvelope) => Promise<void>
  ): Promise<void> {
    if (this.consumers.has(meetingId)) {
      return;
    }
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
              await client.xAck(stream, this.consumerGroup, message.id);
              continue;
            }
            const event = JSON.parse(raw) as FeedbackGeneratedEnvelope;
            if (event.eventType !== "meeting.feedback.generated") {
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
  return `meeting:${meetingId}:feedback-source`;
}

export function feedbackResultStream(meetingId: string): string {
  return `meeting:${meetingId}:feedback-result`;
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("BUSYGROUP");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

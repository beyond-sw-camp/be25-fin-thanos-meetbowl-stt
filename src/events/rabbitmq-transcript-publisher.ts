import amqp, {
  type ConfirmChannel,
  type ChannelModel
} from "amqplib";

import { createEventEnvelope } from "./event-envelope.js";
import type { FinalSegmentPublisher } from "../transcript/segment-publisher.js";
import type {
  FinalizationReason,
  FinalTranscriptPayload,
  TranscriptSegment
} from "../transcript/transcript-types.js";

interface PublisherLogger {
  info(values: Record<string, unknown>, message: string): void;
  error(values: Record<string, unknown>, message: string): void;
}

export class RabbitMqTranscriptPublisher implements FinalSegmentPublisher {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  // segmentId 단위로 이미 발행한 final transcript는 다시 보내지 않는다.
  private readonly publishedSegmentIds = new Set<string>();

  constructor(
    private readonly url: string,
    private readonly exchange: string,
    private readonly logger: PublisherLogger
  ) {}

  async connect(): Promise<void> {
    // confirm channel을 써서 broker ack를 기다릴 수 있게 만든다.
    this.connection = await amqp.connect(this.url);
    this.channel = await this.connection.createConfirmChannel();
    await this.channel.assertExchange(this.exchange, "topic", {
      durable: true
    });
  }

  async publishFinalSegment(
    segment: TranscriptSegment,
    reason: FinalizationReason,
    correlationId: string
  ): Promise<void> {
    if (this.publishedSegmentIds.has(segment.segmentId)) {
      return;
    }
    const channel = this.requireChannel();
    // downstream consumer가 저장/재처리하기 쉬운 최소 payload만 보낸다.
    const payload: FinalTranscriptPayload = {
      meetingId: segment.meetingId,
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      sequence: segment.sequence,
      startedAtMs: segment.startedAtMs,
      endedAtMs: segment.endedAtMs,
      language: segment.language,
      text: segment.text,
      provider: "openai-realtime-transcription",
      finalizationReason: reason,
      idempotencyKey: segment.segmentId
    };
    const envelope = createEventEnvelope(
      "transcript.final.created",
      correlationId,
      payload
    );

    try {
      // persistent + confirm 조합으로 실제 broker 기록까지 확인한다.
      channel.publish(
        this.exchange,
        "transcript.final.created",
        Buffer.from(JSON.stringify(envelope)),
        {
          contentType: "application/json",
          deliveryMode: 2,
          messageId: envelope.eventId,
          correlationId
        }
      );
      await channel.waitForConfirms();
      this.publishedSegmentIds.add(segment.segmentId);
      this.logger.info(
        publishLogContext(segment),
        "transcript.final.created published to RabbitMQ"
      );
    } catch (error) {
      this.logger.error(
        {
          ...publishLogContext(segment),
          error: error instanceof Error ? error.message : String(error)
        },
        "transcript.final.created RabbitMQ publish failed"
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  private requireChannel(): ConfirmChannel {
    if (!this.channel) {
      throw new Error("RabbitMQ publisher is not connected");
    }
    return this.channel;
  }
}

function publishLogContext(segment: TranscriptSegment): Record<string, unknown> {
  // 로그에는 원문 전체 대신 식별에 필요한 키만 남긴다.
  return {
    meetingId: segment.meetingId,
    sessionId: segment.sessionId,
    segmentId: segment.segmentId,
    sequence: segment.sequence,
    status: segment.status
  };
}

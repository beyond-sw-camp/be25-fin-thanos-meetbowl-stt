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

export class RabbitMqTranscriptPublisher implements FinalSegmentPublisher {
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;

  constructor(
    private readonly url: string,
    private readonly exchange: string
  ) {}

  async connect(): Promise<void> {
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
    const channel = this.requireChannel();
    const payload: FinalTranscriptPayload = {
      meetingId: segment.meetingId,
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      sequence: segment.sequence,
      startedAtMs: segment.startedAtMs,
      endedAtMs: segment.endedAtMs,
      sourceLanguage: segment.sourceLanguage,
      sourceText: segment.sourceText,
      koText: segment.koText,
      enText: segment.enText,
      provider: "openai-realtime-stt",
      finalizationReason: reason,
      idempotencyKey: `${segment.meetingId}:${segment.segmentId}`
    };
    const envelope = createEventEnvelope(
      "transcript.final.created",
      correlationId,
      payload
    );

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

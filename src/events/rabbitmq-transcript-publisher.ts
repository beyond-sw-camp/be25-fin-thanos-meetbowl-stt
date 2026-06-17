/**
 * 최종 확정된 자막 데이터를 RabbitMQ 메시지 브로커로 전송하는 퍼블리셔 클래스입니다.
 * 신뢰성 있는 메시지 전송을 위해 Confirm Channel과 영속성(Persistent) 설정을 사용합니다.
 */
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
  /** 중복 발행 방지를 위해 프로세스 런타임 동안 관리되는 발행 완료 세그먼트 ID 집합입니다. */
  private readonly publishedSegmentIds = new Set<string>();

  constructor(
    private readonly url: string,
    private readonly exchange: string,
    private readonly logger: PublisherLogger
  ) {}

  /** [연결 수립] RabbitMQ 서버에 접속하고 토픽 익스체인지를 선언합니다. */
  async connect(): Promise<void> {
    this.connection = await amqp.connect(this.url);
    // 발행 확인(Confirmation) 기능을 지원하는 채널을 생성합니다.
    this.channel = await this.connection.createConfirmChannel();
    await this.channel.assertExchange(this.exchange, "topic", {
      durable: true // 브로커 재시작 시에도 익스체인지 유지
    });
  }

  /** 
   * [자막 발행] 최종 확정된 세그먼트를 RabbitMQ로 전송합니다.
   * @param segment 확정된 자막 세그먼트
   * @param reason 확정 사유
   * @param correlationId 트랜잭션 추적 ID
   */
  async publishFinalSegment(
    segment: TranscriptSegment,
    reason: FinalizationReason,
    correlationId: string
  ): Promise<void> {
    if (this.publishedSegmentIds.has(segment.segmentId)) return;

    const channel = this.requireChannel();
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
      /**
       * 메시지를 직렬화하여 발행합니다.
       * deliveryMode: 2 설정을 통해 메시지를 디스크에 저장(Persistence)하도록 요청합니다.
       */
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

      // 브로커로부터 수신 확인(ACK)이 올 때까지 비동기로 대기합니다.
      await channel.waitForConfirms();
      this.publishedSegmentIds.add(segment.segmentId);
      
      this.logger.info(publishLogContext(segment), "최종 자막 RabbitMQ 발행 성공");
    } catch (error) {
      this.logger.error(
        { ...publishLogContext(segment), error: (error as Error).message },
        "최종 자막 RabbitMQ 발행 실패"
      );
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  private requireChannel(): ConfirmChannel {
    if (!this.channel) throw new Error("RabbitMQ 연결이 수립되지 않았습니다.");
    return this.channel;
  }
}

function publishLogContext(segment: TranscriptSegment): Record<string, unknown> {
  return {
    meetingId: segment.meetingId,
    sessionId: segment.sessionId,
    segmentId: segment.segmentId,
    sequence: segment.sequence
  };
}

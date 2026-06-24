/**
 * 최종 확정된 자막 데이터를 RabbitMQ 메시지 브로커로 전송하는 퍼블리셔 클래스입니다.
 *
 * 이 파일은 "DB 저장 경로의 출발점"이다.
 * 실제 DB 저장은 BE가 하지만, 저장 이벤트를 브로커에 올리는 책임은 STT가 가진다.
 *
 * 흐름:
 * 1. SegmentController가 어떤 문장을 FINALIZED로 확정한다.
 * 2. 이 클래스가 `transcript.final.created` 이벤트를 RabbitMQ에 발행한다.
 * 3. BE의 TranscriptFinalCreatedListener가 그 메시지를 소비한다.
 * 4. SaveFinalTranscriptUseCase가 멱등성 검사 후 DB에 저장한다.
 *
 * 즉, DB에 transcript가 쌓이려면 이 파일의 publish가 먼저 성공해야 한다.
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
   *
   * 주의:
   * - 여기로 들어오는 segment는 이미 FINALIZED 상태다.
   * - STREAMING/partial/interim은 이 메서드로 오지 않는다.
   * - reason은 왜 이 문장이 finalize됐는지 추적하기 위한 메타데이터다.
   *   예: VAD_SILENCE, NO_DELTA_TIMEOUT, MAX_DURATION, FLUSH
   *
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
    // payload는 "DB에 저장 가능한 최종 문장 1건"의 최소 계약이다.
    // 회의 단위 전체 원문을 보내는 것이 아니라 세그먼트 한 건씩 쪼개서 발행한다.
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
       * 메시지를 직렬화하여 발행한다.
       *
       * 핵심 설정:
       * - routing key: transcript.final.created
       * - deliveryMode 2: 브로커 재시작에도 살아남도록 persistent 메시지 요청
       * - messageId: envelope.eventId
       *
       * messageId와 payload.idempotencyKey는 같은 의미가 아니다.
       * - messageId/eventId: "이번 이벤트 envelope 자체"를 식별
       * - idempotencyKey(segmentId): "이 문장 세그먼트"를 식별
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

      // 브로커로부터 ACK를 받아야 실제로 "발행 성공"으로 본다.
      // 여기서 실패하면 BE 저장 경로는 시작되지 않는다.
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

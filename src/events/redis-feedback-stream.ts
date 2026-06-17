/**
 * Redis Stream을 활용하여 실시간 AI 피드백 이벤트를 송수신하는 클래스입니다.
 * 초지연 처리가 필요한 실시간 분석 입력(Source)과 결과(Result) 스트림을 관리합니다.
 */
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
  /** 프로세스 내부 멱등성 보장을 위해 기록된 세그먼트 ID 집합입니다. */
  private readonly publishedSegmentIds = new Set<string>();
  /** 회의별 피드백 결과 수신을 위한 컨슈머 루프 제어 맵입니다. */
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

  /** 
   * [피드백 소스 발행] 확정된 자막 세그먼트를 AI 분석 입력 스트림에 추가합니다.
   * XADD 명령을 사용하며, 메모리 관리를 위해 스트림 최대 길이를 제한(TRIM)합니다.
   */
  async publishFinalSegment(
    segment: TranscriptSegment,
    _reason: FinalizationReason,
    correlationId: string
  ): Promise<void> {
    if (this.publishedSegmentIds.has(segment.segmentId)) return;

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
      // Redis Stream에 메시지 적재 및 자동 길이 제한 적용
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
      this.logger.info({ segmentId: segment.segmentId, messageId }, "피드백 입력 스트림 적재 성공");
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, "피드백 스트림 발행 실패");
      throw error;
    }
  }

  /** 
   * [피드백 결과 구독] AI 서버가 생성한 분석 결과를 실시간으로 수신합니다.
   * Redis Consumer Group을 생성하여 안정적인 메시지 분배를 보장합니다.
   */
  async consumeFeedback(
    meetingId: string,
    handler: (event: FeedbackGeneratedEnvelope) => Promise<void>
  ): Promise<void> {
    if (this.consumers.has(meetingId)) return;

    const stream = feedbackResultStream(meetingId);
    const consumerClient = this.client.duplicate();
    await consumerClient.connect();

    try {
      // 컨슈머 그룹 생성 (이미 존재하는 경우 무시)
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
    
    // 백그라운드에서 메시지 수신 루프 실행
    void this.consumeLoop(stream, consumerClient, controller.signal, handler);
  }

  stopFeedbackConsumer(meetingId: string): void {
    const consumer = this.consumers.get(meetingId);
    consumer?.controller.abort();
    if (consumer?.client.isOpen) void consumer.client.quit();
    this.consumers.delete(meetingId);
  }

  async close(): Promise<void> {
    for (const consumer of this.consumers.values()) {
      consumer.controller.abort();
      if (consumer.client.isOpen) await consumer.client.quit();
    }
    this.consumers.clear();
    if (this.client.isOpen) await this.client.quit();
  }

  /** [메시지 수신 루프] 주기적으로 새로운 피드백 이벤트를 읽어와 처리하고 확인(ACK)을 보냅니다. */
  private async consumeLoop(
    stream: string,
    client: RedisClientType,
    signal: AbortSignal,
    handler: (event: FeedbackGeneratedEnvelope) => Promise<void>
  ): Promise<void> {
    while (!signal.aborted && client.isOpen) {
      try {
        // 읽지 않은 새로운 메시지('>')를 블로킹 방식으로 대기
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
            if (event.eventType === "meeting.feedback.generated") {
              await handler(event);
            }
            // 처리 완료 후 메시지 확인 처리
            await client.xAck(stream, this.consumerGroup, message.id);
          }
        }
      } catch (error) {
        if (!signal.aborted) await delay(500);
      }
    }
    if (client.isOpen) await client.quit();
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

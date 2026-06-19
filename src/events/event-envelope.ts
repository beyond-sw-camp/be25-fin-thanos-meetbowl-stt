/**
 * 모든 외부 이벤트(RabbitMQ, Redis Stream)의 표준 통신 규격을 정의하는 모듈입니다.
 * 분산 시스템 환경에서 이벤트의 출처, 시점, 상관관계를 일관성 있게 추적(Tracing)하기 위해 사용합니다.
 */
import { randomUUID } from "node:crypto";

export interface EventEnvelope<TEventType extends string, TPayload> {
  /** 각 이벤트의 유일한 식별자입니다. (중복 처리 방지용) */
  eventId: string;
  /** 이벤트의 종류를 나타내는 식별 문자열입니다. */
  eventType: TEventType;
  /** 이벤트가 실제로 발생한 시각(ISO 8601)입니다. */
  occurredAt: string;
  /** 이벤트를 생성한 시스템의 이름입니다. */
  producer: "stt-server";
  /** 메시지 포맷의 버전 정보입니다. */
  version: 1;
  /** 여러 시스템을 거치는 전체 요청 흐름을 묶어주는 상관관계 ID입니다. */
  correlationId: string;
  /** 실제 전달하고자 하는 비즈니스 데이터 본문입니다. */
  payload: TPayload;
}

/** 
 * 표준 엔벨로프 형식으로 이벤트를 포장합니다.
 * @param eventType 이벤트 이름
 * @param correlationId 추적을 위한 상관관계 ID
 * @param payload 실제 데이터 본문
 */
export function createEventEnvelope<TEventType extends string, TPayload>(
  eventType: TEventType,
  correlationId: string,
  payload: TPayload
): EventEnvelope<TEventType, TPayload> {
  return {
    eventId: randomUUID(),
    eventType,
    occurredAt: new Date().toISOString(),
    producer: "stt-server",
    version: 1,
    correlationId,
    payload
  };
}

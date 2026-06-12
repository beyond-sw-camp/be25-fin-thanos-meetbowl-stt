import { randomUUID } from "node:crypto";

export interface EventEnvelope<TEventType extends string, TPayload> {
  eventId: string;
  eventType: TEventType;
  occurredAt: string;
  producer: "stt-server";
  version: 1;
  correlationId: string;
  payload: TPayload;
}

export function createEventEnvelope<TEventType extends string, TPayload>(
  eventType: TEventType,
  correlationId: string,
  payload: TPayload
): EventEnvelope<TEventType, TPayload> {
  // 서버 간 이벤트는 모두 같은 envelope로 감싸 추적 필드를 공통화한다.
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

import { randomUUID } from "node:crypto";

import { createClient } from "redis";

const [meetingId, participantIdentity, suppliedRoomName] = process.argv.slice(2);
const sttUrl = process.env.STT_BASE_URL || "http://127.0.0.1:3000/api/v1";
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6381";
const internalToken = process.env.INTERNAL_TOKEN;

if (!meetingId || !participantIdentity) {
  throw new Error(
    "Usage: npm run fixture:feedback-ui -- <meetingId> <user-participantIdentity> [roomName]"
  );
}
if (!isUuid(meetingId)) throw new Error("meetingId must be a UUID.");
if (!participantIdentity.startsWith("user-") || !isUuid(participantIdentity.slice(5))) {
  throw new Error("participantIdentity must use the user-{UUID} format.");
}
if (!internalToken) throw new Error("INTERNAL_TOKEN is required.");

const roomName = suppliedRoomName || `meeting-${meetingId}`;
const userId = participantIdentity.slice(5);
const redis = createClient({ url: redisUrl });

try {
  const session = await postJson(`${sttUrl}/sessions/ensure-started`, {
    meetingId,
    organizationId: process.env.ORGANIZATION_ID || randomUUID(),
    roomName,
    recordingEnabled: false
  });

  await redis.connect();
  const now = new Date().toISOString();
  const event = {
    eventId: randomUUID(),
    eventType: "meeting.feedback.generated",
    occurredAt: now,
    producer: "ai-server",
    version: 1,
    correlationId: randomUUID(),
    payload: {
      feedbackId: randomUUID(),
      meetingId,
      sessionId: session.sessionId,
      feedbackType: "DECISION_REMINDER",
      message: "[UI 테스트] 이전 회의에서 100만원 이하 결제는 자동 승인하기로 결정했습니다.",
      sources: [
        {
          minutesId: randomUUID(),
          meetingId: randomUUID(),
          title: "결제 자동 승인 정책 회의",
          meetingDate: new Date().toISOString().slice(0, 10),
          snippet: "100만원 이하 결제는 자동 승인하기로 최종 확정했습니다."
        }
      ],
      audienceUserIds: [userId],
      fromSequence: 0,
      toSequence: 0,
      generatedAt: now
    }
  };

  const stream = `meeting:${meetingId}:feedback-result`;
  const messageId = await redis.xAdd(stream, "*", { event: JSON.stringify(event) });
  console.log(JSON.stringify({
    meetingId,
    sessionId: session.sessionId,
    roomName,
    participantIdentity,
    stream,
    messageId,
    expectedTopic: "feedback.generated"
  }, null, 2));
} finally {
  if (redis.isOpen) await redis.quit();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": internalToken
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`POST ${url} failed status=${response.status} body=${JSON.stringify(body)}`);
  }
  return body?.data;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

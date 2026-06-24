import { randomUUID } from "node:crypto";

import { Room, RoomEvent, dispose } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { createClient } from "redis";

const liveKitUrl = process.env.LIVEKIT_URL || "http://127.0.0.1:7880";
const liveKitApiKey = process.env.LIVEKIT_API_KEY;
const liveKitApiSecret = process.env.LIVEKIT_API_SECRET;
const sttUrl = process.env.STT_BASE_URL || "http://127.0.0.1:3000/api/v1";
const aiUrl = process.env.AI_BASE_URL || "http://127.0.0.1:8000/api/v1";
const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6381";
const internalToken = process.env.INTERNAL_TOKEN;

if (!liveKitApiKey || !liveKitApiSecret || !internalToken) {
  throw new Error("LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and INTERNAL_TOKEN are required.");
}

const fixture = {
  meetingId: randomUUID(),
  historicalMeetingId: randomUUID(),
  organizationId: randomUUID(),
  documentId: randomUUID(),
  authorizedUserId: randomUUID(),
  correlationId: randomUUID()
};
const roomName = `feedback-probe-${fixture.meetingId}`;
const authorizedIdentity = `user-${fixture.authorizedUserId}`;
const rooms = [];
const redis = createClient({ url: redisUrl });
let sessionId;

try {
  console.log(`[livekit] connecting authorized participant to ${roomName}`);
  const authorized = await connectParticipant(authorizedIdentity, "Feedback Authorized");
  rooms.push(authorized.room);

  const authorizedFeedback = waitForFeedback(authorized);

  console.log("[stt] starting meeting session");
  const session = await postJson(`${sttUrl}/sessions/ensure-started`, {
    meetingId: fixture.meetingId,
    organizationId: fixture.organizationId,
    roomName,
    recordingEnabled: false
  });
  sessionId = session.sessionId;

  console.log("[ai] indexing fixture minutes");
  await postJson(`${aiUrl}/indexes/documents`, {
    documentId: fixture.documentId,
    documentType: "MEETING_MINUTES",
    organizationId: fixture.organizationId,
    ownerUserId: fixture.authorizedUserId,
    accessScope: {
      userIds: [fixture.authorizedUserId],
      departmentIds: [],
      sharedWorkspaceIds: []
    },
    title: "결제 자동 승인 정책 회의",
    content: (
      "결제 자동 승인 정책과 백만원 이하 거래 기준을 검토했습니다. " +
      "백만원 이하 결제는 자동 승인하기로 최종 확정했습니다."
    ),
    metadata: {
      meetingId: fixture.historicalMeetingId,
      approvedAt: "2026-06-18T01:00:00Z"
    }
  });

  await redis.connect();
  console.log("[redis] publishing finalized transcript window");
  await publishTranscriptWindow(redis, sessionId);

  console.log("[livekit] waiting for feedback.generated");
  const received = await authorizedFeedback;

  assertFeedbackContract(received.event, sessionId);
  if (!received.participant?.startsWith("meetbowl-stt")) {
    throw new Error(`Unexpected feedback sender: ${received.participant || "unknown"}`);
  }
  console.log(JSON.stringify({
    meetingId: fixture.meetingId,
    sessionId,
    roomName,
    topic: received.topic,
    senderIdentity: received.participant,
    eventType: received.event.eventType,
    feedbackType: received.event.feedbackType,
    authorizedReceived: true,
    sourceCount: received.event.sources.length
  }, null, 2));
} finally {
  if (sessionId) {
    await postJson(`${sttUrl}/sessions/${sessionId}/stop`, {}).catch(() => undefined);
  }
  if (redis.isOpen) await redis.quit();
  await Promise.allSettled(rooms.map((room) => room.disconnect()));
  await dispose();
}

async function connectParticipant(identity, name) {
  const token = new AccessToken(liveKitApiKey, liveKitApiSecret, {
    identity,
    name,
    ttl: "10m"
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: false,
    canSubscribe: true,
    canPublishData: false
  });
  const room = new Room();
  try {
    await withTimeout(
      room.connect(liveKitUrl, await token.toJwt(), {
        autoSubscribe: true,
        dynacast: false
      }),
      10000,
      `Timed out connecting LiveKit participant ${identity}.`
    );
  } catch (error) {
    await room.disconnect().catch(() => undefined);
    throw error;
  }
  return { room, identity };
}

function waitForFeedback(participant) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for feedback.generated.")),
      20000
    );
    participant.room.on(RoomEvent.DataReceived, (payload, sender, _kind, topic) => {
      if (topic !== "feedback.generated") return;
      const event = JSON.parse(new TextDecoder().decode(payload));
      if (event.eventType !== "feedback.generated") return;
      clearTimeout(timeout);
      resolve({
        event,
        topic,
        participant: sender?.identity
      });
    });
  });
}

async function publishTranscriptWindow(client, currentSessionId) {
  const segments = [
    "지난 회의에서 결제 자동 승인 정책을 논의했었죠",
    "이번에도 백만원 이하 거래 승인 기준을 확인해 봅시다",
    "백만원 이하 결제를 자동 승인하는 방안이 맞는지 검토하겠습니다",
    "기존 결정사항과 현재 정책이 같은지 확인해 주세요"
  ];
  const stream = `meeting:${fixture.meetingId}:feedback-source`;
  for (const [sequence, text] of segments.entries()) {
    const event = {
      eventId: randomUUID(),
      eventType: "meeting.feedback.segment.created",
      occurredAt: new Date().toISOString(),
      producer: "stt-server",
      version: 1,
      correlationId: fixture.correlationId,
      payload: {
        meetingId: fixture.meetingId,
        sessionId: currentSessionId,
        organizationId: fixture.organizationId,
        participantUserIds: [fixture.authorizedUserId],
        segmentId: randomUUID(),
        sequence,
        language: "ko",
        text,
        isFinal: true,
        startedAtMs: sequence * 6000,
        endedAtMs: sequence * 6000 + 5000
      }
    };
    await client.xAdd(stream, "*", { event: JSON.stringify(event) });
  }
}

function assertFeedbackContract(event, currentSessionId) {
  const expectedKeys = [
    "eventType",
    "feedbackId",
    "meetingId",
    "sessionId",
    "feedbackType",
    "message",
    "sources",
    "generatedAt"
  ];
  const actualKeys = Object.keys(event).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys.sort())) {
    throw new Error(`Unexpected feedback.generated fields: ${actualKeys.join(", ")}`);
  }
  if (event.meetingId !== fixture.meetingId || event.sessionId !== currentSessionId) {
    throw new Error("LiveKit feedback meeting/session does not match the active STT session.");
  }
  if (!event.feedbackId || !event.message || !Array.isArray(event.sources)) {
    throw new Error("LiveKit feedback payload is missing required fields.");
  }
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

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

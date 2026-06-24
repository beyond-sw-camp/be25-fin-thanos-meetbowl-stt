import assert from "node:assert/strict";
import test from "node:test";

import {
  parseFeedbackGeneratedEnvelope,
  parseFeedbackGeneratedEnvelopeJson,
  RedisFeedbackStream
} from "../src/events/redis-feedback-stream.js";
import type { TranscriptSegment } from "../src/transcript/transcript-types.js";

test("skips feedback source publishing when no authenticated user is present", async () => {
  const stream = new RedisFeedbackStream(
    "redis://localhost:6379",
    "test-group",
    "test-consumer",
    100,
    {
      info() {},
      error() {}
    }
  );
  const segment: TranscriptSegment = {
    segmentId: "segment-id",
    meetingId: "meeting-id",
    sessionId: "session-id",
    organizationId: "organization-id",
    participantUserIds: [],
    sequence: 1,
    startedAtMs: 100,
    endedAtMs: 200,
    language: "ko",
    text: "확정된 발화",
    sourceLanguage: "ko",
    sourceText: "확정된 발화",
    koText: "확정된 발화",
    enText: "",
    status: "FINALIZED"
  };

  await assert.doesNotReject(
    stream.publishFinalSegment(segment, "VAD_SILENCE", "correlation-id")
  );
});

test("validates the complete AI feedback result envelope", () => {
  const event = {
    eventId: "744e5b8d-2f98-4d87-a8a7-b6dd661e96c9",
    eventType: "meeting.feedback.generated",
    occurredAt: "2026-06-19T00:00:00Z",
    producer: "ai-server",
    version: 1,
    correlationId: "a889573e-953c-4c4e-a77c-2ecb20970ef8",
    payload: {
      feedbackId: "4aff1ad9-e0ff-4848-a18e-85a309c72094",
      meetingId: "37a44ba4-d6f9-4e91-bbb8-1e3913ad9cac",
      sessionId: "49763ddc-e696-4793-b4f1-851a37731934",
      feedbackType: "DUPLICATE_DISCUSSION",
      message: "이전에 유사한 논의가 있었습니다.",
      sources: [{ minutesId: "fdbd09e2-082c-4dcd-95bf-e15692eaf31b" }],
      audienceUserIds: ["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
      fromSequence: 4,
      toSequence: 7,
      generatedAt: "2026-06-19T00:00:01Z"
    }
  };

  assert.deepEqual(parseFeedbackGeneratedEnvelope(event), event);
  assert.equal(
    parseFeedbackGeneratedEnvelope({
      ...event,
      payload: { ...event.payload, audienceUserIds: [] }
    }),
    undefined
  );
  assert.equal(
    parseFeedbackGeneratedEnvelope({
      ...event,
      payload: { ...event.payload, fromSequence: 8 }
    }),
    undefined
  );
  assert.equal(parseFeedbackGeneratedEnvelopeJson("{invalid-json"), undefined);
});

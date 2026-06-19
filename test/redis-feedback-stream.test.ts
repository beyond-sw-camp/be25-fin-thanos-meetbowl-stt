import assert from "node:assert/strict";
import test from "node:test";

import { RedisFeedbackStream } from "../src/events/redis-feedback-stream.js";
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

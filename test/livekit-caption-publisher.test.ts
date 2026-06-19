import assert from "node:assert/strict";
import test from "node:test";

import type { Room } from "@livekit/rtc-node";

import type { FeedbackGeneratedEnvelope } from "../src/events/redis-feedback-stream.js";
import { LiveKitCaptionPublisher } from "../src/livekit/livekit-caption-publisher.js";

test("publishes feedback only to specified LiveKit identities", async () => {
  const calls: Array<{
    payload: Record<string, unknown>;
    options: Record<string, unknown>;
  }> = [];
  const room = {
    localParticipant: {
      async publishData(data: Uint8Array, options: Record<string, unknown>) {
        calls.push({
          payload: JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>,
          options
        });
      }
    }
  } as unknown as Room;
  const publisher = new LiveKitCaptionPublisher(
    room,
    { info() {} },
    { meetingId: "meeting-id", sessionId: "session-id" }
  );
  const event: FeedbackGeneratedEnvelope = {
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
  const destinations = [
    "user-3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "user-4dd5adca-71ba-4204-a91f-e50b29bb83b9"
  ];

  await publisher.publishFeedback(event, destinations);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.payload.eventType, "feedback.generated");
  assert.deepEqual(calls[0]?.options.destination_identities, destinations);
  assert.equal(calls[0]?.options.reliable, true);
  assert.equal(calls[0]?.options.topic, "feedback.generated");
});

test("does not broadcast when feedback has no current destination", async () => {
  let publishCount = 0;
  const room = {
    localParticipant: {
      async publishData() {
        publishCount += 1;
      }
    }
  } as unknown as Room;
  const publisher = new LiveKitCaptionPublisher(
    room,
    { info() {} },
    { meetingId: "meeting-id", sessionId: "session-id" }
  );
  const event = parseFeedbackEvent();

  await publisher.publishFeedback(event, []);

  assert.equal(publishCount, 0);
});

function parseFeedbackEvent(): FeedbackGeneratedEnvelope {
  return {
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
      sources: [{}],
      audienceUserIds: ["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
      fromSequence: 4,
      toSequence: 7,
      generatedAt: "2026-06-19T00:00:01Z"
    }
  };
}

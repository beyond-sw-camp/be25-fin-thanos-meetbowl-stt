import assert from "node:assert/strict";
import test from "node:test";

import { SegmentController } from "../src/transcript/segment-controller.js";
import type { TranscriptSegment } from "../src/transcript/transcript-types.js";

test("publishes streaming updates and one finalized segment", async () => {
  const captions: TranscriptSegment[] = [];
  const finalized: TranscriptSegment[] = [];
  const controller = new SegmentController({
    meetingId: "meeting-id",
    sessionId: "session-id",
    meetingStartedAtMs: 1000,
    noDeltaTimeoutMs: 5,
    translationGraceMs: 5,
    maxSegmentDurationMs: 1000,
    nextSequence: () => 0,
    correlationId: "correlation-id",
    captionPublisher: {
      async publishCaption(segment) {
        captions.push(segment);
      }
    },
    finalSegmentPublisher: {
      async publishFinalSegment(segment) {
        finalized.push(segment);
      }
    }
  });

  controller.startSpeech(1100);
  controller.appendDelta("sourceCandidateKo", "오늘 배포 일정을", 1110);
  controller.appendDelta("koTargetOutput", "오늘 배포 일정을", 1120);
  controller.appendDelta(
    "enTargetOutput",
    "Let's review the deployment schedule.",
    1130
  );
  controller.stopSpeech(1200);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]?.status, "FINALIZED");
  assert.equal(finalized[0]?.startedAtMs, 100);
  assert.equal(finalized[0]?.endedAtMs, 200);
  assert.equal(finalized[0]?.koText, "오늘 배포 일정을");
  assert.equal(
    finalized[0]?.enText,
    "Let's review the deployment schedule."
  );
  assert.ok(captions.some((caption) => caption.status === "STREAMING"));
  assert.ok(captions.some((caption) => caption.status === "FINALIZED"));

  await controller.flush("MANUAL_FLUSH");
  assert.equal(finalized.length, 1);
});

test("retains the active segment when final publishing fails and retries on flush", async () => {
  const publishedSegmentIds: string[] = [];
  let attempts = 0;
  const controller = new SegmentController({
    meetingId: "meeting-id",
    sessionId: "session-id",
    meetingStartedAtMs: 1000,
    noDeltaTimeoutMs: 1000,
    translationGraceMs: 1000,
    maxSegmentDurationMs: 1000,
    nextSequence: () => 3,
    correlationId: "correlation-id",
    captionPublisher: {
      async publishCaption() {}
    },
    finalSegmentPublisher: {
      async publishFinalSegment(segment) {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary publish failure");
        }
        publishedSegmentIds.push(segment.segmentId);
      }
    }
  });

  controller.startSpeech(1100);
  controller.appendDelta("sourceTranscript", "마지막 발화", 1110);

  await assert.rejects(
    controller.flush("MEETING_ENDED"),
    /temporary publish failure/
  );
  assert.equal(controller.hasActiveSegment(), true);

  await controller.flush("MEETING_ENDED");
  assert.equal(controller.hasActiveSegment(), false);
  assert.equal(attempts, 2);
  assert.equal(publishedSegmentIds.length, 1);
});

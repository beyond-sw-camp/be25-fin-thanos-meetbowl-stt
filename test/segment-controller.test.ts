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
    organizationId: "organization-id",
    getParticipantUserIds: () => ["participant-id"],
    meetingStartedAtMs: 1000,
    noDeltaTimeoutMs: 5,
    translationGraceMs: 5,
    maxSegmentDurationMs: 1000,
    nextSequence: () => 0,
    correlationId: "correlation-id",
    logger: {
      info() {}
    },
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
    organizationId: "organization-id",
    getParticipantUserIds: () => ["participant-id"],
    meetingStartedAtMs: 1000,
    noDeltaTimeoutMs: 1000,
    translationGraceMs: 1000,
    maxSegmentDurationMs: 1000,
    nextSequence: () => 3,
    correlationId: "correlation-id",
    logger: {
      info() {}
    },
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

test("fills endedAtMs when finalized without stopSpeech", async () => {
  const finalized: TranscriptSegment[] = [];
  const controller = new SegmentController({
    meetingId: "meeting-id",
    sessionId: "session-id",
    organizationId: "organization-id",
    getParticipantUserIds: () => ["participant-id"],
    meetingStartedAtMs: 1000,
    noDeltaTimeoutMs: 1000,
    translationGraceMs: 5,
    maxSegmentDurationMs: 1000,
    nextSequence: () => 7,
    correlationId: "correlation-id",
    logger: {
      info() {}
    },
    captionPublisher: {
      async publishCaption() {}
    },
    finalSegmentPublisher: {
      async publishFinalSegment(segment) {
        finalized.push(segment);
      }
    }
  });

  controller.startSpeech(1100);
  controller.appendDelta("sourceTranscript", "끝나지 않은 문장", 1110);
  await controller.flush("MANUAL_FLUSH");

  assert.equal(finalized.length, 1);
  assert.equal(typeof finalized[0]?.endedAtMs, "number");
  assert.ok((finalized[0]?.endedAtMs ?? 0) >= (finalized[0]?.startedAtMs ?? 0));
});

test("captures participant user IDs at finalization time", async () => {
  const finalized: TranscriptSegment[] = [];
  let participantUserIds = ["participant-a"];
  const controller = new SegmentController({
    meetingId: "meeting-id",
    sessionId: "session-id",
    organizationId: "organization-id",
    getParticipantUserIds: () => [...participantUserIds],
    meetingStartedAtMs: 1000,
    noDeltaTimeoutMs: 1000,
    translationGraceMs: 1000,
    maxSegmentDurationMs: 1000,
    nextSequence: () => 8,
    correlationId: "correlation-id",
    logger: {
      info() {}
    },
    captionPublisher: {
      async publishCaption() {}
    },
    finalSegmentPublisher: {
      async publishFinalSegment(segment) {
        finalized.push(segment);
      }
    }
  });

  controller.startSpeech(1100);
  controller.appendDelta("sourceTranscript", "참가자 변경 후 확정", 1110);
  participantUserIds = ["participant-a", "participant-b"];
  await controller.flush("MANUAL_FLUSH");

  assert.deepEqual(finalized[0]?.participantUserIds, [
    "participant-a",
    "participant-b"
  ]);
});

test("trims overlapping prefix from the next finalized segment", async () => {
  const finalized: TranscriptSegment[] = [];
  let sequence = 0;
  const controller = new SegmentController({
    meetingId: "meeting-id",
    sessionId: "session-id",
    organizationId: "organization-id",
    getParticipantUserIds: () => ["participant-id"],
    meetingStartedAtMs: 1000,
    noDeltaTimeoutMs: 5,
    translationGraceMs: 5,
    maxSegmentDurationMs: 1000,
    nextSequence: () => sequence++,
    correlationId: "correlation-id",
    logger: {
      info() {}
    },
    captionPublisher: {
      async publishCaption() {}
    },
    finalSegmentPublisher: {
      async publishFinalSegment(segment) {
        finalized.push(segment);
      }
    }
  });

  controller.startSpeech(1100);
  controller.appendDelta(
    "sourceTranscript",
    "이번 주 액션 아이템을 검토하겠습니다",
    1110
  );
  controller.stopSpeech(1200);
  await new Promise((resolve) => setTimeout(resolve, 20));

  controller.startSpeech(1300);
  controller.appendDelta(
    "sourceTranscript",
    "액션 아이템을 검토하겠습니다 그리고 일정도 공유하겠습니다",
    1310
  );
  controller.stopSpeech(1400);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(finalized.length, 2);
  assert.equal(finalized[1]?.text, "그리고 일정도 공유하겠습니다");
});

test("drops a fully overlapped finalized segment", async () => {
  const finalized: TranscriptSegment[] = [];
  let sequence = 0;
  const controller = new SegmentController({
    meetingId: "meeting-id",
    sessionId: "session-id",
    organizationId: "organization-id",
    getParticipantUserIds: () => ["participant-id"],
    meetingStartedAtMs: 1000,
    noDeltaTimeoutMs: 5,
    translationGraceMs: 5,
    maxSegmentDurationMs: 1000,
    nextSequence: () => sequence++,
    correlationId: "correlation-id",
    logger: {
      info() {}
    },
    captionPublisher: {
      async publishCaption() {}
    },
    finalSegmentPublisher: {
      async publishFinalSegment(segment) {
        finalized.push(segment);
      }
    }
  });

  controller.startSpeech(1100);
  controller.appendDelta("sourceTranscript", "안녕하세요 오늘 일정 공유드리겠습니다", 1110);
  controller.stopSpeech(1200);
  await new Promise((resolve) => setTimeout(resolve, 20));

  controller.startSpeech(1300);
  controller.appendDelta("sourceTranscript", "오늘 일정 공유드리겠습니다", 1310);
  controller.stopSpeech(1400);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]?.text, "안녕하세요 오늘 일정 공유드리겠습니다");
});

test("drops a near-duplicate finalized segment with minor wording differences", async () => {
  const finalized: TranscriptSegment[] = [];
  let sequence = 0;
  const controller = new SegmentController({
    meetingId: "meeting-id",
    sessionId: "session-id",
    organizationId: "organization-id",
    getParticipantUserIds: () => ["participant-id"],
    meetingStartedAtMs: 1000,
    noDeltaTimeoutMs: 5,
    translationGraceMs: 5,
    maxSegmentDurationMs: 1000,
    nextSequence: () => sequence++,
    correlationId: "correlation-id",
    logger: {
      info() {}
    },
    captionPublisher: {
      async publishCaption() {}
    },
    finalSegmentPublisher: {
      async publishFinalSegment(segment) {
        finalized.push(segment);
      }
    }
  });

  controller.startSpeech(1100);
  controller.appendDelta("sourceTranscript", "오늘 회의 일정을 먼저 공유하겠습니다", 1110);
  controller.stopSpeech(1200);
  await new Promise((resolve) => setTimeout(resolve, 20));

  controller.startSpeech(1800);
  controller.appendDelta("sourceTranscript", "오늘 회의 일정 먼저 공유하겠습니다", 1810);
  controller.stopSpeech(1900);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]?.text, "오늘 회의 일정을 먼저 공유하겠습니다");
});

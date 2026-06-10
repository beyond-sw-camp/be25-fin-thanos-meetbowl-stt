import assert from "node:assert/strict";
import test from "node:test";

import { buildDisplayTexts } from "../src/transcript/display-text-builder.js";
import type { ActiveTranscriptSegment } from "../src/transcript/transcript-types.js";

function segment(
  values: Partial<ActiveTranscriptSegment>
): ActiveTranscriptSegment {
  return {
    segmentId: "segment-id",
    meetingId: "meeting-id",
    sessionId: "session-id",
    startedAtMs: 0,
    sourceCandidateKo: "",
    sourceCandidateEn: "",
    koTargetOutput: "",
    enTargetOutput: "",
    lastDeltaAtMs: 0,
    ...values
  };
}

test("uses Korean source as koText and English translation as enText", () => {
  assert.deepEqual(
    buildDisplayTexts(
      segment({
        sourceCandidateKo: "오늘 배포 일정을 확인합니다.",
        koTargetOutput: "오늘 배포 일정을 확인합니다.",
        enTargetOutput: "Let's review the deployment schedule."
      })
    ),
    {
      sourceLanguage: "ko",
      sourceText: "오늘 배포 일정을 확인합니다.",
      koText: "오늘 배포 일정을 확인합니다.",
      enText: "Let's review the deployment schedule."
    }
  );
});

test("uses English source as enText and Korean translation as koText", () => {
  assert.deepEqual(
    buildDisplayTexts(
      segment({
        sourceCandidateKo: "I have the deployment checklist.",
        koTargetOutput: "배포 체크리스트를 가지고 있습니다.",
        enTargetOutput: "I have the deployment checklist."
      })
    ),
    {
      sourceLanguage: "en",
      sourceText: "I have the deployment checklist.",
      koText: "배포 체크리스트를 가지고 있습니다.",
      enText: "I have the deployment checklist."
    }
  );
});

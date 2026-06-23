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
    organizationId: "organization-id",
    participantUserIds: [],
    startedAtMs: 0,
    sourceTranscript: "",
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

test("does not mirror Korean source into English tab when translation is missing", () => {
  assert.deepEqual(
    buildDisplayTexts(
      segment({
        sourceTranscript: "오늘 배포 일정을 확인합니다.",
        sourceCandidateKo: "오늘 배포 일정을 확인합니다.",
        koTargetOutput: "오늘 배포 일정을 확인합니다.",
        enTargetOutput: ""
      })
    ),
    {
      sourceLanguage: "ko",
      sourceText: "오늘 배포 일정을 확인합니다.",
      koText: "오늘 배포 일정을 확인합니다.",
      enText: ""
    }
  );
});

test("does not mirror English source into Korean tab when translation is missing", () => {
  assert.deepEqual(
    buildDisplayTexts(
      segment({
        sourceTranscript: "I have the deployment checklist.",
        sourceCandidateEn: "I have the deployment checklist.",
        koTargetOutput: "",
        enTargetOutput: "I have the deployment checklist."
      })
    ),
    {
      sourceLanguage: "en",
      sourceText: "I have the deployment checklist.",
      koText: "",
      enText: "I have the deployment checklist."
    }
  );
});

test("prefers transcription source over translation-derived candidates", () => {
  assert.deepEqual(
    buildDisplayTexts(
      segment({
        sourceTranscript: "회의는 내일 오전 10시에 시작합니다.",
        sourceCandidateKo: "회의는 내일 오전 10시에 시작합니다.",
        sourceCandidateEn: "The meeting starts at 10 a.m. tomorrow.",
        koTargetOutput: "회의는 내일 오전 10시에 시작합니다.",
        enTargetOutput: "The meeting starts at 10 a.m. tomorrow."
      })
    ),
    {
      sourceLanguage: "ko",
      sourceText: "회의는 내일 오전 10시에 시작합니다.",
      koText: "회의는 내일 오전 10시에 시작합니다.",
      enText: "The meeting starts at 10 a.m. tomorrow."
    }
  );
});

test("recovers Korean source when transcription result matches English translation", () => {
  assert.deepEqual(
    buildDisplayTexts(
      segment({
        sourceTranscript: "Let's review the deployment schedule.",
        sourceCandidateKo: "오늘 배포 일정을 확인합니다.",
        sourceCandidateEn: "Let's review the deployment schedule.",
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

test("falls back to readable target texts when source candidates are ambiguous", () => {
  assert.deepEqual(
    buildDisplayTexts(
      segment({
        sourceCandidateKo: "覚えても",
        sourceCandidateEn: "ブラジル",
        koTargetOutput: "기억해도",
        enTargetOutput: "Even if you remember it"
      })
    ),
    {
      sourceLanguage: "unknown",
      sourceText: "",
      koText: "기억해도",
      enText: "Even if you remember it"
    }
  );
});

test("does not copy translated text into source tab when only one target output exists", () => {
  assert.deepEqual(
    buildDisplayTexts(
      segment({
        koTargetOutput: "한글 번역만 도착했습니다."
      })
    ),
    {
      sourceLanguage: "unknown",
      sourceText: "",
      koText: "한글 번역만 도착했습니다.",
      enText: ""
    }
  );
});

test("strips mixed-language noise from Korean and English target tabs", () => {
  assert.deepEqual(
    buildDisplayTexts(
      segment({
        sourceTranscript: "오늘 배포 schedule 확인합니다.",
        sourceCandidateKo: "오늘 배포 schedule 확인합니다.",
        koTargetOutput: "오늘 배포 schedule 확인합니다.",
        enTargetOutput: "Let's 확인 deploy schedule."
      })
    ),
    {
      sourceLanguage: "ko",
      sourceText: "오늘 배포 schedule 확인합니다.",
      koText: "오늘 배포 확인합니다.",
      enText: "Let's deploy schedule."
    }
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { detectSourceLanguage } from "../src/transcript/language-detector.js";

test("detects Korean and English source text", () => {
  assert.equal(detectSourceLanguage("오늘 배포 일정을 확인합니다"), "ko");
  assert.equal(
    detectSourceLanguage("We should review the deployment schedule"),
    "en"
  );
});

test("returns unknown for short or ambiguous text", () => {
  assert.equal(detectSourceLanguage("OK"), "unknown");
  assert.equal(detectSourceLanguage("1234"), "unknown");
});

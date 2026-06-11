import { detectSourceLanguage } from "./language-detector.js";
import type {
  ActiveTranscriptSegment,
  SourceLanguage
} from "./transcript-types.js";

export interface DisplayTexts {
  sourceLanguage: SourceLanguage;
  sourceText: string;
  koText: string;
  enText: string;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// KO/EN 세션이 각각 낸 원문 후보 중 실제 발화에 더 가까운 문자열을 고른다.
function chooseSourceText(
  sourceTranscript: string,
  sourceCandidateKo: string,
  sourceCandidateEn: string
): string {
  const transcript = normalize(sourceTranscript);
  if (transcript) {
    return transcript;
  }

  const koCandidate = normalize(sourceCandidateKo);
  const enCandidate = normalize(sourceCandidateEn);

  if (!koCandidate) {
    return enCandidate;
  }
  if (!enCandidate) {
    return koCandidate;
  }

  const koLanguage = detectSourceLanguage(koCandidate);
  const enLanguage = detectSourceLanguage(enCandidate);

  if (koLanguage === "ko" && enLanguage !== "ko") {
    return koCandidate;
  }
  if (enLanguage === "en" && koLanguage !== "en") {
    return enCandidate;
  }
  if (koLanguage === "unknown" && enLanguage !== "unknown") {
    return enCandidate;
  }
  if (enLanguage === "unknown" && koLanguage !== "unknown") {
    return koCandidate;
  }

  return koCandidate.length >= enCandidate.length ? koCandidate : enCandidate;
}

export function buildDisplayTexts(
  segment: ActiveTranscriptSegment
): DisplayTexts {
  // STT가 우선이고, 번역은 있을 때만 덧붙인다.
  const sourceText = chooseSourceText(
    segment.sourceTranscript,
    segment.sourceCandidateKo,
    segment.sourceCandidateEn
  );
  const koTargetOutput = normalize(segment.koTargetOutput);
  const enTargetOutput = normalize(segment.enTargetOutput);
  const sourceLanguage = detectSourceLanguage(sourceText);

  if (!sourceText) {
    return {
      sourceLanguage: "unknown",
      sourceText: "",
      koText: "",
      enText: ""
    };
  }

  if (sourceLanguage === "ko") {
    return {
      sourceLanguage,
      sourceText,
      koText: sourceText,
      enText: enTargetOutput || sourceText
    };
  }
  if (sourceLanguage === "en") {
    return {
      sourceLanguage,
      sourceText,
      koText: koTargetOutput || sourceText,
      enText: sourceText
    };
  }
  return {
    sourceLanguage,
    sourceText,
    koText: koTargetOutput || sourceText,
    enText: enTargetOutput || sourceText
  };
}

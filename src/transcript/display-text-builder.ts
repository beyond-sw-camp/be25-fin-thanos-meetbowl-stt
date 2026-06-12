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
  // provider가 보낸 공백 흔들림을 화면 표시 전에 정리한다.
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
    // transcription provider가 준 원문이 있으면 가장 신뢰할 수 있는 표시값으로 본다.
    return transcript;
  }

  const koCandidate = normalize(sourceCandidateKo);
  const enCandidate = normalize(sourceCandidateEn);

  if (!koCandidate) {
    // 한국어 후보가 없으면 영어 후보라도 원문으로 사용한다.
    return enCandidate;
  }
  if (!enCandidate) {
    // 영어 후보가 없으면 한국어 후보를 사용한다.
    return koCandidate;
  }

  // 각 후보의 언어를 대충 판별해 실제 발화 언어에 더 가까운 쪽을 고른다.
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
    // 아직 텍스트가 없더라도 UI가 깨지지 않도록 빈 값을 반환한다.
    return {
      sourceLanguage: "unknown",
      sourceText: "",
      koText: "",
      enText: ""
    };
  }

  if (sourceLanguage === "ko") {
    // 한국어 발화는 sourceText를 그대로 보여주고, 영어는 번역 결과를 우선한다.
    return {
      sourceLanguage,
      sourceText,
      koText: sourceText,
      enText: enTargetOutput || sourceText
    };
  }
  if (sourceLanguage === "en") {
    // 영어 발화는 sourceText를 그대로 보여주고, 한국어는 번역 결과를 우선한다.
    return {
      sourceLanguage,
      sourceText,
      koText: koTargetOutput || sourceText,
      enText: sourceText
    };
  }
  return {
    // 언어 판별이 애매하면 원문과 번역 후보를 둘 다 fallback으로 사용한다.
    sourceLanguage,
    sourceText,
    koText: koTargetOutput || sourceText,
    enText: enTargetOutput || sourceText
  };
}

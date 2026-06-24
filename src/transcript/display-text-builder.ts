/**
 * 전사(Transcription) 엔진과 번역(Translation) 엔진으로부터 수신된 여러 텍스트 후보 중
 * 사용자에게 실제로 표시할 최적의 텍스트를 결정하고 가공하는 빌더 모듈입니다.
 */
import { detectSourceLanguage } from "./language-detector.js";
import type {
  ActiveTranscriptSegment,
  SourceLanguage
} from "./transcript-types.js";

export interface DisplayTexts {
  /** 실제 발화된 것으로 판별된 원문 언어 */
  sourceLanguage: SourceLanguage;
  /** 사용자 화면의 메인 자막 영역에 표시될 텍스트 */
  sourceText: string;
  /** 한국어 탭 또는 검색용으로 사용될 한국어 최종 텍스트 */
  koText: string;
  /** 영어 탭 또는 검색용으로 사용될 영어 최종 텍스트 */
  enText: string;
}

/** 불필요한 공백을 제거하고 텍스트를 정규화합니다. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeTargetText(text: string, targetLanguage: "ko" | "en"): string {
  const normalized = normalize(text);
  if (!normalized) return "";

  const cleaned =
    targetLanguage === "ko"
      ? normalized.replace(/[A-Za-z]/g, "")
      : normalized.replace(/[\uAC00-\uD7A3]/g, "");

  return normalize(cleaned);
}

function sameNormalizedText(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}

function selectFallbackSourceCandidate(
  sourceCandidateKo: string,
  sourceCandidateEn: string
): string {
  const koCandidate = normalize(sourceCandidateKo);
  const enCandidate = normalize(sourceCandidateEn);

  if (!koCandidate) return enCandidate;
  if (!enCandidate) return koCandidate;

  const koLanguage = detectSourceLanguage(koCandidate);
  const enLanguage = detectSourceLanguage(enCandidate);

  if (koLanguage === "ko" && enLanguage !== "ko") return koCandidate;
  if (enLanguage === "en" && koLanguage !== "en") return enCandidate;

  return "";
}

function detectTranslatedTranscriptFallback(
  sourceTranscript: string,
  sourceCandidateKo: string,
  sourceCandidateEn: string,
  koTargetOutput: string,
  enTargetOutput: string
): string {
  const transcript = normalize(sourceTranscript);
  if (!transcript) return "";

  const koCandidate = normalize(sourceCandidateKo);
  const enCandidate = normalize(sourceCandidateEn);
  const koTarget = sanitizeTargetText(koTargetOutput, "ko");
  const enTarget = sanitizeTargetText(enTargetOutput, "en");

  const transcriptLanguage = detectSourceLanguage(transcript);
  const koCandidateLanguage = detectSourceLanguage(koCandidate);
  const enCandidateLanguage = detectSourceLanguage(enCandidate);

  /**
   * OpenAI 전사 결과가 실제 원문이 아니라 번역문으로 내려오는 경우가 있어,
   * 번역 세션의 source 후보/target 결과와 충돌하면 원문 후보를 우선한다.
   */
  if (
    transcriptLanguage === "en" &&
    koCandidateLanguage === "ko" &&
    koCandidate &&
    sameNormalizedText(koCandidate, koTarget) &&
    enTarget &&
    sameNormalizedText(transcript, enTarget)
  ) {
    return koCandidate;
  }

  return "";
}

/** 
 * 여러 엔진이 제공하는 원문 후보 중 가장 신뢰도가 높은 텍스트를 선택합니다.
 * 우선순위: 1. 전용 전사 엔진 결과 > 2. 타겟 언어 판별 결과에 따른 번역 엔진 입력 원문
 */
function chooseSourceText(
  sourceTranscript: string,
  sourceCandidateKo: string,
  sourceCandidateEn: string,
  koTargetOutput: string,
  enTargetOutput: string
): string {
  const transcript = normalize(sourceTranscript);
  if (transcript) {
    const recoveredSource = detectTranslatedTranscriptFallback(
      transcript,
      sourceCandidateKo,
      sourceCandidateEn,
      koTargetOutput,
      enTargetOutput
    );
    if (recoveredSource) return recoveredSource;
    return transcript;
  }

  return selectFallbackSourceCandidate(sourceCandidateKo, sourceCandidateEn);
}

function chooseReadableFallback(
  koTargetOutput: string,
  enTargetOutput: string
): Pick<DisplayTexts, "sourceLanguage" | "sourceText" | "koText" | "enText"> {
  const koText = sanitizeTargetText(koTargetOutput, "ko");
  const enText = sanitizeTargetText(enTargetOutput, "en");

  if (koText && enText) {
    return {
      sourceLanguage: "unknown",
      sourceText: "",
      koText,
      enText
    };
  }

  if (koText) {
    return {
      sourceLanguage: "unknown",
      sourceText: "",
      koText,
      enText: ""
    };
  }

  if (enText) {
    return {
      sourceLanguage: "unknown",
      sourceText: "",
      koText: "",
      enText
    };
  }

  return { sourceLanguage: "unknown", sourceText: "", koText: "", enText: "" };
}

/** 
 * 활성 세그먼트 데이터를 바탕으로 화면 표시용 텍스트 세트를 구축합니다.
 * @param segment 현재 분석 중인 발화 세그먼트
 */
export function buildDisplayTexts(
  segment: ActiveTranscriptSegment
): DisplayTexts {
  const sourceText = chooseSourceText(
    segment.sourceTranscript,
    segment.sourceCandidateKo,
    segment.sourceCandidateEn,
    segment.koTargetOutput,
    segment.enTargetOutput
  );
  const koTargetOutput = sanitizeTargetText(segment.koTargetOutput, "ko");
  const enTargetOutput = sanitizeTargetText(segment.enTargetOutput, "en");
  const sourceLanguage = detectSourceLanguage(sourceText);

  if (!sourceText) {
    return chooseReadableFallback(koTargetOutput, enTargetOutput);
  }

  /**
   * [언어별 텍스트 매핑 전략]
   * - 발화 언어가 한국어인 경우: 원문을 한국어 텍스트로, 번역 엔진 결과를 영어 텍스트로 할당
   * - 발화 언어가 영어인 경우: 원문을 영어 텍스트로, 번역 엔진 결과를 한국어 텍스트로 할당
   */
  if (sourceLanguage === "ko") {
    return {
      sourceLanguage,
      sourceText,
      koText: sanitizeTargetText(sourceText, "ko"),
      enText: enTargetOutput
    };
  }
  if (sourceLanguage === "en") {
    return {
      sourceLanguage,
      sourceText,
      koText: koTargetOutput,
      enText: sanitizeTargetText(sourceText, "en")
    };
  }
  
  // 언어 판별 실패 시에도 원문 탭에는 확인된 source만 남기고,
  // 번역 탭에는 각 타깃 언어 결과만 싣는다.
  return {
    sourceLanguage,
    sourceText,
    koText: koTargetOutput,
    enText: enTargetOutput
  };
}

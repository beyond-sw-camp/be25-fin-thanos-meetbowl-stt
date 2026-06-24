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

/** 
 * 여러 엔진이 제공하는 원문 후보 중 가장 신뢰도가 높은 텍스트를 선택합니다.
 * 우선순위: 1. 전용 전사 엔진 결과 > 2. 타겟 언어 판별 결과에 따른 번역 엔진 입력 원문
 */
function chooseSourceText(
  sourceTranscript: string,
  sourceCandidateKo: string,
  sourceCandidateEn: string
): string {
  const transcript = normalize(sourceTranscript);
  // 1. 핵심 전사 엔진(Transcription)의 결과가 있다면 최우선 채택
  if (transcript) return transcript;

  const koCandidate = normalize(sourceCandidateKo);
  const enCandidate = normalize(sourceCandidateEn);

  if (!koCandidate) return enCandidate;
  if (!enCandidate) return koCandidate;

  // 2. 언어 판별 휴리스틱을 적용하여 실제 발화 언어와 일치하는 후보 선택
  const koLanguage = detectSourceLanguage(koCandidate);
  const enLanguage = detectSourceLanguage(enCandidate);

  if (koLanguage === "ko" && enLanguage !== "ko") return koCandidate;
  if (enLanguage === "en" && koLanguage !== "en") return enCandidate;

  // 3. 둘 다 모호하면 원문으로 단정하지 않는다.
  return "";
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
    segment.sourceCandidateEn
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

/**
 * 텍스트 데이터의 문자 구성을 분석하여 발화 언어(한국어, 영어)를 추정하는 유틸리티 모듈입니다.
 * 별도의 무거운 엔진 없이 정규표현식 기반의 휴리스틱을 사용하여 빠르게 분류합니다.
 */
import type { SourceLanguage } from "./transcript-types.js";

/** 
 * 입력 텍스트 내의 한글과 영문 비율을 계산하여 언어를 판별합니다.
 * @param sourceText 분석할 대상 문자열
 * @returns 판별된 언어 코드 (ko, en, unknown)
 */
export function detectSourceLanguage(sourceText: string): SourceLanguage {
  // 1. 문자 집합별 출현 빈도 계산
  const hangulCount = sourceText.match(/[가-힣]/g)?.length ?? 0;
  const latinCount = sourceText.match(/[a-zA-Z]/g)?.length ?? 0;

  /**
   * [판별 로직]
   * - 한글이 2글자 이상 포함되어 있고 영문보다 많으면 한국어로 간주합니다.
   * - 영문이 4글자 이상 포함되어 있고 한글보다 많으면 영어로 간주합니다.
   * - 데이터가 너무 짧거나(예: 'OK', '네') 비율이 모호하면 unknown을 반환합니다.
   */
  if (hangulCount >= 2 && hangulCount >= latinCount) {
    return "ko";
  }
  if (latinCount >= 4 && latinCount > hangulCount) {
    return "en";
  }
  
  return "unknown";
}

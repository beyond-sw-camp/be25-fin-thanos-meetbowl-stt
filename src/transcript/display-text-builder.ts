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

export function buildDisplayTexts(
  segment: ActiveTranscriptSegment
): DisplayTexts {
  const sourceText =
    normalize(segment.sourceCandidateKo) ||
    normalize(segment.sourceCandidateEn);
  const koTargetOutput = normalize(segment.koTargetOutput);
  const enTargetOutput = normalize(segment.enTargetOutput);
  const sourceLanguage = detectSourceLanguage(sourceText);

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

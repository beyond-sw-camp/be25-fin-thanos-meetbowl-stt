import type { SourceLanguage } from "./transcript-types.js";

export function detectSourceLanguage(sourceText: string): SourceLanguage {
  const hangulCount = sourceText.match(/[가-힣]/g)?.length ?? 0;
  const latinCount = sourceText.match(/[a-zA-Z]/g)?.length ?? 0;

  if (hangulCount >= 2 && hangulCount >= latinCount) {
    return "ko";
  }
  if (latinCount >= 4 && latinCount > hangulCount) {
    return "en";
  }
  return "unknown";
}

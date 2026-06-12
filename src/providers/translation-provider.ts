export type TranslationTargetLanguage = "ko" | "en";

export interface TranslationSessionHandlers {
  onSourceDelta(delta: string): void;
  onTranslationDelta(delta: string): void;
  onError(error: Error): void;
}

export interface TranslationSession {
  connect(): Promise<void>;
  appendAudio(samples: Int16Array): void;
  close(): Promise<void>;
}

export interface TranslationProvider {
  createSession(
    targetLanguage: TranslationTargetLanguage,
    handlers: TranslationSessionHandlers
  ): TranslationSession;
}

export type TranscriptionDelay =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface TranscriptionSessionHandlers {
  onTranscriptDelta(delta: string): void;
  onTranscriptCompleted(transcript: string): void;
  onError(error: Error): void;
}

export interface TranscriptionSession {
  connect(): Promise<void>;
  appendAudio(samples: Int16Array): void;
  commitAudio(): void;
  close(): Promise<void>;
}

export interface TranscriptionProvider {
  createSession(
    handlers: TranscriptionSessionHandlers
  ): TranscriptionSession;
}

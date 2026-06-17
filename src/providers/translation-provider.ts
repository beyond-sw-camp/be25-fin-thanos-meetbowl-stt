/**
 * STT(전사) 및 번역 엔진 연동을 위한 추상 인터페이스 및 타입 정의 파일입니다.
 * 특정 업체(OpenAI 등)의 SDK에 의존하지 않는 표준 계약을 정의합니다.
 */

// cspell:ignore xhigh LIVEKIT meetbowl

/** 번역 엔진 결과의 대상 언어입니다. */
export type TranslationTargetLanguage = "ko" | "en";

/** 실시간 번역 세션에서 발생하는 이벤트를 수신하는 핸들러 인터페이스입니다. */
export interface TranslationSessionHandlers {
  /** 번역 엔진이 인식한 원문 텍스트 조각을 수신합니다. */
  onSourceDelta(delta: string): void;
  /** 번역된 결과 텍스트 조각을 수신합니다. */
  onTranslationDelta(delta: string): void;
  /** 엔진과의 통신 중 발생한 오류를 수신합니다. */
  onError(error: Error): void;
}

/** 런타임에 유지되는 실시간 번역 세션 객체의 인터페이스입니다. */
export interface TranslationSession {
  /** 외부 엔진 서버와 연결을 수립합니다. */
  connect(): Promise<void>;
  /** 분석할 오디오 데이터를 엔진에 전송합니다. */
  appendAudio(samples: Int16Array): void;
  /** 세션을 종료하고 리소스를 해제합니다. */
  close(): Promise<void>;
}

/** 각 참가자 트랙별로 번역 세션을 생성하는 프로바이더 인터페이스입니다. */
export interface TranslationProvider {
  createSession(
    targetLanguage: TranslationTargetLanguage,
    handlers: TranslationSessionHandlers
  ): TranslationSession;
}

/** 전사 결과 생성 시의 지연 시간 정책 수준입니다. */
export type TranscriptionDelay =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

/** 실시간 전사 세션의 이벤트를 처리하는 핸들러 인터페이스입니다. */
export interface TranscriptionSessionHandlers {
  /** 실시간으로 생성 중인 자막 조각을 수신합니다. */
  onTranscriptDelta(delta: string): void;
  /** 발화가 완료되어 확정된 문장 전체를 수신합니다. */
  onTranscriptCompleted(transcript: string): void;
  /** 전사 엔진 오류를 수신합니다. */
  onError(error: Error): void;
}

/** 런타임 전사 세션 객체의 인터페이스입니다. */
export interface TranscriptionSession {
  connect(): Promise<void>;
  appendAudio(samples: Int16Array): void;
  /** 현재까지의 오디오 데이터를 확정하도록 엔진에 요청합니다. */
  commitAudio(): void;
  close(): Promise<void>;
}

/** 전사 세션을 생성하는 프로바이더 인터페이스입니다. */
export interface TranscriptionProvider {
  createSession(
    handlers: TranscriptionSessionHandlers
  ): TranscriptionSession;
}

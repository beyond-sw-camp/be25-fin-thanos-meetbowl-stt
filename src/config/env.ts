import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

// cspell:ignore xhigh LIVEKIT meetbowl

/**
 * [환경 변수 스키마 정의]
 * 서버 인프라, OpenAI API, 실시간 처리 타이밍 등 핵심 설정값을 정의합니다.
 */
const envSchema = z.object({
  /** 서버가 바인딩할 호스트 주소입니다. (예: 0.0.0.0은 모든 인터페이스 수신) */
  HOST: z.string({ error: undefined }).default("0.0.0.0"),
  /** 서버가 리스닝할 포트 번호입니다. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** 내부 서버 간 API 호출 시 인증에 사용되는 보안 토큰입니다. */
  INTERNAL_TOKEN: z.string({ error: undefined }).min(16),

  // --- OpenAI Realtime API 설정 ---
  /** OpenAI API 인증 키입니다. */
  OPENAI_API_KEY: z.string({ error: undefined }).min(1),
  /** 실시간 번역에 사용할 OpenAI 모델명입니다. */
  OPENAI_REALTIME_TRANSLATION_MODEL: z.string({ error: undefined }).default("gpt-realtime-translate"),
  /** 실시간 전사(STT)에 사용할 OpenAI 모델명입니다. */
  OPENAI_REALTIME_TRANSCRIPTION_MODEL: z.string({ error: undefined }).default("gpt-realtime-whisper"),
  /** 전사 결과 생성 시의 지연 시간 정책입니다. (예: low는 빠른 응답 위주) */
  OPENAI_REALTIME_TRANSCRIPTION_DELAY: z
    .enum(["minimal", "low", "medium", "high", "xhigh"])
    .default("low"),
  /** 실시간 번역 기능을 활성화할지 여부입니다. */
  ENABLE_TRANSLATION: booleanString,

  // --- 인프라 서비스 연결 설정 ---
  /** LiveKit 서버의 접속 URL입니다. */
  LIVEKIT_URL: z.string({ error: undefined }).url(),
  /** LiveKit API 키입니다. */
  LIVEKIT_API_KEY: z.string({ error: undefined }).min(1),
  /** LiveKit API 시크릿입니다. */
  LIVEKIT_API_SECRET: z.string({ error: undefined }).min(1),
  /** LiveKit Room 참여 시 사용할 에이전트 이름의 접두사입니다. */
  LIVEKIT_AGENT_IDENTITY_PREFIX: z.string({ error: undefined }).default("meetbowl-stt"),
  /** RabbitMQ 메시지 브로커 연결 URL입니다. */
  RABBITMQ_URL: z.string({ error: undefined }).url(),
  /** 최종 자막 데이터를 발행할 RabbitMQ 익스체인지 이름입니다. */
  RABBITMQ_EXCHANGE: z.string({ error: undefined }).default("meetbowl.topic"),
  /** Redis 서버 연결 URL입니다. */
  REDIS_URL: z.string({ error: undefined }).url(),
  /** 실시간 피드백 수신을 위한 Redis Stream 컨슈머 그룹명입니다. */
  REDIS_FEEDBACK_CONSUMER_GROUP: z.string({ error: undefined }).default("stt-feedback-relay"),
  /** Redis 컨슈머 그룹 내에서 이 서버 인스턴스를 식별할 이름입니다. */
  REDIS_FEEDBACK_CONSUMER_NAME: z
    .string({ error: undefined })
    .default(() => `stt-${process.pid}`),
  /** Redis Stream에 유지할 최대 이벤트 개수입니다. */
  REDIS_STREAM_MAX_LENGTH: positiveInteger.default(2000),

  // --- 실시간 자막 처리 및 타이밍 설정 ---
  /**
   * VAD(음성 활동 감지) 임계값입니다. 
   * 이 값보다 에너지가 작으면 무음으로 간주합니다. (0.0 ~ 1.0)
   */
  VAD_RMS_THRESHOLD: z.coerce.number().min(0).max(1).default(0.003),
  /**
   * 발화 종료 판정 무음 시간입니다. 
   * 마지막 음성 감지 후 이 시간만큼 조용하면 한 문장이 끝난 것으로 봅니다.
   */
  VAD_SILENCE_MS: positiveInteger.default(30),
  /**
   * 엔진 응답 타임아웃입니다. 
   * 텍스트 델타가 오지 않으면서 무음인 상태가 지속되면 세그먼트를 강제 마감합니다.
   */
  SEGMENT_NO_DELTA_TIMEOUT_MS: positiveInteger.default(1200),
  /**
   * 번역/전사 결과 동기화 유예 시간입니다. 
   * 최종 확정 전 늦게 도착하는 텍스트 조각들을 흡수하기 위해 대기합니다.
   */
  TRANSLATION_GRACE_MS: positiveInteger.default(500),
  /**
   * 한 세그먼트(문장)의 최대 지속 시간입니다. - 15초
   * 발화가 너무 길어지면 자막 가독성을 위해 이 시간 주기로 문장을 강제 분리합니다.
   */
  MAX_SEGMENT_DURATION_MS: positiveInteger.default(15000),
  /**
   * 화자 전환 유예 시간입니다.
   * Active Speaker가 바뀌었을 때 트랙을 즉시 바꾸지 않고 대기하여 짧은 잡음으로 인한 흔들림을 방지합니다.
   * 너무 짧으면 자막이 자주 쪼개지고, 너무 길면 다른 화자의 시작을 놓칠 수 있습니다.
   */
  TRACK_SWITCH_GRACE_MS: positiveInteger.default(10)
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => issue.path.join(".") || "environment")
      .join(", ");
    throw new Error(`Invalid STT environment variables: ${fields}`);
  }
  return result.data;
}

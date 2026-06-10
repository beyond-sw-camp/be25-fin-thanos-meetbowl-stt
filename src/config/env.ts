import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  INTERNAL_TOKEN: z.string().min(16),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_REALTIME_TRANSLATION_MODEL: z.string().default("gpt-realtime-translate"),
  LIVEKIT_URL: z.string().url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  LIVEKIT_AGENT_IDENTITY_PREFIX: z.string().default("meetbowl-stt"),
  RABBITMQ_URL: z.string().url(),
  RABBITMQ_EXCHANGE: z.string().default("meetbowl.topic"),
  REDIS_URL: z.string().url(),
  REDIS_FEEDBACK_CONSUMER_GROUP: z.string().default("stt-feedback-relay"),
  REDIS_FEEDBACK_CONSUMER_NAME: z
    .string()
    .default(() => `stt-${process.pid}`),
  REDIS_STREAM_MAX_LENGTH: positiveInteger.default(2000),
  VAD_RMS_THRESHOLD: z.coerce.number().min(0).max(1).default(0.015),
  VAD_SILENCE_MS: positiveInteger.default(700),
  SEGMENT_NO_DELTA_TIMEOUT_MS: positiveInteger.default(1200),
  TRANSLATION_GRACE_MS: positiveInteger.default(500),
  MAX_SEGMENT_DURATION_MS: positiveInteger.default(15000)
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

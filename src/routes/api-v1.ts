/**
 * API v1 라우터 정의 파일입니다.
 * 내부 관리용 REST 엔드포인트와 웹소켓 건강 체크 경로를 포함합니다.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AppRuntime } from "../app-runtime.js";
import {
  SessionNotFoundError,
  type SttSessionService
} from "../sessions/stt-session-service.js";

/**
 * [스키마 정의] 요청 데이터의 유효성을 검증하기 위한 Zod 객체들입니다.
 * 런타임 타입 안정성과 자동 밸리데이션 에러 처리를 보장합니다.
 */
const createSessionSchema = z.object({
  meetingId: z.string().uuid(),
  organizationId: z.string().uuid(),
  participantUserIds: z.array(z.string().uuid()).min(1),
  roomName: z.string().min(1).max(255),
  correlationId: z.string().uuid().optional(),
  recordingEnabled: z.boolean().optional()
});

const sessionParamsSchema = z.object({
  sessionId: z.string().uuid()
});

export interface ApiV1RoutesOptions {
  runtime?: AppRuntime;
}

/**
 * Fastify 라우트 플러그인 함수입니다.
 */
export const apiV1Routes: FastifyPluginAsync<ApiV1RoutesOptions> = async (
  app,
  options
) => {
  /** 헬스 체크 엔드포인트: 인프라 수준의 모니터링을 위한 최소 응답 경로입니다. */
  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/health/provider", async () => {
    return {
      status: options.runtime ? "configured" : "not-configured"
    };
  });

  /** 웹소켓 헬스 체크: 실시간 스트리밍 채널의 정상 작동 여부를 확인합니다. */
  app.get("/ws/health", { websocket: true }, (socket) => {
    socket.on("message", (message: Parameters<typeof socket.send>[0]) => {
      socket.send(message);
    });
  });

  if (!options.runtime) {
    return;
  }

  /**
   * [보안 미들웨어] 내부 서버 간 통신 보호를 위한 토큰 검증 로직입니다.
   * X-Internal-Token 헤더가 설정값과 일치하지 않으면 401 Unauthorized를 반환합니다.
   */
  const requireInternalToken = async (
    request: { headers: Record<string, unknown> },
    reply: { code(statusCode: number): { send(payload: unknown): unknown } }
  ) => {
    if (
      request.headers["x-internal-token"] !==
      options.runtime?.config.INTERNAL_TOKEN
    ) {
      return reply.code(401).send({
        success: false,
        error: {
          code: "COMMON_UNAUTHORIZED",
          message: "내부 인증이 필요합니다.",
          details: []
        }
      });
    }
  };

  const service = options.runtime.sessionService;

  /**
   * STT 세션 수동 생성 API
   * 주로 meetbowl-be가 회의 시작 전 예약을 위해 호출합니다.
   */
  app.post(
    "/sessions",
    { preHandler: requireInternalToken },
    async (request, reply) => {
      const parsed = createSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationError(reply, parsed.error);
      }
      return success(service.create(parsed.data));
    }
  );

  /**
   * STT 세션 멱등성 보장 시작 API
   * 회의실 입장 시 호출하며, 이미 세션이 존재하면 기존 정보를 반환하고 없으면 생성 후 시작합니다.
   */
  app.post(
    "/sessions/ensure-started",
    { preHandler: requireInternalToken },
    async (request, reply) => {
      const parsed = createSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return validationError(reply, parsed.error);
      }
      return success(await service.ensureStarted(parsed.data));
    }
  );

  /** 세션 시작: 지정된 세션의 LiveKit 연결 및 STT 프로세스를 가동합니다. */
  app.post(
    "/sessions/:sessionId/start",
    { preHandler: requireInternalToken },
    async (request, reply) =>
      handleSessionRequest(service, request.params, reply, (sessionId) =>
        service.start(sessionId)
      )
  );

  /** 세션 중지: 리소스를 정리하고 마지막 자막 데이터를 확정(Finalize)합니다. */
  app.post(
    "/sessions/:sessionId/stop",
    { preHandler: requireInternalToken },
    async (request, reply) =>
      handleSessionRequest(service, request.params, reply, (sessionId) =>
        service.stop(sessionId)
      )
  );

  /** 강제 자막 플러시: 진행 중인 미완성 세그먼트를 즉시 최종 데이터로 발행합니다. */
  app.post(
    "/sessions/:sessionId/transcripts/final/flush",
    { preHandler: requireInternalToken },
    async (request, reply) =>
      handleSessionRequest(service, request.params, reply, (sessionId) =>
        service.flush(sessionId)
      )
  );

  /** 세션 상태 조회: 현재 연결 상태 및 파이프라인 가동 정보를 확인합니다. */
  app.get(
    "/sessions/:sessionId",
    { preHandler: requireInternalToken },
    async (request, reply) =>
      handleSessionRequest(service, request.params, reply, async (sessionId) =>
        service.get(sessionId)
      )
  );
};

/**
 * 세션 요청 공통 핸들러
 * 파라미터 파싱 및 비즈니스 예외(SessionNotFoundError)를 표준 에러 응답으로 변환합니다.
 */
async function handleSessionRequest(
  _service: SttSessionService,
  params: unknown,
  reply: {
    code(statusCode: number): { send(payload: unknown): unknown };
  },
  handler: (sessionId: string) => Promise<unknown>
): Promise<unknown> {
  const parsed = sessionParamsSchema.safeParse(params);
  if (!parsed.success) {
    return validationError(reply, parsed.error);
  }
  try {
    return success(await handler(parsed.data.sessionId));
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return reply.code(404).send({
        success: false,
        error: {
          code: "STT_SESSION_NOT_FOUND",
          message: "STT 세션을 찾을 수 없습니다.",
          details: []
        }
      });
    }
    throw error;
  }
}

/** 공통 성공 응답 래퍼 */
function success(data: unknown): {
  success: true;
  data: unknown;
  message: null;
} {
  return { success: true, data, message: null };
}

/** 공통 검증 에러 응답 래퍼 */
function validationError(
  reply: {
    code(statusCode: number): { send(payload: unknown): unknown };
  },
  error: z.ZodError
): unknown {
  return reply.code(400).send({
    success: false,
    error: {
      code: "VALIDATION_FAILED",
      message: "요청 값이 올바르지 않습니다.",
      details: error.issues.map((issue) => ({
        field: issue.path.join("."),
        reason: issue.message
      }))
    }
  });
}

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AppRuntime } from "../app-runtime.js";
import {
  SessionNotFoundError,
  type SttSessionService
} from "../sessions/stt-session-service.js";

const createSessionSchema = z.object({
  meetingId: z.string().uuid(),
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

export const apiV1Routes: FastifyPluginAsync<ApiV1RoutesOptions> = async (
  app,
  options
) => {
  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/health/provider", async () => {
    return {
      status: options.runtime ? "configured" : "not-configured"
    };
  });

  app.get("/health/livekit", async () => {
    return {
      status: options.runtime ? "configured" : "not-configured"
    };
  });

  app.get("/ws/health", { websocket: true }, (socket) => {
    socket.on("message", (message: Parameters<typeof socket.send>[0]) => {
      socket.send(message);
    });
  });

  if (!options.runtime) {
    return;
  }

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

  app.post(
    "/sessions/:sessionId/start",
    { preHandler: requireInternalToken },
    async (request, reply) =>
      handleSessionRequest(service, request.params, reply, (sessionId) =>
        service.start(sessionId)
      )
  );

  app.post(
    "/sessions/:sessionId/stop",
    { preHandler: requireInternalToken },
    async (request, reply) =>
      handleSessionRequest(service, request.params, reply, (sessionId) =>
        service.stop(sessionId)
      )
  );

  app.post(
    "/sessions/:sessionId/transcripts/final/flush",
    { preHandler: requireInternalToken },
    async (request, reply) =>
      handleSessionRequest(service, request.params, reply, (sessionId) =>
        service.flush(sessionId)
      )
  );

  app.get(
    "/sessions/:sessionId",
    { preHandler: requireInternalToken },
    async (request, reply) =>
      handleSessionRequest(service, request.params, reply, async (sessionId) =>
        service.get(sessionId)
      )
  );
};

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

function success(data: unknown): {
  success: true;
  data: unknown;
  message: null;
} {
  return { success: true, data, message: null };
}

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

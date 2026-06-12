import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import type { AppRuntime } from "./app-runtime.js";
import { apiV1Routes } from "./routes/api-v1.js";

export interface CreateAppOptions {
  runtime?: AppRuntime;
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  // logger는 서버 전체 디버그/운영 로그를 위한 기본 Fastify logger를 사용한다.
  const app = Fastify({
    logger: true
  });

  // websocket 플러그인과 API 라우트를 앱 생성 시점에만 조립한다.
  void app.register(websocket);
  void app.register(apiV1Routes, {
    prefix: "/api/v1",
    runtime: options.runtime
  });

  return app;
}

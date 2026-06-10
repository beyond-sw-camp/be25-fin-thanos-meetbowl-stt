import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import type { AppRuntime } from "./app-runtime.js";
import { apiV1Routes } from "./routes/api-v1.js";

export interface CreateAppOptions {
  runtime?: AppRuntime;
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: true
  });

  void app.register(websocket);
  void app.register(apiV1Routes, {
    prefix: "/api/v1",
    runtime: options.runtime
  });

  return app;
}

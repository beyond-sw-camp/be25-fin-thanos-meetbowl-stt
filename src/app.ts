import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import { apiV1Routes } from "./routes/api-v1.js";

export function createApp(): FastifyInstance {
  const app = Fastify({
    logger: true
  });

  void app.register(websocket);
  void app.register(apiV1Routes, { prefix: "/api/v1" });

  return app;
}

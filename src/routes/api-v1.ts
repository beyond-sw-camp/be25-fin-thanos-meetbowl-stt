import type { FastifyPluginAsync } from "fastify";

export const apiV1Routes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return { status: "ok" };
  });

  app.get("/ws/health", { websocket: true }, (socket) => {
    socket.on("message", (message: Parameters<typeof socket.send>[0]) => {
      socket.send(message);
    });
  });
};

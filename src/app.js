import express from "express";

import { apiV1Router } from "./routes/api-v1.js";

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use("/api/v1", apiV1Router);

  return app;
}

export const app = createApp();

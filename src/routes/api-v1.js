import { Router } from "express";

export const apiV1Router = Router();

apiV1Router.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

import { loadEnvFile } from "node:process";

import { AppRuntime } from "./app-runtime.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";

try {
  // .env가 없으면 그냥 넘어가고, 다른 실제 parse 오류만 다시 던진다.
  loadEnvFile();
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT"
  ) {
    throw error;
  }
}

const config = loadConfig();
const bootstrapApp = createApp();
const runtime = new AppRuntime(config, bootstrapApp.log);
await bootstrapApp.close();

const app = createApp({ runtime });

try {
  // 외부 브로커 연결 후 Fastify listen 순서로 올린다.
  await runtime.start();
  app.addHook("onClose", async () => {
    await runtime.close();
  });
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  await runtime.close();
  process.exit(1);
}

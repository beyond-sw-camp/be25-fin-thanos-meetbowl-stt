import { loadEnvFile } from "node:process";

import { AppRuntime } from "./app-runtime.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";

try {
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

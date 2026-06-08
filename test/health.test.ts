import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.js";

test("GET /api/v1/health returns ok", async () => {
  const app = createApp();

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health"
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
  } finally {
    await app.close();
  }
});

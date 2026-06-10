import assert from "node:assert/strict";
import test from "node:test";

import type { AppRuntime } from "../src/app-runtime.js";
import { createApp } from "../src/app.js";

function fakeRuntime(): AppRuntime {
  return {
    config: {
      INTERNAL_TOKEN: "test-internal-token"
    },
    sessionService: {
      create(command: { meetingId: string; roomName: string }) {
        return {
          sessionId: "0de73437-e29f-4cb3-82fd-32b1478d66ad",
          meetingId: command.meetingId,
          roomName: command.roomName,
          status: "CREATED",
          pipelineCount: 0
        };
      }
    }
  } as unknown as AppRuntime;
}

test("POST /api/v1/sessions requires the internal token", async () => {
  const app = createApp({ runtime: fakeRuntime() });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: {
        meetingId: "4dd5adca-71ba-4204-a91f-e50b29bb83b9",
        roomName: "meeting-room"
      }
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "COMMON_UNAUTHORIZED");
  } finally {
    await app.close();
  }
});

test("POST /api/v1/sessions returns the standard success envelope", async () => {
  const app = createApp({ runtime: fakeRuntime() });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: {
        "x-internal-token": "test-internal-token"
      },
      payload: {
        meetingId: "4dd5adca-71ba-4204-a91f-e50b29bb83b9",
        roomName: "meeting-room"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      success: true,
      data: {
        sessionId: "0de73437-e29f-4cb3-82fd-32b1478d66ad",
        meetingId: "4dd5adca-71ba-4204-a91f-e50b29bb83b9",
        roomName: "meeting-room",
        status: "CREATED",
        pipelineCount: 0
      },
      message: null
    });
  } finally {
    await app.close();
  }
});

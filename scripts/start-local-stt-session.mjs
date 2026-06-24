import { randomUUID } from "node:crypto";

const roomName = process.argv[2] || "stt-test-room";
const meetingId = process.argv[3] || randomUUID();
const baseUrl = process.env.STT_BASE_URL || "http://localhost:3000/api/v1";
const internalToken = process.env.INTERNAL_TOKEN;

if (!internalToken) {
  console.error("INTERNAL_TOKEN is required.");
  process.exit(1);
}

// 내부 토큰을 가진 상태에서 session create -> start를 한 번에 수행한다.
const headers = {
  "content-type": "application/json",
  "x-internal-token": internalToken
};

const createResponse = await fetch(`${baseUrl}/sessions`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    meetingId,
    roomName,
    recordingEnabled: false
  })
});
const created = await readResponse(createResponse, "create");
const sessionId = created.data?.sessionId;

if (!sessionId) {
  throw new Error("Session create response did not include sessionId.");
}

const startResponse = await fetch(`${baseUrl}/sessions/${sessionId}/start`, {
  method: "POST",
  headers,
  body: "{}"
});
const started = await readResponse(startResponse, "start");

console.log(
  JSON.stringify(
    {
      sessionId,
      meetingId,
      roomName,
      status: started.data?.status,
      pipelineCount: started.data?.pipelineCount
    },
    null,
    2
  )
);

async function readResponse(response, operation) {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `Session ${operation} failed status=${response.status} body=${JSON.stringify(body)}`
    );
  }
  return body;
}

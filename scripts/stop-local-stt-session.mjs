const sessionId = process.argv[2];
const baseUrl = process.env.STT_BASE_URL || "http://localhost:3000/api/v1";
const internalToken = process.env.INTERNAL_TOKEN;

if (!sessionId) {
  console.error("Usage: npm run session:stop:local -- <session-id>");
  process.exit(1);
}
if (!internalToken) {
  console.error("INTERNAL_TOKEN is required.");
  process.exit(1);
}

// stop API는 마지막 segment flush까지 포함하는 종료 경로다.
const response = await fetch(`${baseUrl}/sessions/${sessionId}/stop`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-internal-token": internalToken
  },
  body: "{}"
});
const body = await response.json().catch(() => undefined);
if (!response.ok) {
  throw new Error(
    `Session stop failed status=${response.status} body=${JSON.stringify(body)}`
  );
}

console.log(JSON.stringify(body.data, null, 2));

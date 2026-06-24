import { readFile } from "node:fs/promises";
import path from "node:path";

const [audioPath, requestedModel] = process.argv.slice(2);

if (!audioPath) {
  console.error(
    "Usage: npm run probe:transcription -- <audio-file> [model]"
  );
  process.exit(1);
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("OPENAI_API_KEY is not configured");
  process.exit(1);
}

const model =
  requestedModel ??
  process.env.OPENAI_TRANSCRIPTION_PROBE_MODEL ??
  "whisper-1";
const absoluteAudioPath = path.resolve(audioPath);
const audio = await readFile(absoluteAudioPath);
const form = new FormData();

form.append(
  "file",
  new Blob([audio], { type: mimeTypeFor(absoluteAudioPath) }),
  path.basename(absoluteAudioPath)
);
form.append("model", model);
form.append("response_format", "json");

const startedAt = Date.now();
const response = await fetch(
  "https://api.openai.com/v1/audio/transcriptions",
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  }
);
const responseBody = await response.text();
const elapsedMs = Date.now() - startedAt;

if (!response.ok) {
  console.error(
    JSON.stringify(
      {
        success: false,
        status: response.status,
        model,
        elapsedMs,
        error: parseJson(responseBody)
      },
      null,
      2
    )
  );
  process.exit(1);
}

const result = parseJson(responseBody);
console.log(
  JSON.stringify(
    {
      success: true,
      status: response.status,
      model,
      elapsedMs,
      text: result?.text ?? null
    },
    null,
    2
  )
);

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mimeTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
      return "audio/mp4";
    case ".webm":
      return "audio/webm";
    case ".wav":
      return "audio/wav";
    default:
      return "application/octet-stream";
  }
}

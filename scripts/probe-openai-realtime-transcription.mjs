import { readFile } from "node:fs/promises";

import WebSocket from "ws";

const audioPath = process.argv[2];
const model =
  process.argv[3] ||
  process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ||
  "gpt-realtime-whisper";
const apiKey = process.env.OPENAI_API_KEY;

if (!audioPath) {
  console.error(
    "Usage: npm run probe:realtime-transcription -- <24-kHz-mono-pcm16.wav> [model]"
  );
  process.exit(1);
}
if (!apiKey) {
  console.error("OPENAI_API_KEY is required.");
  process.exit(1);
}

const wav = await readFile(audioPath);
const pcm = extractPcm16Mono24Khz(wav);
const url = new URL("wss://api.openai.com/v1/realtime");
url.searchParams.set("intent", "transcription");

const startedAt = Date.now();
const socket = new WebSocket(url, {
  headers: {
    Authorization: `Bearer ${apiKey}`
  }
});

let settled = false;
const timeout = setTimeout(() => finish(1, "Timed out waiting for transcript."), 30000);

socket.on("open", () => {
  console.log(`Connected transcriptionModel=${model}`);
  socket.send(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: {
              type: "audio/pcm",
              rate: 24000
            },
            transcription: {
              model,
              delay: "low"
            },
            turn_detection: null
          }
        }
      }
    })
  );
});

socket.on("message", async (raw) => {
  const event = JSON.parse(raw.toString());

  if (event.type === "session.updated") {
    console.log("Session configured");
    await streamAudio(socket, pcm);
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    return;
  }

  if (
    event.type === "conversation.item.input_audio_transcription.delta" &&
    event.delta
  ) {
    process.stdout.write(event.delta);
    return;
  }

  if (
    event.type === "conversation.item.input_audio_transcription.completed"
  ) {
    console.log(`\nTranscript: ${event.transcript || ""}`);
    finish(0, `Completed in ${Date.now() - startedAt}ms`);
    return;
  }

  if (event.type === "error") {
    finish(1, `OpenAI error: ${event.error?.message || "unknown error"}`);
  }
});

socket.on("error", (error) => finish(1, `WebSocket error: ${error.message}`));
socket.on("close", (code, reason) => {
  if (!settled) {
    finish(1, `WebSocket closed code=${code} reason=${reason.toString() || "none"}`);
  }
});

function finish(exitCode, message) {
  if (settled) {
    return;
  }
  settled = true;
  clearTimeout(timeout);
  console.log(message);
  socket.close();
  process.exitCode = exitCode;
}

async function streamAudio(ws, audio) {
  const bytesPer100Ms = 24000 * 2 / 10;
  for (let offset = 0; offset < audio.length; offset += bytesPer100Ms) {
    const chunk = audio.subarray(offset, offset + bytesPer100Ms);
    ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64")
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function extractPcm16Mono24Khz(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Expected a RIFF WAV file.");
  }

  let format;
  let data;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + chunkSize);
    if (chunkId === "fmt ") {
      format = {
        audioFormat: chunk.readUInt16LE(0),
        channels: chunk.readUInt16LE(2),
        sampleRate: chunk.readUInt32LE(4),
        bitsPerSample: chunk.readUInt16LE(14)
      };
    } else if (chunkId === "data") {
      data = chunk;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (
    !format ||
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 24000 ||
    format.bitsPerSample !== 16 ||
    !data
  ) {
    throw new Error("Expected mono 24-kHz 16-bit PCM WAV audio.");
  }
  return data;
}

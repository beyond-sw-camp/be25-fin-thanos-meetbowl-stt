import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  dispose
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

const audioPath = process.argv[2];
const roomName = process.argv[3] || "stt-test-room";
const liveKitUrl = process.env.LIVEKIT_URL || "http://localhost:7880";
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;

if (!audioPath) {
  console.error(
    "Usage: npm run probe:livekit-caption -- <24-kHz-mono-pcm16.wav> [room-name]"
  );
  process.exit(1);
}
if (!apiKey || !apiSecret) {
  console.error("LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required.");
  process.exit(1);
}

const pcm = extractPcm16Mono24Khz(await readFile(audioPath));
const identity = `caption-probe-${randomUUID()}`;
const token = new AccessToken(apiKey, apiSecret, {
  identity,
  name: "Caption Probe",
  ttl: "10m"
});
token.addGrant({
  roomJoin: true,
  room: roomName,
  canPublish: true,
  canSubscribe: true,
  canPublishData: true
});

const room = new Room();
const captionReceived = new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("Timed out waiting for caption.updated.")),
    20000
  );
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    if (topic !== "caption.updated") {
      return;
    }
    const event = JSON.parse(new TextDecoder().decode(payload));
    if (event.eventType !== "caption.updated" || !event.sourceText) {
      return;
    }
    clearTimeout(timeout);
    resolve({
      participant: participant?.identity,
      status: event.status,
      sourceText: event.sourceText
    });
  });
});

let source;
let track;
try {
  await room.connect(liveKitUrl, await token.toJwt(), {
    autoSubscribe: true,
    dynacast: false
  });
  source = new AudioSource(24000, 1);
  track = LocalAudioTrack.createAudioTrack("caption-probe-audio", source);
  const publishOptions = new TrackPublishOptions();
  publishOptions.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(track, publishOptions);

  const samplesPerFrame = 24000 / 50;
  for (let offset = 0; offset < pcm.length; offset += samplesPerFrame) {
    const frame = Int16Array.from(
      pcm.subarray(offset, offset + samplesPerFrame)
    );
    await source.captureFrame(
      new AudioFrame(frame, 24000, 1, frame.length)
    );
  }
  const silence = new Int16Array(samplesPerFrame);
  for (let frameIndex = 0; frameIndex < 50; frameIndex += 1) {
    await source.captureFrame(
      new AudioFrame(silence, 24000, 1, silence.length)
    );
  }
  await source.waitForPlayout();

  const caption = await captionReceived;
  console.log(JSON.stringify(caption, null, 2));
} finally {
  await track?.close();
  await source?.close();
  await room.disconnect();
  await dispose();
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
  return new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
}

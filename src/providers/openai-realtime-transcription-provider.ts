import WebSocket, { type RawData } from "ws";

import type {
  TranscriptionDelay,
  TranscriptionProvider,
  TranscriptionSession,
  TranscriptionSessionHandlers
} from "./translation-provider.js";

interface OpenAiEvent {
  type: string;
  delta?: string;
  transcript?: string;
  error?: {
    message?: string;
  };
  [key: string]: unknown;
}

export interface OpenAiRealtimeTranscriptionProviderOptions {
  apiKey: string;
  model: string;
  delay: TranscriptionDelay;
  language?: string;
}

export class OpenAiRealtimeTranscriptionProvider
  implements TranscriptionProvider
{
  constructor(
    private readonly options: OpenAiRealtimeTranscriptionProviderOptions
  ) {}

  createSession(
    handlers: TranscriptionSessionHandlers
  ): TranscriptionSession {
    return new OpenAiTranscriptionSession(this.options, handlers);
  }
}

class OpenAiTranscriptionSession implements TranscriptionSession {
  private socket?: WebSocket;
  private closed = false;

  constructor(
    private readonly options: OpenAiRealtimeTranscriptionProviderOptions,
    private readonly handlers: TranscriptionSessionHandlers
  ) {}

  async connect(): Promise<void> {
    const url = new URL("wss://api.openai.com/v1/realtime");
    url.searchParams.set("intent", "transcription");

    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`
      }
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        socket.off("error", handleInitialError);
        resolve();
      };
      const handleInitialError = (error: Error) => {
        socket.off("open", handleOpen);
        reject(
          new Error(
            `OpenAI transcription websocket failed for model=${this.options.model}: ${error.message}`
          )
        );
      };
      socket.once("open", handleOpen);
      socket.once("error", handleInitialError);
    });

    socket.on("message", (data) => this.handleMessage(data));
    socket.on("error", (error) => this.handlers.onError(error));
    socket.on("close", (code, reason) => {
      this.closed = true;
      if (code !== 1000) {
        this.handlers.onError(
          new Error(
            `OpenAI transcription websocket closed code=${code} reason=${reason.toString() || "none"}`
          )
        );
      }
    });

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
                model: this.options.model,
                delay: this.options.delay,
                ...(this.options.language
                  ? { language: this.options.language }
                  : {})
              }
            }
          }
        }
      })
    );
  }

  appendAudio(samples: Int16Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const audio = Buffer.from(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength
    ).toString("base64");
    this.socket.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio
      })
    );
  }

  commitAudio(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    // local VAD가 끝난 시점마다 commit해서 turn을 자른다.
    this.socket.send(
      JSON.stringify({
        type: "input_audio_buffer.commit"
      })
    );
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || this.closed) {
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      socket.close(1000);
      return;
    }

    const closed = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    socket.close(1000);
    await closed;
  }

  private handleMessage(data: RawData): void {
    const event = parseEvent(data);
    if (!event) {
      return;
    }
    debugOpenAiTranscriptionEvent(event);
    if (
      event.type === "conversation.item.input_audio_transcription.delta" &&
      event.delta
    ) {
      this.handlers.onTranscriptDelta(event.delta);
    } else if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      event.transcript
    ) {
      this.handlers.onTranscriptCompleted(event.transcript);
    } else if (event.type === "error") {
      this.handlers.onError(
        new Error(event.error?.message ?? "OpenAI transcription session failed")
      );
    }
  }
}

function parseEvent(data: RawData): OpenAiEvent | undefined {
  try {
    return JSON.parse(data.toString()) as OpenAiEvent;
  } catch {
    return undefined;
  }
}

function debugOpenAiTranscriptionEvent(event: OpenAiEvent): void {
  const interestingTypes = new Set([
    "conversation.item.input_audio_transcription.delta",
    "conversation.item.input_audio_transcription.completed",
    "session.created",
    "session.updated",
    "error"
  ]);

  if (!interestingTypes.has(event.type)) {
    return;
  }

  console.log(
    JSON.stringify({
      scope: "openai-realtime-transcription",
      type: event.type,
      delta:
        typeof event.delta === "string" ? event.delta.slice(0, 120) : undefined,
      transcript:
        typeof event.transcript === "string"
          ? event.transcript.slice(0, 120)
          : undefined,
      error:
        event.type === "error"
          ? event.error?.message ?? "unknown OpenAI error"
          : undefined
    })
  );
}

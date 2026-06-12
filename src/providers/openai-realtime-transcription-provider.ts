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
    // session 객체는 연결/오디오 append/close를 캡슐화한다.
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
    // transcription 전용 realtime websocket을 열고 session.update를 먼저 보낸다.
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
                // delay는 provider가 partial delta를 얼마나 빨리 내보낼지 제어한다.
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
    // PCM frame을 base64로 감싸 OpenAI websocket payload 형식에 맞춘다.
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
    // local VAD가 끝난 시점마다 commit해서 같은 발화를 다음 turn과 분리한다.
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
    // open 상태면 닫힘 이벤트를 기다리고, 이미 닫힌 경우엔 즉시 반환한다.
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
    // delta/completed/error만 상위 pipeline에 전달하고 나머지는 무시한다.
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
  // 디버그 로그는 관심 이벤트만 골라 짧게 남긴다.
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

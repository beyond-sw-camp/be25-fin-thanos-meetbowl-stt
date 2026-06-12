import WebSocket, { type RawData } from "ws";

import type {
  TranslationProvider,
  TranslationSession,
  TranslationSessionHandlers,
  TranslationTargetLanguage
} from "./translation-provider.js";

interface OpenAiEvent {
  type: string;
  delta?: string;
  error?: {
    message?: string;
  };
}

export interface OpenAiTranslationProviderOptions {
  apiKey: string;
  model: string;
}

export class OpenAiRealtimeTranslationProvider
  implements TranslationProvider
{
  constructor(private readonly options: OpenAiTranslationProviderOptions) {}

  createSession(
    targetLanguage: TranslationTargetLanguage,
    handlers: TranslationSessionHandlers
  ): TranslationSession {
    // 각 target language별로 독립된 websocket session을 만든다.
    return new OpenAiTranslationSession(
      this.options,
      targetLanguage,
      handlers
    );
  }
}

class OpenAiTranslationSession implements TranslationSession {
  private socket?: WebSocket;
  private closed = false;

  constructor(
    private readonly options: OpenAiTranslationProviderOptions,
    private readonly targetLanguage: TranslationTargetLanguage,
    private readonly handlers: TranslationSessionHandlers
  ) {}

  async connect(): Promise<void> {
    // translation websocket을 열고 target language를 session.update로 전달한다.
    const url = new URL("wss://api.openai.com/v1/realtime/translations");
    url.searchParams.set("model", this.options.model);

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
        reject(error);
      };
      socket.once("open", handleOpen);
      socket.once("error", handleInitialError);
    });

    socket.on("message", (data) => this.handleMessage(data));
    socket.on("error", (error) => this.handlers.onError(error));
    socket.on("close", () => {
      this.closed = true;
    });

    socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            output: {
              // targetLanguage는 한국어/영어 전환 output의 기준 언어가 된다.
              language: this.targetLanguage
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
    // audio frame은 transcription provider와 동일하게 base64 PCM으로 전달한다.
    const audio = Buffer.from(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength
    ).toString("base64");
    this.socket.send(
      JSON.stringify({
        type: "session.input_audio_buffer.append",
        audio
      })
    );
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || this.closed) {
      return;
    }
    // session.close를 먼저 보내고 server가 닫힌 뒤 websocket을 종료한다.
    if (socket.readyState !== WebSocket.OPEN) {
      socket.close();
      return;
    }

    const closed = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      const handleMessage = (data: RawData) => {
        const event = parseEvent(data);
        if (event?.type === "session.closed") {
          socket.off("message", handleMessage);
          socket.close();
        }
      };
      socket.on("message", handleMessage);
    });

    socket.send(JSON.stringify({ type: "session.close" }));
    await closed;
    socket.close();
  }

  private handleMessage(data: RawData): void {
    const event = parseEvent(data);
    if (!event) {
      return;
    }
    // source delta와 translation delta만 상위 pipeline으로 전달한다.
    if (event.type === "session.input_transcript.delta" && event.delta) {
      this.handlers.onSourceDelta(event.delta);
    } else if (
      event.type === "session.output_transcript.delta" &&
      event.delta
    ) {
      this.handlers.onTranslationDelta(event.delta);
    } else if (event.type === "error") {
      this.handlers.onError(
        new Error(event.error?.message ?? "OpenAI translation session failed")
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

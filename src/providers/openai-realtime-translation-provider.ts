/**
 * OpenAI Realtime API를 통해 실시간 기계 번역(Translation)을 수행하는 프로바이더 클래스입니다.
 * 한국어 또는 영어 중 지정된 대상 언어로의 스트리밍 번역 결과를 제공합니다.
 */
import WebSocket, { type RawData } from "ws";

import type {
  TranslationProvider,
  TranslationSession,
  TranslationSessionHandlers,
  TranslationTargetLanguage
} from "./translation-provider.js";

interface OpenAiEvent {
  /** OpenAI API 이벤트 타입입니다. */
  type: string;
  /** 입력된 원문 또는 출력된 번역문의 텍스트 조각입니다. */
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

  /** 
   * [세션 생성] 특정 타겟 언어(ko/en)를 처리하기 위한 번역 세션을 생성합니다.
   * @param targetLanguage 결과 텍스트가 표시될 언어
   * @param handlers 실시간 데이터 및 에러 처리를 위한 콜백 집합
   */
  createSession(
    targetLanguage: TranslationTargetLanguage,
    handlers: TranslationSessionHandlers
  ): TranslationSession {
    return new OpenAiTranslationSession(
      this.options,
      targetLanguage,
      handlers
    );
  }
}

/** 
 * 실시간 번역 세션을 관리하는 내부 구현 클래스입니다. 
 */
class OpenAiTranslationSession implements TranslationSession {
  private socket?: WebSocket;
  private closed = false;

  constructor(
    private readonly options: OpenAiTranslationProviderOptions,
    private readonly targetLanguage: TranslationTargetLanguage,
    private readonly handlers: TranslationSessionHandlers
  ) {}

  /** [엔진 연결] 번역 엔진에 접속하고 타겟 언어 설정을 주입합니다. */
  async connect(): Promise<void> {
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
    socket.on("close", () => { this.closed = true; });

    // 번역 타겟 언어 구성 전송
    socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            output: { language: this.targetLanguage }
          }
        }
      })
    );
  }

  /** [오디오 데이터 전송] 번역 분석을 위해 PCM 데이터를 바이너리로 전송합니다. */
  appendAudio(samples: Int16Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

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
    if (!socket || this.closed) return;

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

  /** 수신된 이벤트를 구분하여 원문 후보(Source)와 번역 결과(Translation)를 파이프라인에 전달합니다. */
  private handleMessage(data: RawData): void {
    const event = parseEvent(data);
    if (!event) return;

    if (event.type === "session.input_transcript.delta" && event.delta) {
      this.handlers.onSourceDelta(event.delta);
    } else if (event.type === "session.output_transcript.delta" && event.delta) {
      this.handlers.onTranslationDelta(event.delta);
    } else if (event.type === "error") {
      this.handlers.onError(new Error(event.error?.message ?? "OpenAI 번역 엔진 오류"));
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

/**
 * OpenAI Realtime API를 사용하여 실시간 음성 전사(Transcription)를 수행하는 프로바이더 클래스입니다.
 * WebSocket을 통해 음성 데이터를 스트리밍하고 실시간으로 텍스트 델타를 수신합니다.
 */
import WebSocket, { type RawData } from "ws";

import type {
  TranscriptionDelay,
  TranscriptionProvider,
  TranscriptionSession,
  TranscriptionSessionHandlers
} from "./translation-provider.js";

interface OpenAiEvent {
  /** OpenAI 서버에서 정의한 이벤트 타입입니다. */
  type: string;
  /** 실시간으로 생성된 자막 텍스트 조각입니다. */
  delta?: string;
  /** 발화가 완료되어 확정된 전체 문장입니다. */
  transcript?: string;
  /** 오류 발생 시 상세 정보를 포함하는 객체입니다. */
  error?: {
    message?: string;
  };
  [key: string]: unknown;
}

export interface OpenAiRealtimeTranscriptionProviderOptions {
  apiKey: string;
  model: string;
  /** 텍스트 생성 결과의 지연 시간 정책(minimal, low, medium 등)입니다. */
  delay: TranscriptionDelay;
  language?: string;
}

export class OpenAiRealtimeTranscriptionProvider
  implements TranscriptionProvider
{
  constructor(
    private readonly options: OpenAiRealtimeTranscriptionProviderOptions
  ) {}

  /** 개별 참가자 트랙 처리를 위한 독립적인 전사 세션을 생성합니다. */
  createSession(
    handlers: TranscriptionSessionHandlers
  ): TranscriptionSession {
    return new OpenAiTranscriptionSession(this.options, handlers);
  }
}

/** 
 * 실제 OpenAI 서버와 통신하는 런타임 세션 클래스입니다.
 * WebSocket 생명주기 및 오디오 버퍼 관리를 담당합니다.
 */
class OpenAiTranscriptionSession implements TranscriptionSession {
  private socket?: WebSocket;
  private closed = false;

  constructor(
    private readonly options: OpenAiRealtimeTranscriptionProviderOptions,
    private readonly handlers: TranscriptionSessionHandlers
  ) {}

  /** 
   * [엔진 연결] OpenAI Realtime WebSocket 서버에 접속하고 세션 설정을 동기화합니다.
   */
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
        reject(new Error(`OpenAI 전사 엔진 연결 실패: ${error.message}`));
      };
      socket.once("open", handleOpen);
      socket.once("error", handleInitialError);
    });

    socket.on("message", (data) => this.handleMessage(data));
    socket.on("error", (error) => this.handlers.onError(error));
    socket.on("close", (code, reason) => {
      this.closed = true;
      if (code !== 1000) {
        this.handlers.onError(new Error(`OpenAI 연결 비정상 종료: ${code} (${reason})`));
      }
    });

    // 세션 초기 설정 전송: 오디오 포맷 및 전사 지연 모델 구성
    socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: this.options.model,
                delay: this.options.delay,
                ...(this.options.language ? { language: this.options.language } : {})
              }
            }
          }
        }
      })
    );
  }

  /** [오디오 데이터 전송] PCM 데이터를 Base64로 인코딩하여 서버에 버퍼링합니다. */
  appendAudio(samples: Int16Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

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

  /** [발화 마감] 현재까지의 오디오 버퍼를 커밋하여 최종 전사 결과를 요청합니다. */
  commitAudio(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || this.closed) return;

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

  /** OpenAI로부터 수신된 원시 메시지를 해석하여 도메인 핸들러에 전달합니다. */
  private handleMessage(data: RawData): void {
    const event = parseEvent(data);
    if (!event) return;

    if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
      this.handlers.onTranscriptDelta(event.delta);
    } else if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      this.handlers.onTranscriptCompleted(event.transcript);
    } else if (event.type === "error") {
      this.handlers.onError(new Error(event.error?.message ?? "OpenAI 내부 오류 발생"));
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

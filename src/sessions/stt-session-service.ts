/**
 * 회의별 STT 세션의 생명주기를 총괄 관리하는 서비스 클래스입니다.
 * 세션 생성, 가동, 중지 및 상태 모니터링을 담당하며 메모리 기반 인덱스를 통해 중복 가동을 방지합니다.
 */
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config/env.js";
import type { RedisFeedbackStream } from "../events/redis-feedback-stream.js";
import type { RabbitMqTranscriptPublisher } from "../events/rabbitmq-transcript-publisher.js";
import { LiveKitMeetingSession } from "../livekit/livekit-meeting-session.js";
import type { PipelineLogger } from "../livekit/participant-audio-pipeline.js";
import type {
  TranscriptionProvider,
  TranslationProvider
} from "../providers/translation-provider.js";

/** 세션의 현재 진행 상태를 나타내는 유한 상태 집합입니다. */
export type SttSessionStatus =
  /** 세션 엔티티가 생성됨 (LiveKit 미접속) */
  | "CREATED"
  /** 인프라 연결 및 접속 시도 중 */
  | "STARTING"
  /** 정상 가동 중 및 오디오 분석 수행 중 */
  | "RUNNING"
  /** 리소스 정리 및 종료 절차 진행 중 */
  | "STOPPING"
  /** 안전하게 중단됨 */
  | "STOPPED"
  /** 기동 또는 종료 과정에서 복구 불가능한 에러 발생 */
  | "FAILED";

/** 외부 API 응답을 위한 세션 정보 뷰 객체입니다. */
export interface SttSessionView {
  sessionId: string;
  meetingId: string;
  roomName: string;
  status: SttSessionStatus;
  pipelineCount: number;
}

/** 시스템 내부 관리를 위한 세션 상세 레코드입니다. */
interface SttSessionRecord {
  sessionId: string;
  meetingId: string;
  roomName: string;
  correlationId: string;
  status: SttSessionStatus;
  runtime?: LiveKitMeetingSession;
}

export interface CreateSttSessionCommand {
  meetingId: string;
  roomName: string;
  correlationId?: string;
}

export interface SttSessionServiceDependencies {
  config: AppConfig;
  rabbitPublisher: RabbitMqTranscriptPublisher;
  feedbackStream: RedisFeedbackStream;
  translationProvider: TranslationProvider;
  transcriptionProvider: TranscriptionProvider;
  logger: PipelineLogger;
}

export class SttSessionService {
  /** 세션 ID를 키로 하는 메인 저장소 (메모리 상주) */
  private readonly sessions = new Map<string, SttSessionRecord>();
  /** 회의 ID별 활성 세션을 빠르게 찾기 위한 보조 인덱스 */
  private readonly meetingSessionIndex = new Map<string, string>();

  constructor(private readonly dependencies: SttSessionServiceDependencies) {}

  /** [세션 예약] 새로운 STT 컨텍스트를 생성합니다. 실제 인프라 연결은 이루어지지 않습니다. */
  create(command: CreateSttSessionCommand): SttSessionView {
    const sessionId = randomUUID();
    const record: SttSessionRecord = {
      sessionId,
      meetingId: command.meetingId,
      roomName: command.roomName,
      correlationId: command.correlationId ?? randomUUID(),
      status: "CREATED"
    };
    this.sessions.set(sessionId, record);
    this.meetingSessionIndex.set(command.meetingId, sessionId);
    return this.toView(record);
  }

  /** 
   * [멱등성 보장 기동] 회의 정보를 바탕으로 세션 가동을 보장합니다.
   * 이미 가동 중이면 기존 정보를 반환하고, 실패했거나 다른 회의실인 경우 새로 생성하여 시작합니다.
   */
  async ensureStarted(command: CreateSttSessionCommand): Promise<SttSessionView> {
    const existingSessionId = this.meetingSessionIndex.get(command.meetingId);
    if (!existingSessionId) {
      const created = this.create(command);
      return this.start(created.sessionId);
    }

    const record = this.sessions.get(existingSessionId);
    if (!record) {
      this.meetingSessionIndex.delete(command.meetingId);
      const created = this.create(command);
      return this.start(created.sessionId);
    }

    // 1. 이미 정상 가동 중인 경우 재사용
    if (record.status === "RUNNING" || record.status === "STARTING") {
      return this.toView(record);
    }

    // 2. 과거에 실패했거나 대상 회의실이 변경된 경우 강제 갱신 후 재시작
    if (record.status === "FAILED" || record.roomName !== command.roomName) {
      this.sessions.delete(record.sessionId);
      this.meetingSessionIndex.delete(record.meetingId);
      const created = this.create(command);
      return this.start(created.sessionId);
    }

    return this.start(record.sessionId);
  }

  /** [세션 실제 가동] LiveKit 런타임을 생성하고 외부 엔진 연동을 시작합니다. */
  async start(sessionId: string): Promise<SttSessionView> {
    const record = this.requireSession(sessionId);
    if (record.status === "RUNNING") return this.toView(record);

    if (record.status !== "CREATED" && record.status !== "STOPPED") {
      throw new Error(`현재 상태(${record.status})에서는 세션을 시작할 수 없습니다.`);
    }

    record.status = "STARTING";
    const runtime = new LiveKitMeetingSession({
      meetingId: record.meetingId,
      sessionId: record.sessionId,
      roomName: record.roomName,
      correlationId: record.correlationId,
      ...this.dependencies
    });
    record.runtime = runtime;

    try {
      await runtime.start();
      record.status = "RUNNING";
      return this.toView(record);
    } catch (error) {
      record.status = "FAILED";
      record.runtime = undefined;
      throw error;
    }
  }

  /** [세션 중지] 모든 프로세스를 종료하고 마지막 데이터를 플러시합니다. */
  async stop(sessionId: string): Promise<SttSessionView> {
    const record = this.requireSession(sessionId);
    if (record.status === "STOPPED") return this.toView(record);

    record.status = "STOPPING";
    try {
      await record.runtime?.stop("MEETING_ENDED");
      record.status = "STOPPED";
      record.runtime = undefined;
      return this.toView(record);
    } catch (error) {
      record.status = "FAILED";
      throw error;
    }
  }

  /** 관리자용 기능: 현재 활성 세그먼트를 강제로 마감 처리합니다. */
  async flush(sessionId: string): Promise<SttSessionView> {
    const record = this.requireSession(sessionId);
    await record.runtime?.flush("MANUAL_FLUSH");
    return this.toView(record);
  }

  get(sessionId: string): SttSessionView {
    return this.toView(this.requireSession(sessionId));
  }

  /** 서버 종료 시 모든 활성 세션을 일괄 정리합니다. */
  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.values()].map(async (record) => {
        await record.runtime?.stop("SERVER_SHUTDOWN");
        record.runtime = undefined;
        record.status = "STOPPED";
      })
    );
  }

  private requireSession(sessionId: string): SttSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  private toView(record: SttSessionRecord): SttSessionView {
    return {
      sessionId: record.sessionId,
      meetingId: record.meetingId,
      roomName: record.roomName,
      status: record.status,
      pipelineCount: record.runtime?.pipelineCount ?? 0
    };
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`해당 ID의 STT 세션을 찾을 수 없습니다: ${sessionId}`);
  }
}

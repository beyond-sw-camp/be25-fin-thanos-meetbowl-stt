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

export type SttSessionStatus =
  | "CREATED"
  | "STARTING"
  | "RUNNING"
  | "STOPPING"
  | "STOPPED"
  | "FAILED";

export interface SttSessionView {
  sessionId: string;
  meetingId: string;
  organizationId: string;
  roomName: string;
  status: SttSessionStatus;
  pipelineCount: number;
}

interface SttSessionRecord {
  sessionId: string;
  meetingId: string;
  organizationId: string;
  participantUserIds: string[];
  roomName: string;
  correlationId: string;
  status: SttSessionStatus;
  runtime?: LiveKitMeetingSession;
}

export interface CreateSttSessionCommand {
  meetingId: string;
  organizationId: string;
  participantUserIds: string[];
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
  private readonly sessions = new Map<string, SttSessionRecord>();

  constructor(private readonly dependencies: SttSessionServiceDependencies) {}

  create(command: CreateSttSessionCommand): SttSessionView {
    // 세션은 메모리 상에서만 관리되며, 시작 전에는 runtime이 없다.
    const sessionId = randomUUID();
    const record: SttSessionRecord = {
      sessionId,
      meetingId: command.meetingId,
      organizationId: command.organizationId,
      participantUserIds: command.participantUserIds,
      roomName: command.roomName,
      correlationId: command.correlationId ?? randomUUID(),
      status: "CREATED"
    };
    this.sessions.set(sessionId, record);
    return this.toView(record);
  }

  async start(sessionId: string): Promise<SttSessionView> {
    const record = this.requireSession(sessionId);
    if (record.status === "RUNNING") {
      return this.toView(record);
    }
    // CREATED/STOPPED 상태에서만 새 runtime을 붙인다.
    if (record.status !== "CREATED" && record.status !== "STOPPED") {
      throw new Error(`STT session cannot start from ${record.status}`);
    }
    record.status = "STARTING";
    const runtime = new LiveKitMeetingSession({
      meetingId: record.meetingId,
      sessionId: record.sessionId,
      organizationId: record.organizationId,
      participantUserIds: record.participantUserIds,
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
      // 시작 실패 시 상태를 FAILED로 기록하고 runtime 참조를 비운다.
      record.status = "FAILED";
      record.runtime = undefined;
      throw error;
    }
  }

  async stop(sessionId: string): Promise<SttSessionView> {
    const record = this.requireSession(sessionId);
    if (record.status === "STOPPED") {
      return this.toView(record);
    }
    // stop은 마지막 flush와 disconnect를 함께 수행하는 종료 경로다.
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

  async flush(sessionId: string): Promise<SttSessionView> {
    const record = this.requireSession(sessionId);
    // 마지막 발화만 강제 final로 밀어내는 관리용 API다.
    await record.runtime?.flush("MANUAL_FLUSH");
    return this.toView(record);
  }

  get(sessionId: string): SttSessionView {
    return this.toView(this.requireSession(sessionId));
  }

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
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  }

  private toView(record: SttSessionRecord): SttSessionView {
    return {
      sessionId: record.sessionId,
      meetingId: record.meetingId,
      organizationId: record.organizationId,
      roomName: record.roomName,
      status: record.status,
      pipelineCount: record.runtime?.pipelineCount ?? 0
    };
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`STT session not found: ${sessionId}`);
  }
}

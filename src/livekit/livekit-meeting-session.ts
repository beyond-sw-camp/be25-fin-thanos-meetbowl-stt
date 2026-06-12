import {
  RemoteAudioTrack,
  Room,
  RoomEvent,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

import type { AppConfig } from "../config/env.js";
import { CompositeFinalSegmentPublisher } from "../events/composite-final-segment-publisher.js";
import type {
  FeedbackGeneratedEnvelope,
  RedisFeedbackStream
} from "../events/redis-feedback-stream.js";
import type { RabbitMqTranscriptPublisher } from "../events/rabbitmq-transcript-publisher.js";
import type {
  TranscriptionProvider,
  TranslationProvider
} from "../providers/translation-provider.js";
import type { FinalizationReason } from "../transcript/transcript-types.js";
import { LiveKitCaptionPublisher } from "./livekit-caption-publisher.js";
import {
  ParticipantAudioPipeline,
  type PipelineLogger
} from "./participant-audio-pipeline.js";

export interface LiveKitMeetingSessionOptions {
  meetingId: string;
  sessionId: string;
  roomName: string;
  correlationId: string;
  config: AppConfig;
  rabbitPublisher: RabbitMqTranscriptPublisher;
  feedbackStream: RedisFeedbackStream;
  translationProvider: TranslationProvider;
  transcriptionProvider: TranscriptionProvider;
  logger: PipelineLogger;
}

export class LiveKitMeetingSession {
  private readonly room = new Room();
  private readonly pipelines = new Map<string, ParticipantAudioPipeline>();
  private sequence = 0;
  private startedAtMs?: number;
  private captionPublisher?: LiveKitCaptionPublisher;

  constructor(private readonly options: LiveKitMeetingSessionOptions) {}

  async start(): Promise<void> {
    if (this.startedAtMs !== undefined) {
      return;
    }
    this.startedAtMs = Date.now();
    // room 내부에서 생성되는 caption.updated를 다시 room data channel로 내보내는 publisher를 준비한다.
    this.captionPublisher = new LiveKitCaptionPublisher(
      this.room,
      this.options.logger,
      {
        meetingId: this.options.meetingId,
        sessionId: this.options.sessionId
      }
    );
    this.room
      .on(
        RoomEvent.TrackSubscribed,
        (
          track: RemoteTrack,
          publication: RemoteTrackPublication,
          participant: RemoteParticipant
        ) => {
          void this.attachTrack(track, publication, participant);
        }
      )
      // 트랙이 사라지면 그 트랙에 붙은 pipeline만 정리한다.
      .on(
        RoomEvent.TrackUnsubscribed,
        (
          _track: RemoteTrack,
          publication: RemoteTrackPublication,
          participant: RemoteParticipant
        ) => {
          if (publication.sid) {
            void this.detachTrack(publication.sid, participant.identity);
          }
        }
      )
      // 참가자가 통째로 나가면 participant 단위로 남은 track pipeline도 함께 종료한다.
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        void this.detachParticipant(participant.identity);
      });

    // STT 에이전트는 room join/subscribe/publish/data 권한만 가진 토큰으로 입장한다.
    const token = await this.createToken();
    await this.room.connect(this.options.config.LIVEKIT_URL, token, {
      autoSubscribe: true,
      dynacast: false
    });
    // finalized segment가 나올 때 AI 피드백 입력용 Redis stream에도 바로 전달할 수 있게 consumer를 연다.
    await this.options.feedbackStream.consumeFeedback(
      this.options.meetingId,
      (event) => this.publishFeedback(event)
    );
  }

  async stop(reason: FinalizationReason): Promise<void> {
    // stop 중 새 feedback이 들어오지 않도록 consumer부터 닫는다.
    this.options.feedbackStream.stopFeedbackConsumer(this.options.meetingId);
    // 현재 연결된 pipeline을 스냅샷으로 떠서 정리 중 맵 변경에 영향을 받지 않도록 한다.
    const pipelines = [...this.pipelines.values()];
    this.pipelines.clear();
    const results = await Promise.allSettled(
      pipelines.map((pipeline) => pipeline.stop(reason))
    );
    try {
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      if (failures.length > 0) {
        this.options.logger.error(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            failureCount: failures.length
          },
          "one or more participant pipelines failed during session stop"
        );
      }
    } finally {
      // room disconnect 이후에는 새 track 이벤트가 들어오지 않으므로 세션을 초기 상태로 되돌린다.
      await this.room.disconnect();
      this.startedAtMs = undefined;
    }
  }

  async flush(reason: FinalizationReason): Promise<void> {
    await Promise.allSettled(
      [...this.pipelines.values()].map((pipeline) =>
        pipeline.flush(reason)
      )
    );
  }

  get pipelineCount(): number {
    return this.pipelines.size;
  }

  private async attachTrack(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): Promise<void> {
    // 오디오가 아닌 트랙은 STT 파이프라인 대상이 아니다.
    if (!(track instanceof RemoteAudioTrack) || !this.startedAtMs) {
      return;
    }
    const trackSid = publication.sid ?? track.sid;
    if (!trackSid) {
      return;
    }
    // 동일 participant + trackSid 조합은 한 번만 attach 한다.
    const key = pipelineKey(participant.identity, trackSid);
    if (this.pipelines.has(key)) {
      return;
    }

    const captionPublisher = this.captionPublisher;
    if (!captionPublisher) {
      return;
    }
    const pipeline = new ParticipantAudioPipeline({
      meetingId: this.options.meetingId,
      sessionId: this.options.sessionId,
      correlationId: this.options.correlationId,
      participantIdentity: participant.identity,
      trackSid,
      track,
      meetingStartedAtMs: this.startedAtMs,
      nextSequence: () => this.sequence++,
      translationProvider: this.options.translationProvider,
      captionPublisher,
      finalSegmentPublisher: new CompositeFinalSegmentPublisher([
        this.options.rabbitPublisher,
        this.options.feedbackStream
      ]),
      rmsThreshold: this.options.config.VAD_RMS_THRESHOLD,
      silenceMs: this.options.config.VAD_SILENCE_MS,
      noDeltaTimeoutMs: this.options.config.SEGMENT_NO_DELTA_TIMEOUT_MS,
      translationGraceMs: this.options.config.TRANSLATION_GRACE_MS,
      enableTranslation: this.options.config.ENABLE_TRANSLATION,
      maxSegmentDurationMs: this.options.config.MAX_SEGMENT_DURATION_MS,
      transcriptionProvider: this.options.transcriptionProvider,
      logger: this.options.logger
    });
    this.pipelines.set(key, pipeline);
    try {
      await pipeline.start();
    } catch (error) {
      // 시작 실패한 pipeline은 map에서 제거해 다음 이벤트에 영향을 주지 않게 한다.
      this.pipelines.delete(key);
      this.options.logger.error(
        {
          meetingId: this.options.meetingId,
          sessionId: this.options.sessionId,
          trackSid,
          error: error instanceof Error ? error.message : String(error)
        },
        "participant audio pipeline failed to start"
      );
    }
  }

  private async detachTrack(
    trackSid: string,
    participantIdentity: string
  ): Promise<void> {
    const key = pipelineKey(participantIdentity, trackSid);
    const pipeline = this.pipelines.get(key);
    if (!pipeline) {
      return;
    }
    // track 단위 종료는 해당 participant의 다른 track에는 영향을 주지 않는다.
    this.pipelines.delete(key);
    await pipeline.stop("TRACK_ENDED");
  }

  private async detachParticipant(participantIdentity: string): Promise<void> {
    const entries = [...this.pipelines.entries()].filter(([key]) =>
      key.startsWith(`${participantIdentity}:`)
    );
    for (const [key, pipeline] of entries) {
      // participant가 나가면 해당 participant의 모든 track pipeline을 종료한다.
      this.pipelines.delete(key);
      await pipeline.stop("TRACK_ENDED");
    }
  }

  private async publishFeedback(
    event: FeedbackGeneratedEnvelope
  ): Promise<void> {
    // AI가 계산한 feedback 결과는 LiveKit caption channel에도 다시 반영한다.
    await this.captionPublisher?.publishFeedback(event);
  }

  private async createToken(): Promise<string> {
    // LiveKit 서버는 STT agent를 일반 participant처럼 다루므로 grant로 권한을 명시한다.
    const identity = `${this.options.config.LIVEKIT_AGENT_IDENTITY_PREFIX}-${this.options.sessionId}`;
    const token = new AccessToken(
      this.options.config.LIVEKIT_API_KEY,
      this.options.config.LIVEKIT_API_SECRET,
      {
        identity,
        name: "Meetbowl STT",
        ttl: "6h"
      }
    );
    token.addGrant({
      roomJoin: true,
      room: this.options.roomName,
      canSubscribe: true,
      canPublish: true,
      canPublishData: true
    });
    return token.toJwt();
  }
}

function pipelineKey(participantIdentity: string, trackSid: string): string {
  return `${participantIdentity}:${trackSid}`;
}

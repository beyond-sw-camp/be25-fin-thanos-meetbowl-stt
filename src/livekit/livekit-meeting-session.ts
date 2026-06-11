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
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        void this.detachParticipant(participant.identity);
      });

    const token = await this.createToken();
    await this.room.connect(this.options.config.LIVEKIT_URL, token, {
      autoSubscribe: true,
      dynacast: false
    });
    await this.options.feedbackStream.consumeFeedback(
      this.options.meetingId,
      (event) => this.publishFeedback(event)
    );
  }

  async stop(reason: FinalizationReason): Promise<void> {
    this.options.feedbackStream.stopFeedbackConsumer(this.options.meetingId);
    const pipelines = [...this.pipelines.values()];
    this.pipelines.clear();
    await Promise.allSettled(
      pipelines.map((pipeline) => pipeline.stop(reason))
    );
    await this.room.disconnect();
    this.startedAtMs = undefined;
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
    if (!(track instanceof RemoteAudioTrack) || !this.startedAtMs) {
      return;
    }
    const trackSid = publication.sid ?? track.sid;
    if (!trackSid) {
      return;
    }
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
    this.pipelines.delete(key);
    await pipeline.stop("TRACK_ENDED");
  }

  private async detachParticipant(participantIdentity: string): Promise<void> {
    const entries = [...this.pipelines.entries()].filter(([key]) =>
      key.startsWith(`${participantIdentity}:`)
    );
    for (const [key, pipeline] of entries) {
      this.pipelines.delete(key);
      await pipeline.stop("TRACK_ENDED");
    }
  }

  private async publishFeedback(
    event: FeedbackGeneratedEnvelope
  ): Promise<void> {
    await this.captionPublisher?.publishFeedback(event);
  }

  private async createToken(): Promise<string> {
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

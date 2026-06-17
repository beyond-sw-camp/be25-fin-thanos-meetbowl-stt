/**
 * LiveKit 회의실(Room) 연결 및 오디오 트랙 관리를 담당하는 서비스 클래스입니다.
 * 실시간 화상회의 인프라에 참여하여 참가자의 목소리를 감지하고 자막 파이프라인으로 라우팅합니다.
 */
import {
  AudioStream,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from "@livekit/rtc-node";
import { TrackKind } from "@livekit/rtc-ffi-bindings";
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

// cspell:ignore LIVEKIT meetbowl

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
  /** LiveKit RTC SDK의 메인 Room 객체입니다. 단일 회의 세션과 1:1로 대응됩니다. */
  private readonly room = new Room();
  /** 현재 회의실에서 발견된 모든 원격 오디오 트랙(Candidate)을 저장하고 관리합니다. */
  private readonly trackCandidates = new Map<string, TrackCandidate>();
  /** 각 원격 오디오 트랙마다 유지되는 background reader 상태입니다. */
  private readonly trackReaders = new Map<string, TrackReaderState>();
  private sequence = 0;
  private startedAtMs?: number;
  private captionPublisher?: LiveKitCaptionPublisher;
  /** 현재 STT 파이프라인에 실제로 오디오를 공급 중인 트랙의 고유 키입니다. */
  private activeTrackKey?: string;
  /** 실제 음성 분석 및 STT 엔진 연동을 수행하는 하위 파이프라인 인스턴스입니다. */
  private pipeline?: ParticipantAudioPipeline;

  constructor(private readonly options: LiveKitMeetingSessionOptions) {}

  /**
   * [세션 기동] LiveKit Room에 접속하고 오디오 구독 및 파이프라인을 초기화합니다.
   */
  async start(): Promise<void> {
    if (this.startedAtMs !== undefined) {
      return;
    }
    
    // 1. 런타임 기준 시각 설정 (자막 타임라인 계산용)
    this.startedAtMs = Date.now();
    
    // 2. 실시간 자막 전송을 위한 퍼블리셔 구성
    this.captionPublisher = new LiveKitCaptionPublisher(
      this.room,
      this.options.logger,
      {
        meetingId: this.options.meetingId,
        sessionId: this.options.sessionId
      }
    );
    
    // 3. 단일 오디오 파이프라인 생성 및 시작
    this.pipeline = this.createPipeline();
    await this.pipeline.start();

    /**
     * 4. [이벤트 리스너 등록]
     * Room에서 발생하는 트랙 발행, 구독, 화자 변경 이벤트를 실시간으로 처리합니다.
     */
    this.room
      .on(
        RoomEvent.TrackPublished,
        (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          void this.ensurePublicationSubscribed(publication, participant);
        }
      )
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
          const trackSid = publication.sid;
          if (trackSid) {
            void this.detachTrack(trackSid, participant.identity);
          }
        }
      )
      .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
        void this.handleActiveSpeakersChanged(participants);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        void this.detachParticipant(participant.identity);
      });

    // 5. 서버 참가자 토큰 발급 및 Room 접속 수립
    const token = await this.createToken();
    await this.room.connect(this.options.config.LIVEKIT_URL, token, {
      autoSubscribe: true,
      dynacast: false
    });

    // 6. 기존 접속자들의 트랙 상태 동기화 및 기본 트랙 연결 시도
    await this.syncExistingRemoteAudioPublications();
    await this.ensureDefaultTrackAttached();
    
    // 7. 실시간 AI 피드백 결과 구독 시작
    await this.options.feedbackStream.consumeFeedback(
      this.options.meetingId,
      (event) => this.publishFeedback(event)
    );
  }

  /**
   * [세션 종료] 연결을 해제하고 모든 하위 프로세스를 안전하게 중단합니다.
   * @param reason 종료 사유 (예: 회의 종료, 서버 중지 등)
   */
  async stop(reason: FinalizationReason): Promise<void> {
    this.options.feedbackStream.stopFeedbackConsumer(this.options.meetingId);
    this.trackCandidates.clear();
    await this.stopAllTrackReaders();
    this.activeTrackKey = undefined;
    const pipeline = this.pipeline;
    this.pipeline = undefined;
    try {
      // 진행 중인 마지막 세그먼트를 확정하고 파이프라인 중단
      await pipeline?.stop(reason);
    } finally {
      // LiveKit Room 연결 해제
      await this.room.disconnect();
      this.startedAtMs = undefined;
    }
  }

  /** 진행 중인 미완성 자막을 즉시 최종 데이터로 발행 요청합니다. */
  async flush(reason: FinalizationReason): Promise<void> {
    await this.pipeline?.flush(reason);
  }

  get pipelineCount(): number {
    return this.pipeline ? 1 : 0;
  }

  /** 도메인 엔진과 연동되는 오디오 처리 파이프라인을 조립합니다. */
  private createPipeline(): ParticipantAudioPipeline {
    if (!this.startedAtMs || !this.captionPublisher) {
      throw new Error("LiveKit meeting session is not initialized");
    }
    return new ParticipantAudioPipeline({
      meetingId: this.options.meetingId,
      sessionId: this.options.sessionId,
      correlationId: this.options.correlationId,
      meetingStartedAtMs: this.startedAtMs,
      nextSequence: () => this.sequence++,
      translationProvider: this.options.translationProvider,
      transcriptionProvider: this.options.transcriptionProvider,
      enableTranslation: this.options.config.ENABLE_TRANSLATION,
      captionPublisher: this.captionPublisher,
      finalSegmentPublisher: new CompositeFinalSegmentPublisher([
        this.options.rabbitPublisher,
        this.options.feedbackStream
      ]),
      logger: this.options.logger,
      rmsThreshold: this.options.config.VAD_RMS_THRESHOLD,
      silenceMs: this.options.config.VAD_SILENCE_MS,
      noDeltaTimeoutMs: this.options.config.SEGMENT_NO_DELTA_TIMEOUT_MS,
      translationGraceMs: this.options.config.TRANSLATION_GRACE_MS,
      maxSegmentDurationMs: this.options.config.MAX_SEGMENT_DURATION_MS
    });
  }

  /** 이미 발행된 오디오 트랙 정보가 누락되지 않도록 현재 Room 상태와 동기화합니다. */
  private async syncExistingRemoteAudioPublications(): Promise<void> {
    const participants = [...this.room.remoteParticipants.values()];
    for (const participant of participants) {
      const publications = [...participant.trackPublications.values()];
      for (const publication of publications) {
        await this.ensurePublicationSubscribed(publication, participant);
      }
    }
  }

  /** 특정 오디오 발행물이 구독 상태인지 확인하고 관리 맵에 등록합니다. */
  private async ensurePublicationSubscribed(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): Promise<void> {
    if (publication.kind !== TrackKind.KIND_AUDIO) {
      return;
    }

    if (!publication.subscribed) {
      publication.setSubscribed(true);
    }

    if (publication.track instanceof RemoteAudioTrack) {
      const trackSid = publication.sid ?? publication.track.sid;
      if (!trackSid) return;
      
      this.trackCandidates.set(pipelineKey(participant.identity, trackSid), {
        participantIdentity: participant.identity,
        trackSid,
        track: publication.track
      });
      await this.startTrackReader(
        participant.identity,
        trackSid,
        publication.track
      );
    }
  }

  /** 새로 생성된 오디오 트랙을 파이프라인 후보군에 추가합니다. */
  private async attachTrack(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): Promise<void> {
    if (!(track instanceof RemoteAudioTrack) || !this.startedAtMs) {
      return;
    }
    const trackSid = publication.sid ?? track.sid;
    if (!trackSid) return;
    
    this.trackCandidates.set(pipelineKey(participant.identity, trackSid), {
      participantIdentity: participant.identity,
      trackSid,
      track
    });
    await this.startTrackReader(participant.identity, trackSid, track);
  }

  /** 오디오 트랙이 사라졌을 때 관리 명단에서 제거하고 파이프라인 연결을 끊습니다. */
  private async detachTrack(
    trackSid: string,
    participantIdentity: string
  ): Promise<void> {
    const key = pipelineKey(participantIdentity, trackSid);
    this.trackCandidates.delete(key);
    await this.stopTrackReader(key);
    if (this.activeTrackKey === key) {
      this.activeTrackKey = undefined;
      await this.pipeline?.deactivateSource("TRACK_ENDED");
    }
  }

  private async detachParticipant(participantIdentity: string): Promise<void> {
    const keys = [...this.trackCandidates.keys()].filter((key) =>
      key.startsWith(`${participantIdentity}:`)
    );
    for (const key of keys) {
      this.trackCandidates.delete(key);
      await this.stopTrackReader(key);
      if (this.activeTrackKey === key) {
        this.activeTrackKey = undefined;
        await this.pipeline?.deactivateSource("TRACK_ENDED");
      }
    }
  }

  private async publishFeedback(
    event: FeedbackGeneratedEnvelope
  ): Promise<void> {
    await this.captionPublisher?.publishFeedback(event);
  }

  /** Active speaker 이벤트는 관측용으로만 유지합니다. 실제 STT 입력 선택은 RMS 기반으로 수행합니다. */
  private async handleActiveSpeakersChanged(
    participants: Participant[]
  ): Promise<void> {
    this.options.logger.info(
      {
        meetingId: this.options.meetingId,
        sessionId: this.options.sessionId,
        activeSpeakerIdentity: participants[0]?.identity?.trim() || undefined,
        activeSpeakerCount: participants.length
      },
      "LiveKit active speakers changed"
    );
  }

  /** 최초 동기화 시 이미 존재하던 모든 remote track reader를 시작합니다. */
  private async ensureDefaultTrackAttached(): Promise<void> {
    const candidates = [...this.trackCandidates.values()];
    for (const candidate of candidates) {
      await this.startTrackReader(
        candidate.participantIdentity,
        candidate.trackSid,
        candidate.track
      );
    }
  }

  /** 각 track reader가 전달한 RMS를 기준으로 현재 프레임을 STT에 보낼지 결정합니다. */
  private async routeFrame(
    key: string,
    samples: Int16Array,
    nowMs: number,
    rms: number
  ): Promise<void> {
    if (!this.pipeline) return;

    const reader = this.trackReaders.get(key);
    if (!reader) return;

    reader.lastRms = rms;
    reader.lastFrameAtMs = nowMs;
    if (rms >= this.options.config.VAD_RMS_THRESHOLD) {
      reader.lastVoiceAtMs = nowMs;
    }

    const desiredKey = this.selectDominantTrackKey(nowMs);
    if (!desiredKey) {
      return;
    }

    if (desiredKey !== this.activeTrackKey) {
      const nextReader = this.trackReaders.get(desiredKey);
      if (!nextReader) return;

      await this.pipeline.activateSource(
        nextReader.participantIdentity,
        nextReader.trackSid
      );
      this.activeTrackKey = desiredKey;
      this.options.logger.info(
        {
          meetingId: this.options.meetingId,
          sessionId: this.options.sessionId,
          participantIdentity: nextReader.participantIdentity,
          trackSid: nextReader.trackSid,
          rms: nextReader.lastRms
        },
        "STT active track attached"
      );
    }

    if (this.activeTrackKey === key) {
      this.pipeline.consumeFrame(samples, nowMs);
    }
  }

  /** 최근 목소리가 감지된 트랙 중 RMS가 가장 큰 후보를 우선 선택합니다. */
  private selectDominantTrackKey(nowMs: number): string | undefined {
    const recentVoiceWindowMs = Math.max(
      this.options.config.VAD_SILENCE_MS,
      this.options.config.TRACK_SWITCH_GRACE_MS
    );

    // 화자 구분보다 실시간성이 더 중요한 현재 요구사항에서는,
    // 이미 선택된 source에서 최근까지 음성이 감지됐다면 그 source를 계속 유지하는 편이 낫다.
    // 그렇지 않으면 같은 공간의 여러 게스트 track 사이를 매 프레임마다 오가면서
    // STT 입력이 흔들리고 자막 지연이 크게 늘어난다.
    if (this.activeTrackKey) {
      const activeState = this.trackReaders.get(this.activeTrackKey);
      const activeHeardRecently =
        activeState?.lastVoiceAtMs !== undefined &&
        nowMs - activeState.lastVoiceAtMs <= recentVoiceWindowMs;
      if (activeHeardRecently) {
        return activeState.key;
      }
    }

    let dominant: TrackReaderState | undefined;

    for (const state of this.trackReaders.values()) {
      const heardRecently =
        state.lastVoiceAtMs !== undefined &&
        nowMs - state.lastVoiceAtMs <= recentVoiceWindowMs;
      if (!heardRecently) {
        continue;
      }
      if (!dominant || state.lastRms > dominant.lastRms) {
        dominant = state;
      }
    }

    return dominant?.key;
  }

  /** 새 오디오 트랙을 발견하면 background reader를 띄워 RMS 후보로 유지합니다. */
  private async startTrackReader(
    participantIdentity: string,
    trackSid: string,
    track: RemoteAudioTrack
  ): Promise<void> {
    const key = pipelineKey(participantIdentity, trackSid);
    if (this.trackReaders.has(key)) {
      return;
    }

    const stream = new AudioStream(track, {
      sampleRate: 24000,
      numChannels: 1,
      frameSizeMs: 20
    });
    const reader = stream.getReader();
    const abortController = new AbortController();
    const state: TrackReaderState = {
      key,
      participantIdentity,
      trackSid,
      track,
      reader,
      abortController,
      runningTask: Promise.resolve(),
      lastRms: 0
    };
    state.runningTask = this.readTrackFrames(state);
    this.trackReaders.set(key, state);
  }

  /** 특정 track reader를 중단합니다. */
  private async stopTrackReader(key: string): Promise<void> {
    const state = this.trackReaders.get(key);
    if (!state) return;
    state.abortController.abort();
    await state.runningTask;
    this.trackReaders.delete(key);
    if (this.activeTrackKey === key) {
      this.activeTrackKey = undefined;
    }
  }

  /** 모든 background reader를 정리합니다. */
  private async stopAllTrackReaders(): Promise<void> {
    const keys = [...this.trackReaders.keys()];
    for (const key of keys) {
      await this.stopTrackReader(key);
    }
  }

  /** 각 remote track의 프레임을 계속 읽고, 로컬에서 RMS 후보 평가를 수행합니다. */
  private async readTrackFrames(state: TrackReaderState): Promise<void> {
    const handleAbort = () => {
      void state.reader.cancel("abort");
    };
    state.abortController.signal.addEventListener("abort", handleAbort, { once: true });
    try {
      while (!state.abortController.signal.aborted) {
        const { done, value } = await state.reader.read();
        if (done) break;
        const nowMs = Date.now();
        const samples = (value as { data: Int16Array }).data;
        const rms = computeRms(samples);
        await this.routeFrame(state.key, samples, nowMs, rms);
      }
    } catch (error) {
      if (!state.abortController.signal.aborted) {
        this.options.logger.error(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            participantIdentity: state.participantIdentity,
            trackSid: state.trackSid,
            error: error instanceof Error ? error.message : String(error)
          },
          "오디오 트랙 reader 실패"
        );
      }
    } finally {
      state.abortController.signal.removeEventListener("abort", handleAbort);
      state.reader.releaseLock();
    }
  }

  /** 서버 수준의 LiveKit 접근 권한을 가진 액세스 토큰을 생성합니다. */
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

interface TrackCandidate {
  participantIdentity: string;
  trackSid: string;
  track: RemoteAudioTrack;
}

interface TrackReaderState {
  key: string;
  participantIdentity: string;
  trackSid: string;
  track: RemoteAudioTrack;
  reader: any;
  abortController: AbortController;
  runningTask: Promise<void>;
  lastRms: number;
  lastVoiceAtMs?: number;
  lastFrameAtMs?: number;
}

function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

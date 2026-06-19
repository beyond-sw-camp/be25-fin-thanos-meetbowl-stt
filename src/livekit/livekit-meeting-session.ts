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
import { LiveKitParticipantRegistry } from "./livekit-participant-registry.js";
import {
  ParticipantAudioPipeline,
  type PipelineLogger
} from "./participant-audio-pipeline.js";

// cspell:ignore LIVEKIT meetbowl

export interface LiveKitMeetingSessionOptions {
  /** 최종 자막 이벤트가 귀속될 회의 ID입니다. */
  meetingId: string;
  /** 현재 STT runtime을 식별하는 세션 ID입니다. */
  sessionId: string;
  /** 접속해야 하는 LiveKit room 이름입니다. */
  organizationId: string;
  roomName: string;
  /** 요청/이벤트 흐름 추적용 상관관계 ID입니다. */
  correlationId: string;
  /** 런타임 전체에서 공유하는 환경 설정 값 모음입니다. */
  config: AppConfig;
  /** finalized segment를 BE 저장 경로로 넘기는 RabbitMQ publisher입니다. */
  rabbitPublisher: RabbitMqTranscriptPublisher;
  /** AI 피드백 입력/결과 흐름을 담당하는 Redis Stream 어댑터입니다. */
  feedbackStream: RedisFeedbackStream;
  /** 번역 provider 팩토리입니다. */
  translationProvider: TranslationProvider;
  /** 원문 transcription provider 팩토리입니다. */
  transcriptionProvider: TranscriptionProvider;
  /** 세션 내부 로그 기록기입니다. */
  logger: PipelineLogger;
}

export class LiveKitMeetingSession {
  /** LiveKit RTC SDK의 메인 Room 객체입니다. 단일 회의 세션과 1:1로 대응됩니다. */
  private readonly room = new Room();
  /** 현재 회의실에서 발견된 모든 원격 오디오 트랙(Candidate)을 저장하고 관리합니다. */
  private readonly trackCandidates = new Map<string, TrackCandidate>();
  /** 각 원격 오디오 트랙마다 유지되는 background reader 상태입니다. */
  private readonly trackReaders = new Map<string, TrackReaderState>();
  /** BE가 발급한 user-{UUID} identity만 보관하는 현재 Room 인증 사용자 registry입니다. */
  private readonly participantRegistry = new LiveKitParticipantRegistry();
  /** 새 세그먼트가 열릴 때마다 0부터 증가하는 회의 내 자막 순번입니다. */
  private sequence = 0;
  /** STT runtime이 실제로 start된 절대 시각입니다. 자막 상대시간 기준점입니다. */
  private startedAtMs?: number;
  /** LiveKit DataChannel로 caption/feedback를 발행하는 helper입니다. */
  private captionPublisher?: LiveKitCaptionPublisher;
  /** 현재 STT participant가 LiveKit room과 정상 연결돼 있는지 추적합니다. */
  private connectionHealthy = false;
  /** 정상적인 stop 호출로 종료 중인지 표시해 예기치 않은 disconnect와 구분합니다. */
  private stopRequested = false;
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

    this.stopRequested = false;
    this.connectionHealthy = false;
    
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
      .on(RoomEvent.ParticipantConnected, (participant) => {
        this.participantRegistry.add(participant.identity);
      })
      .on(
        RoomEvent.TrackPublished,
        (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          this.participantRegistry.add(participant.identity);
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
          this.participantRegistry.add(participant.identity);
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
        this.participantRegistry.remove(participant.identity);
        void this.detachParticipant(participant.identity);
      })
      .on(RoomEvent.Reconnecting, () => {
        this.connectionHealthy = false;
        this.options.logger.warn(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId
          },
          "STT room reconnecting"
        );
      })
      .on(RoomEvent.Reconnected, () => {
        this.connectionHealthy = true;
        this.options.logger.info(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId
          },
          "STT room reconnected"
        );
      })
      .on(RoomEvent.Disconnected, (reason) => {
        this.connectionHealthy = false;
        this.options.logger.warn(
          {
            meetingId: this.options.meetingId,
            sessionId: this.options.sessionId,
            stopRequested: this.stopRequested,
            reason: reason ?? undefined
          },
          "STT room disconnected"
        );
      });

    // 5. 서버 참가자 토큰 발급 및 Room 접속 수립
    const token = await this.createToken();
    await this.room.connect(this.options.config.LIVEKIT_URL, token, {
      autoSubscribe: true,
      dynacast: false
    });
    this.connectionHealthy = true;

    // 6. 기존 접속자 identity와 트랙 상태 동기화 및 기본 트랙 연결 시도
    this.syncExistingParticipants();
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
    this.stopRequested = true;
    this.connectionHealthy = false;
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
      this.participantRegistry.clear();
      // LiveKit Room 연결 해제
      await this.room.disconnect();
      this.startedAtMs = undefined;
    }
  }

  /**
   * 세션 객체가 살아 있어도 실제 LiveKit room 연결이 끊긴 상태면 unhealthy로 본다.
   *
   * STT 세션 서비스는 이 값을 보고 stale RUNNING 세션을 재사용하지 않고 새로 시작한다.
   */
  isHealthy(): boolean {
    return this.connectionHealthy;
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
      organizationId: this.options.organizationId,
      getParticipantUserIds: () => this.participantRegistry.snapshotUserIds(),
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

  /** Room 접속 이전부터 존재하던 인증 참가자를 registry에 반영합니다. */
  private syncExistingParticipants(): void {
    for (const participant of this.room.remoteParticipants.values()) {
      this.participantRegistry.add(participant.identity);
    }
  }

  /** 이미 발행된 오디오 트랙 정보가 누락되지 않도록 현재 Room 상태와 동기화합니다. */
  private async syncExistingRemoteAudioPublications(): Promise<void> {
    /** 이미 room 안에 들어와 있던 원격 참가자 목록입니다. */
    const participants = [...this.room.remoteParticipants.values()];
    for (const participant of participants) {
      /** 각 참가자가 publish 중인 track publication 목록입니다. */
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
      
      /**
       * trackCandidates는 "이 회의에 어떤 원격 오디오 source가 존재하는가"를 기억하는 맵입니다.
       * 실제 provider 입력은 1개만 쓰더라도, 후보 집합은 모두 유지해야 현재 최강 source를 고를 수 있습니다.
       */
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
    if (
      event.payload.meetingId !== this.options.meetingId ||
      event.payload.sessionId !== this.options.sessionId
    ) {
      this.options.logger.warn(
        {
          meetingId: this.options.meetingId,
          sessionId: this.options.sessionId,
          feedbackId: event.payload.feedbackId
        },
        "현재 STT 세션과 일치하지 않는 피드백 결과 무시"
      );
      return;
    }
    const destinationIdentities = this.participantRegistry.identitiesForUserIds(
      event.payload.audienceUserIds
    );
    if (destinationIdentities.length === 0) return;
    await this.captionPublisher?.publishFeedback(event, destinationIdentities);
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

    /** 현재 프레임을 보낸 track의 reader 상태입니다. */
    const reader = this.trackReaders.get(key);
    if (!reader) return;

    reader.lastRms = rms;
    reader.lastFrameAtMs = nowMs;
    if (rms >= this.options.config.VAD_RMS_THRESHOLD) {
      reader.lastVoiceAtMs = nowMs;
    }

    /** 지금 시점에 STT 입력으로 쓸 "가장 유력한 source"를 고릅니다. */
    const desiredKey = this.selectDominantTrackKey(nowMs);
    if (!desiredKey) {
      return;
    }

    if (desiredKey !== this.activeTrackKey) {
      /** 실제 provider에 오디오를 밀어넣을 다음 source의 reader 상태입니다. */
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
    /**
     * "최근까지 사람이 말하고 있었다"고 인정하는 시간 창입니다.
     * 너무 짧으면 source가 매 프레임 흔들리고, 너무 길면 이미 끝난 화자를 오래 붙잡습니다.
     */
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

    /**
     * LiveKit SDK reader는 각 remote track에서 계속 프레임을 뽑아오되,
     * provider로 보내기 전에 여기서 RMS만 먼저 계산합니다.
     */
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
  /** 이 후보 track을 publish한 원격 참가자 identity입니다. */
  participantIdentity: string;
  /** LiveKit이 발급한 원격 오디오 track SID입니다. */
  trackSid: string;
  /** 실제 프레임을 읽을 수 있는 LiveKit remote audio track 객체입니다. */
  track: RemoteAudioTrack;
}

interface TrackReaderState {
  /** `participantIdentity:trackSid` 형식의 내부 고유 키입니다. */
  key: string;
  /** 이 reader가 감시하는 track의 owner participant입니다. */
  participantIdentity: string;
  /** 이 reader가 감시하는 LiveKit track SID입니다. */
  trackSid: string;
  /** reader가 물고 있는 실제 remote audio track 객체입니다. */
  track: RemoteAudioTrack;
  /** LiveKit AudioStream에서 프레임을 pull하는 low-level reader입니다. */
  reader: any;
  /** reader 루프를 중단시키는 취소 토큰입니다. */
  abortController: AbortController;
  /** background frame read loop의 실행 Promise입니다. stop 시 join 용도로 사용합니다. */
  runningTask: Promise<void>;
  /** 가장 최근 프레임의 RMS 값입니다. dominant source 선택에 사용합니다. */
  lastRms: number;
  /** 마지막으로 threshold 이상 목소리가 감지된 절대 시각입니다. */
  lastVoiceAtMs?: number;
  /** 마지막 프레임을 읽은 시각입니다. reader 활력 확인 및 디버깅용입니다. */
  lastFrameAtMs?: number;
}

/** Int16 PCM 프레임을 0~1 범위의 RMS 값으로 바꿔 source 우선순위 비교에 사용합니다. */
function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

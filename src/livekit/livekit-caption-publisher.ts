/**
 * LiveKit의 데이터 채널(DataChannel)을 통해 실시간 자막 및 피드백을 참가자들에게 전송하는 퍼블리셔 클래스입니다.
 * 초지연 화면 업데이트를 위해 신뢰성 있는(Reliable) 데이터 전송 방식을 사용합니다.
 */
import type { Room } from "@livekit/rtc-node";

import type { CaptionPublisher } from "../transcript/segment-publisher.js";
import type { TranscriptSegment } from "../transcript/transcript-types.js";
import type { FeedbackGeneratedEnvelope } from "../events/redis-feedback-stream.js";

interface CaptionPublisherLogger {
  info(values: Record<string, unknown>, message: string): void;
}

interface CaptionPublisherContext {
  meetingId: string;
  sessionId: string;
}

export class LiveKitCaptionPublisher implements CaptionPublisher {
  /** 발행된 총 자막 개수를 추적합니다. */
  private publishedCaptionCount = 0;

  constructor(
    private readonly room: Room,
    private readonly logger: CaptionPublisherLogger,
    private readonly context: CaptionPublisherContext
  ) {}

  /** 
   * [자막 발행] 생성된 전사/번역 데이터를 'caption.updated' 토픽으로 실시간 전송합니다.
   * 프론트엔드는 이 이벤트를 수신하여 화면의 자막 바를 업데이트합니다.
   */
  async publishCaption(segment: TranscriptSegment): Promise<void> {
    const publishedAtMs = Date.now();
    await this.publish("caption.updated", {
      eventType: "caption.updated",
      meetingId: segment.meetingId,
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      sequence: segment.sequence,
      status: segment.status, // STREAMING 또는 FINALIZED
      language: segment.language,
      text: segment.text,
      startedAtMs: segment.startedAtMs,
      startedAtEpochMs: segment.startedAtEpochMs ?? null,
      endedAtMs: segment.endedAtMs ?? null,
      publishedAtMs,
      sourceLanguage: segment.sourceLanguage,
      sourceText: segment.sourceText,
      koText: segment.koText,
      enText: segment.enText,
      sourceTranscript: segment.sourceTranscript?.trim() || undefined,
      updatedAt: new Date().toISOString()
    });
    
    this.publishedCaptionCount++;
    
    // 로그 과부하를 막기 위해 첫 패킷과 최종 패킷 위주로 기록
    if (this.publishedCaptionCount === 1 || segment.status === "FINALIZED") {
      this.logger.info(
        {
          ...this.context,
          segmentId: segment.segmentId,
          status: segment.status,
          textPreview: buildTextPreview(segment.text)
        },
        "LiveKit 데이터 채널로 자막 이벤트 발행 완료"
      );
    }
  }

  /** [피드백 발행] AI 분석 서버로부터 수신된 피드백 결과를 'feedback.generated' 토픽으로 전송합니다. */
  async publishFeedback(
    event: FeedbackGeneratedEnvelope,
    destinationIdentities: readonly string[]
  ): Promise<void> {
    if (destinationIdentities.length === 0) return;
    const {
      feedbackId,
      meetingId,
      sessionId,
      feedbackType,
      message,
      sources,
      generatedAt
    } = event.payload;
    await this.publish("feedback.generated", {
      eventType: "feedback.generated",
      feedbackId,
      meetingId,
      sessionId,
      feedbackType,
      message,
      sources,
      generatedAt
    }, destinationIdentities);
  }

  async publishMeetingEnded(message = "해당 회의는 종료되었습니다."): Promise<void> {
    await this.publish("meeting.ended", {
      eventType: "meeting.ended",
      meetingId: this.context.meetingId,
      reason: message,
      endedAt: new Date().toISOString()
    });
  }

  /** LiveKit 네이티브 SDK의 데이터 전송 기능을 호출합니다. */
  private async publish(
    topic: string,
    payload: Record<string, unknown>,
    destinationIdentities?: readonly string[]
  ): Promise<void> {
    const participant = this.room.localParticipant;
    if (!participant) throw new Error("발행을 위한 로컬 참가자 객체가 존재하지 않습니다.");

    await participant.publishData(
      new TextEncoder().encode(JSON.stringify(payload)),
      {
        reliable: true, // 전송 보장 모드 사용
        topic,
        destination_identities: destinationIdentities
          ? [...destinationIdentities]
          : undefined
      }
    );
  }
}

/** 긴 텍스트를 로그에 남기기 적절한 길이로 축약합니다. */
function buildTextPreview(text: string): string {
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

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
  private publishedCaptionCount = 0;

  constructor(
    private readonly room: Room,
    private readonly logger: CaptionPublisherLogger,
    private readonly context: CaptionPublisherContext
  ) {}

  async publishCaption(segment: TranscriptSegment): Promise<void> {
    // DataChannel에는 caption.updated만 보낸다. FE는 이 payload만 보고 화면을 갱신한다.
    await this.publish("caption.updated", {
      eventType: "caption.updated",
      meetingId: segment.meetingId,
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      sequence: segment.sequence,
      status: segment.status,
      language: segment.language,
      text: segment.text,
      startedAtMs: segment.startedAtMs,
      endedAtMs: segment.endedAtMs ?? null,
      sourceLanguage: segment.sourceLanguage,
      sourceText: segment.sourceText,
      sourceTranscript: segment.sourceTranscript?.trim() || undefined,
      updatedAt: new Date().toISOString()
    });
    this.publishedCaptionCount += 1;
    if (this.publishedCaptionCount === 1 || segment.status === "FINALIZED") {
      // 첫 패킷과 최종 패킷만 로깅해 스트리밍 중복 로그를 줄인다.
      this.logger.info(
        {
          ...this.context,
          segmentId: segment.segmentId,
          sequence: segment.sequence,
          status: segment.status,
          publishedCaptionCount: this.publishedCaptionCount
        },
        "caption.updated published to LiveKit DataChannel"
      );
    }
  }

  async publishFeedback(event: FeedbackGeneratedEnvelope): Promise<void> {
    // AI가 만든 피드백 결과도 같은 room 안에서 별도 topic으로 재전달한다.
    await this.publish("feedback.generated", {
      eventType: "feedback.generated",
      ...event.payload
    });
  }

  private async publish(
    topic: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const participant = this.room.localParticipant;
    if (!participant) {
      throw new Error("LiveKit room has no local participant");
    }
    await participant.publishData(
      new TextEncoder().encode(JSON.stringify(payload)),
      {
        reliable: true,
        topic
      }
    );
  }
}

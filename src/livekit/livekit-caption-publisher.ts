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
    await this.publish("caption.updated", {
      eventType: "caption.updated",
      ...segment,
      updatedAt: new Date().toISOString()
    });
    this.publishedCaptionCount += 1;
    if (this.publishedCaptionCount === 1 || segment.status === "FINALIZED") {
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

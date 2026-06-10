import type { Room } from "@livekit/rtc-node";

import type { CaptionPublisher } from "../transcript/segment-publisher.js";
import type { TranscriptSegment } from "../transcript/transcript-types.js";
import type { FeedbackGeneratedEnvelope } from "../events/redis-feedback-stream.js";

export class LiveKitCaptionPublisher implements CaptionPublisher {
  constructor(private readonly room: Room) {}

  async publishCaption(segment: TranscriptSegment): Promise<void> {
    await this.publish("caption.updated", {
      eventType: "caption.updated",
      ...segment,
      updatedAt: new Date().toISOString()
    });
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

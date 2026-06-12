import type { FinalSegmentPublisher } from "../transcript/segment-publisher.js";
import type {
  FinalizationReason,
  TranscriptSegment
} from "../transcript/transcript-types.js";

export class CompositeFinalSegmentPublisher
  implements FinalSegmentPublisher
{
  constructor(private readonly publishers: FinalSegmentPublisher[]) {}

  async publishFinalSegment(
    segment: TranscriptSegment,
    reason: FinalizationReason,
    correlationId: string
  ): Promise<void> {
    // 동일 final segment를 RabbitMQ와 Redis Stream에 동시에 전달한다.
    const results = await Promise.allSettled(
      this.publishers.map((publisher) =>
        publisher.publishFinalSegment(segment, reason, correlationId)
      )
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected"
    );
    if (failures.length > 0) {
      // 일부만 실패하면 호출자가 재시도/보정 판단을 할 수 있도록 aggregate error를 던진다.
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "One or more final segment publishers failed"
      );
    }
  }
}

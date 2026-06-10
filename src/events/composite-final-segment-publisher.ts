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
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "One or more final segment publishers failed"
      );
    }
  }
}

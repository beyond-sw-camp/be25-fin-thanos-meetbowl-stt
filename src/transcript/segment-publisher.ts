import type {
  FinalizationReason,
  TranscriptSegment
} from "./transcript-types.js";

export interface CaptionPublisher {
  publishCaption(segment: TranscriptSegment): Promise<void>;
}

export interface FinalSegmentPublisher {
  publishFinalSegment(
    segment: TranscriptSegment,
    reason: FinalizationReason,
    correlationId: string
  ): Promise<void>;
}

/**
 * 여러 개의 최종 세그먼트 퍼블리셔(RabbitMQ, Redis 등)를 하나로 묶어 관리하는 컴포지트(Composite) 클래스입니다.
 * 단일 호출로 등록된 모든 퍼블리셔에게 데이터를 동시에 전파합니다.
 */
import type { FinalSegmentPublisher } from "../transcript/segment-publisher.js";
import type {
  FinalizationReason,
  TranscriptSegment
} from "../transcript/transcript-types.js";

export class CompositeFinalSegmentPublisher
  implements FinalSegmentPublisher
{
  constructor(private readonly publishers: FinalSegmentPublisher[]) {}

  /** 
   * [자막 통합 전파] 확정된 자막 데이터를 모든 등록된 퍼블리셔에 비동기로 전달합니다.
   * 모든 작업이 완료될 때까지 기다리며, 일부 실패 시에도 나머지 시도를 중단하지 않습니다.
   */
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
    
    // 실패한 작업들만 필터링하여 확인합니다.
    const failures = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected"
    );
    
    if (failures.length > 0) {
      /**
       * 하나 이상의 퍼블리셔가 실패한 경우 호출자에게 알리기 위해 AggregateError를 던집니다.
       * 이는 시스템의 데이터 전파 상태를 모니터링하기 위함입니다.
       */
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "하나 이상의 최종 세그먼트 발행 작업이 실패했습니다."
      );
    }
  }
}

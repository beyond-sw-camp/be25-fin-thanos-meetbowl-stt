/**
 * 생성된 자막 데이터를 외부(UI 또는 메시지 브로커)로 전달하기 위한 발행(Publisher) 인터페이스 정의 파일입니다.
 * 실제 전송 기술(LiveKit DataChannel, RabbitMQ 등)에 의존하지 않는 논리적 송신 계약을 정의합니다.
 */
import type {
  FinalizationReason,
  TranscriptSegment
} from "./transcript-types.js";

/** 
 * 실시간 사용자 화면에 자막을 표시하기 위한 퍼블리셔 인터페이스입니다. 
 */
export interface CaptionPublisher {
  /** 
   * 현재 분석 중인 자막 상태(STREAMING 또는 FINALIZED)를 전송합니다.
   * @param segment 발행할 자막 세그먼트 정보
   */
  publishCaption(segment: TranscriptSegment): Promise<void>;

  /**
   * FINALIZED 세그먼트가 RabbitMQ/Redis 등 후속 경로로 실제 전파된 뒤,
   * 프론트 디버깅용으로 전송 여부를 알려주는 선택적 훅입니다.
   */
  publishFinalSegmentDelivered?(segment: TranscriptSegment): Promise<void>;
}

/** 
 * 확정된 자막 데이터를 영구 저장소나 실시간 분석 엔진으로 전달하기 위한 퍼블리셔 인터페이스입니다. 
 */
export interface FinalSegmentPublisher {
  /** 
   * 한 문장의 분석이 완전히 끝났을 때(FINALIZED) 해당 데이터를 외부 시스템에 공표합니다.
   * @param segment 확정된 자막 세그먼트
   * @param reason 확정 사유 (VAD 무음, 타임아웃 등)
   * @param correlationId 트랜잭션 추적을 위한 상관관계 ID
   */
  publishFinalSegment(
    segment: TranscriptSegment,
    reason: FinalizationReason,
    correlationId: string
  ): Promise<void>;
}

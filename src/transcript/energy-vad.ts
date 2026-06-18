/**
 * 오디오 프레임의 에너지 세기(RMS)를 기반으로 음성 활동 여부를 감지하는 VAD(Voice Activity Detection) 클래스입니다.
 * 하드웨어 잡음과 실제 사람의 발화 구간을 구분하는 기초적인 분석을 수행합니다.
 */
export interface EnergyVadOptions {
  /** 유효한 목소리로 간주할 최소 에너지 임계값(Root Mean Square)입니다. */
  rmsThreshold: number;
  /** 마지막 음성 감지 후 발화 종료로 판단하기까지 대기할 무음 시간(ms)입니다. */
  silenceMs: number;
}

export interface VadUpdate {
  /** 정지 상태에서 발화가 새로 시작되었는지 여부입니다. */
  speechStarted: boolean;
  /** 발화 중 상태에서 무음 구간으로 진입하여 정지되었는지 여부입니다. */
  speechStopped: boolean;
}

export class EnergyVad {
  /** 현재 음성 신호가 유효한지(말하는 중인지) 관리하는 내부 상태입니다. */
  private speaking = false;
  /** 마지막으로 유효 에너지(Threshold 이상)가 감지된 시점의 타임스탬프입니다. */
  private lastVoiceAtMs?: number;

  constructor(private readonly options: EnergyVadOptions) {}

  /**
   * [활동 상태 업데이트] 새로운 오디오 샘플 데이터를 분석하여 상태 변화를 반환합니다.
   * @param samples 16비트 정수형 PCM 데이터 배열
   * @param nowMs 현재 시스템 타임스탬프
   */
  update(samples: Int16Array, nowMs: number): VadUpdate {
    // 1. 현재 오디오 프레임의 RMS(제곱평균제곱근)를 계산하여 물리적 세기를 측정합니다.
    const rms = calculateRms(samples);
    
    if (rms >= this.options.rmsThreshold) {
      // 2. 임계값 이상의 에너지가 감지된 경우 화자 활동 중으로 판단
      this.lastVoiceAtMs = nowMs;
      if (!this.speaking) {
        this.speaking = true;
        return { speechStarted: true, speechStopped: false };
      }
      return { speechStarted: false, speechStopped: false };
    }

    /**
     * 3. [무음 판정 로직]
     * 단순히 에너지가 0이 된 시점이 아니라, 임계값 미만 상태가 일정 시간(silenceMs) 
     * 이상 지속되었을 때 비로소 발화가 종료된 것으로 간주합니다.
     */
    if (
      this.speaking &&
      this.lastVoiceAtMs !== undefined &&
      nowMs - this.lastVoiceAtMs >= this.options.silenceMs
    ) {
      this.speaking = false;
      return { speechStarted: false, speechStopped: true };
    }
    
    return { speechStarted: false, speechStopped: false };
  }
}

/**
 * PCM 샘플 데이터로부터 오디오 신호의 평균 세기(RMS)를 계산합니다.
 * @param samples Int16 범위(-32768 ~ 32767)의 오디오 샘플
 * @returns 0.0 ~ 1.0 사이의 에너지 레벨
 */
function calculateRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  
  /** 모든 샘플의 제곱합입니다. 나중에 평균을 낸 뒤 제곱근을 취해 RMS를 계산합니다. */
  let sumSquares = 0;
  for (const sample of samples) {
    // 오디오 진폭을 -1.0 ~ 1.0 범위로 정규화한 뒤 제곱하여 합산
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  
  // 전체 합계를 샘플 수로 나누고 제곱근을 취해 물리적인 실효치(Root Mean Square)를 도출
  return Math.sqrt(sumSquares / samples.length);
}

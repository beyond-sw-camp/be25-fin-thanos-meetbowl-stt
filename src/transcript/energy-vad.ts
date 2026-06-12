export interface EnergyVadOptions {
  rmsThreshold: number;
  silenceMs: number;
}

export interface VadUpdate {
  speechStarted: boolean;
  speechStopped: boolean;
}

export class EnergyVad {
  private speaking = false;
  private lastVoiceAtMs?: number;

  constructor(private readonly options: EnergyVadOptions) {}

  update(samples: Int16Array, nowMs: number): VadUpdate {
    // PCM frame의 평균 에너지(RMS)를 계산해 음성 여부를 근사한다.
    const rms = calculateRms(samples);
    if (rms >= this.options.rmsThreshold) {
      this.lastVoiceAtMs = nowMs;
      if (!this.speaking) {
        // threshold를 넘는 첫 frame을 발화 시작으로 본다.
        this.speaking = true;
        return { speechStarted: true, speechStopped: false };
      }
      return { speechStarted: false, speechStopped: false };
    }

    if (
      this.speaking &&
      this.lastVoiceAtMs !== undefined &&
      nowMs - this.lastVoiceAtMs >= this.options.silenceMs
    ) {
      // 마지막 음성 이후 silenceMs 이상 지나면 발화 종료로 본다.
      this.speaking = false;
      return { speechStarted: false, speechStopped: true };
    }
    return { speechStarted: false, speechStopped: false };
  }
}

function calculateRms(samples: Int16Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (const sample of samples) {
    // Int16 PCM은 -32768..32767 범위이므로 -1..1로 정규화한다.
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

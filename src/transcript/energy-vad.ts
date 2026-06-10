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
    const rms = calculateRms(samples);
    if (rms >= this.options.rmsThreshold) {
      this.lastVoiceAtMs = nowMs;
      if (!this.speaking) {
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
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

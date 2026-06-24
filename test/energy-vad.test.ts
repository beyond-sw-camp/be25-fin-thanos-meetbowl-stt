import assert from "node:assert/strict";
import test from "node:test";

import { EnergyVad } from "../src/transcript/energy-vad.js";

test("starts on voice energy and stops after configured silence", () => {
  const vad = new EnergyVad({ rmsThreshold: 0.01, silenceMs: 100 });
  const voice = new Int16Array([2000, -2000, 2000, -2000]);
  const silence = new Int16Array(4);

  assert.deepEqual(vad.update(voice, 1000), {
    speechStarted: true,
    speechStopped: false
  });
  assert.deepEqual(vad.update(silence, 1050), {
    speechStarted: false,
    speechStopped: false
  });
  assert.deepEqual(vad.update(silence, 1100), {
    speechStarted: false,
    speechStopped: true
  });
});

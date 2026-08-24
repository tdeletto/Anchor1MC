/**
 * Energy-based voice activity detection, used only to decide when to auto-stop
 * a toggle-mode recording. It adapts to the room's noise floor rather than
 * using a fixed threshold, so a noisy cafe does not record forever.
 */
export class SilenceDetector {
  /**
   * @param {object} o
   * @param {number} o.silenceMs how much trailing silence ends the recording
   * @param {number} o.graceMs   never fire before this much audio exists
   */
  constructor({ silenceMs = 2500, graceMs = 700 } = {}) {
    this.silenceMs = silenceMs;
    this.graceMs = graceMs;
    this.noiseFloor = 0.005;
    this.silentSince = null;
    // Latched on the first sample rather than at construction: the detector is
    // built slightly before capture actually starts, and the caller's clock is
    // the one the timings must be measured against.
    this.startedAt = null;
    this.sawSpeech = false;
  }

  /**
   * @param {number} rms level of the latest audio block, 0..1
   * @param {number} now
   * @returns {boolean} true when the recording should stop
   */
  push(rms, now = performance.now()) {
    if (this.startedAt === null) this.startedAt = now;
    const threshold = Math.max(this.noiseFloor * 3, 0.008);
    // The opening moments are treated as ambient, which is what calibrates the
    // floor for a noisy room.
    const calibrating = now - this.startedAt < this.graceMs;
    const speaking = !calibrating && rms > threshold;

    // Crucially, the floor only moves while we believe nobody is talking.
    // Letting speech raise it means a long uninterrupted sentence eventually
    // lifts the threshold above the speaker's own level, and the recording
    // cuts off mid-word.
    if (calibrating) {
      this.noiseFloor = this.noiseFloor * 0.7 + rms * 0.3;
    } else if (!speaking) {
      this.noiseFloor = rms < this.noiseFloor
        ? this.noiseFloor * 0.9 + rms * 0.1
        : this.noiseFloor * 0.98 + rms * 0.02;
    }

    if (speaking) {
      this.sawSpeech = true;
      this.silentSince = null;
      return false;
    }
    if (this.silentSince === null) this.silentSince = now;
    if (now - this.startedAt < this.graceMs) return false;
    // Do not cut someone off who has not started talking yet; give them a
    // longer runway before the first word than between sentences.
    const limit = this.sawSpeech ? this.silenceMs : Math.max(this.silenceMs, 4000);
    return now - this.silentSince >= limit;
  }
}

/** RMS of one audio block, for both VAD and the waveform display. */
export function rms(block) {
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
  return Math.sqrt(sum / block.length);
}

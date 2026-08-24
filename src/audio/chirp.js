/** Generates the short start/stop chirps as WAV bytes. */
import { encodeWav } from './resample.js';

export const CHIRP_RATE = 44100;

/**
 * A sine chirp shaped so it neither clicks on attack nor rings on release.
 *
 * @param {number} frequency Hz
 * @param {number} seconds   total duration, envelope included
 * @param {number} volume    0..1 peak amplitude
 * @returns {Blob} audio/wav
 */
export function chirpWav(frequency, seconds = 0.08, volume = 0.25, rate = CHIRP_RATE) {
  const length = Math.max(1, Math.round(rate * seconds));
  // Short enough to stay crisp, long enough that neither edge is a click.
  const attack = Math.max(1, Math.round(rate * 0.006));
  const release = Math.max(1, Math.round(rate * 0.02));
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const envelope = Math.min(1, i / attack, (length - i) / release);
    samples[i] = volume * envelope * Math.sin((2 * Math.PI * frequency * i) / rate);
  }
  return encodeWav(samples, rate);
}

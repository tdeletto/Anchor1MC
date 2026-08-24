/** Mic audio is whatever rate the device gives us; every model wants 16 kHz mono. */

export const TARGET_RATE = 16000;

/**
 * High-quality resample via OfflineAudioContext.
 * @param {Float32Array} samples mono PCM
 * @param {number} fromRate
 * @returns {Promise<Float32Array>} mono PCM at 16 kHz
 */
export async function resampleTo16k(samples, fromRate) {
  if (fromRate === TARGET_RATE) return samples;
  const frames = Math.max(1, Math.round((samples.length * TARGET_RATE) / fromRate));
  const ctx = new OfflineAudioContext(1, frames, TARGET_RATE);
  const buffer = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate: fromRate });
  buffer.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Average interleaved/multi-channel data down to mono. */
export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (let i = 0; i < out.length; i += 1) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/** Concatenate the chunk list an AudioWorklet handed us. */
export function concat(chunks, totalLength) {
  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 16-bit PCM WAV, for history playback and for OpenAI-compatible upload. */
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (offset, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

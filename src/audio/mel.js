/**
 * Log-mel front-end matching NeMo's AudioToMelSpectrogramPreprocessor, which is
 * what Parakeet expects.
 *
 * This is only the fallback path: when the model repo ships the exported
 * preprocessor graph (nemo128.onnx), the engine runs that instead, because it is
 * guaranteed to match the training front-end. This implementation follows the
 * same recipe — preemphasis, periodic Hann, power spectrum, Slaney-normalized
 * mel filters, log, then per-feature normalization.
 */
import { FFT } from './fft.js';

const DEFAULTS = {
  sampleRate: 16000,
  nFft: 512,
  winLength: 400,   // 25 ms
  hopLength: 160,   // 10 ms
  nMels: 128,
  fMin: 0,
  fMax: 8000,
  preemph: 0.97,
  logGuard: 2 ** -24,
};

const hzToMel = (hz) => {
  // Slaney scale: linear below 1 kHz, log above.
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logStep;
};

const melToHz = (mel) => {
  const fSp = 200 / 3;
  const minLogMel = 1000 / fSp;
  const logStep = Math.log(6.4) / 27;
  return mel < minLogMel ? mel * fSp : 1000 * Math.exp(logStep * (mel - minLogMel));
};

/** Triangular mel filterbank, Slaney-normalized (librosa htk=False, norm='slaney'). */
function melFilters({ sampleRate, nFft, nMels, fMin, fMax }) {
  const bins = nFft / 2 + 1;
  const fftFreqs = new Float64Array(bins);
  for (let i = 0; i < bins; i += 1) fftFreqs[i] = (i * sampleRate) / nFft;

  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  const points = new Float64Array(nMels + 2);
  for (let i = 0; i < points.length; i += 1) points[i] = melToHz(melMin + ((melMax - melMin) * i) / (nMels + 1));

  // Stored densely: filters[m * bins + k]
  const filters = new Float32Array(nMels * bins);
  for (let m = 0; m < nMels; m += 1) {
    const left = points[m];
    const center = points[m + 1];
    const right = points[m + 2];
    const enorm = 2 / (right - left);
    for (let k = 0; k < bins; k += 1) {
      const f = fftFreqs[k];
      let w = 0;
      if (f >= left && f <= center && center > left) w = (f - left) / (center - left);
      else if (f > center && f <= right && right > center) w = (right - f) / (right - center);
      filters[m * bins + k] = w * enorm;
    }
  }
  return filters;
}

export class MelSpectrogram {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    const { nFft, winLength } = this.opts;
    this.fft = new FFT(nFft);
    this.filters = melFilters(this.opts);
    // Periodic Hann, as torch.hann_window(periodic=True) produces.
    this.window = new Float32Array(winLength);
    for (let i = 0; i < winLength; i += 1) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / winLength);
    this.frameBuf = new Float32Array(nFft);
    this.powerBuf = new Float32Array(nFft / 2 + 1);
  }

  /**
   * @param {Float32Array} samples 16 kHz mono
   * @returns {{data: Float32Array, nMels: number, frames: number}} [nMels, frames], row-major by mel bin
   */
  compute(samples) {
    const { nFft, winLength, hopLength, nMels, preemph, logGuard } = this.opts;

    // Preemphasis, NeMo-style: y[0] kept, y[n] = x[n] - a * x[n-1].
    const x = new Float32Array(samples.length);
    if (preemph) {
      x[0] = samples[0];
      for (let i = 1; i < samples.length; i += 1) x[i] = samples[i] - preemph * samples[i - 1];
    } else {
      x.set(samples);
    }

    // Center padding by reflection, matching torch.stft(center=True).
    const pad = Math.floor(nFft / 2);
    const padded = new Float32Array(x.length + 2 * pad);
    padded.set(x, pad);
    for (let i = 0; i < pad; i += 1) {
      padded[pad - 1 - i] = x[Math.min(i + 1, x.length - 1)];
      padded[pad + x.length + i] = x[Math.max(x.length - 2 - i, 0)];
    }

    const frames = Math.max(1, 1 + Math.floor((padded.length - nFft) / hopLength));
    const bins = nFft / 2 + 1;
    const out = new Float32Array(nMels * frames);

    for (let t = 0; t < frames; t += 1) {
      const start = t * hopLength;
      this.frameBuf.fill(0);
      for (let i = 0; i < winLength; i += 1) this.frameBuf[i] = (padded[start + i] ?? 0) * this.window[i];
      this.fft.power(this.frameBuf, this.powerBuf);
      for (let m = 0; m < nMels; m += 1) {
        let acc = 0;
        const base = m * bins;
        for (let k = 0; k < bins; k += 1) acc += this.filters[base + k] * this.powerBuf[k];
        out[m * frames + t] = Math.log(acc + logGuard);
      }
    }

    // per_feature normalization: zero mean, unit variance for each mel bin.
    for (let m = 0; m < nMels; m += 1) {
      const base = m * frames;
      let mean = 0;
      for (let t = 0; t < frames; t += 1) mean += out[base + t];
      mean /= frames;
      let varSum = 0;
      for (let t = 0; t < frames; t += 1) {
        const d = out[base + t] - mean;
        varSum += d * d;
      }
      // NeMo divides by std with a small epsilon; frames === 1 has no variance.
      const std = Math.sqrt(varSum / Math.max(1, frames - 1)) + 1e-5;
      for (let t = 0; t < frames; t += 1) out[base + t] = (out[base + t] - mean) / std;
    }

    return { data: out, nMels, frames };
  }
}

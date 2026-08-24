/** Iterative radix-2 FFT. Sized once per instance and reused per frame. */
export class FFT {
  constructor(size) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i += 1) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i += 1) {
      let r = 0;
      for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
  }

  /**
   * Power spectrum of a real signal.
   * @param {Float32Array} input length === size
   * @param {Float32Array} out length === size/2 + 1
   */
  power(input, out) {
    const { size, re, im, rev, cos, sin } = this;
    for (let i = 0; i < size; i += 1) {
      re[i] = input[rev[i]];
      im[i] = 0;
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let i = 0; i < size; i += len) {
        for (let j = 0, k = 0; j < half; j += 1, k += step) {
          const tre = re[i + j + half] * cos[k] - im[i + j + half] * sin[k];
          const tim = re[i + j + half] * sin[k] + im[i + j + half] * cos[k];
          re[i + j + half] = re[i + j] - tre;
          im[i + j + half] = im[i + j] - tim;
          re[i + j] += tre;
          im[i + j] += tim;
        }
      }
    }
    for (let i = 0; i <= size / 2; i += 1) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
  }
}

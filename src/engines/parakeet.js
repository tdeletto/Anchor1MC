/**
 * Parakeet TDT (Token-and-Duration Transducer) running locally through ONNX
 * Runtime Web — the most accurate speech model here that runs on-device.
 *
 * The export is three graphs:
 *   1. a mel front-end (optional; we have a JS equivalent if it is absent),
 *   2. a conformer encoder producing one embedding per 80 ms frame,
 *   3. a fused decoder+joint that, for a given encoder frame and the previously
 *      emitted token, predicts the next token *and how many frames to skip*.
 *
 * That third output is what makes TDT fast: it walks the encoder output in
 * jumps instead of one frame at a time.
 *
 * Graph input/output names differ between exports, so everything is discovered
 * from the session at load time rather than hardcoded.
 */
import { configureOrt, createSession, intTensor, inputTypes, inputDims, ort } from './ort-setup.js';
import { resolveParakeetFiles, getCachedBuffer, getCachedText } from '../lib/models.js';
import { MelSpectrogram } from '../audio/mel.js';
import { logger } from '../lib/log.js';

const log = logger('parakeet');

/** Longer than this and we split at a quiet point rather than feeding one huge tensor. */
const MAX_CHUNK_SEC = 60;
const SAMPLE_RATE = 16000;

const find = (names, patterns, label) => {
  for (const re of patterns) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  throw new Error(`Parakeet: could not find the ${label} tensor. Available: ${names.join(', ')}`);
};

const findOptional = (names, patterns) => {
  for (const re of patterns) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return null;
};

/** Split audio at low-energy points so chunks never cut a word in half. */
function splitAtQuiet(samples, maxSec = MAX_CHUNK_SEC) {
  const maxLen = maxSec * SAMPLE_RATE;
  if (samples.length <= maxLen) return [samples];

  const chunks = [];
  let start = 0;
  const win = 320; // 20 ms
  while (start < samples.length) {
    if (samples.length - start <= maxLen) {
      chunks.push(samples.subarray(start));
      break;
    }
    // Look for the quietest 20 ms window in the last 10 s of the chunk.
    const hardEnd = start + maxLen;
    const searchFrom = hardEnd - 10 * SAMPLE_RATE;
    let bestAt = hardEnd;
    let bestEnergy = Infinity;
    for (let i = searchFrom; i + win < hardEnd; i += win) {
      let e = 0;
      for (let j = i; j < i + win; j += 1) e += samples[j] * samples[j];
      if (e < bestEnergy) {
        bestEnergy = e;
        bestAt = i + win / 2;
      }
    }
    chunks.push(samples.subarray(start, bestAt));
    start = bestAt;
  }
  return chunks;
}

function parseVocab(text, filename) {
  if (filename.endsWith('.json')) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    // { token: id } -> dense array
    const out = [];
    for (const [token, id] of Object.entries(parsed)) out[Number(id)] = token;
    return out;
  }
  // vocab.txt / tokens.txt: one token per line, sometimes "token id".
  return text.split('\n').filter((l) => l.length > 0).map((line) => {
    const parts = line.split(/\s+/);
    return parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])
      ? parts.slice(0, -1).join(' ')
      : line;
  });
}

/** SentencePiece pieces back into text. U+2581 marks a word boundary. */
function detokenize(pieces) {
  return pieces.join('').replaceAll('▁', ' ').replace(/\s+/g, ' ').trim();
}

export class ParakeetEngine {
  static id = 'parakeet';
  static displayName = 'Parakeet V3 (on-device)';

  constructor(config = {}) {
    this.config = config;
    this.loaded = false;
    // Built on first use: the registry constructs a throwaway instance just to
    // read modelKey, and the filterbank is not free.
    this.melFallback = null;
  }

  get modelKey() {
    return `${this.config.modelId}:${this.config.precision}`;
  }

  /** Download (if needed) and instantiate the graphs. */
  async load({ onProgress, signal } = {}) {
    if (this.loaded) return;
    configureOrt({ numThreads: this.config.numThreads });

    const { modelId, precision = 'int8', device = 'auto' } = this.config;
    onProgress?.({ phase: 'resolving', message: `Looking up ${modelId}…` });
    const files = await resolveParakeetFiles(modelId, precision);
    log.info('resolved files', files.names);

    // Weighted progress so the encoder (by far the biggest) dominates the bar.
    const report = (label) => (p) => onProgress?.({
      phase: 'downloading',
      message: `Downloading ${label}…`,
      file: label,
      loaded: p.loaded,
      total: p.total,
      done: p.done,
    });

    const vocabText = await getCachedText(files.vocab, { onProgress: report('vocabulary'), signal });
    this.vocab = parseVocab(vocabText, files.names.vocab);
    this.blankId = this.vocab.length;

    const encoderBuf = await getCachedBuffer(files.encoder, { onProgress: report('encoder'), signal });
    const decoderBuf = await getCachedBuffer(files.decoderJoint, { onProgress: report('decoder'), signal });
    const melBuf = files.mel ? await getCachedBuffer(files.mel, { onProgress: report('preprocessor'), signal }) : null;

    onProgress?.({ phase: 'initializing', message: 'Starting the model…' });

    const enc = await createSession(encoderBuf, { device, graphName: 'parakeet-encoder' });
    this.encoder = enc.session;
    this.provider = enc.provider;

    // The decoder runs once per emitted token with tiny tensors; wasm beats
    // WebGPU there because per-call GPU dispatch overhead dominates.
    const dec = await createSession(decoderBuf, { device: 'wasm', graphName: 'parakeet-decoder-joint' });
    this.decoder = dec.session;

    if (melBuf) {
      // NeMo's exported preprocessor is frequently unrunnable in a browser: it
      // leans on double-precision casts that ONNX Runtime Web has no kernels
      // for, and the session fails to create with "Could not find an
      // implementation for Cast". That is not fatal — mel.js reimplements the
      // same front-end — so treat the graph as an optimization, not a
      // requirement.
      try {
        const mel = await createSession(melBuf, { device: 'wasm', graphName: 'parakeet-preprocessor' });
        this.mel = mel.session;
      } catch (err) {
        log.warn(`preprocessor graph rejected by the runtime, using the built-in front-end instead: ${err?.message ?? err}`);
        this.mel = null;
      }
    }

    this.#mapTensorNames();
    await this.#probeStateShape();
    this.loaded = true;
    onProgress?.({ phase: 'ready', message: 'Ready' });
    log.info(
      `loaded ${modelId} (${precision}) on ${this.provider}; vocab ${this.vocab.length}; `
      + `front-end: ${this.mel ? 'exported graph' : 'built-in log-mel'}`,
    );
  }

  /** Work out this export's tensor names once, so the hot loop stays cheap. */
  #mapTensorNames() {
    const encIn = this.encoder.inputNames;
    const encOut = this.encoder.outputNames;
    const encOutNonLength = encOut.filter((n) => !/len/i.test(n));
    this.names = {
      encAudio: find(encIn, [/audio|signal|features|input|mel/i], 'encoder audio input'),
      encLength: find(encIn, [/len/i], 'encoder length input'),
      encOut: find(encOutNonLength, [/output|encoded|encoder/i, /.*/], 'encoder output'),
      encOutLength: findOptional(encOut, [/len/i]),
    };

    const decIn = this.decoder.inputNames;
    const decOut = this.decoder.outputNames;
    this.names.decEnc = find(decIn, [/encoder|enc_out|^encoder_outputs$/i], 'decoder encoder-frame input');
    this.names.decTargets = find(decIn, [/target(?!.*len)|^targets$|token|label(?!.*len)/i], 'decoder token input');
    this.names.decTargetLen = findOptional(decIn, [/target.*len|label.*len/i]);
    this.names.decStates = decIn.filter((n) => /state/i.test(n)).sort();
    this.names.decLogits = find(decOut, [/^outputs?$|logit|joint/i, /^(?!.*state)(?!.*len).*/], 'decoder logits output');
    this.names.decOutStates = decOut.filter((n) => /state/i.test(n)).sort();

    this.types = {
      enc: inputTypes(this.encoder),
      dec: inputTypes(this.decoder),
      mel: this.mel ? inputTypes(this.mel) : {},
    };
    this.dims = { dec: inputDims(this.decoder) };

    if (this.names.decStates.length !== this.names.decOutStates.length) {
      log.warn('decoder state inputs and outputs do not pair up', this.names.decStates, this.names.decOutStates);
    }
    log.debug('tensor names', this.names);
  }

  /** [1, nMels, frames] features, from the exported front-end or the JS one. */
  async #features(samples) {
    if (this.mel) {
      const inNames = this.mel.inputNames;
      const audioName = find(inNames, [/wave|audio|signal|input/i], 'preprocessor audio input');
      const lenName = findOptional(inNames, [/len/i]);
      const feeds = {
        [audioName]: new ort.Tensor('float32', samples, [1, samples.length]),
      };
      if (lenName) feeds[lenName] = intTensor([samples.length], [1], this.types.mel[lenName]);
      const out = await this.mel.run(feeds);
      const featName = find(this.mel.outputNames, [/^(?!.*len).*/], 'preprocessor features output');
      const lenOut = findOptional(this.mel.outputNames, [/len/i]);
      const tensor = out[featName];
      const frames = lenOut ? Number(out[lenOut].data[0]) : tensor.dims[2];
      return { tensor, frames };
    }

    this.melFallback ??= new MelSpectrogram();
    const { data, nMels, frames } = this.melFallback.compute(samples);
    return { tensor: new ort.Tensor('float32', data, [1, nMels, frames]), frames };
  }

  /**
   * @param {Float32Array} samples 16 kHz mono
   * @returns {Promise<{text: string, chunks: string[]}>}
   */
  async transcribe(samples, { onPartial, signal } = {}) {
    if (!this.loaded) throw new Error('Parakeet engine used before load()');
    const pieces = [];
    const chunks = splitAtQuiet(samples);
    for (const [i, chunk] of chunks.entries()) {
      signal?.throwIfAborted();
      const text = await this.#transcribeChunk(chunk);
      pieces.push(text);
      if (chunks.length > 1) onPartial?.(pieces.join(' ').trim(), { chunk: i + 1, of: chunks.length });
    }
    return { text: pieces.join(' ').replace(/\s+/g, ' ').trim(), chunks: pieces };
  }

  async #transcribeChunk(samples) {
    const { tensor: features, frames } = await this.#features(samples);

    const encFeeds = {
      [this.names.encAudio]: features,
      [this.names.encLength]: intTensor([frames], [1], this.types.enc[this.names.encLength]),
    };
    const encOut = await this.encoder.run(encFeeds);
    const encoded = encOut[this.names.encOut];
    const encLen = this.names.encOutLength ? Number(encOut[this.names.encOutLength].data[0]) : null;

    // NeMo exports are usually [B, D, T]; some are [B, T, D]. The reported
    // encoded length tells us which axis is time without guessing.
    const [, a, b] = encoded.dims;
    let timeSteps;
    let hidden;
    let timeMajor; // true when layout is [B, T, D]
    if (encLen !== null && b === encLen && a !== encLen) {
      timeSteps = b; hidden = a; timeMajor = false;
    } else if (encLen !== null && a === encLen && b !== encLen) {
      timeSteps = a; hidden = b; timeMajor = true;
    } else {
      // Fall back on the shape of the thing: hidden size is 512/1024, and a
      // dictation has far more frames than that only past ~10 s, so prefer the
      // axis that looks like a model dimension.
      const looksHidden = (n) => n === 512 || n === 640 || n === 768 || n === 1024;
      timeMajor = looksHidden(b) && !looksHidden(a);
      timeSteps = timeMajor ? a : b;
      hidden = timeMajor ? b : a;
    }
    if (encLen !== null) timeSteps = Math.min(timeSteps, encLen);

    return this.#greedyDecode(encoded.data, { timeSteps, hidden, timeMajor });
  }

  /**
   * TDT greedy search.
   *
   * At each encoder frame the joint predicts a token and a duration. A non-blank
   * token is emitted and the prediction network advances; either way we jump
   * forward by the predicted duration.
   */
  async #greedyDecode(encData, { timeSteps, hidden, timeMajor }) {
    const frame = new Float32Array(hidden);
    const emitted = [];

    let states = this.#zeroStates();
    let lastToken = this.blankId;
    let t = 0;
    let symbolsAtT = 0;
    const MAX_SYMBOLS_PER_STEP = 10;

    while (t < timeSteps) {
      // Copy out encoder frame t.
      if (timeMajor) {
        frame.set(encData.subarray(t * hidden, (t + 1) * hidden));
      } else {
        for (let d = 0; d < hidden; d += 1) frame[d] = encData[d * timeSteps + t];
      }

      const feeds = {
        [this.names.decEnc]: this.#encoderFrameTensor(frame, hidden),
        [this.names.decTargets]: intTensor([lastToken], [1, 1], this.types.dec[this.names.decTargets]),
      };
      if (this.names.decTargetLen) {
        feeds[this.names.decTargetLen] = intTensor([1], [1], this.types.dec[this.names.decTargetLen]);
      }
      for (const [i, name] of this.names.decStates.entries()) feeds[name] = states[i];

      const out = await this.decoder.run(feeds);
      const logits = out[this.names.decLogits].data;

      // Trailing outputs are the duration head: |vocab| + 1 blank + N durations.
      const numDurations = logits.length - (this.blankId + 1);
      let bestToken = 0;
      let bestTokenScore = -Infinity;
      for (let i = 0; i <= this.blankId; i += 1) {
        if (logits[i] > bestTokenScore) { bestTokenScore = logits[i]; bestToken = i; }
      }
      let duration = 1;
      if (numDurations > 0) {
        let bestDurScore = -Infinity;
        let bestDurIdx = 0;
        for (let i = 0; i < numDurations; i += 1) {
          const v = logits[this.blankId + 1 + i];
          if (v > bestDurScore) { bestDurScore = v; bestDurIdx = i; }
        }
        // Exported durations are the index itself: [0, 1, 2, …].
        duration = bestDurIdx;
      }

      if (bestToken !== this.blankId) {
        emitted.push(this.vocab[bestToken] ?? '');
        lastToken = bestToken;
        states = this.names.decOutStates.map((n) => out[n]);
        symbolsAtT += 1;
      } else {
        symbolsAtT = 0;
      }

      // A zero duration means "stay on this frame and emit again". Guard against
      // a model that never advances, which would otherwise hang the tab.
      if (duration === 0 && (bestToken === this.blankId || symbolsAtT >= MAX_SYMBOLS_PER_STEP)) {
        t += 1;
        symbolsAtT = 0;
      } else {
        t += duration;
      }
    }

    return detokenize(emitted);
  }

  /** The decoder wants one frame; exports disagree on [B,1,D] vs [B,D,1]. */
  #encoderFrameTensor(frame, hidden) {
    const declared = this.dims.dec[this.names.decEnc];
    if (Array.isArray(declared) && declared.length === 3 && declared[1] === hidden) {
      return new ort.Tensor('float32', frame, [1, hidden, 1]);
    }
    return new ort.Tensor('float32', frame, [1, 1, hidden]);
  }

  /**
   * Decide the prediction network's state shape.
   *
   * Exports leave the layer and hidden dimensions symbolic often enough that
   * reading them off the graph is not reliable, and a wrong shape only shows up
   * as a failure on the first decode. So try the plausible shapes once, at load
   * time, against a zero encoder frame and keep whichever the graph accepts.
   */
  async #probeStateShape() {
    // Width of one encoder frame, read off the decoder's own input when the
    // export declares it, since that is the tensor we have to fabricate.
    const encDims = this.dims.dec[this.names.decEnc];
    const encoderHidden = Array.isArray(encDims)
      ? (encDims.filter((d) => typeof d === 'number' && d > 1)[0] ?? 1024)
      : 1024;

    if (this.names.decStates.length === 0) {
      this.stateDims = [];
      return;
    }
    const declared = this.dims.dec[this.names.decStates[0]];
    const fromGraph = Array.isArray(declared) && declared.every((d) => typeof d === 'number' && d > 0)
      ? [declared]
      : [];
    const candidates = [
      ...fromGraph,
      [1, 1, 640], [2, 1, 640], [1, 1, 1024], [2, 1, 1024], [1, 1, 512], [2, 1, 512],
    ];

    for (const dims of candidates) {
      this.stateDims = dims;
      try {
        const frame = new Float32Array(encoderHidden);
        const feeds = {
          [this.names.decEnc]: this.#encoderFrameTensor(frame, encoderHidden),
          [this.names.decTargets]: intTensor([this.blankId], [1, 1], this.types.dec[this.names.decTargets]),
        };
        if (this.names.decTargetLen) {
          feeds[this.names.decTargetLen] = intTensor([1], [1], this.types.dec[this.names.decTargetLen]);
        }
        for (const [i, name] of this.names.decStates.entries()) feeds[name] = this.#zeroStates()[i];
        await this.decoder.run(feeds);
        log.info('prediction-network state shape', dims);
        return;
      } catch (err) {
        log.debug(`state shape ${dims.join('x')} rejected: ${err?.message ?? err}`);
      }
    }
    // Nothing worked; keep the last guess so the real error surfaces on decode
    // with the runtime's own message rather than one invented here.
    log.warn('Could not determine the prediction-network state shape; falling back to 2x1x640.');
    this.stateDims = [2, 1, 640];
  }

  /** Zeroed LSTM state for the prediction network. */
  #zeroStates() {
    const dims = this.stateDims ?? [2, 1, 640];
    const size = dims.reduce((a, b) => a * b, 1);
    return this.names.decStates.map(() => new ort.Tensor('float32', new Float32Array(size), dims));
  }

  async unload() {
    for (const s of [this.encoder, this.decoder, this.mel]) {
      try { await s?.release?.(); } catch { /* already gone */ }
    }
    this.encoder = this.decoder = this.mel = null;
    this.loaded = false;
  }
}

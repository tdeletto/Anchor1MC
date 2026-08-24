/**
 * Any OpenAI-compatible /v1/audio/transcriptions server: whisper.cpp's
 * server, faster-whisper-server, a Parakeet ONNX server, vLLM, or a hosted
 * open-model endpoint. An API key is optional — most self-hosted servers
 * ignore it entirely.
 */
import { encodeWav } from '../audio/resample.js';
import { logger } from '../lib/log.js';

const log = logger('remote');

const trimSlash = (s) => (s ?? '').replace(/\/+$/, '');

export class RemoteEngine {
  static id = 'remote';
  static displayName = 'Self-hosted / hosted endpoint';

  constructor(config = {}) {
    this.config = config;
    this.loaded = true; // nothing to download
  }

  get modelKey() {
    return `${this.config.baseUrl}:${this.config.model}`;
  }

  async load() { /* no-op */ }

  async transcribe(samples, { language, translate, initialPrompt, signal } = {}) {
    const { baseUrl, model, apiKey, timeoutMs = 120000 } = this.config;
    if (!baseUrl) throw new Error('No transcription endpoint configured. Set one in Anchor1MC options.');

    const wav = encodeWav(samples);
    const form = new FormData();
    form.append('file', wav, 'audio.wav');
    form.append('model', model || 'whisper-1');
    form.append('response_format', 'json');
    if (language && language !== 'auto') form.append('language', language);
    if (initialPrompt) form.append('prompt', initialPrompt);

    const path = translate ? '/audio/translations' : '/audio/transcriptions';
    const url = `${trimSlash(baseUrl)}${path}`;

    const timeout = AbortSignal.timeout(timeoutMs);
    const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        body: form,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
        signal: composite,
      });
    } catch (err) {
      if (timeout.aborted) throw new Error(`The endpoint at ${url} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
      if (signal?.aborted) throw err;
      throw new Error(`Could not reach ${url}. Is the server running, and does it allow requests from extensions? (${err.message})`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Transcription endpoint returned HTTP ${res.status}. ${body.slice(0, 300)}`);
    }

    const payload = await res.json().catch(() => null);
    // OpenAI returns {text}; some servers nest it under segments or results.
    const text = payload?.text
      ?? payload?.results?.[0]?.text
      ?? (Array.isArray(payload?.segments) ? payload.segments.map((s) => s.text).join(' ') : null);
    if (typeof text !== 'string') {
      throw new Error(`Endpoint replied without a "text" field: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    log.debug('remote transcription ok', { chars: text.length });
    return { text: text.trim() };
  }

  async unload() { /* nothing held */ }
}

/** Ping a server's /models so the options page can show a live check. */
export async function testTranscriptionEndpoint({ baseUrl, apiKey }) {
  const url = `${trimSlash(baseUrl)}/models`;
  try {
    const res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status} from ${url}` };
    const data = await res.json().catch(() => null);
    const models = (data?.data ?? data?.models ?? []).map((m) => m.id ?? m.name ?? String(m)).filter(Boolean);
    return { ok: true, message: models.length ? `Reachable — ${models.length} model(s)` : 'Reachable', models };
  } catch (err) {
    return { ok: false, message: `Could not reach ${url}: ${err.message}` };
  }
}

/**
 * Chrome's built-in SpeechRecognition. Zero install and instant, but Chrome
 * streams the audio to Google's servers, so it is the one engine here that is
 * not private. Offered as an escape hatch, never as the default.
 *
 * It captures its own microphone stream, running alongside our recorder, which
 * still provides the level meter, the auto-stop timer, and audio retention.
 */
import { logger } from '../lib/log.js';

const log = logger('webspeech');
const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

export class WebSpeechEngine {
  static id = 'webspeech';
  static displayName = 'Chrome speech recognition (cloud)';

  constructor(config = {}) {
    this.config = config;
    this.loaded = !!Recognition;
  }

  get modelKey() { return 'webspeech'; }

  async load() {
    if (!Recognition) throw new Error('This build of Chrome does not expose SpeechRecognition.');
  }

  /**
   * Unlike the other engines this one is live: start() begins listening and
   * returns a handle whose finish() resolves with the final transcript.
   */
  start({ language, onPartial } = {}) {
    if (!Recognition) throw new Error('SpeechRecognition is unavailable.');
    const rec = new Recognition();
    rec.lang = language && language !== 'auto' ? language : (navigator.language || 'en-US');
    rec.continuous = true;
    rec.interimResults = this.config.interim ?? true;

    let finalText = '';
    let settle;
    const finished = new Promise((resolve) => { settle = resolve; });

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += chunk;
        else interim += chunk;
      }
      onPartial?.(`${finalText}${interim}`.trim());
    };
    rec.onerror = (event) => {
      // 'no-speech' and 'aborted' are normal ways for a dictation to end.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        log.warn('recognition error', event.error);
        this.lastError = event.error;
      }
    };
    rec.onend = () => settle(finalText.trim());

    rec.start();
    this.recognition = rec;

    return {
      finish: async () => {
        try { rec.stop(); } catch { /* already stopped */ }
        const text = await finished;
        if (!text && this.lastError === 'not-allowed') {
          throw new Error('Chrome blocked speech recognition. Check the microphone permission.');
        }
        if (!text && this.lastError === 'network') {
          throw new Error('Chrome speech recognition needs a network connection.');
        }
        return { text };
      },
      abort: () => { try { rec.abort(); } catch { /* already stopped */ } },
    };
  }

  async transcribe() {
    throw new Error('The Chrome speech engine is live-only; use start().');
  }

  async unload() {
    try { this.recognition?.abort(); } catch { /* already stopped */ }
    this.recognition = null;
  }
}

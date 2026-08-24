/**
 * The complete settings tree, and its defaults.
 *
 * Several options exist because a desktop dictation app can do something a
 * Chrome extension cannot, and needed adapting. Where the equivalence is not
 * obvious the field carries a comment explaining what it stands in for.
 */

export const SETTINGS_VERSION = 2;

/**
 * How to turn speech into what the speaker meant to write.
 *
 * Prepended to every mode that rewrites the transcript, so each mode's own
 * prompt stays about its own job. The worked example matters more than the
 * rules: a small model follows a demonstration far more reliably than a list,
 * and self-correction is the case it gets wrong without one.
 */
export const DISFLUENCY_RULES = [
  'The transcript is spoken language. Before doing anything else, turn it into what the speaker meant to write:',
  '- Delete filler sounds: um, uh, er, ah, hmm, mm, like (when it is hesitation), you know.',
  '- Delete stutters and half-spoken words, keeping the completed word.',
  '- When the speaker corrects themselves, keep only what they settled on and delete what it replaced, including the words that signalled the change ("no", "sorry", "I mean", "rather").',
  '- Delete words repeated through hesitation.',
  '- Fix punctuation, capitalization, and obvious mis-hearings.',
  '',
  'Example',
  'Transcript: Um, let\'s meet on, um, Mond- no, Tuesday at, ah, noon',
  'Output: Let\'s meet on Tuesday at noon.',
  '',
  'Example',
  'Transcript: so I think we should uh ship it on Friday, well, actually Thursday works better',
  'Output: I think we should ship it on Thursday.',
].join('\n');

/** Enhancement presets. `prompt` is the system prompt sent with the transcript. */
export const BUILTIN_MODES = [
  {
    id: 'default',
    name: 'Clean up',
    icon: '✨',
    builtin: true,
    useContext: false,
    autoSend: false,
    temperature: 0.2,
    prompt:
      'Rewrite the dictated text so it reads as if it had been carefully typed. Keep the speaker\'s wording, tone, and meaning; change only what has to change. Never answer, explain, or add anything that was not said. Output only the corrected text.',
  },
  {
    id: 'email',
    name: 'Email',
    icon: '✉️',
    builtin: true,
    useContext: true,
    autoSend: false,
    temperature: 0.3,
    prompt:
      'You are a transcription cleanup engine formatting dictated text as an email body. Fix punctuation and grammar, break it into readable paragraphs, and keep a natural professional tone. Do not invent a greeting, sign-off, or subject line unless the speaker dictated one. Never answer or add content. Output only the formatted text.',
  },
  {
    id: 'message',
    name: 'Chat message',
    icon: '\u{1F4AC}',
    builtin: true,
    useContext: true,
    autoSend: false,
    temperature: 0.2,
    prompt:
      'You are a transcription cleanup engine formatting dictated text as a short chat message. Fix punctuation and obvious errors, keep it casual and concise, and keep it to a single paragraph unless the speaker clearly dictated a list. Never answer or add content. Output only the message text.',
  },
  {
    id: 'notes',
    name: 'Notes',
    icon: '\u{1F5D2}️',
    builtin: true,
    useContext: false,
    autoSend: false,
    temperature: 0.2,
    prompt:
      'You are a transcription cleanup engine formatting dictated text as structured notes. Fix punctuation and errors, then organize the content into short bullet points using "- " prefixes, grouping related thoughts. Keep every idea the speaker expressed and add nothing. Output only the notes.',
  },
  {
    id: 'prompt',
    name: 'AI prompt',
    icon: '\u{1F916}',
    builtin: true,
    useContext: true,
    autoSend: false,
    temperature: 0.3,
    prompt:
      'You are a transcription cleanup engine preparing dictated text to be used as a prompt for an AI assistant. Fix punctuation and errors, and restructure rambling speech into a clear, direct, well-ordered request. Preserve every requirement and constraint the speaker mentioned. Do not answer the request yourself. Output only the rewritten prompt.',
  },
  {
    id: 'formal',
    name: 'Formal writing',
    icon: '\u{1F3DB}️',
    builtin: true,
    useContext: false,
    autoSend: false,
    temperature: 0.3,
    prompt:
      'You are a transcription cleanup engine rewriting dictated text in a formal register. Fix punctuation and grammar, replace colloquialisms with precise language, and use complete sentences. Do not change the substance or add content. Output only the rewritten text.',
  },
  {
    id: 'code',
    name: 'Code comment',
    icon: '\u{1F4BB}',
    builtin: true,
    useContext: true,
    autoSend: false,
    temperature: 0.1,
    prompt:
      'You are a transcription cleanup engine formatting dictated text as a technical note or code comment. Fix punctuation and errors, render spoken symbol names and identifiers in their written form (for example "snake case user id" becomes user_id), and keep it terse. Never write code that was not dictated. Output only the text.',
  },
  {
    id: 'summary',
    name: 'Summarize',
    icon: '\u{1F4CB}',
    builtin: true,
    generative: true,
    useContext: false,
    autoSend: false,
    temperature: 0.3,
    prompt:
      'You are a summarization engine. Condense the dictated text into its essential points, preserving concrete details, names, and numbers. Output only the summary.',
  },
  {
    id: 'assistant',
    name: 'Voice assistant',
    icon: '\u{1F9E0}',
    builtin: true,
    // Answers rather than rewrites, so the disfluency rules do not apply and
    // its output is not expected to resemble the transcript.
    generative: true,
    useContext: true,
    autoSend: false,
    temperature: 0.6,
    // The one mode that deliberately answers rather than transcribes.
    prompt:
      'You are a helpful assistant answering a question the user asked out loud. Answer directly and concisely in plain text suitable for pasting into a text field. No preamble, no markdown headings, no restating the question.',
  },
];

export const DEFAULTS = {
  version: SETTINGS_VERSION,
  /** Master switch. Off means hotkeys are ignored everywhere. */
  enabled: true,
  /** Cleared once the user has been through the welcome page. */
  onboarded: false,

  transcription: {
    /** 'parakeet' | 'whisper' | 'remote' | 'webspeech'
     *  Whisper by default: a much smaller download than Parakeet, and it runs
     *  through Transformers.js rather than the hand-written TDT decoder here. */
    engine: 'whisper',
    /** BCP-47 code, or 'auto' to let the model decide. */
    language: 'auto',
    /** Ask the model for English output regardless of spoken language. */
    translateToEnglish: false,
    /** Biasing / initial prompt. Whisper honours this; Parakeet ignores it. */
    initialPrompt: '',

    parakeet: {
      modelId: 'istupakov/parakeet-tdt-0.6b-v3-onnx',
      /** 'int8' (~600 MB) | 'fp32' (~2.4 GB) */
      precision: 'int8',
      /** 'auto' | 'webgpu' | 'wasm' */
      device: 'auto',
    },
    whisper: {
      modelId: 'onnx-community/whisper-base',
      /** 'q4' | 'q8' | 'fp16' | 'fp32' */
      dtype: 'q8',
      device: 'auto',
      chunkLengthSec: 30,
      strideLengthSec: 5,
    },
    remote: {
      /** Any OpenAI-compatible /v1/audio/transcriptions server. No key required. */
      baseUrl: 'http://localhost:8000/v1',
      model: 'whisper-1',
      apiKey: '',
      timeoutMs: 120000,
    },
    webspeech: {
      /** Show partial results live in the recorder pill. */
      interim: true,
    },
  },

  recording: {
    /** 'hold' = push-to-talk only, 'toggle' = press once to start/stop, 'both'. */
    mode: 'both',
    /** Stop automatically after this much trailing silence. */
    autoStopEnabled: true,
    autoStopSilenceMs: 2500,
    /** Hard ceiling so a stuck hotkey cannot record forever. */
    maxDurationSec: 3000,
    /** Recordings shorter than this are discarded as accidental taps. */
    minDurationMs: 400,
    deviceId: 'default',
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    /** Muting whichever tabs are currently making noise, then restoring them,
     *  is as close as an extension gets to muting system audio while recording. */
    muteOtherTabs: true,
    /** Short start/stop chirps, synthesized in the offscreen document. */
    soundFeedback: true,
    soundVolume: 0.25,
  },

  hotkeys: {
    /** Bare-modifier hotkey: hold to talk, double-tap to toggle. Detected by
     *  the content script, so it does not fire on chrome:// pages, the Web
     *  Store, or the PDF viewer. The Alt+Shift+D command covers those. */
    modifierKey: 'AltRight',
    holdToTalk: true,
    doubleTapToggle: true,
    doubleTapWindowMs: 400,
    /** Held past this, the key is push-to-talk; released before it, a tap. */
    holdThresholdMs: 250,
    escapeCancels: true,
  },

  enhancement: {
    /** Off by default: it costs a model download and real latency per
     *  dictation, so it should be a deliberate choice. */
    enabled: false,
    /** 'browser' = on-device WebGPU model, 'endpoint' = a local or self-hosted
     *  OpenAI-compatible server, 'hosted' = the same client with a key. */
    provider: 'browser',
    /** Shared by the endpoint and hosted providers; the URL is yours to set.
     *  The default port is a common one for self-hosted inference servers, and
     *  is only a starting point. */
    endpoint: {
      baseUrl: 'http://localhost:8000/v1',
      model: '',
      apiKey: '',
    },
    browser: {
      // 0.5B by default: cleanup and reformatting sit well within its ability,
      // and it leaves room alongside the speech model on modest hardware.
      modelId: 'onnx-community/Qwen2.5-0.5B-Instruct',
      // Falls back to q4 automatically where the GPU has no shader-f16.
      dtype: 'q4f16',
      device: 'webgpu',
      maxNewTokens: 512,
    },
    activeModeId: 'default',
    modes: BUILTIN_MODES,
    /** What the model is allowed to see about where you are typing. */
    contextCapture: {
      url: true,
      title: true,
      fieldLabel: true,
      selection: true,
      /** Off by default: sends surrounding page text to the model. */
      pageText: false,
      maxChars: 2000,
    },
    timeoutMs: 30000,
    /** If enhancement fails, insert the raw transcript rather than nothing. */
    fallbackToRaw: true,
  },

  dictionary: {
    /** Proper nouns and jargon, fed to the model as biasing where supported. */
    words: [],
    /** [{ from, to, matchCase, regex }] applied after transcription. */
    replacements: [],
    autoCapitalize: true,
    autoPunctuate: false,
    trimWhitespace: true,
  },

  output: {
    /** 'auto' = type into the focused field, 'clipboard' = copy only, 'both'. */
    insertMode: 'auto',
    /** Press Enter after inserting. Power Mode can override per site. */
    autoSend: false,
    /** Put the previous clipboard contents back after a clipboard insert. */
    restoreClipboard: true,
    insertDelayMs: 0,
    addTrailingSpace: true,
  },

  ui: {
    /** 'mini' = pill near the focused field, 'notch' = centered top bar,
     *  'none' = no on-page UI, badge only. */
    recorderStyle: 'mini',
    position: 'bottom-center',
    showWaveform: true,
    showTimer: true,
    showPartials: true,
    theme: 'auto',
  },

  history: {
    enabled: true,
    retainDays: 30,
    maxEntries: 500,
  },

  powerMode: {
    enabled: false,
    /** [{ id, name, enabled, match: {type, value}, overrides: {...} }] */
    profiles: [],
  },

  sites: {
    /** Hostnames where the extension stays out of the way entirely. */
    disabled: [],
  },

  advanced: {
    /** 'auto' resolves to min(4, hardwareConcurrency) when threads are usable. */
    numThreads: 'auto',
    /** Keep the model resident between dictations. Faster, uses more memory. */
    keepModelWarm: true,
    /** Unload the model after this many minutes idle. 0 = never. */
    unloadAfterMinutes: 30,
    logLevel: 'info',
  },
};

/** Deep clone so callers can never mutate the defaults by reference. */
export function freshDefaults() {
  return structuredClone(DEFAULTS);
}

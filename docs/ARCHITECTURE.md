# Architecture

## The four contexts

A Chrome extension is not one program. Anchor1MC runs in four places at once,
and most of the design falls out of what each one is allowed to do.

| Context | File | Can | Cannot |
| --- | --- | --- | --- |
| Service worker | `src/background/service-worker.js` | `chrome.*` APIs, IndexedDB, coordinate everything | Touch the DOM, hold a mic, run WebGPU, stay alive |
| Offscreen document | `src/offscreen/offscreen.js` | `getUserMedia`, WebGPU, WASM, clipboard, audio | Use any `chrome.*` API except `chrome.runtime`, show UI |
| Content script | `src/content/content.js` | See keystrokes, read and write page fields | Be an ES module, run on `chrome://` pages |
| Extension pages | `src/options`, `src/popup` | Full DOM, prompt for permissions | Exist when closed |

The service worker owns the state machine but deliberately holds no audio and
runs no inference — MV3 can terminate it at any idle moment, and the offscreen
document survives that.

## One dictation, end to end

1. **Content script** sees the hotkey. It runs a small state machine that
   distinguishes a hold (push-to-talk) from a tap, and a tap from a double-tap
   (hands-free toggle). Recording begins on *key down*, before that decision is
   made, so the first syllable is not clipped; a tap that is never confirmed
   cancels the recording it started.
2. **Service worker** resolves settings, applies any matching Power Mode
   profile, asks the page for context, mutes noisy tabs, and tells the offscreen
   document to start.
3. **Offscreen document** opens the microphone, pulls audio through an
   `AudioWorklet` in ~64 ms blocks, computes a level for the meter, and runs
   silence detection.
4. On stop, audio is resampled to 16 kHz mono and handed to the engine.
5. The transcript goes through the deterministic pipeline (filler removal,
   replacements, whitespace, capitalization) and then, optionally, the AI mode.
6. **Service worker** sends the text back to the content script, which types it
   into the field, and writes the entry to history.

## Parakeet

Parakeet TDT is three ONNX graphs: a mel front-end, a conformer encoder, and a
fused decoder+joint that predicts both the next token and *how many frames to
skip*. That duration head is what makes it fast — the decoder walks the encoder
output in jumps rather than one frame at a time.

Two decisions worth knowing about:

- **Tensor names are discovered, not hardcoded.** ONNX exports of this model
  disagree on almost every name (`encoder-model.onnx` vs `encoder.onnx`,
  `audio_signal` vs `input`, int32 vs int64 lengths). The engine reads
  `session.inputNames` and the repo's own file listing and matches by pattern.
  Where metadata is not exposed — the prediction network's LSTM state shape —
  it probes the plausible shapes once at load and keeps whichever the graph
  accepts.
- **The encoder runs on WebGPU, the decoder on WASM.** The decoder is called
  once per emitted token with tiny tensors, where per-call GPU dispatch overhead
  dominates the actual work.

`src/audio/mel.js` is a NeMo-compatible log-mel front-end (preemphasis, periodic
Hann, Slaney mel filters, per-feature normalization) used only when the model
repo does not ship the exported preprocessor graph.

## MV3 constraints that shaped the code

- **No remote code.** ONNX Runtime and Transformers.js are vendored into
  `vendor/`. Model *weights* are data, not code, so they may be fetched at
  runtime; they are cached in Cache Storage and handed to ORT as ArrayBuffers.
- **The wasm variant is not a choice.** ONNX Runtime ships several builds of its
  kernels, and the JS bundle names the one it will fetch — 1.26's WebGPU build
  wants the `asyncify` binary, and Transformers.js also wants the plain one for
  CPU. Shipping a different variant fails at the first inference with "no
  available backend found", nowhere near the cause, so `scripts/check.mjs`
  re-derives the required list from the shipped bundles.
- **No `blob:` in the CSP.** ORT's `*.bundle.min.mjs` builds spawn their wasm
  worker from an inlined blob, which the CSP rejects. `scripts/vendor.mjs`
  therefore ships the non-bundle ESM build, whose worker loads from a real
  `chrome-extension://` URL. It also rewrites Transformers.js's bare import
  specifiers to relative paths, since browsers cannot resolve them and import
  maps do not work inside workers.
- **Threads need cross-origin isolation.** The manifest opts in with COOP/COEP.
  If that ever fails, the runtime falls back to a single thread rather than
  failing to create a session.
- **Content scripts cannot be modules.** The message names in `content.js` are
  duplicated rather than imported; `scripts/check.mjs` asserts they still match
  `src/lib/messaging.js`.
- **The offscreen document gets `chrome.runtime` and nothing else.** Touching
  another `chrome.*` API throws, and throwing while a module evaluates prevents
  the document's message listener from ever registering — which the service
  worker can only observe as silence. Settings therefore travel to the offscreen
  document by message rather than being read from storage there, and
  `scripts/check.mjs` walks its whole import graph, dynamic imports included, to
  enforce this.

## Where a desktop dictation app does not map cleanly

| On a desktop | Here |
| --- | --- |
| Global hotkey in any app | Only while Chrome is focused; only in web pages for the bare modifier |
| Types into any application | Only into web page fields; elsewhere the text is copied to the clipboard |
| Context from the frontmost window and screen | Context from the tab's URL, title, field label, and selection |
| Per-app Power Mode profiles | Per-site profiles, matched on URL |
| Mutes system audio while recording | Mutes tabs that are currently making noise, then restores them |
| Launch at login | Always on; a global switch and a per-site disable list instead |

## Verification status

Run `npm run verify`. Two categories of correctness are covered differently:

**Tested here** (`scripts/test.mjs`, 21 assertions): the settings merge and
migration, the text pipeline, Power Mode matching and override inheritance,
silence detection including the noisy-room case, and the log-mel front-end's
shape, normalization, and frequency placement. `scripts/check.mjs` statically
verifies every import, manifest path, HTML asset, and settings binding.

**Not tested here** — this was built in a container with no browser,
microphone, GPU, or access to `huggingface.co`, so the following has been
written carefully against the documented interfaces but not executed:

- Microphone capture and the `AudioWorklet` path.
- The Parakeet ONNX graphs. The name-discovery and shape-probing logic exists
  precisely because the exact export layout could not be inspected; if a graph
  is shaped unexpectedly, the failure surfaces at load with the tensor names it
  did find, which is the information needed to fix it.
- Whisper through Transformers.js, and the WebGPU paths generally.
- Text insertion against real editors (Google Docs, Slack, ProseMirror-based
  apps). `execCommand('insertText')` is used first because it is the one method
  that React, Slate, ProseMirror, and CodeMirror all treat as genuine user
  input, with a native-setter fallback behind it.

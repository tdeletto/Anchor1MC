# Anchor1MC

AI-assisted voice typing as a Chrome extension. Runs on Chromebooks and Macs
— anywhere desktop Chrome runs.

Hold **Right Alt**, talk, let go. The text appears in whatever field you were
using. Transcription runs on your own machine by default — Whisper out of the
box, Parakeet TDT 0.6B v3 if you want it — through ONNX Runtime Web with
WebGPU. Nothing is uploaded, and no API key is required anywhere in the
product.

```
  hotkey ──► offscreen document ──► Parakeet / Whisper ──► dictionary ──► AI mode ──► your text field
             (mic + WebGPU)          (on-device)            (rules)       (optional)
```

## Install

The extension loads unpacked, with no build step — the ONNX Runtime and
Transformers.js files are vendored in `vendor/`.

1. Clone this repository onto the machine.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked**, and choose the repository folder.
4. The settings page opens. Do the three steps it lists — grant the microphone,
   pick a model, learn the hotkey.

Granting the microphone from the settings page is not optional. Chrome will not
let an offscreen document raise a permission prompt, so the grant has to happen
on an extension page first; after that, recording is silent and instant.

> Loading unpacked requires Developer mode, which is unavailable on
> enterprise-managed Chromebooks (most school devices). On those, the extension
> has to be published or force-installed by an administrator.

## Using it

| Action | Chromebook | Mac |
| --- | --- | --- |
| Push to talk | Hold **Right Alt** | Hold **Right Option ⌥** |
| Hands-free toggle | Double-tap the same key | Double-tap the same key |
| Cancel the recording | **Esc** | **Esc** |
| Start/stop anywhere in Chrome | **Alt+Shift+D** | **⌥⇧D** |
| Cancel | **Alt+Shift+X** | **⌥⇧X** |
| Re-insert the last dictation | **Alt+Shift+R** | **⌥⇧R** |
| Toggle AI enhancement | **Alt+Shift+E** | **⌥⇧E** |

The two columns are the same physical keys. The hotkey is matched on
`event.code`, which describes position rather than meaning, so the key to the
right of the space bar is `AltRight` whether it is engraved Alt or Option — no
per-platform configuration, and a profile synced between the two machines
behaves identically. The settings page names whichever keyboard you are on.

Command (⌘) and Control (⌃) can be chosen instead. The settings page detects
which platform it is running on — telling a Chromebook apart from the Linux it
reports itself as — and names every key accordingly: Command on a Mac is the
Search key on a Chromebook, the Windows key on Windows, and Super on Linux.

Keys the window manager takes before a page sees them are labelled *usually
captured by the system* rather than hidden, since a remapped or external
keyboard may still deliver them. That is Meta everywhere except macOS, where
Command is a perfectly good choice.

The bare-modifier hotkey is detected by a content script, which is what makes
hold-to-talk possible at all. Chrome does not run content scripts on
`chrome://` pages, the Web Store, or the PDF viewer, so `Alt+Shift+D` covers
those — and when the text cannot be typed into the page, it is copied to the
clipboard instead, with a notification saying so.

`Ctrl+Shift+Space` would have been the obvious default, but ChromeOS reserves it
for cycling input methods, so `Alt+Shift+D` is used instead. Every key here is
remappable: the modifier in the settings page, the combos at
`chrome://extensions/shortcuts`.

## Transcription engines

| Engine | Where audio goes | Download | Notes |
| --- | --- | --- | --- |
| **Whisper** (default) | Stays on device | 40 MB – 1.6 GB | tiny/base/small/large-v3-turbo. base is a good starting point. |
| **Parakeet V3** | Stays on device | ~650 MB (int8) / ~2.4 GB (fp32) | The most accurate on-device engine. 25 languages. Wants WebGPU. |
| **Self-hosted endpoint** | Your server | none | Any OpenAI-compatible `/v1/audio/transcriptions`. API key optional. |
| **Chrome speech** | **Google's servers** | none | Zero setup, not private. Offered as an escape hatch. |

Models download once and are cached in the browser, so everything after the
first run works offline.

## AI enhancement

An optional second pass rewrites the transcript according to the active mode.
Nine modes ship built in — Clean up, Email, Chat message, Notes, AI prompt,
Formal, Code comment, Summarize, and a Voice assistant mode that answers rather
than transcribes. All of them are editable, and you can add your own.

Three ways to run it, only the last of which involves anyone else's server:

- **On this device** (default) — a small instruct model through WebGPU, using
  the same runtime the speech models already load. Qwen2.5 0.5B out of the box,
  which is ample for cleanup and reformatting. Half-precision builds fall back
  to full precision automatically on GPUs without `shader-f16`.
- **A local or self-hosted server** — any OpenAI-compatible
  `/chat/completions` endpoint you run. No API key needed.
- **A hosted endpoint** — the same client, with a key field for providers that
  want one.

Enhancement is off by default: it costs a model download and real latency on
every dictation, so it should be a deliberate choice.

Modes that ask for context receive the page URL, title, the field's label, and
your selection. Page text is off by default. That context comes from a web page,
so it is fenced in the prompt and the model is told it is reference material,
never instructions.

## Power Mode

Per-site profiles, matched by domain, URL substring, or regex. The first match
wins and overrides the engine, language, AI mode, enhancement on/off, whether
Enter is pressed after inserting, and where the text goes. Set Gmail to the Email
mode, your chat app to press Enter automatically, and a bank site to the disabled
list.

## Everything else

Custom dictionary and literal replacements · filler-word removal ·
auto-capitalization and punctuation · searchable history with optional audio
retention and JSON/CSV/text export · mini-pill or notch recorder with live level
meter, timer, and partial text · silence auto-stop with room calibration ·
microphone selection and per-stream audio processing · muting noisy tabs while
you record · start/stop chirps · settings import and export.

## Development

```bash
npm install       # only needed to re-vendor
npm run vendor    # refresh vendor/ from node_modules
npm run icons     # regenerate the PNG icons from icons/source.png
npm run verify    # static checks + logic tests
npm run zip       # dist/anchor1mc-<version>.zip
```

`npm run check` verifies that every import, manifest path, HTML asset, and
`data-setting` binding resolves, and that no page pulls in remote code.
`npm test` covers the settings merge, text pipeline, Power Mode matching,
silence detection, and the log-mel front-end.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together
and which parts have and have not been exercised end to end.

## Licence

MIT. Model weights are downloaded from Hugging Face at runtime and carry their
own licences.

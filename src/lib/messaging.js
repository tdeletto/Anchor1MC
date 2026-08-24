/** Message names shared across the service worker, offscreen doc, and content scripts. */
export const MSG = {
  // content script -> background
  HOTKEY_DOWN: 'hotkey-down',
  HOTKEY_UP: 'hotkey-up',
  HOTKEY_TAP: 'hotkey-tap',
  CANCEL: 'cancel',
  CONTEXT_RESULT: 'context-result',
  CONTENT_READY: 'content-ready',

  // background -> content script
  SHOW_RECORDER: 'show-recorder',
  UPDATE_RECORDER: 'update-recorder',
  HIDE_RECORDER: 'hide-recorder',
  INSERT_TEXT: 'insert-text',
  COLLECT_CONTEXT: 'collect-context',
  SETTINGS_PUSH: 'settings-push',

  // background <-> offscreen
  OFFSCREEN_READY: 'offscreen-ready',
  PING: 'ping',
  START_CAPTURE: 'start-capture',
  STOP_CAPTURE: 'stop-capture',
  ABORT_CAPTURE: 'abort-capture',
  CAPTURE_LEVEL: 'capture-level',
  CAPTURE_DONE: 'capture-done',
  CAPTURE_ERROR: 'capture-error',
  PARTIAL_TEXT: 'partial-text',
  TRANSCRIBE: 'transcribe',
  ENHANCE: 'enhance',
  MODEL_STATUS: 'model-status',
  MODEL_PROGRESS: 'model-progress',
  PRELOAD_MODEL: 'preload-model',
  PRELOAD_LLM: 'preload-llm',
  UNLOAD_LLM: 'unload-llm',
  LLM_STATUS: 'llm-status',
  UNLOAD_MODEL: 'unload-model',
  CLEAR_MODEL_CACHE: 'clear-model-cache',
  PLAY_SOUND: 'play-sound',
  COPY_TO_CLIPBOARD: 'copy-to-clipboard',
  PROBE_CAPABILITIES: 'probe-capabilities',
  LIST_DEVICES: 'list-devices',
  TEST_ENDPOINT: 'test-endpoint',

  // ui pages -> background
  GET_STATE: 'get-state',
  STATE_CHANGED: 'state-changed',
  HISTORY_CHANGED: 'history-changed',
  START_FROM_UI: 'start-from-ui',
  STOP_FROM_UI: 'stop-from-ui',
  RETRY_LAST: 'retry-last',
  SET_ACTIVE_MODE: 'set-active-mode',
};

/** Recording lifecycle, surfaced to every UI surface. */
export const STATE = {
  IDLE: 'idle',
  RECORDING: 'recording',
  TRANSCRIBING: 'transcribing',
  ENHANCING: 'enhancing',
  INSERTING: 'inserting',
  ERROR: 'error',
};

/** chrome.runtime.sendMessage that resolves to null instead of throwing when
 *  nobody is listening — the common case for a tab with no content script.
 *
 *  This module is imported by the offscreen document, so it must touch nothing
 *  outside chrome.runtime; anything tab-related lives in the service worker. */
export async function send(message, options) {
  try {
    return await chrome.runtime.sendMessage(message, options);
  } catch {
    return null;
  }
}

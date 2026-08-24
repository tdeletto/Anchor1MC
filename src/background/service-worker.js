/**
 * Service worker: the coordinator.
 *
 * It owns the recording state machine and talks to three places — the content
 * script in the page you are typing into, the offscreen document that holds the
 * microphone and the models, and the extension's own UI pages.
 *
 * It deliberately holds no audio and runs no inference: MV3 can terminate this
 * worker at any idle moment, and the offscreen document survives that.
 */
import { MSG, STATE, send } from '../lib/messaging.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import { setLogLevel, logger } from '../lib/log.js';
import { resolveProfile, applyProfile, isSiteDisabled } from '../lib/power-mode.js';

const log = logger('sw');

/** chrome.tabs.sendMessage that resolves to null when the tab has no listener.
 *  Lives here rather than in messaging.js, which the offscreen document
 *  imports and where chrome.tabs does not exist. */
async function sendToTab(tabId, message, options = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    return null;
  }
}

/** @type {{state: string, tabId: number|null, ...}} */
let session = { state: STATE.IDLE, tabId: null, frameId: null, context: null, settings: null, mutedTabs: [], startedAt: 0 };
let lastResult = null;
let offscreenReady = null;

// ------------------------------------------------------------- offscreen ----

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function createOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK', 'CLIPBOARD'],
      justification: 'Record the microphone and run speech recognition models on-device.',
    });
  } catch (err) {
    // Chrome allows exactly one offscreen document, so a caller that lost a
    // race finds it already made. That is success, not failure.
    if (!/single offscreen document|already exists/i.test(err?.message ?? '')) throw err;
  }
}

/** Is the document's message listener actually registered yet? */
async function offscreenResponds() {
  try {
    const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type: MSG.PING });
    return reply?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Guarantee a *responsive* offscreen document.
 *
 * Two things make this more than a create call. Concurrent callers must not
 * each try to create one — the options page alone fires three requests as it
 * opens. And `createDocument` resolves when the document exists, not when its
 * scripts have finished loading, so a message sent immediately after can arrive
 * before there is anything listening for it. We wait for the document to answer
 * a ping instead of assuming it will.
 */
async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;

  offscreenReady = (async () => {
    if (!(await hasOffscreen())) await createOffscreen();

    const deadline = Date.now() + 15000;
    let attempts = 0;
    while (Date.now() < deadline) {
      if (await offscreenResponds()) {
        log.debug(`audio worker ready after ${attempts} ping(s)`);
        return;
      }
      attempts += 1;
      await sleep(150);
    }
    throw new Error(
      'The audio worker did not start. Open chrome://extensions, find Anchor1MC, '
      + 'and click "offscreen.html" under "Inspect views" to see the underlying error.',
    );
  })();

  // A failed attempt must not be cached, or every later call inherits it.
  offscreenReady.catch(() => { offscreenReady = null; });
  return offscreenReady;
}

/** Call into the offscreen document, surfacing its errors as real exceptions. */
async function callOffscreen(type, payload = {}) {
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...payload });
  // An open options page or popup also receives this message and ignores it,
  // which is enough for sendMessage to resolve with nothing. So an empty reply
  // means the worker is gone, not that no context heard us.
  if (!reply) {
    offscreenReady = null;
    throw new Error(`The audio worker stopped responding during "${type}". Reload the extension to restart it.`);
  }
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

// ----------------------------------------------------------------- state ----

function setState(state, extra = {}) {
  session.state = state;
  const payload = { state, ...extra };
  send({ target: 'ui', type: MSG.STATE_CHANGED, ...payload });
  if (session.tabId != null) sendToTab(session.tabId, { type: MSG.UPDATE_RECORDER, ...payload });
  updateBadge(state);
}

function updateBadge(state) {
  const badge = {
    [STATE.RECORDING]: { text: '●', color: '#e5484d' },
    [STATE.TRANSCRIBING]: { text: '…', color: '#f5a524' },
    [STATE.ENHANCING]: { text: '…', color: '#8b5cf6' },
    [STATE.INSERTING]: { text: '…', color: '#8b5cf6' },
    [STATE.ERROR]: { text: '!', color: '#e5484d' },
  }[state] ?? { text: '', color: '#000000' };
  chrome.action.setBadgeText({ text: badge.text });
  chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title,
    message,
  }, () => void chrome.runtime.lastError);
}

// ------------------------------------------------------------ tab muting ----

/** The microphone picks up whatever the speakers are playing, so tabs making
 *  noise are muted for the duration and restored afterwards. */
async function muteNoisyTabs() {
  try {
    const tabs = await chrome.tabs.query({ audible: true, muted: false });
    session.mutedTabs = tabs.map((t) => t.id);
    await Promise.all(session.mutedTabs.map((id) => chrome.tabs.update(id, { muted: true }).catch(() => {})));
  } catch (err) {
    log.debug('could not mute tabs', err?.message);
  }
}

async function unmuteTabs() {
  const ids = session.mutedTabs;
  session.mutedTabs = [];
  await Promise.all(ids.map((id) => chrome.tabs.update(id, { muted: false }).catch(() => {})));
}

// --------------------------------------------------------------- capture ----

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/**
 * Begin a dictation.
 * @param {object} o
 * @param {number=} o.tabId  tab that owns this dictation; defaults to the active one
 */
async function startRecording({ tabId = null, frameId = null, source = 'hotkey' } = {}) {
  await step('start-requested', { source, state: session.state });
  if (session.state !== STATE.IDLE && session.state !== STATE.ERROR) {
    await step('start-ignored', `already ${session.state}`);
    return;
  }

  const base = await getSettings();
  if (!base.enabled) {
    await step('start-ignored', 'extension disabled');
    return;
  }

  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : await activeTab();
  const url = tab?.url ?? '';

  if (isSiteDisabled(base, url)) {
    await step('start-ignored', 'site is on the disabled list');
    return;
  }

  const profile = resolveProfile(base, url);
  const settings = applyProfile(base, profile);

  session = {
    state: STATE.IDLE,
    tabId: tab?.id ?? null,
    frameId,
    context: null,
    settings,
    mutedTabs: [],
    startedAt: Date.now(),
    source,
    url,
    title: tab?.title ?? null,
    profileName: profile?.name ?? null,
  };

  try {
    // Ask the page what is around the cursor before the recorder UI steals focus.
    if (session.tabId != null && settings.enhancement.enabled) {
      session.context = await sendToTab(session.tabId, {
        type: MSG.COLLECT_CONTEXT,
        capture: settings.enhancement.contextCapture,
      });
    }

    if (settings.recording.muteOtherTabs) await muteNoisyTabs();

    if (session.tabId != null && settings.ui.recorderStyle !== 'none') {
      sendToTab(session.tabId, { type: MSG.SHOW_RECORDER, ui: settings.ui, profileName: session.profileName });
    }

    await callOffscreen(MSG.START_CAPTURE, { settings });
    setState(STATE.RECORDING);
    await step('recording');
  } catch (err) {
    await failSession(err);
  }
}

async function stopRecording({ reason = 'hotkey' } = {}) {
  await step('stop-requested', { reason, state: session.state });
  if (session.state !== STATE.RECORDING) {
    await step('stop-ignored', `state was ${session.state}, not recording`);
    return;
  }
  setState(STATE.TRANSCRIBING);

  try {
    const result = await callOffscreen(MSG.STOP_CAPTURE, {
      context: session.context,
      settings: session.settings,
    });
    await step('transcribed', { chars: result?.final?.length ?? null, discarded: !!result?.discarded });
    await unmuteTabs();

    if (result.discarded) {
      await step('discarded', result.reason);
      await finishSession();
      return;
    }

    lastResult = { ...result, url: session.url, title: session.title };
    setState(STATE.INSERTING);
    await deliver(result);
    await step('delivered');
    await record(result).catch(async (err) => {
      log.error('could not write to history', err);
      await step('record-threw', err?.message ?? String(err));
      await noteHistoryWrite({ phase: 'failed', reason: err?.message ?? String(err) });
    });
    await step('recorded');
    await finishSession();
    log.info(`done in ${Math.round(result.latencyMs)}ms (${reason})`, { words: result.final.split(/\s+/).length });
  } catch (err) {
    await step('stop-failed', err?.message ?? String(err));
    await unmuteTabs();
    await failSession(err);
  }
}

async function cancelRecording() {
  if (session.state === STATE.IDLE) return;
  try { await callOffscreen(MSG.ABORT_CAPTURE); } catch { /* nothing running */ }
  await unmuteTabs();
  await finishSession();
  await step('cancelled');
}

async function finishSession() {
  if (session.tabId != null) sendToTab(session.tabId, { type: MSG.HIDE_RECORDER });
  setState(STATE.IDLE);
  session = { ...session, state: STATE.IDLE, context: null };
}

async function failSession(err) {
  log.error(err);
  await step('failed', err?.message ?? String(err));
  const message = err?.message ?? String(err);
  setState(STATE.ERROR, { error: message });
  if (session.tabId != null) sendToTab(session.tabId, { type: MSG.HIDE_RECORDER, error: message });
  notify('Anchor1MC', message);
  // Leave the badge briefly so the failure is visible, then reset.
  setTimeout(() => { if (session.state === STATE.ERROR) setState(STATE.IDLE); }, 4000);
}

// -------------------------------------------------------------- delivery ----

/** Put the text where the user wants it: typed into the page, copied, or both. */
async function deliver(result) {
  const settings = session.settings;
  const text = result.final;
  if (!text) return;

  const wantsInsert = settings.output.insertMode === 'auto' || settings.output.insertMode === 'both';
  const wantsClipboard = settings.output.insertMode === 'clipboard' || settings.output.insertMode === 'both';

  let inserted = false;
  if (wantsInsert && session.tabId != null) {
    const reply = await sendToTab(session.tabId, {
      type: MSG.INSERT_TEXT,
      text,
      autoSend: settings.output.autoSend,
      addTrailingSpace: settings.output.addTrailingSpace,
      delayMs: settings.output.insertDelayMs,
    }, session.frameId != null ? { frameId: session.frameId } : {});
    inserted = !!reply?.ok;
  }

  if (wantsClipboard || !inserted) {
    await callOffscreen(MSG.COPY_TO_CLIPBOARD, { text }).catch((err) => log.warn('clipboard failed', err.message));
    if (!inserted && wantsInsert) {
      // Common on chrome:// pages, the Web Store, and the PDF viewer, where
      // extensions are not allowed to run at all.
      notify('Copied to clipboard', 'Anchor1MC cannot type into this page, so the text was copied instead. Press Ctrl+V.');
    }
  }
}

/**
 * Record the outcome of the last history write where the options page can read
 * it. A failure here is deliberately not fatal — the text is already in the
 * user's document — but that means it would otherwise be invisible, and an
 * empty history looks identical whether nothing was written or every write
 * threw.
 */
/**
 * A persisted breadcrumb trail through one dictation.
 *
 * The write outcome told us record() was never reached but not why, and the
 * worker's console is gone the moment it is terminated. Each step is written to
 * storage as it happens, so the path a dictation actually took survives and can
 * be read back from the settings page.
 */
const TRACE_LIMIT = 60;
let trace = [];

async function step(event, detail) {
  trace = [...trace, { at: Date.now(), event, ...(detail === undefined ? {} : { detail }) }].slice(-TRACE_LIMIT);
  log.debug('trace', event, detail ?? '');
  try {
    await chrome.storage.local.set({ dictationTrace: trace });
  } catch {
    // Diagnostics must never be the thing that breaks a dictation.
  }
}

let lastAnnouncedHistoryProblem = null;

async function noteHistoryWrite(outcome) {
  try {
    await chrome.storage.local.set({ lastHistoryWrite: { ...outcome, at: Date.now() } });
  } catch (err) {
    log.warn('could not record the history-write outcome', err?.message ?? err);
  }

  // Say so once when a dictation is not saved. Silence here is what made this
  // look like a broken feature rather than a setting or an error, and repeating
  // it every dictation would be its own nuisance — so only on a change.
  const problem = outcome.phase === 'skipped' || outcome.phase === 'failed' ? outcome.reason : null;
  if (problem && problem !== lastAnnouncedHistoryProblem) {
    notify('Dictation not saved to history', problem);
  }
  if (outcome.phase === 'written' || problem !== lastAnnouncedHistoryProblem) {
    lastAnnouncedHistoryProblem = problem;
  }
}

/**
 * Write the dictation to history.
 *
 * Failures here are logged, not thrown: the text is already in the user's
 * document by this point, and losing the transcript from a log is not worth
 * reporting the whole dictation as failed.
 */
async function record(result) {
  await step('record-called');
  const settings = session.settings;
  // Recorded before anything is attempted, so "the write failed" stays
  // distinguishable from "the write was never reached".
  await noteHistoryWrite({
    phase: 'started',
    state: session.state,
    hasSettings: !!settings,
    enabled: settings?.history?.enabled ?? null,
  });

  if (!settings) {
    await noteHistoryWrite({ phase: 'skipped', reason: 'the session had no settings by the time the transcript arrived' });
    return;
  }
  if (!settings.history.enabled) {
    await noteHistoryWrite({ phase: 'skipped', reason: 'history is switched off in settings' });
    return;
  }

  const { id, total } = await callOffscreen(MSG.PERSIST_HISTORY, {
    entry: {
      raw: result.raw,
      final: result.final,
      enhanced: result.enhanced,
      modeId: result.modeId,
      engine: result.engine,
      language: result.language,
      durationMs: Math.round(result.durationMs),
      latencyMs: Math.round(result.latencyMs),
      url: session.url,
      title: session.title,
    },
    retention: { retainDays: settings.history.retainDays, maxEntries: settings.history.maxEntries },
  });

  await noteHistoryWrite({ phase: 'written', ok: true, id, total });
  log.info(`history entry ${id} written; ${total} total`);
  // An options page open in another tab renders its list once, at load, so it
  // has to be told that there is something new to show.
  send({ target: 'ui', type: MSG.HISTORY_CHANGED });
}

/** Re-run the last recording through the pipeline, e.g. after changing modes. */
async function retryLast() {
  if (!lastResult) {
    notify('Anchor1MC', 'There is no recent dictation to retry.');
    return;
  }
  const settings = await getSettings();
  session.settings = settings;
  session.tabId = (await activeTab())?.id ?? null;
  setState(STATE.INSERTING);
  await deliver({ final: lastResult.final });
  await finishSession();
}

// -------------------------------------------------------------- messages ----

/**
 * Message types this worker answers. Checked before claiming the response
 * channel: an async handler always returns a promise, so without this the
 * worker would answer every message it sees — including ones addressed
 * elsewhere — and mask a genuinely absent receiver.
 */
const HANDLED = new Set([
  MSG.HOTKEY_DOWN, MSG.HOTKEY_UP, MSG.CANCEL,
  MSG.CAPTURE_LEVEL, MSG.STOP_CAPTURE, MSG.PARTIAL_TEXT, MSG.MODEL_PROGRESS,
  MSG.STATE_CHANGED, MSG.OFFSCREEN_READY,
  MSG.GET_STATE, MSG.START_FROM_UI, MSG.STOP_FROM_UI, MSG.RETRY_LAST,
  MSG.SET_ACTIVE_MODE, MSG.CONTENT_READY,
  MSG.PRELOAD_MODEL, MSG.UNLOAD_MODEL, MSG.MODEL_STATUS, MSG.CLEAR_MODEL_CACHE,
  MSG.PRELOAD_LLM, MSG.UNLOAD_LLM, MSG.LLM_STATUS,
  MSG.TEST_ENDPOINT, MSG.LIST_DEVICES, MSG.PROBE_CAPABILITIES, MSG.PLAY_SOUND,
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false; // not ours
  if (!HANDLED.has(message?.type)) return false;

  const handle = async () => {
    switch (message?.type) {
      // ---- from the content script's hotkey state machine
      case MSG.HOTKEY_DOWN:
        await startRecording({ tabId: sender.tab?.id ?? null, frameId: sender.frameId ?? null });
        return { ok: true };
      case MSG.HOTKEY_UP:
        await stopRecording({ reason: 'hold-release' });
        return { ok: true };
      case MSG.CANCEL:
        await cancelRecording();
        return { ok: true };

      // ---- from the offscreen document
      case MSG.CAPTURE_LEVEL:
        if (session.tabId != null) {
          sendToTab(session.tabId, { type: MSG.UPDATE_RECORDER, level: message.level, elapsedMs: message.elapsedMs });
        }
        send({ target: 'ui', type: MSG.UPDATE_RECORDER, level: message.level, elapsedMs: message.elapsedMs });
        return { ok: true };
      case MSG.STOP_CAPTURE:
        await stopRecording({ reason: message.reason });
        return { ok: true };
      case MSG.PARTIAL_TEXT:
        if (session.tabId != null) sendToTab(session.tabId, { type: MSG.UPDATE_RECORDER, partial: message.text });
        send({ target: 'ui', type: MSG.UPDATE_RECORDER, partial: message.text });
        return { ok: true };
      case MSG.MODEL_PROGRESS:
        if (session.tabId != null) sendToTab(session.tabId, { type: MSG.UPDATE_RECORDER, progress: message.progress });
        send({ target: 'ui', type: MSG.MODEL_PROGRESS, progress: message.progress, kind: message.kind });
        return { ok: true };
      case MSG.STATE_CHANGED:
        setState(message.state);
        return { ok: true };
      case MSG.OFFSCREEN_READY:
        log.debug('audio worker announced itself');
        return { ok: true };

      // ---- from the popup and options pages
      case MSG.GET_STATE: {
        const settings = await getSettings();
        return {
          state: session.state,
          enabled: settings.enabled,
          engine: settings.transcription.engine,
          modeId: settings.enhancement.activeModeId,
          enhancementEnabled: settings.enhancement.enabled,
          profileName: session.profileName ?? null,
          lastResult: lastResult ? { final: lastResult.final, ts: session.startedAt } : null,
        };
      }
      case MSG.START_FROM_UI:
        await startRecording({ source: 'ui' });
        return { ok: true };
      case MSG.STOP_FROM_UI:
        await stopRecording({ reason: 'ui' });
        return { ok: true };
      case MSG.RETRY_LAST:
        await retryLast();
        return { ok: true };
      case MSG.SET_ACTIVE_MODE:
        await updateSettings((s) => { s.enhancement.activeModeId = message.modeId; });
        return { ok: true };
      case MSG.CONTENT_READY:
        return { ok: true, enabled: (await getSettings()).enabled };

      // ---- pass-through to the offscreen document, for the options page
      case MSG.PRELOAD_MODEL:
      case MSG.UNLOAD_MODEL:
      case MSG.MODEL_STATUS:
      case MSG.CLEAR_MODEL_CACHE:
      case MSG.PRELOAD_LLM:
      case MSG.UNLOAD_LLM:
      case MSG.LLM_STATUS:
      case MSG.TEST_ENDPOINT:
      case MSG.LIST_DEVICES:
      case MSG.PROBE_CAPABILITIES:
      case MSG.PLAY_SOUND:
        return callOffscreen(message.type, message);

      default:
        return undefined;
    }
  };

  handle()
    .then((value) => sendResponse(value))
    .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
  return true;
});

// ------------------------------------------------------ browser hotkeys -----

chrome.commands.onCommand.addListener(async (command) => {
  switch (command) {
    case 'toggle-recording':
      if (session.state === STATE.RECORDING) await stopRecording({ reason: 'command' });
      else await startRecording({ source: 'command' });
      break;
    case 'cancel-recording':
      await cancelRecording();
      break;
    case 'retry-last':
      await retryLast();
      break;
    case 'toggle-enhancement': {
      const next = await updateSettings((s) => { s.enhancement.enabled = !s.enhancement.enabled; });
      notify('Anchor1MC', `AI enhancement ${next.enhancement.enabled ? 'on' : 'off'}`);
      break;
    }
    default:
      break;
  }
});

// ------------------------------------------------------------ lifecycle -----

/**
 * Put the content script into tabs that were already open.
 *
 * A manifest content script is only injected into pages loaded after the
 * extension is, so every tab open at install or reload time has none — and
 * without one the hold-to-talk key does nothing and the recorder never appears,
 * while the browser-wide shortcut keeps working because it does not need the
 * page. That asymmetry is confusing enough that it is worth closing rather than
 * documenting.
 */
async function injectIntoOpenTabs() {
  let injected = 0;
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.all(tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['src/content/content.js'],
        });
        injected += 1;
      } catch {
        // Restricted pages (the Web Store, PDF viewer, other extensions)
        // refuse injection; nothing can be done for those.
      }
    }));
  } catch (err) {
    log.warn('could not enumerate tabs for injection', err?.message ?? err);
  }
  log.info(`content script injected into ${injected} open tab(s)`);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await injectIntoOpenTabs();
  const settings = await getSettings();
  setLogLevel(settings.advanced.logLevel);
  if (details.reason === 'install' && !settings.onboarded) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#welcome') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  setLogLevel((await getSettings()).advanced.logLevel);
  await injectIntoOpenTabs();
});

// A dictation must not outlive the tab it belongs to.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session.tabId === tabId && session.state !== STATE.IDLE) cancelRecording();
});

getSettings().then((s) => {
  setLogLevel(s.advanced.logLevel);
  updateBadge(STATE.IDLE);
});

/** Toolbar popup: status, quick toggles, and a manual start/stop. */
import { getSettings, updateSettings } from '../lib/settings.js';
import { MSG, STATE } from '../lib/messaging.js';
import { keyLabel } from '../lib/keys.js';

const $ = (sel) => document.querySelector(sel);
const ask = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

let settings = null;
let state = STATE.IDLE;

const STATUS_TEXT = {
  [STATE.IDLE]: 'Ready',
  [STATE.RECORDING]: 'Listening…',
  [STATE.TRANSCRIBING]: 'Transcribing…',
  [STATE.ENHANCING]: 'Enhancing…',
  [STATE.INSERTING]: 'Inserting…',
  [STATE.ERROR]: 'Something went wrong',
};

function renderState() {
  const recording = state === STATE.RECORDING;
  $('#record').classList.toggle('active', recording);
  $('#record-label').textContent = recording ? 'Stop and transcribe' : 'Start dictating';
  $('#status').textContent = STATUS_TEXT[state] ?? '';
  const busy = state !== STATE.IDLE && state !== STATE.RECORDING && state !== STATE.ERROR;
  $('#record').disabled = busy;
}

function renderSettings() {
  $('#enabled').checked = settings.enabled;
  $('#engine').value = settings.transcription.engine;
  $('#enhance').checked = settings.enhancement.enabled;
  $('#mode').replaceChildren(...settings.enhancement.modes.map((m) => {
    const option = document.createElement('option');
    option.value = m.id;
    option.textContent = `${m.icon ?? ''} ${m.name}`.trim();
    option.selected = m.id === settings.enhancement.activeModeId;
    return option;
  }));

  $('#hotkey-hint').textContent = keyLabel(settings.hotkeys.modifierKey);
}

function renderLast(last) {
  if (!last?.final) return;
  $('#last').hidden = false;
  $('#last-text').textContent = last.final;
  $('#copy-last').onclick = async () => {
    await navigator.clipboard.writeText(last.final);
    $('#copy-last').textContent = 'Copied';
    setTimeout(() => { $('#copy-last').textContent = 'Copy'; }, 1200);
  };
}

async function init() {
  settings = await getSettings();
  renderSettings();

  const status = await ask(MSG.GET_STATE).catch(() => null);
  if (status) {
    state = status.state;
    renderLast(status.lastResult);
  }
  renderState();

  $('#record').addEventListener('click', async () => {
    if (state === STATE.RECORDING) await ask(MSG.STOP_FROM_UI);
    else await ask(MSG.START_FROM_UI);
    // The popup usually closes when focus moves to the page; closing it
    // explicitly keeps the recorder pill from fighting for attention.
    window.close();
  });

  $('#enabled').addEventListener('change', async (e) => {
    settings = await updateSettings((s) => { s.enabled = e.target.checked; });
  });
  $('#engine').addEventListener('change', async (e) => {
    settings = await updateSettings((s) => { s.transcription.engine = e.target.value; });
  });
  $('#enhance').addEventListener('change', async (e) => {
    settings = await updateSettings((s) => { s.enhancement.enabled = e.target.checked; });
  });
  $('#mode').addEventListener('change', async (e) => {
    await ask(MSG.SET_ACTIVE_MODE, { modeId: e.target.value });
  });
  $('#open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== 'ui') return false;
    if (message.type === MSG.STATE_CHANGED) {
      state = message.state;
      renderState();
    }
    if (message.type === MSG.UPDATE_RECORDER && typeof message.level === 'number') {
      $('#meter-fill').style.width = `${Math.min(100, Math.round(message.level * 320))}%`;
    }
    return false;
  });
}

init();

/** Settings UI. Most controls bind generically through data-setting paths. */
import { getSettings, updateSettings, resetSettings, saveSettings, getPath, setPath } from '../lib/settings.js';
import { BUILTIN_MODES } from '../lib/defaults.js';
import { MSG } from '../lib/messaging.js';
import { MODEL_CATALOG, formatBytes, bytesForModel } from '../lib/models.js';
import { makeProfile } from '../lib/power-mode.js';
import { modifierOptions, keyLabel, commandLabel, modifierNote, platformName } from '../lib/keys.js';
import * as history from '../lib/history.js';

const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Query for an element that must exist, and say which one is missing.
 *
 * A null from $() surfaces as "cannot set properties of null" at whatever line
 * touched it, which took down renderAll and with it wireEvents — leaving every
 * button on the page inert for want of one id. The static check now catches
 * this before it ships; this makes the runtime failure name itself.
 */
const $must = (sel) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Settings page is missing ${sel}`);
  return el;
};
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let settings = null;

const LANGUAGES = [
  ['auto', 'Auto-detect'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'],
  ['uk', 'Ukrainian'], ['cs', 'Czech'], ['sk', 'Slovak'], ['sv', 'Swedish'], ['da', 'Danish'],
  ['fi', 'Finnish'], ['no', 'Norwegian'], ['el', 'Greek'], ['hu', 'Hungarian'], ['ro', 'Romanian'],
  ['bg', 'Bulgarian'], ['hr', 'Croatian'], ['sl', 'Slovenian'], ['et', 'Estonian'], ['lv', 'Latvian'],
  ['lt', 'Lithuanian'], ['mt', 'Maltese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'],
  ['ar', 'Arabic'], ['hi', 'Hindi'], ['tr', 'Turkish'], ['vi', 'Vietnamese'], ['id', 'Indonesian'],
];

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
}

const ask = (type, payload = {}) => chrome.runtime.sendMessage({ type, ...payload });

// ------------------------------------------------------------- binding -----

/** Wire every [data-setting] control to its path in the settings tree. */
function bindControls() {
  for (const el of $$('[data-setting]')) {
    const path = el.dataset.setting;
    const value = getPath(settings, path);

    if (el.type === 'checkbox') el.checked = !!value;
    else if (value !== undefined && value !== null) el.value = value;

    // renderAll() runs again after an import or a reset, so only attach the
    // listeners once per element.
    if (el.dataset.bound) continue;
    el.dataset.bound = '1';

    el.addEventListener('change', async () => {
      let next;
      if (el.type === 'checkbox') next = el.checked;
      else if (el.type === 'number' || el.type === 'range') next = Number(el.value);
      else next = el.value;

      settings = await updateSettings((s) => { setPath(s, path, next); });
      onSettingsApplied(path);
    });
    // Sliders should update their caption while dragging, not only on release.
    if (el.type === 'range') el.addEventListener('input', () => renderDerived());
  }
}

/** Things that depend on other settings and must re-render when they change. */
function onSettingsApplied(path) {
  if (path === 'transcription.engine') renderEnginePanels();
  if (path === 'enhancement.provider') renderProviderPanels();
  if (path === 'enhancement.modes' || path === 'enhancement.activeModeId') renderModeSelect();
  // Download sizes and model notes depend on the model and precision picked.
  if (path === 'hotkeys.modifierKey') renderHotkeyLabels();
  if (path.startsWith('transcription.') || path.startsWith('enhancement.browser.')) {
    renderModelSelects();
    refreshModelStatus();
  }
  renderDerived();
}

function renderDerived() {
  const ms = Number($('[data-setting="recording.autoStopSilenceMs"]').value);
  $('#silence-value').textContent = `${(ms / 1000).toFixed(2)} seconds of quiet`;

  const engine = $('[data-setting="transcription.engine"]').value;
  $('#engine-desc').textContent = {
    parakeet: 'Runs on this Chromebook. Nothing leaves the device.',
    whisper: 'Runs on this Chromebook. Smaller download than Parakeet.',
    remote: 'Audio is uploaded to the server you configure.',
    webspeech: 'Chrome sends your audio to Google.',
  }[engine] ?? '';

  const provider = $('[data-setting="enhancement.provider"]').value;
  $('#provider-desc').textContent = {
    browser: 'Your transcript never leaves this device. Needs WebGPU and a one-off model download.',
    endpoint: 'Your transcript is sent to the server you run. No API key needed.',
    hosted: 'Your transcript is sent to the hosted provider you configure.',
  }[provider] ?? '';
}

function renderEnginePanels() {
  const engine = settings.transcription.engine;
  for (const panel of $$('[data-engine-panel]')) {
    panel.hidden = panel.dataset.enginePanel !== engine;
  }
}

function renderProviderPanels() {
  const provider = settings.enhancement.provider;
  for (const panel of $$('[data-provider-panel]')) {
    panel.hidden = !panel.dataset.providerPanel.split(' ').includes(provider);
  }
}

function fillSelect(el, options, selected) {
  el.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (value === selected) option.selected = true;
    return option;
  }));
}

// ------------------------------------------------------------- welcome -----

async function checkMicPermission() {
  const status = $('#mic-status');
  try {
    const result = await navigator.permissions.query({ name: 'microphone' });
    const label = { granted: ['Granted', 'ok'], denied: ['Blocked', 'bad'], prompt: ['Not granted yet', ''] }[result.state];
    status.textContent = label[0];
    status.className = `status ${label[1]}`;
  } catch {
    status.textContent = 'Unknown';
    status.className = 'status';
  }
}

async function grantMic() {
  try {
    // The prompt can only appear on a real extension page, which this is; the
    // offscreen document then inherits the grant.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    toast('Microphone access granted');
    await checkMicPermission();
    await loadDevices();
  } catch (err) {
    toast(`Microphone blocked: ${err.message}`);
    await checkMicPermission();
  }
}

async function renderCapabilities() {
  const line = $('#caps-line');
  try {
    const caps = await ask(MSG.PROBE_CAPABILITIES);
    if (caps?.ok === false) throw new Error(caps.error);
    const bits = [
      caps.webgpu ? 'WebGPU available' : 'No WebGPU — models will run on the CPU',
      `${caps.cores ?? '?'} cores`,
      caps.memoryGb ? `${caps.memoryGb} GB RAM (as reported)` : null,
      caps.threads ? 'multi-threaded WASM' : 'single-threaded WASM',
    ].filter(Boolean);
    line.textContent = [platformName(), ...bits].join(' · ');
    if (!caps.webgpu) {
      line.textContent += '. Parakeet will be slow here; Whisper base is a better fit.';
    }
  } catch (err) {
    line.textContent = `Could not probe this device: ${err.message}`;
  }
}

// -------------------------------------------------------------- models -----

function renderModelSelects() {
  fillSelect($('#parakeet-model'), MODEL_CATALOG.parakeet.map((m) => [m.id, m.name]), settings.transcription.parakeet.modelId);
  fillSelect($('#whisper-model'), MODEL_CATALOG.whisper.map((m) => [m.id, m.name]), settings.transcription.whisper.modelId);
  fillSelect($('#browser-llm'), MODEL_CATALOG.llm.map((m) => [m.id, m.name]), settings.enhancement.browser.modelId);

  const parakeet = MODEL_CATALOG.parakeet.find((m) => m.id === settings.transcription.parakeet.modelId);
  $('#parakeet-note').textContent = parakeet
    ? `${parakeet.note} Download: ${parakeet.sizes[settings.transcription.parakeet.precision] ?? '—'}.`
    : '';
  const whisper = MODEL_CATALOG.whisper.find((m) => m.id === settings.transcription.whisper.modelId);
  $('#whisper-note').textContent = whisper
    ? `${whisper.note} Download: ${whisper.sizes[settings.transcription.whisper.dtype] ?? '—'}.`
    : '';
}

/**
 * How many open web pages actually have a live content script.
 *
 * A manifest content script only reaches pages loaded after the extension, so
 * tabs open at reload time have none — and the symptom is that the
 * hold-to-talk key and the recorder do nothing on exactly those tabs while the
 * browser-wide shortcut still works. Worth being able to see.
 */
async function contentScriptCoverage() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const results = await Promise.all(tabs.map(async (tab) => {
    if (tab.id == null) return false;
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: MSG.PING });
      return reply?.ok === true;
    } catch {
      return false;
    }
  }));
  return { live: results.filter(Boolean).length, total: tabs.length };
}

async function renderContentCoverage() {
  const line = $('#content-coverage');
  try {
    const { live, total } = await contentScriptCoverage();
    if (!total) {
      line.textContent = 'No ordinary web pages are open to check.';
    } else if (live === total) {
      line.textContent = `Active in all ${total} open web ${total === 1 ? 'page' : 'pages'}.`;
    } else {
      line.textContent = `Active in ${live} of ${total} open web pages.`
        + ' Pages that were already open when the extension last reloaded need activating,'
        + ' or a page refresh. The browser-wide shortcut works either way.';
    }
  } catch (err) {
    line.textContent = `Could not check open tabs: ${err.message}`;
  }
}

/** Which model id each panel is reporting on, given the current settings. */
function speechModelId() {
  const t = settings.transcription;
  if (t.engine === 'parakeet') return t.parakeet.modelId;
  if (t.engine === 'whisper') return t.whisper.modelId;
  return null; // remote and Chrome speech download nothing
}

async function refreshModelStatus() {
  try {
    const status = await ask(MSG.MODEL_STATUS);
    if (!status) throw new Error('No answer from the audio worker.');
    if (status.ok === false) throw new Error(status.error);
    const entries = status.entries ?? [];

    $('#model-state').textContent = status.error
      ? `Engine unavailable: ${status.error}`
      : (status.loaded ? `Loaded: ${status.id} (${status.provider ?? 'cpu'})` : 'Nothing loaded');

    const speechId = speechModelId();
    const speechBytes = bytesForModel(entries, speechId);
    $('#cache-line').textContent = speechId
      ? (speechBytes
        ? `${formatBytes(speechBytes)} cached for ${speechId}.`
        : `Nothing cached for ${speechId} yet — it downloads on first use.`)
      : 'This engine downloads nothing.';

    // The AI model lives in the same cache store, so one call covers both.
    const llmId = settings.enhancement.browser.modelId;
    const llmBytes = bytesForModel(entries, llmId);
    const llm = await ask(MSG.LLM_STATUS).catch(() => null);
    $('#llm-state').textContent = llm?.loaded ? `Loaded: ${llm.key}` : 'Nothing loaded';
    $('#llm-cache-line').textContent = llmBytes
      ? `${formatBytes(llmBytes)} cached for ${llmId}.`
      : `Nothing cached for ${llmId} yet — it downloads the first time enhancement runs.`;
  } catch (err) {
    $('#cache-line').textContent = `Could not read the model cache: ${err.message}`;
  }
}

/** @param {'speech'|'ai'} kind which download this progress belongs to */
function showProgress(progress, kind = 'speech') {
  const bar = $(kind === 'ai' ? '#llm-progress' : '#dl-progress');
  const label = $(kind === 'ai' ? '#llm-state' : '#model-state');
  if (!progress) { bar.hidden = true; return; }
  bar.hidden = false;
  const pct = progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0;
  bar.firstElementChild.style.width = `${pct}%`;
  label.textContent = progress.total
    ? `${progress.message} ${pct}% (${formatBytes(progress.loaded)} / ${formatBytes(progress.total)})`
    : progress.message;
  if (progress.phase === 'ready') setTimeout(() => { bar.hidden = true; refreshModelStatus(); }, 800);
}

async function loadDevices() {
  try {
    const devices = await ask(MSG.LIST_DEVICES);
    if (!Array.isArray(devices)) return;
    fillSelect($('#mic-select'), [['default', 'System default'], ...devices.map((d) => [d.deviceId, d.label])], settings.recording.deviceId);
  } catch {
    // Offscreen document may not exist yet; the default entry still works.
  }
}

// --------------------------------------------------------------- lists -----

/** Small helper for the repeated "row with a delete button" pattern. */
function listItem(children, onDelete) {
  const item = document.createElement('div');
  item.className = 'item';
  item.append(...children);
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Remove';
    del.addEventListener('click', onDelete);
    item.append(del);
  }
  return item;
}

function textNode(text, className = 'grow') {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = text;
  return div;
}

function renderDisabledSites() {
  const list = $('#disabled-sites');
  const sites = settings.sites.disabled;
  list.replaceChildren(...(sites.length
    ? sites.map((site, i) => listItem([textNode(site)], async () => {
        settings = await updateSettings((s) => { s.sites.disabled.splice(i, 1); });
        renderDisabledSites();
      }))
    : [textNode('No sites disabled.', 'empty')]));
}

function renderWords() {
  const list = $('#word-list');
  const words = settings.dictionary.words;
  list.replaceChildren(...(words.length
    ? words.map((word, i) => listItem([textNode(word)], async () => {
        settings = await updateSettings((s) => { s.dictionary.words.splice(i, 1); });
        renderWords();
      }))
    : [textNode('No custom words yet.', 'empty')]));
}

function renderReplacements() {
  const list = $('#repl-list');
  const rules = settings.dictionary.replacements;
  list.replaceChildren(...(rules.length
    ? rules.map((rule, i) => {
        const from = document.createElement('input');
        from.type = 'text';
        from.value = rule.from;
        from.addEventListener('change', async () => {
          settings = await updateSettings((s) => { s.dictionary.replacements[i].from = from.value; });
        });

        const arrow = textNode('→', 'meta');

        const to = document.createElement('input');
        to.type = 'text';
        to.value = rule.to;
        to.addEventListener('change', async () => {
          settings = await updateSettings((s) => { s.dictionary.replacements[i].to = to.value; });
        });

        const wrapFrom = document.createElement('div');
        wrapFrom.className = 'grow';
        wrapFrom.append(from);
        const wrapTo = document.createElement('div');
        wrapTo.className = 'grow';
        wrapTo.append(to);

        const caseLabel = document.createElement('label');
        caseLabel.className = 'meta';
        const caseBox = document.createElement('input');
        caseBox.type = 'checkbox';
        caseBox.checked = !!rule.matchCase;
        caseBox.addEventListener('change', async () => {
          settings = await updateSettings((s) => { s.dictionary.replacements[i].matchCase = caseBox.checked; });
        });
        caseLabel.append(caseBox, document.createTextNode(' Aa'));

        const reLabel = document.createElement('label');
        reLabel.className = 'meta';
        const reBox = document.createElement('input');
        reBox.type = 'checkbox';
        reBox.checked = !!rule.regex;
        reBox.addEventListener('change', async () => {
          settings = await updateSettings((s) => { s.dictionary.replacements[i].regex = reBox.checked; });
        });
        reLabel.append(reBox, document.createTextNode(' .*'));

        return listItem([wrapFrom, arrow, wrapTo, caseLabel, reLabel], async () => {
          settings = await updateSettings((s) => { s.dictionary.replacements.splice(i, 1); });
          renderReplacements();
        });
      })
    : [textNode('No replacements yet.', 'empty')]));
}

function renderModeSelect() {
  fillSelect(
    $('#active-mode'),
    settings.enhancement.modes.map((m) => [m.id, `${m.icon ?? ''} ${m.name}`.trim()]),
    settings.enhancement.activeModeId,
  );
}

function renderModes() {
  const list = $('#mode-list');
  list.replaceChildren(...settings.enhancement.modes.map((mode, i) => {
    const card = document.createElement('div');
    card.className = 'card mode-card';
    card.style.padding = '14px 18px';

    const header = document.createElement('header');
    const icon = document.createElement('input');
    icon.type = 'text';
    icon.value = mode.icon ?? '';
    icon.style.minWidth = '52px';
    icon.style.width = '52px';
    icon.addEventListener('change', () => patchMode(i, { icon: icon.value }));

    const name = document.createElement('input');
    name.type = 'text';
    name.value = mode.name;
    name.className = 'name';
    name.style.flex = '1';
    name.addEventListener('change', () => patchMode(i, { name: name.value }));

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      settings = await updateSettings((s) => {
        s.enhancement.modes.splice(i, 1);
        if (s.enhancement.activeModeId === mode.id) s.enhancement.activeModeId = s.enhancement.modes[0]?.id ?? 'default';
      });
      renderModes();
      renderModeSelect();
    });

    header.append(icon, name, del);

    const prompt = document.createElement('textarea');
    prompt.value = mode.prompt;
    prompt.spellcheck = false;
    prompt.addEventListener('change', () => patchMode(i, { prompt: prompt.value }));

    const opts = document.createElement('div');
    opts.className = 'opts';

    const ctxLabel = document.createElement('label');
    const ctxBox = document.createElement('input');
    ctxBox.type = 'checkbox';
    ctxBox.checked = !!mode.useContext;
    ctxBox.addEventListener('change', () => patchMode(i, { useContext: ctxBox.checked }));
    ctxLabel.append(ctxBox, document.createTextNode(' Send page context'));

    const tempLabel = document.createElement('label');
    const temp = document.createElement('input');
    temp.type = 'number';
    temp.min = '0';
    temp.max = '2';
    temp.step = '0.1';
    temp.value = mode.temperature ?? 0.2;
    temp.style.minWidth = '80px';
    temp.addEventListener('change', () => patchMode(i, { temperature: Number(temp.value) }));
    tempLabel.append(document.createTextNode('Temperature '), temp);

    const idNote = textNode(`id: ${mode.id}`, 'meta');

    opts.append(ctxLabel, tempLabel, idNote);
    card.append(header, prompt, opts);
    return card;
  }));
}

async function patchMode(index, patch) {
  settings = await updateSettings((s) => { Object.assign(s.enhancement.modes[index], patch); });
  renderModeSelect();
}

function renderProfiles() {
  const list = $('#profile-list');
  const profiles = settings.powerMode.profiles;
  if (!profiles.length) {
    list.replaceChildren(textNode('No profiles yet. Add one to change settings automatically on a given site.', 'empty'));
    return;
  }

  list.replaceChildren(...profiles.map((profile, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '14px 18px';

    const patch = async (fn) => {
      settings = await updateSettings((s) => fn(s.powerMode.profiles[i]));
    };

    const header = document.createElement('div');
    header.className = 'item';
    header.style.background = 'transparent';
    header.style.border = 'none';
    header.style.padding = '0';

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = profile.enabled;
    enabled.addEventListener('change', () => patch((p) => { p.enabled = enabled.checked; }));

    const name = document.createElement('input');
    name.type = 'text';
    name.value = profile.name;
    name.className = 'grow';
    name.addEventListener('change', () => patch((p) => { p.name = name.value; }));

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      settings = await updateSettings((s) => { s.powerMode.profiles.splice(i, 1); });
      renderProfiles();
    });
    header.append(enabled, name, del);

    const matchRow = document.createElement('div');
    matchRow.className = 'item';
    const matchType = document.createElement('select');
    fillSelect(matchType, [['domain', 'Domain is'], ['contains', 'URL contains'], ['regex', 'URL matches regex']], profile.match.type);
    matchType.addEventListener('change', () => patch((p) => { p.match.type = matchType.value; }));
    const matchValue = document.createElement('input');
    matchValue.type = 'text';
    matchValue.className = 'grow';
    matchValue.placeholder = profile.match.type === 'domain' ? 'mail.google.com' : 'docs.google.com/document';
    matchValue.value = profile.match.value;
    matchValue.addEventListener('change', () => patch((p) => { p.match.value = matchValue.value; }));
    matchRow.append(matchType, matchValue);

    const overrides = document.createElement('div');
    overrides.className = 'grid-2';
    overrides.style.marginTop = '10px';

    const override = (label, options, key) => {
      const wrap = document.createElement('div');
      wrap.className = 'item';
      const select = document.createElement('select');
      select.style.minWidth = '0';
      select.style.flex = '1';
      fillSelect(select, [['', `${label}: inherit`], ...options], profile.overrides[key] ?? '');
      select.addEventListener('change', () => patch((p) => {
        const raw = select.value;
        p.overrides[key] = raw === '' ? null : (raw === 'true' ? true : (raw === 'false' ? false : raw));
      }));
      wrap.append(select);
      return wrap;
    };

    overrides.append(
      override('Engine', [['parakeet', 'Parakeet'], ['whisper', 'Whisper'], ['remote', 'Endpoint'], ['webspeech', 'Chrome']], 'engine'),
      override('Language', LANGUAGES, 'language'),
      override('AI enhancement', [['true', 'on'], ['false', 'off']], 'enhancementEnabled'),
      override('Mode', settings.enhancement.modes.map((m) => [m.id, m.name]), 'modeId'),
      override('Press Enter', [['true', 'yes'], ['false', 'no']], 'autoSend'),
      override('Output', [['auto', 'type'], ['clipboard', 'clipboard'], ['both', 'both']], 'insertMode'),
    );

    card.append(header, matchRow, overrides);
    return card;
  }));
}

// ------------------------------------------------------------- history -----

let historyQuery = '';

/**
 * Report what the database actually holds, and how the last write went.
 *
 * An empty list has several very different causes — nothing recorded yet,
 * history switched off, a worker that lost its session, a failing write — and
 * they are indistinguishable from the list alone.
 */
async function renderHistoryDiagnostics() {
  const line = $('#history-diagnostics');
  // Shown whatever the list contains. Tying this to an empty list meant that
  // writing a single test entry hid the most likely explanation for good.
  $('#history-off-banner').hidden = settings.history.enabled;
  try {
    const count = await history.countEntries();
    const { lastHistoryWrite: last } = await chrome.storage.local.get('lastHistoryWrite');

    const parts = [`${count} ${count === 1 ? 'entry' : 'entries'} in the database.`];
    if (!last) {
      parts.push('No dictation has tried to write yet.');
    } else {
      const when = new Date(last.at).toLocaleString();
      // 'started' still showing means the attempt began and never finished,
      // which is a different fault from one that reported an error.
      parts.push({
        written: `Last dictation was saved at ${when}.`,
        skipped: `Last dictation was not saved at ${when}: ${last.reason}`,
        failed: `Last dictation failed to save at ${when}: ${last.reason}`,
        started: `A save began at ${when} and never finished`
          + ` (session state "${last.state}", settings ${last.hasSettings ? 'present' : 'missing'},`
          + ` history ${last.enabled === null ? 'unknown' : (last.enabled ? 'on' : 'off')}).`,
      }[last.phase] ?? `Last write reported: ${JSON.stringify(last)}`);
    }

    const { dictationTrace } = await chrome.storage.local.get('dictationTrace');
    const lastStep = dictationTrace?.at(-1);
    if (lastStep) {
      parts.push(`Last step: ${lastStep.event}${lastStep.detail ? ` (${JSON.stringify(lastStep.detail)})` : ''}.`);
    }
    line.textContent = parts.join(' ');
  } catch (err) {
    line.textContent = `Could not read the database: ${err.message}`;
  }
}

async function renderHistory() {
  const list = $('#history-list');
  // Deliberately first and unguarded by the list query: the diagnostics matter
  // most when that query is the thing failing.
  renderHistoryDiagnostics();

  let entries;
  let totals;
  try {
    entries = await history.listEntries({ limit: 200, query: historyQuery });
    totals = await history.stats();
  } catch (err) {
    // Without this the section just renders empty, which is indistinguishable
    // from having nothing recorded yet.
    list.replaceChildren(textNode(`Could not read the history database: ${err.message}`, 'empty'));
    return;
  }
  $('#history-stats').replaceChildren(...[
    ['Dictations', totals.count.toLocaleString()],
    ['Words', totals.words.toLocaleString()],
    ['Time spoken', `${Math.round(totals.seconds / 60)} min`],
  ].map(([k, n]) => {
    const cell = document.createElement('div');
    const num = document.createElement('div');
    num.className = 'n';
    num.textContent = n;
    const key = document.createElement('div');
    key.className = 'k';
    key.textContent = k;
    cell.append(num, key);
    return cell;
  }));

  if (!entries.length) {
    const empty = historyQuery
      ? 'Nothing matches that search.'
      : (settings.history.enabled
        ? 'No dictations yet. Entries appear here once a dictation completes and text is inserted.'
        : 'History is switched off, so nothing is being recorded.');
    list.replaceChildren(textNode(empty, 'empty'));
    return;
  }

  list.replaceChildren(...entries.map((entry) => {
    const card = document.createElement('div');
    card.className = 'card history-entry';
    card.style.padding = '14px 18px';

    const top = document.createElement('div');
    top.className = 'top';
    const when = textNode(new Date(entry.ts).toLocaleString(), 'meta');
    const meta = textNode(
      [entry.engine, entry.enhanced ? `enhanced (${entry.modeId})` : null, `${(entry.durationMs / 1000).toFixed(1)}s`, entry.title]
        .filter(Boolean).join(' · '),
      'meta',
    );
    meta.style.flex = '1';
    meta.style.overflow = 'hidden';
    meta.style.textOverflow = 'ellipsis';
    meta.style.whiteSpace = 'nowrap';

    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(entry.final || entry.raw);
      toast('Copied');
    });

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await history.deleteEntry(entry.id);
      renderHistory();
    });

    top.append(when, meta, copy, del);

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = entry.final || entry.raw;
    card.append(top, text);

    if (entry.enhanced && entry.raw && entry.raw !== entry.final) {
      const raw = document.createElement('div');
      raw.className = 'raw';
      raw.textContent = `Before enhancement: ${entry.raw}`;
      card.append(raw);
    }

    return card;
  }));
}

function download(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- wire -----

function wireEvents() {
  $('#grant-mic').addEventListener('click', grantMic);
  $('#recheck-caps').addEventListener('click', renderCapabilities);
  $('#go-models').addEventListener('click', () => { location.hash = '#models'; });
  $('#go-hotkeys').addEventListener('click', () => { location.hash = '#hotkeys'; });
  $('#open-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  $('#activate-tabs').addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    let done = 0;
    await Promise.all(tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['src/content/content.js'],
        });
        done += 1;
      } catch {
        // Restricted pages refuse injection; nothing to do for those.
      }
    }));
    toast(`Activated in ${done} of ${tabs.length} pages.`);
    renderContentCoverage();
  });
  $('#refresh-mics').addEventListener('click', loadDevices);

  $('#test-sound').addEventListener('click', async () => {
    const result = await ask(MSG.PLAY_SOUND, { frequency: 880, seconds: 0.08, volume: settings.recording.soundVolume });
    if (!result) toast('No answer from the audio worker.');
    else if (result.ok === false) toast(`Could not play a sound: ${result.error}`);
    else if (result.via === 'muted') toast('Chirp volume is set to zero.');
    else toast('Played a test chirp.');
  });

  $('#preload').addEventListener('click', async () => {
    $('#model-state').textContent = 'Starting…';
    const bar = $('#dl-progress');
    bar.firstElementChild.style.width = '0%';
    bar.hidden = false;
    try {
      const result = await ask(MSG.PRELOAD_MODEL, { settings });
      if (!result) throw new Error('No answer from the audio worker.');
      if (result.ok === false) throw new Error(result.error);
      toast('Model loaded.');
    } catch (err) {
      toast(err.message);
    } finally {
      // Otherwise a failed load leaves the bar stranded at whatever it reached.
      bar.hidden = true;
      refreshModelStatus();
    }
  });
  $('#unload').addEventListener('click', async () => { await ask(MSG.UNLOAD_MODEL); refreshModelStatus(); });

  $('#preload-llm').addEventListener('click', async () => {
    const bar = $('#llm-progress');
    bar.firstElementChild.style.width = '0%';
    bar.hidden = false;
    $('#llm-state').textContent = 'Starting…';
    try {
      const result = await ask(MSG.PRELOAD_LLM, { config: settings.enhancement.browser });
      if (!result) throw new Error('No answer from the audio worker.');
      if (result.ok === false) throw new Error(result.error);
      toast('AI model loaded.');
    } catch (err) {
      toast(err.message);
    } finally {
      bar.hidden = true;
      refreshModelStatus();
    }
  });
  $('#unload-llm').addEventListener('click', async () => { await ask(MSG.UNLOAD_LLM); refreshModelStatus(); });
  $('#clear-cache').addEventListener('click', async () => {
    if (!confirm('Delete every cached model? They will download again next time you dictate.')) return;
    await ask(MSG.CLEAR_MODEL_CACHE);
    toast('Model cache cleared');
    refreshModelStatus();
  });

  $('#test-asr').addEventListener('click', async () => {
    $('#asr-test-result').textContent = 'Testing…';
    const result = await ask(MSG.TEST_ENDPOINT, { kind: 'asr', config: settings.transcription.remote });
    $('#asr-test-result').textContent = result?.message ?? 'No answer';
  });
  $('#test-llm').addEventListener('click', async () => {
    if (!settings.enhancement.endpoint.baseUrl.trim()) {
      $('#llm-test-result').textContent = 'Enter an endpoint URL first.';
      return;
    }
    $('#llm-test-result').textContent = 'Testing…';
    const result = await ask(MSG.TEST_ENDPOINT, { kind: 'chat', config: settings.enhancement.endpoint });
    $('#llm-test-result').textContent = result?.message ?? 'No answer';
  });

  const addFrom = async (inputSel, mutate, rerender) => {
    const input = $(inputSel);
    const value = input.value.trim();
    if (!value) return;
    settings = await updateSettings((s) => mutate(s, value));
    input.value = '';
    rerender();
  };

  $('#add-disabled-site').addEventListener('click', () => addFrom('#disabled-site-input', (s, v) => { s.sites.disabled.push(v); }, renderDisabledSites));
  $('#add-word').addEventListener('click', () => addFrom('#word-input', (s, v) => { s.dictionary.words.push(v); }, renderWords));
  $('#add-repl').addEventListener('click', async () => {
    const from = $('#repl-from').value.trim();
    if (!from) return;
    const to = $('#repl-to').value;
    settings = await updateSettings((s) => { s.dictionary.replacements.push({ from, to, matchCase: false, regex: false }); });
    $('#repl-from').value = '';
    $('#repl-to').value = '';
    renderReplacements();
  });

  $('#add-mode').addEventListener('click', async () => {
    settings = await updateSettings((s) => {
      s.enhancement.modes.push({
        id: crypto.randomUUID(),
        name: 'New mode',
        icon: '⭐',
        useContext: false,
        temperature: 0.2,
        prompt: 'Rewrite the dictated text. Output only the rewritten text.',
      });
    });
    renderModes();
    renderModeSelect();
  });
  $('#restore-modes').addEventListener('click', async () => {
    settings = await updateSettings((s) => {
      const custom = s.enhancement.modes.filter((m) => !BUILTIN_MODES.some((b) => b.id === m.id));
      s.enhancement.modes = [...structuredClone(BUILTIN_MODES), ...custom];
    });
    renderModes();
    renderModeSelect();
    toast('Built-in modes restored');
  });

  $('#add-profile').addEventListener('click', async () => {
    settings = await updateSettings((s) => { s.powerMode.profiles.push(makeProfile()); });
    renderProfiles();
  });

  $('#history-search').addEventListener('input', (e) => {
    historyQuery = e.target.value;
    renderHistory();
  });
  $('#clear-history').addEventListener('click', async () => {
    if (!confirm('Delete every stored dictation?')) return;
    await history.clearHistory();
    renderHistory();
  });
  $('#export-json').addEventListener('click', async () => download('anchor1mc-history.json', await history.exportEntries('json')));
  $('#export-csv').addEventListener('click', async () => download('anchor1mc-history.csv', await history.exportEntries('csv'), 'text/csv'));
  $('#export-txt').addEventListener('click', async () => download('anchor1mc-history.txt', await history.exportEntries('txt'), 'text/plain'));

  $('#export-settings').addEventListener('click', () => download('anchor1mc-settings.json', JSON.stringify(settings, null, 2)));
  $('#import-settings').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      settings = await saveSettings(JSON.parse(await file.text()));
      toast('Settings imported');
      renderAll();
    } catch (err) {
      toast(`Could not import: ${err.message}`);
    }
  });
  $('#reset-settings').addEventListener('click', async () => {
    if (!confirm('Reset every setting to its default?')) return;
    settings = await resetSettings();
    renderAll();
    toast('Settings reset');
  });

  $('#refresh-history').addEventListener('click', () => renderHistory());

  // Writes straight from this page, bypassing the worker entirely. If the entry
  // appears, the database and this list are fine and the problem is upstream in
  // the dictation path; if it does not, the problem is here.
  $('#enable-history').addEventListener('click', async () => {
    settings = await updateSettings((s) => { s.history.enabled = true; });
    bindControls();
    renderHistory();
    toast('History is on. Dictations from now on will be saved.');
  });

  $('#copy-diagnostics').addEventListener('click', async () => {
    // One click to hand over everything needed to diagnose a missing entry.
    const { lastHistoryWrite, dictationTrace } = await chrome.storage.local.get(['lastHistoryWrite', 'dictationTrace']);
    // Relative timestamps: what matters is the order and the gaps, and absolute
    // epoch numbers make that harder to read, not easier.
    const first = dictationTrace?.[0]?.at ?? 0;
    const report = {
      version: chrome.runtime.getManifest().version,
      historySettings: settings.history,
      entriesInDatabase: await history.countEntries().catch((err) => `error: ${err.message}`),
      lastHistoryWrite: lastHistoryWrite ?? null,
      engine: settings.transcription.engine,
      enhancement: { enabled: settings.enhancement.enabled, provider: settings.enhancement.provider },
      trace: (dictationTrace ?? []).map(({ at, ...rest }) => ({ tMs: at - first, ...rest })),
      contentScript: await contentScriptCoverage().catch((err) => `error: ${err.message}`),
      platform: platformName(),
    };
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    toast('Diagnostics copied to the clipboard.');
  });

  $('#history-selftest').addEventListener('click', async () => {
    try {
      await history.addEntry({
        raw: 'test entry', final: 'Test entry written from the settings page.',
        engine: 'self-test', language: 'n/a', durationMs: 0, latencyMs: 0,
        url: location.href, title: 'Anchor1MC settings',
      });
      toast('Test entry written.');
    } catch (err) {
      toast(`Could not write: ${err.message}`);
    }
    renderHistory();
  });

  // Progress and state pushed from the background.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== 'ui') return false;
    if (message.type === MSG.MODEL_PROGRESS) showProgress(message.progress, message.kind);
    if (message.type === MSG.HISTORY_CHANGED) renderHistory();
    return false;
  });

  // The list is otherwise rendered once, at load. A page left open in another
  // tab while you dictate would keep showing the state it had when it opened —
  // which reads as history being broken rather than stale. Messages cover the
  // common case; this covers a worker that restarted and missed sending one.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') renderHistory();
  });

  // Highlight the section currently in view.
  const links = $$('nav a');
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of links) link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`);
    }
  }, { rootMargin: '-10% 0px -80% 0px' });
  for (const section of $$('main section')) observer.observe(section);
}

function renderAll() {
  // Each section is rendered independently: one section failing should cost
  // that section, not the rest of the page and every event listener with it.
  const sections = [
    ['controls', () => bindControls()],
    ['languages', () => fillSelect($('#language-select'), LANGUAGES, settings.transcription.language)],
    ['hotkeys', () => { renderHotkeyLabels(); renderContentCoverage(); }],
    ['models', renderModelSelects],
    ['panels', () => { renderEnginePanels(); renderProviderPanels(); }],
    ['modes', () => { renderModeSelect(); renderModes(); }],
    ['dictionary', () => { renderWords(); renderReplacements(); }],
    ['sites', renderDisabledSites],
    ['power mode', renderProfiles],
    ['derived text', renderDerived],
    ['history', renderHistory],
  ];
  for (const [name, render] of sections) {
    try {
      render();
    } catch (err) {
      console.error(`[anchor1mc] could not render the ${name} section`, err);
      toast(`Could not render the ${name} section: ${err.message}`);
    }
  }
}

function renderHotkeyLabels() {
  const code = settings.hotkeys.modifierKey;
  fillSelect($must('#modifier-key'), modifierOptions(), code);
  $must('#welcome-hotkey').textContent = keyLabel(code);
  $must('#modifier-key-note').textContent = modifierNote(code);
}

async function init() {
  settings = await getSettings();
  renderAll();
  wireEvents();
  checkMicPermission();
  renderCapabilities();
  refreshModelStatus();
  loadDevices();

  const manifest = chrome.runtime.getManifest();
  $('#version-line').textContent = `${manifest.name} ${manifest.version}`;

  const commands = await chrome.commands.getAll();
  const toggle = commands.find((c) => c.name === 'toggle-recording');
  if (toggle?.shortcut) $('#command-hint').textContent = commandLabel(toggle.shortcut);

  // Mark the first run as done so the welcome tab does not reappear.
  if (!settings.onboarded) await updateSettings((s) => { s.onboarded = true; });
}

init();

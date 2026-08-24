/** Settings storage: load, deep-merge onto defaults, save, and subscribe. */
import { DEFAULTS, SETTINGS_VERSION, freshDefaults } from './defaults.js';

const KEY = 'settings';
let cache = null;
const listeners = new Set();

/** Merge stored values over defaults, so a new option appears without migration.
 *  Arrays are replaced wholesale — a user who deleted every mode means it. */
function merge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? structuredClone(override) : structuredClone(base);
  if (base && typeof base === 'object') {
    const out = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(override ?? {})])) {
      out[k] = k in base ? merge(base[k], override?.[k]) : structuredClone(override[k]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

function migrate(stored) {
  if (!stored || typeof stored !== 'object') return freshDefaults();
  // Only one schema version so far; future migrations branch on stored.version.
  const merged = merge(DEFAULTS, stored);
  merged.version = SETTINGS_VERSION;
  return merged;
}

function requireStorage() {
  if (!chrome.storage?.local) {
    throw new Error('Settings storage is unavailable in this context (offscreen documents only get chrome.runtime). Pass settings in the message instead.');
  }
}

export async function getSettings({ force = false } = {}) {
  if (cache && !force) return cache;
  requireStorage();
  const stored = await chrome.storage.local.get(KEY);
  cache = migrate(stored[KEY]);
  return cache;
}

/** Synchronous read of the last loaded settings, or null before first load. */
export function peekSettings() {
  return cache;
}

export async function saveSettings(next) {
  requireStorage();
  cache = migrate(next);
  await chrome.storage.local.set({ [KEY]: cache });
  return cache;
}

/** Apply a mutation to the settings object and persist the result. */
export async function updateSettings(mutator) {
  const current = structuredClone(await getSettings());
  const returned = mutator(current);
  return saveSettings(returned ?? current);
}

export async function resetSettings() {
  return saveSettings(freshDefaults());
}

/** Read a dotted path, e.g. getPath(s, 'transcription.parakeet.precision'). */
export function getPath(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = obj;
  for (const k of keys) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  node[last] = value;
  return obj;
}

export function onSettingsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Keeps the service worker, options page, and popup current as settings change.
//
// Deliberately guarded: an offscreen document is only granted chrome.runtime,
// so chrome.storage is undefined there. Reaching for it unguarded throws while
// the module is still evaluating, which takes down everything that imported it
// — including, in that context, the message listener the whole document exists
// to provide. Offscreen code receives settings by message instead.
if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    cache = migrate(changes[KEY].newValue);
    for (const fn of listeners) {
      try { fn(cache); } catch (err) { console.error('[anchor1mc] settings listener failed', err); }
    }
  });
}

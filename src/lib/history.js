/** Transcription history, in IndexedDB so audio blobs are cheap to keep. */
const DB_NAME = 'anchor1mc';
const DB_VERSION = 1;
const STORE = 'history';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @param {object} entry
 * @param {string} entry.raw    transcript straight from the engine
 * @param {string} entry.final  what was actually inserted
 */
export async function addEntry(entry) {
  const record = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    raw: '',
    final: '',
    modeId: null,
    enhanced: false,
    engine: null,
    language: null,
    durationMs: 0,
    latencyMs: 0,
    url: null,
    title: null,
    wordCount: 0,
    ...entry,
  };
  record.wordCount = (record.final || record.raw).trim().split(/\s+/).filter(Boolean).length;
  await done((await tx('readwrite')).put(record));
  return record;
}

export async function listEntries({ limit = 100, offset = 0, query = '' } = {}) {
  const store = await tx('readonly');
  const index = store.index('ts');
  const out = [];
  const needle = query.trim().toLowerCase();
  let skipped = 0;
  await new Promise((resolve, reject) => {
    // Newest first.
    const req = index.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve();
      const v = cursor.value;
      const matches = !needle
        || (v.final || '').toLowerCase().includes(needle)
        || (v.raw || '').toLowerCase().includes(needle)
        || (v.title || '').toLowerCase().includes(needle);
      if (matches) {
        if (skipped >= offset) {
          out.push(v);
        } else {
          skipped += 1;
        }
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out;
}

export async function getEntry(id) {
  return done((await tx('readonly')).get(id));
}

export async function deleteEntry(id) {
  return done((await tx('readwrite')).delete(id));
}

export async function clearHistory() {
  return done((await tx('readwrite')).clear());
}

export async function countEntries() {
  return done((await tx('readonly')).count());
}

/** Drop entries past the age or count limit. */
export async function prune({ retainDays, maxEntries }) {
  const store = await tx('readwrite');
  const now = Date.now();
  const entryCutoff = retainDays > 0 ? now - retainDays * 864e5 : 0;
  const keep = [];

  await new Promise((resolve, reject) => {
    const req = store.index('ts').openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const v = cursor.value;
      const tooOld = entryCutoff && v.ts < entryCutoff;
      const overflow = maxEntries > 0 && keep.length >= maxEntries;
      if (tooOld || overflow) {
        cursor.delete();
      } else {
        keep.push(v.id);
        // Audio retention was removed; reclaim the space any older entry holds.
        if (v.audio) {
          const { audio, ...rest } = v;
          cursor.update(rest);
        }
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return keep.length;
}

export async function exportEntries(format = 'json') {
  const entries = await listEntries({ limit: 1e6 });
  if (format === 'json') return JSON.stringify(entries, null, 2);
  if (format === 'txt') {
    return entries.map((e) => `--- ${new Date(e.ts).toLocaleString()}${e.title ? ` — ${e.title}` : ''}\n${e.final || e.raw}`).join('\n\n');
  }
  const esc = (s) => `"${String(s ?? '').replaceAll('"', '""')}"`;
  const head = 'timestamp,engine,mode,enhanced,duration_ms,latency_ms,words,url,title,raw,final';
  const rows = entries.map((e) => [
    new Date(e.ts).toISOString(), e.engine, e.modeId, e.enhanced, e.durationMs, e.latencyMs, e.wordCount, e.url, e.title, e.raw, e.final,
  ].map(esc).join(','));
  return [head, ...rows].join('\n');
}

/** Lifetime totals for the stats strip in options. */
export async function stats() {
  const entries = await listEntries({ limit: 1e6 });
  const words = entries.reduce((n, e) => n + (e.wordCount || 0), 0);
  const seconds = entries.reduce((n, e) => n + (e.durationMs || 0), 0) / 1000;
  return { count: entries.length, words, seconds };
}

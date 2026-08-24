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

/**
 * Run work inside one transaction.
 *
 * The connection is awaited *before* the transaction is created, and every
 * request is then issued synchronously inside `fn`. That ordering is the whole
 * point: an IndexedDB transaction is only active for the task that created it,
 * so creating one inside a promise callback and issuing the request after a
 * later `await` — as an earlier version did — leaves a window where the
 * transaction has already gone inactive and the request throws. It survived
 * being called straight from a click handler and failed when called deep in a
 * chain of awaits, which is exactly the shape a dictation takes.
 *
 * Resolving on `oncomplete` rather than on the request also means a write is
 * durable before the caller is told it succeeded, which matters in a service
 * worker that can be terminated at any point.
 *
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => any} fn issues requests synchronously;
 *   its return value, or whatever it accumulates, resolves once the
 *   transaction commits
 */
async function withStore(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(STORE, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let value;
    let failed = null;
    try {
      value = fn(transaction.objectStore(STORE), transaction);
    } catch (err) {
      failed = err;
      try { transaction.abort(); } catch { /* already aborting */ }
    }
    transaction.oncomplete = () => (failed ? reject(failed) : resolve(value?.result ?? value));
    transaction.onerror = () => reject(failed ?? transaction.error);
    transaction.onabort = () => reject(failed ?? transaction.error ?? new Error('History transaction aborted'));
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
  await withStore('readwrite', (store) => { store.put(record); });
  return record;
}

export async function listEntries({ limit = 100, offset = 0, query = '' } = {}) {
  const out = [];
  const needle = query.trim().toLowerCase();
  let skipped = 0;

  await withStore('readonly', (store) => {
    // Newest first.
    const req = store.index('ts').openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return;
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
  });
  return out;
}

export async function getEntry(id) {
  return withStore('readonly', (store) => store.get(id));
}

export async function deleteEntry(id) {
  return withStore('readwrite', (store) => { store.delete(id); });
}

export async function clearHistory() {
  return withStore('readwrite', (store) => { store.clear(); });
}

export async function countEntries() {
  return withStore('readonly', (store) => store.count());
}

/** Drop entries past the age or count limit. */
export async function prune({ retainDays, maxEntries }) {
  const now = Date.now();
  const entryCutoff = retainDays > 0 ? now - retainDays * 864e5 : 0;
  const keep = [];

  await withStore('readwrite', (store) => {
    const req = store.index('ts').openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
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

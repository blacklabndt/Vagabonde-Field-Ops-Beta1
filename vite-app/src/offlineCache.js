// The read half of working offline.
//
// The offline queue keeps work that is on its way *out*. This keeps the last
// known copy of what the field screens need on the way *in* — the jobs board,
// a job's record and history, the client's rates, who is on the crew — so a
// technician who opens the app on a lease with no signal sees the day's work
// instead of an empty table and "Failed to fetch".
//
// Deliberately a fallback, never a first choice: every read goes to Supabase
// first and only drops to the cache when the network genuinely fails. A stale
// rate that quietly looked live would be a worse problem than no rate at all,
// which is why anything served from here also flips the banner that says so.
//
// Kept in its own IndexedDB database rather than a store inside the queue's,
// so the two never share an upgrade path — losing queued work to a schema
// bump on the cache would be an absurd way to lose a day of billing.

import { isNetworkError } from "./offlineQueue.js";

const OC_DB_NAME = "nde-offline-cache";
const OC_STORE = "reads";

let ocDbPromise = null;
function ocOpenDb() {
  if (ocDbPromise) return ocDbPromise;
  ocDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(OC_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(OC_STORE, { keyPath: "key" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { ocDbPromise = null; reject(req.error); };
  });
  return ocDbPromise;
}

async function ocGet(key) {
  const db = await ocOpenDb();
  const tx = db.transaction(OC_STORE, "readonly");
  const req = tx.objectStore(OC_STORE).get(key);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function ocPut(key, value) {
  const db = await ocOpenDb();
  const tx = db.transaction(OC_STORE, "readwrite");
  tx.objectStore(OC_STORE).put({ key, value, at: Date.now() });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function ocDelete(key) {
  const db = await ocOpenDb();
  const tx = db.transaction(OC_STORE, "readwrite");
  tx.objectStore(OC_STORE).delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Whether the app is currently showing remembered data, and how old it is.
// One flag for the whole app rather than per-screen: "some of this page is
// from Tuesday" is not a thing anyone can act on, but "you are offline, this
// is what was here at 14:32" is.
let state = { servingCached: false, at: null };
const listeners = new Set();
const notify = () => listeners.forEach(fn => fn(state));

function setState(next) {
  if (next.servingCached === state.servingCached && next.at === state.at) return;
  state = next;
  notify();
}

export const OfflineCache = {
  get state() { return state; },

  subscribe(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  },

  // A successful read from the network means we are back; clear the banner.
  markLive() { setState({ servingCached: false, at: null }); },

  // For callers that do their own fallback rather than going through
  // readThrough (the jobs board, which serves one cached page for any query).
  noteServingCached(at) { setState({ servingCached: true, at }); },

  // Store without reading — for values fetched as part of a bigger response
  // (the jobs page carries every job on it, so each one is worth keeping).
  put(key, value) { return ocPut(key, value).catch(() => {}); },

  read(key) { return ocGet(key); },

  // Drop one entry. Used by the ticket screen to throw away its in-progress
  // copy once the real thing is safely stored — a leftover would otherwise be
  // offered back the next time that job's ticket screen opens.
  remove(key) { return ocDelete(key).catch(() => {}); },

  // Network first, remembered copy second, and only ever for a real
  // connectivity failure. A permission error or a bad request is a genuine
  // answer from the server and has to surface as one.
  async readThrough(key, fetcher) {
    try {
      const value = await fetcher();
      this.markLive();
      ocPut(key, value).catch(() => {});
      return value;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      const hit = await ocGet(key).catch(() => null);
      if (!hit) throw e;
      setState({ servingCached: true, at: hit.at });
      return hit.value;
    }
  },

  // Everything this device remembers, dropped. Used when signing out, so the
  // next person to use the tablet cannot page through the last crew's work.
  //
  // Cache keys are not scoped to an account — "contacts", "job.<id>" — because
  // they are the same rows whoever is reading them. That is fine while a
  // session lasts and is exactly why this has to actually succeed: whatever
  // survives a sign-out is readable by the next person to sign in, the moment
  // they lose signal.
  //
  // It used to resolve on error as well as on success, so a clear that aborted
  // was indistinguishable from one that worked, and the guarantee in the
  // paragraph above was a hope. It now throws, and the caller says so.
  //
  // Emptying the store, deliberately, rather than deleting the database. A
  // deleteDatabase fallback was tried and taken back out: it is blocked by any
  // other tab holding the same origin open, which on a shared tablet with the
  // app open twice is far more likely than the aborted transaction it was
  // meant to rescue. Trading a rare silent failure for a common noisy one is
  // not a trade.
  async clear() {
    const db = await ocOpenDb();
    const tx = db.transaction(OC_STORE, "readwrite");
    tx.objectStore(OC_STORE).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    setState({ servingCached: false, at: null });
  }
};

// Offline queue for the three field screens that need to keep working with no
// signal: the JHA builder, report upload, and the billing ticket. Queued
// items live in IndexedDB — not localStorage, since a report upload carries a
// real PDF File and localStorage can't hold one — so they survive a reload
// and replay automatically the moment the browser is back online.
//
// This never queues a real app error (a completed job, a bad value) — only a
// genuine connectivity failure. Anything else still surfaces immediately,
// same as before.

import { Toasts } from "./toastBus.js";

const OQ_DB_NAME = "nde-offline-queue";
const OQ_STORE = "queue";

// One connection for the life of the tab. Every queue operation used to open
// its own and never close it, so a session that queued and flushed a few times
// left a handful of live IndexedDB connections behind — enough to block a
// version upgrade later on.
let oqDbPromise = null;
function oqOpenDb() {
  if (oqDbPromise) return oqDbPromise;
  oqDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(OQ_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(OQ_STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { oqDbPromise = null; reject(req.error); };
  });
  return oqDbPromise;
}

function oqPromisifyTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function oqPut(item) {
  const db = await oqOpenDb();
  const tx = db.transaction(OQ_STORE, "readwrite");
  tx.objectStore(OQ_STORE).put(item);
  await oqPromisifyTx(tx);
}

async function oqDelete(id) {
  const db = await oqOpenDb();
  const tx = db.transaction(OQ_STORE, "readwrite");
  tx.objectStore(OQ_STORE).delete(id);
  await oqPromisifyTx(tx);
}

async function oqGetAll() {
  const db = await oqOpenDb();
  const tx = db.transaction(OQ_STORE, "readonly");
  const req = tx.objectStore(OQ_STORE).getAll();
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return result.sort((a, b) => a.createdAt - b.createdAt);
}

// A network failure looks like a thrown TypeError from fetch ("Failed to
// fetch", "NetworkError…", "Load failed" on Safari) or the browser already
// knowing it has no connection. Anything else — a validation message, a
// permission error, a completed job — is a real error and must not be queued
// silently, or the crew never finds out something is actually wrong.
export function isNetworkError(e) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const msg = String((e && e.message) || "");
  return /failed to fetch|networkerror|load failed|network request failed|ERR_INTERNET_DISCONNECTED/i.test(msg);
}

const oqListeners = new Set();
function oqNotify() {
  oqGetAll().then(items => oqListeners.forEach(fn => fn(items)));
}

let oqFlushing = null;

async function oqFlushOnce(handlers) {
  let synced = 0, stillOffline = false;
  const items = await oqGetAll();
  for (const item of items) {
    const handler = handlers[item.type];
    if (!handler) continue;

    // Handlers that take more than one write get a way to record what has
    // already landed. Without it, a replay that dies halfway starts again
    // from the top: a ticket whose row was created but whose crew hadn't
    // been saved yet comes back as a *second* ticket with a second number,
    // and the first is left with no crew on it. Signal dropping mid-write
    // is the normal condition out there, not the rare one.
    //
    // The checkpoint is written to IndexedDB before the next step runs, so
    // it survives the tab being closed as well as the request failing.
    let current = item;
    const checkpoint = async fields => {
      current = { ...current, payload: { ...current.payload, ...fields } };
      await oqPut(current);
    };

    try {
      await handler(item.payload, checkpoint);
      await oqDelete(item.id);
      synced++;
      oqNotify();
    } catch (e) {
      if (isNetworkError(e)) { stillOffline = true; break; }
      // A real error on replay (e.g. the job was completed meanwhile) —
      // leave it queued with the reason attached rather than dropping the
      // work silently. Whoever reviews the queue can see why it stalled.
      //
      // Written from `current`, not `item`: if the handler checkpointed
      // before it failed, saving the original payload here would throw that
      // progress away and the retry would duplicate the work it already did.
      await oqPut({ ...current, lastError: e.message || "Couldn't sync this item." });
      oqNotify();
    }
  }
  return { synced, stillOffline };
}

export const OfflineQueue = {
  isNetworkError,

  async enqueue(type, payload) {
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    await oqPut({ id, type, payload, createdAt: Date.now(), lastError: null });
    oqNotify();
    return id;
  },

  list: oqGetAll,

  // Throwing away an item that will never sync — a ticket for a job that was
  // completed while the crew was out of range, say. Only ever called with the
  // reason on screen and a confirmation behind it: this is somebody's day of
  // work, and nothing else holds a copy.
  async remove(id) {
    await oqDelete(id);
    oqNotify();
  },

  // Called on load and whenever the browser comes back online. Replays each
  // queued item through the real handler in the order it was queued.
  //
  // One flush at a time: the load-time call and an `online` event that fires
  // moments later would otherwise both be walking the same list, and a ticket
  // whose handler was still running would be replayed — and re-sent — twice.
  async flush(handlers) {
    if (oqFlushing) return oqFlushing;
    oqFlushing = (async () => {
      // Replaying calls the same writes a person would, so without this a
      // truck coming back into signal would throw a handful of "Ticket
      // created" confirmations at whoever is holding it, for work done hours
      // ago. The queue badge and its panel are how syncing reports itself.
      Toasts.mute();
      try { return await oqFlushOnce(handlers); }
      finally { Toasts.unmute(); oqFlushing = null; }
    })();
    return oqFlushing;
  },

  // Subscribe to queue changes — used by the topbar badge. Calls back
  // immediately with the current list, then again on every change.
  subscribe(fn) {
    oqListeners.add(fn);
    oqGetAll().then(fn);
    return () => oqListeners.delete(fn);
  },

  attachAutoFlush(handlers) {
    const tryFlush = () => this.flush(handlers).catch(() => {});
    window.addEventListener("online", tryFlush);
    tryFlush();
    return () => window.removeEventListener("online", tryFlush);
  }
};

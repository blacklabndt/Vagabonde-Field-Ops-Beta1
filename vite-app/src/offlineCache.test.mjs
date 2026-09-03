// Tests for the other half of working offline — what the field screens read.
//
// Run with: node --test src/offlineCache.test.mjs
//
// The contract is narrow on purpose and every clause of it has teeth: the
// network is asked first, always; the remembered copy is served only for a
// genuine connectivity failure, never for a server that answered "no"; and
// anything served from memory flips the banner that admits it. A stale rate
// that quietly looked live is a worse problem than no rate at all.

// IndexedDB before the module, same as the queue's tests.
import "fake-indexeddb/auto";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// isNetworkError (imported by the cache from the queue) reads navigator.onLine.
// It is a getter-only global in node, so it has to be defined over rather than
// assigned.
const nav = { onLine: true };
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });

const { OfflineCache } = await import("./offlineCache.js");

// readThrough deliberately does not await the write it starts — a read must
// not wait on disk. So poll for the outcome instead of sleeping.
async function eventually(fn, what = "the expected state", ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// Run something with the clock held still, so a saved-at stamp is evidence
// rather than a race.
async function at(ts, fn) {
  const real = Date.now;
  Date.now = () => ts;
  try { return await fn(); }
  finally { Date.now = real; }
}

const failedFetch = () => { throw new TypeError("Failed to fetch"); };

beforeEach(async () => {
  nav.onLine = true;
  await OfflineCache.clear();
});

test("a read that answers is the answer, and it is remembered", async () => {
  const value = { id: "J-77", project: "Wapiti 12-3" };
  const got = await OfflineCache.readThrough("job.J-77", async () => value);

  assert.deepEqual(got, value);
  assert.deepEqual(OfflineCache.state, { servingCached: false, at: null }, "no banner: this is live");
  const hit = await eventually(() => OfflineCache.read("job.J-77"), "the value to reach disk");
  assert.deepEqual(hit.value, value);
});

test("with the signal gone, the remembered copy is served — and says so", async () => {
  const value = { id: "J-77", project: "Wapiti 12-3" };
  await at(1_700_000_000_000, async () => {
    await OfflineCache.readThrough("job.J-77", async () => value);
    await eventually(() => OfflineCache.read("job.J-77"), "the value to reach disk");
  });

  const out = await OfflineCache.readThrough("job.J-77", failedFetch);
  assert.deepEqual(out, value, "the technician sees the day's work, not an empty table");
  assert.equal(OfflineCache.state.servingCached, true);
  assert.equal(OfflineCache.state.at, 1_700_000_000_000, "and the banner can say when this was true");

  // A read that answers again puts the app back on live data.
  await OfflineCache.readThrough("job.J-77", async () => value);
  assert.deepEqual(OfflineCache.state, { servingCached: false, at: null });
});

test("nothing remembered means the failure surfaces", async () => {
  await assert.rejects(
    () => OfflineCache.readThrough("job.never-opened-here", failedFetch),
    /Failed to fetch/,
    "an empty screen and a plain error beats inventing an answer"
  );
  assert.equal(OfflineCache.state.servingCached, false, "and no banner claims this is remembered data");
});

test("a real answer from the server is never replaced by a remembered one", async () => {
  await OfflineCache.readThrough("rates.published", async () => ({ film: 1200 }));
  await eventually(() => OfflineCache.read("rates.published"), "the value to reach disk");

  await assert.rejects(
    () => OfflineCache.readThrough("rates.published", async () => { throw new Error("permission denied for table rates"); }),
    /permission denied/,
    "a permission error is an answer, and has to be seen as one"
  );
  assert.equal(OfflineCache.state.servingCached, false);
});

test("a plain failure while the browser knows it is offline still serves the cache", async () => {
  await OfflineCache.readThrough("contacts", async () => [{ name: "Athabasca Energy" }]);
  await eventually(() => OfflineCache.read("contacts"), "the value to reach disk");

  nav.onLine = false;
  const out = await OfflineCache.readThrough("contacts", async () => { throw new Error("Load failed"); });
  assert.equal(out[0].name, "Athabasca Energy");
  assert.equal(OfflineCache.state.servingCached, true);
});

test("put, read and remove round-trip", async () => {
  await OfflineCache.put("job.J-9", { id: "J-9" });
  const hit = await OfflineCache.read("job.J-9");
  assert.equal(hit.value.id, "J-9");
  assert.ok(hit.at, "stamped, so the banner can date it");

  await OfflineCache.remove("job.J-9");
  assert.equal(await OfflineCache.read("job.J-9"), null);
  assert.equal(await OfflineCache.read("job.never-put"), null, "a key that was never here reads as nothing, not an error");
});

test("an unchanged result skips the disk; a changed one does not", async () => {
  const rates = { film: 1200 };
  await at(1_000, () => OfflineCache.readThrough("rates.default", async () => rates));
  await eventually(async () => (await OfflineCache.read("rates.default")) !== null, "the first write");
  assert.equal((await OfflineCache.read("rates.default")).at, 1_000);

  // The same bytes again — the chat polls its page for as long as the room is
  // open, and rewriting an identical blob every couple of minutes is battery
  // spent remembering what the device already knows.
  await at(2_000, async () => {
    await OfflineCache.readThrough("rates.default", async () => ({ film: 1200 }));
    // The write readThrough starts is not awaited, so prove the absence of one
    // by ordering: a readwrite transaction opened after it would have to queue
    // behind it. Once this awaited write has completed, any skipped one has
    // had its chance.
    await OfflineCache.put("_probe", 1);
  });
  assert.equal((await OfflineCache.read("rates.default")).at, 1_000, "the older saved-at stamp is honest — the content really is from then");

  // Changed bytes always land.
  await at(3_000, () => OfflineCache.readThrough("rates.default", async () => ({ film: 1350 })));
  const hit = await eventually(
    async () => { const h = await OfflineCache.read("rates.default"); return h && h.at === 3_000 ? h : null; },
    "the changed rate to be written"
  );
  assert.equal(hit.value.film, 1350);
});

test("signing out empties the cache — and the guard that skips writes with it", async () => {
  const rates = { film: 1200 };
  await OfflineCache.readThrough("rates.default", async () => rates);
  await OfflineCache.put("job.J-9", { id: "J-9" });
  await eventually(() => OfflineCache.read("rates.default"), "the value to reach disk");

  await OfflineCache.clear();
  assert.equal(await OfflineCache.read("rates.default"), null, "the next person cannot page through the last crew's work");
  assert.equal(await OfflineCache.read("job.J-9"), null);
  assert.deepEqual(OfflineCache.state, { servingCached: false, at: null });

  // The same fetch, unchanged, must reach disk again: the skip-unchanged guard
  // used to survive the clear, so the next session's offline copy was silently
  // never written.
  await OfflineCache.readThrough("rates.default", async () => rates);
  const hit = await eventually(() => OfflineCache.read("rates.default"), "the rebuilt offline copy");
  assert.deepEqual(hit.value, rates);
});

test("subscribers are told the state at once and on every change", async () => {
  const seen = [];
  const stop = OfflineCache.subscribe(s => seen.push(s.servingCached));
  assert.deepEqual(seen, [false], "called immediately with where things stand");

  await OfflineCache.readThrough("job.J-8", async () => ({ id: "J-8" }));
  await eventually(() => OfflineCache.read("job.J-8"), "the value to reach disk");
  assert.deepEqual(seen, [false], "a live read that changes nothing does not re-render the banner");

  await OfflineCache.readThrough("job.J-8", failedFetch);
  assert.deepEqual(seen, [false, true]);

  stop();
  OfflineCache.markLive();
  assert.deepEqual(seen, [false, true], "an unsubscribed listener hears nothing");
});

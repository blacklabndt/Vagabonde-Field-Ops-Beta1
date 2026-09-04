// Tests for the bulk-send pool behind "Chase all unsigned".
//
//   node --test src/sendPool.test.mjs
//
// The thing being pinned down is what four thousand emails do to a browser and
// to the transport: that no more than a handful are in flight, that starts are
// paced, that a "come back in a moment" refusal is waited out rather than
// counted as a failure, that anything else is not retried, and that Stop stops.
// Fake senders and a fake clock, so none of that costs a second of wall time.

import test from "node:test";
import assert from "node:assert/strict";
import { runSendPool, isTransientSendError, retryAfterFromError, backoffMs, MAX_WAIT_MS } from "./sendPool.js";

// A clock whose sleep is instantaneous but still moves time forward, so the
// pacing arithmetic is exercised for real without waiting for it.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async ms => { t += ms; await Promise.resolve(); }
  };
}

const nums = n => Array.from({ length: n }, (_, i) => i + 1);

test("items start in list order", async () => {
  const startOrder = [];
  const clock = fakeClock();
  const out = await runSendPool(nums(9), async item => { startOrder.push(item); }, {
    concurrency: 3, minInterval: 0, sleep: clock.sleep, now: clock.now
  });
  assert.deepEqual(startOrder, nums(9));
  assert.deepEqual(out.sent, nums(9));
  assert.equal(out.failed.length, 0);
  assert.equal(out.stopped, false);
  assert.equal(out.remaining, 0);
});

test("no more than `concurrency` sends are ever in flight", async () => {
  let inFlight = 0, peak = 0;
  await runSendPool(nums(20), async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 2));
    inFlight--;
  }, { concurrency: 3, minInterval: 0 });
  assert.equal(peak, 3, "three at a time, never four");
});

test("a single worker really is one at a time", async () => {
  let inFlight = 0, peak = 0;
  await runSendPool(nums(5), async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 1));
    inFlight--;
  }, { concurrency: 1, minInterval: 0 });
  assert.equal(peak, 1);
});

test("starts are paced by minInterval even with instant sends", async () => {
  // Ten sends that each take no time at all still cannot go out faster than
  // the floor allows — which is the whole point, because the transport's
  // ceiling is per second and a burst just converts sends into 429s.
  const clock = fakeClock();
  await runSendPool(nums(10), async () => {}, {
    concurrency: 3, minInterval: 500, sleep: clock.sleep, now: clock.now
  });
  assert.ok(clock.now() >= 9 * 500, `ten starts at 500ms apart, got ${clock.now()}ms`);
});

test("a rate-limit refusal is waited out and retried, not counted failed", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const out = await runSendPool(["T-1"], async () => {
    attempts++;
    if (attempts < 3) throw new Error("Resend is rate-limiting: too many requests");
  }, { concurrency: 1, sleep: clock.sleep, now: clock.now });
  assert.equal(attempts, 3, "failed twice, third try landed");
  assert.deepEqual(out.sent, ["T-1"]);
  assert.equal(out.failed.length, 0);
  // 1s then 2s of backoff, doubling.
  assert.equal(clock.now(), 3000);
});

test("an unavailable transport is retried too", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const out = await runSendPool(["T-1"], async () => {
    attempts++;
    if (attempts < 2) throw new Error("Resend is unavailable (503): upstream error");
  }, { concurrency: 1, sleep: clock.sleep, now: clock.now });
  assert.equal(attempts, 2);
  assert.deepEqual(out.sent, ["T-1"]);
});

test("Retry-After on the error beats the doubling backoff", async () => {
  const clock = fakeClock();
  let attempts = 0;
  await runSendPool(["T-1"], async () => {
    attempts++;
    if (attempts < 2) {
      const e = new Error("Resend is rate-limiting: slow down (retry after 7s)");
      e.retryAfter = 7;
      throw e;
    }
  }, { concurrency: 1, sleep: clock.sleep, now: clock.now });
  assert.equal(clock.now(), 7000, "waited the seven seconds it was told, not one");
});

test("a retryable failure gives up after three retries", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const out = await runSendPool(["T-9"], async () => {
    attempts++;
    throw new Error("Resend is rate-limiting: too many requests");
  }, { concurrency: 1, sleep: clock.sleep, now: clock.now });
  assert.equal(attempts, 4, "the first try plus three retries");
  assert.equal(out.sent.length, 0);
  assert.deepEqual(out.failed.map(f => f.item), ["T-9"]);
  assert.match(out.failed[0].error.message, /rate-limiting/);
});

test("anything else is not retried — a bad address is not a busy server", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const out = await runSendPool(["T-2"], async () => {
    attempts++;
    throw new Error("rep@nowhere is not a valid email address");
  }, { concurrency: 1, sleep: clock.sleep, now: clock.now });
  assert.equal(attempts, 1);
  assert.equal(out.failed.length, 1);
  assert.equal(clock.now(), 0, "no backoff was waited for a permanent refusal");
});

test("one failure does not strand the rest of the run", async () => {
  const out = await runSendPool(nums(5), async item => {
    if (item === 3) throw new Error("mailbox full");
  }, { concurrency: 2, minInterval: 0 });
  assert.deepEqual(out.sent.sort((a, b) => a - b), [1, 2, 4, 5]);
  assert.deepEqual(out.failed.map(f => f.item), [3]);
});

test("Stop starts nothing new and lets what is in flight finish", async () => {
  let stop = false;
  const finished = [];
  const out = await runSendPool(nums(50), async item => {
    await new Promise(r => setTimeout(r, 1));
    finished.push(item);
    if (finished.length >= 4) stop = true;
  }, { concurrency: 2, minInterval: 0, shouldStop: () => stop });
  assert.equal(out.stopped, true);
  assert.ok(out.remaining > 0, "the rest of the fifty were never started");
  assert.ok(out.started <= 8, `stopped promptly, started ${out.started}`);
  assert.equal(out.sent.length, out.started, "every started send was allowed to land");
});

test("Stop during a backoff abandons the retry", async () => {
  const clock = fakeClock();
  let attempts = 0;
  let stop = false;
  const out = await runSendPool(["T-1"], async () => {
    attempts++;
    stop = true;
    throw new Error("Resend is rate-limiting: too many requests");
  }, { concurrency: 1, sleep: clock.sleep, now: clock.now, shouldStop: () => stop });
  assert.equal(attempts, 1, "the wait was interrupted rather than tried again");
  assert.equal(out.failed.length, 1);
});

test("Stop is answered part-way through a long wait, not at the end of it", async () => {
  // The stepped clock is the whole point: Stop is pressed one second into a
  // Retry-After of a minute, and the pool has to come back at about that
  // second. Waited in one piece it came back at sixty — the office pressed
  // Stop, the button said "Stopping…", and nothing happened for a minute.
  const clock = fakeClock();
  let attempts = 0;
  const out = await runSendPool(["T-1"], async () => {
    attempts++;
    const e = new Error("Resend is rate-limiting: slow down");
    e.retryAfter = 60;
    throw e;
  }, {
    concurrency: 1, sleep: clock.sleep, now: clock.now,
    shouldStop: () => clock.now() >= 1000
  });
  assert.equal(attempts, 1, "the wait was abandoned rather than retried");
  assert.ok(clock.now() < 2000, `came back mid-wait at ${clock.now()}ms, not at the end of the minute`);
  assert.equal(out.stopped, true);
  assert.deepEqual(out.failed.map(f => f.item), ["T-1"]);
});

test("a Retry-After of an hour is capped, not obeyed", async () => {
  // Resend's header is the far end's number to choose. An hour of it would
  // hold one worker — and one ticket of four thousand — for the hour.
  const clock = fakeClock();
  let attempts = 0;
  const out = await runSendPool(["T-1"], async () => {
    attempts++;
    if (attempts < 2) {
      const e = new Error("Resend is rate-limiting: come back later (retry after 3600s)");
      e.retryAfter = 3600;
      throw e;
    }
  }, { concurrency: 1, sleep: clock.sleep, now: clock.now });
  assert.equal(clock.now(), MAX_WAIT_MS, "waited the ceiling, not the hour it was told");
  assert.deepEqual(out.sent, ["T-1"]);
});

test("progress is reported once per settled item, in order", async () => {
  const seen = [];
  await runSendPool(nums(6), async item => {
    if (item === 2) throw new Error("nope");
  }, { concurrency: 2, minInterval: 0, onProgress: (done, total) => seen.push(`${done}/${total}`) });
  assert.deepEqual(seen, ["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
});

test("an empty list is a no-op, not a hang", async () => {
  const out = await runSendPool([], async () => { throw new Error("never called"); }, { concurrency: 3 });
  assert.deepEqual(out.sent, []);
  assert.equal(out.started, 0);
});

test("isTransientSendError knows what is worth waiting for", () => {
  assert.equal(isTransientSendError(new Error("Resend is rate-limiting: too many requests")), true);
  assert.equal(isTransientSendError(new Error("Resend is unavailable (500): upstream")), true);
  assert.equal(isTransientSendError(new Error("Too Many Requests")), true);
  assert.equal(isTransientSendError(new Error("Resend refused the sending address")), false);
  assert.equal(isTransientSendError(new Error("to is not a valid email address")), false);
  assert.equal(isTransientSendError(null), false);
});

test("retryAfterFromError reads the property or the message, else nothing", () => {
  const withProp = new Error("Resend is rate-limiting");
  withProp.retryAfter = 12;
  assert.equal(retryAfterFromError(withProp), 12000);
  assert.equal(retryAfterFromError(new Error("Resend is rate-limiting: wait (retry after 3s)")), 3000);
  assert.equal(retryAfterFromError(new Error("Resend is rate-limiting")), null);
  assert.equal(retryAfterFromError(undefined), null);
});

test("backoff doubles from a second", () => {
  assert.deepEqual([1, 2, 3, 4].map(backoffMs), [1000, 2000, 4000, 8000]);
});

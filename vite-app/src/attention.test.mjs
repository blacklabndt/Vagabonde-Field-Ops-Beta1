// The reading of the records that Home's attention strip and the daily
// digest both act on. The cases that matter are the four things worth
// telling the office about, and — just as much — the ordinary morning
// where the answer has to be nothing at all.

import test from "node:test";
import assert from "node:assert/strict";
import { attentionItems, agoPhrase, ERRORS_WINDOW_MS, OVERDUE_GRACE_MS } from "./attention.js";

const NOW = Date.parse("2026-09-06T18:00:00Z");
const agoMs = ms => new Date(NOW - ms).toISOString();
const days = n => n * 86400000;
const hours = n => n * 3600000;

const keys = items => items.map(i => i.key);
const find = (items, key) => items.find(i => i.key === key);

test("an ordinary morning says nothing", () => {
  const state = {
    connected: true,
    connection_error: null,
    next_run_at: new Date(NOW + hours(8)).toISOString(),
    last_run: { kind: "backup", status: "complete", finished_at: agoMs(hours(16)) }
  };
  assert.deepEqual(attentionItems(state, [], NOW), []);
});

test("nothing read at all is nothing to say, not a crash", () => {
  assert.deepEqual(attentionItems(null, null, NOW), []);
  assert.deepEqual(attentionItems({}, [], NOW), []);
});

test("a backup that failed three days ago says so, with its reason", () => {
  const state = {
    connected: true,
    next_run_at: new Date(NOW + hours(2)).toISOString(),
    last_run: {
      kind: "backup", status: "failed", finished_at: agoMs(days(3)),
      error: "The drive is out of space."
    }
  };
  const items = attentionItems(state, [], NOW);
  assert.deepEqual(keys(items), ["failed-run"]);
  assert.equal(
    find(items, "failed-run").text,
    "Last backup failed 3 days ago — The drive is out of space."
  );
  assert.match(find(items, "failed-run").where, /Automatic backup/);
});

test("a failed restore is not called a backup", () => {
  const state = {
    connected: true,
    last_run: { kind: "restore_all", status: "failed", finished_at: agoMs(hours(2)) }
  };
  const items = attentionItems(state, [], NOW);
  assert.equal(find(items, "failed-run").text, "Last restore failed 2 hours ago");
});

test("a run that finished is not news", () => {
  const state = {
    connected: true,
    next_run_at: new Date(NOW + hours(2)).toISOString(),
    last_run: { kind: "backup", status: "complete", finished_at: agoMs(days(3)) }
  };
  assert.deepEqual(attentionItems(state, [], NOW), []);
});

test("a lapsed drive connection is the first thing said", () => {
  const state = {
    connected: true,
    connection_error: "Google refused the saved permission (invalid_grant).",
    next_run_at: agoMs(days(2)),
    last_run: { kind: "backup", status: "failed", finished_at: agoMs(days(2)) }
  };
  const items = attentionItems(state, [], NOW);
  assert.equal(items[0].key, "connection");
  assert.match(items[0].text, /needs reconnecting — Google refused/);
  assert.match(items[0].where, /connect the drive again/);
  // The overdue line is left off on purpose: the reconnect line above is
  // already the cause and the fix, and "press Back up now" cannot work
  // until the drive is back.
  assert.deepEqual(keys(items), ["connection", "failed-run"]);
});

test("a due date well in the past means nothing is picking the schedule up", () => {
  const state = {
    connected: true,
    connection_error: null,
    next_run_at: agoMs(days(2)),
    last_run: { kind: "backup", status: "complete", finished_at: agoMs(days(3)) }
  };
  const items = attentionItems(state, [], NOW);
  assert.deepEqual(keys(items), ["overdue"]);
  assert.equal(find(items, "overdue").text, "A backup was due 2 days ago and has not started");
});

test("a backup a little late is not late enough to say", () => {
  const state = { connected: true, next_run_at: agoMs(OVERDUE_GRACE_MS - hours(1)) };
  assert.deepEqual(attentionItems(state, [], NOW), []);
});

test("a drive that was never connected has no schedule to be late for", () => {
  const state = { connected: false, next_run_at: agoMs(days(5)) };
  assert.deepEqual(attentionItems(state, [], NOW), []);
});

test("background errors inside the day are counted and grouped by function", () => {
  const errors = [
    { function_name: "backup-run", created_at: agoMs(hours(1)) },
    { function_name: "chat-push", created_at: agoMs(hours(3)) },
    { function_name: "chat-push", created_at: agoMs(hours(4)) },
    { function_name: "chat-push", created_at: agoMs(hours(20)) }
  ];
  const items = attentionItems({}, errors, NOW);
  assert.deepEqual(keys(items), ["errors"]);
  assert.equal(
    find(items, "errors").text,
    "4 background errors since yesterday — chat-push (3), backup-run (1)"
  );
  assert.match(find(items, "errors").where, /Recent background errors/);
});

test("errors older than the day are left out, and one error is singular", () => {
  const errors = [
    { function_name: "chat-push", created_at: agoMs(hours(2)) },
    { function_name: "chat-push", created_at: agoMs(ERRORS_WINDOW_MS + hours(1)) },
    { function_name: "backup-run", created_at: agoMs(days(6)) }
  ];
  const items = attentionItems({}, errors, NOW);
  assert.equal(find(items, "errors").text, "1 background error since yesterday — chat-push (1)");
});

test("a row stamped a minute ahead of this device's clock still counts", () => {
  const errors = [{ function_name: "chat-push", created_at: new Date(NOW + 60000).toISOString() }];
  assert.equal(attentionItems({}, errors, NOW).length, 1);
});

test("agoPhrase reads like a person saying it", () => {
  assert.equal(agoPhrase(0), "less than an hour ago");
  assert.equal(agoPhrase(hours(1)), "1 hour ago");
  assert.equal(agoPhrase(hours(23)), "23 hours ago");
  assert.equal(agoPhrase(days(1)), "1 day ago");
  assert.equal(agoPhrase(days(9)), "9 days ago");
});

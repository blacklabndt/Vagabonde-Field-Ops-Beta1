// Tests for the batch timesheet approval runner.
//
//   node --test src/approvalRun.test.mjs
//
// What is being pinned down is what a pay period's worth of sign-offs does
// when one of them fails and when the admin presses Stop half way: that the
// order is the order, that one failure does not strand the rest, that Stop is
// answered between people rather than during one, and that the summary names
// whoever did not make it instead of counting them.

import test from "node:test";
import assert from "node:assert/strict";
import { runInOrder, approvalProgressLine, approvalRunSummary, NAME_LIST_LIMIT } from "./approvalRun.js";

const crew = names => names.map((name, i) => ({ profileId: "p" + i, name }));

test("runs every item in order, one at a time", async () => {
  const people = crew(["Ada", "Bob", "Cy"]);
  const seen = [];
  let inFlight = 0;
  const out = await runInOrder(people, async p => {
    inFlight++;
    assert.equal(inFlight, 1, "two approvals were in flight at once");
    await Promise.resolve();
    seen.push(p.name);
    inFlight--;
  });
  assert.deepEqual(seen, ["Ada", "Bob", "Cy"]);
  assert.deepEqual(out.done.map(p => p.name), ["Ada", "Bob", "Cy"]);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.notStarted, []);
  assert.equal(out.stopped, false);
});

test("one failure does not strand the rest, and is carried back with its error", async () => {
  const people = crew(["Ada", "Bob", "Cy"]);
  const out = await runInOrder(people, async p => {
    if (p.name === "Bob") throw new Error("upload refused");
  });
  assert.deepEqual(out.done.map(p => p.name), ["Ada", "Cy"]);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].item.name, "Bob");
  assert.equal(out.failed[0].error.message, "upload refused");
  assert.deepEqual(out.notStarted, []);
});

test("Stop finishes the one in hand and starts no more", async () => {
  const people = crew(["Ada", "Bob", "Cy", "Dee"]);
  let stop = false;
  const seen = [];
  const out = await runInOrder(people, async p => {
    seen.push(p.name);
    // Pressed while Bob's PDF is uploading: Bob still lands, Cy never starts.
    if (p.name === "Bob") stop = true;
  }, { shouldStop: () => stop });
  assert.deepEqual(seen, ["Ada", "Bob"]);
  assert.deepEqual(out.done.map(p => p.name), ["Ada", "Bob"]);
  assert.equal(out.stopped, true);
  assert.deepEqual(out.notStarted.map(p => p.name), ["Cy", "Dee"]);
});

test("Stop before the first one starts nothing", async () => {
  const people = crew(["Ada", "Bob"]);
  const out = await runInOrder(people, async () => { throw new Error("should not run"); }, { shouldStop: () => true });
  assert.deepEqual(out.done, []);
  assert.deepEqual(out.failed, []);
  assert.equal(out.stopped, true);
  assert.deepEqual(out.notStarted.map(p => p.name), ["Ada", "Bob"]);
});

test("an empty list is a run that did nothing, not an error", async () => {
  const out = await runInOrder([], async () => { throw new Error("should not run"); });
  assert.deepEqual(out, { done: [], failed: [], stopped: false, notStarted: [] });
});

test("onStart names who is being worked on, before the work", async () => {
  const people = crew(["Ada", "Bob"]);
  const lines = [];
  await runInOrder(people, async () => {}, {
    onStart: (n, total, p) => lines.push(approvalProgressLine(n, total, p.name))
  });
  assert.deepEqual(lines, ["1 of 2 · Ada…", "2 of 2 · Bob…"]);
});

test("a person with no name still reads as a person", () => {
  assert.equal(approvalProgressLine(1, 3, ""), "1 of 3 · Unnamed…");
});

test("the summary of a clean run is just the count", () => {
  const people = crew(["Ada", "Bob"]);
  assert.equal(
    approvalRunSummary({ done: people, total: 2 }),
    "Approved 2 of 2"
  );
});

test("the summary names failures rather than counting them", () => {
  const people = crew(["Ada", "Bob", "Cy"]);
  const line = approvalRunSummary({
    done: [people[0]],
    failed: [{ item: people[1], error: new Error("x") }, { item: people[2], error: new Error("y") }],
    total: 3
  });
  assert.match(line, /^Approved 1 of 3 · 2 not approved/);
  assert.match(line, /Bob, Cy$/);
});

test("a stopped run says how many were never started", () => {
  const people = crew(["Ada", "Bob", "Cy"]);
  const line = approvalRunSummary({
    done: [people[0]], notStarted: [people[1], people[2]], stopped: true, total: 3
  });
  assert.equal(line, "Approved 1 of 3 · stopped — 2 not started");
});

test("a long list of failures counts the tail instead of running off the line", () => {
  const people = crew(Array.from({ length: NAME_LIST_LIMIT + 3 }, (_, i) => "Person " + (i + 1)));
  const line = approvalRunSummary({
    failed: people.map(p => ({ item: p, error: new Error("x") })), total: people.length
  });
  assert.match(line, / and 3 more$/);
  assert.equal(line.includes("Person " + NAME_LIST_LIMIT), true);
  assert.equal(line.includes("Person " + (NAME_LIST_LIMIT + 1)), false);
});

test("the total defaults to everything the run knows about", () => {
  const people = crew(["Ada", "Bob", "Cy"]);
  const line = approvalRunSummary({
    done: [people[0]],
    failed: [{ item: people[1], error: new Error("x") }],
    notStarted: [people[2]],
    stopped: true
  });
  assert.match(line, /^Approved 1 of 3 /);
});

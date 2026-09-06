// What "Chase all unsigned" is about to do, before it does it.
//
// Run with: node --test src/chasePlan.test.mjs
//
// The three skips are the whole point of this module: each of them is an
// email that must NOT go out, and each has a different reason the office is
// shown in the confirm dialog. The tests below pin the order they are tested
// in as well as the buckets themselves — a ticket that is queried AND stale
// AND has no rep must be reported once, under the reason that matters.

import test from "node:test";
import assert from "node:assert/strict";
import { planChase, CHASE_RECENT_DAYS } from "./chasePlan.js";

// The tracker passes common.jsx's emailIn. This is the same rule, standing in
// for it here because a node test cannot load a JSX module.
const emailIn = s => { const m = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(s || ""); return m ? m[0] : ""; };
const plan = list => planChase(list, { emailIn });

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

test("a ticket with a rep and no history is due, with the address its link goes to", () => {
  const out = plan([{ id: "T-1", contactLabel: "Dana Reyes <dana@acme.ca>", chasedAt: null, queriedAt: null }]);
  assert.deepEqual(out.due, [{ id: "T-1", to: "dana@acme.ca" }]);
  assert.deepEqual([out.queried, out.recent, out.noEmail], [[], [], []]);
});

test("a rep with a question open is left alone, not chased", () => {
  const out = plan([{ id: "T-2", contactLabel: "dana@acme.ca", chasedAt: null, queriedAt: daysAgo(1) }]);
  assert.deepEqual(out.due, []);
  assert.deepEqual(out.queried, ["T-2"]);
});

test("chased inside the window is skipped; chased outside it is due again", () => {
  const out = plan([
    { id: "T-3", contactLabel: "dana@acme.ca", chasedAt: daysAgo(1), queriedAt: null },
    { id: "T-4", contactLabel: "dana@acme.ca", chasedAt: daysAgo(CHASE_RECENT_DAYS + 1), queriedAt: null }
  ]);
  assert.deepEqual(out.recent, ["T-3"]);
  assert.deepEqual(out.due.map(d => d.id), ["T-4"]);
});

test("a label with no address in it cannot be chased and is counted separately", () => {
  const out = plan([{ id: "T-5", contactLabel: "Site office, ask at the gate", chasedAt: null, queriedAt: null }]);
  assert.deepEqual(out.noEmail, ["T-5"]);
  assert.deepEqual(out.due, []);
});

test("a ticket with no contact at all is a no-email skip, not a crash", () => {
  const out = plan([{ id: "T-6", contactLabel: "", chasedAt: null, queriedAt: null }]);
  assert.deepEqual(out.noEmail, ["T-6"]);
});

test("the reasons are exclusive and tested in order: queried wins over recent and over no email", () => {
  const out = plan([{ id: "T-7", contactLabel: "no address here", chasedAt: daysAgo(0), queriedAt: daysAgo(1) }]);
  assert.deepEqual(out.queried, ["T-7"]);
  assert.deepEqual([out.recent, out.noEmail, out.due], [[], [], []]);
});

test("recent wins over no email — the ticket is not due either way", () => {
  const out = plan([{ id: "T-8", contactLabel: "no address here", chasedAt: daysAgo(1), queriedAt: null }]);
  assert.deepEqual(out.recent, ["T-8"]);
  assert.deepEqual(out.noEmail, []);
});

test("the due list keeps the order it was read in, because the dialog lists it", () => {
  const rows = ["T-30", "T-10", "T-20"].map(id => ({ id, contactLabel: `${id}@acme.ca`, chasedAt: null, queriedAt: null }));
  assert.deepEqual(plan(rows).due.map(d => d.id), ["T-30", "T-10", "T-20"]);
});

test("nothing unsigned means four empty buckets, not a thrown dialog", () => {
  for (const empty of [[], null, undefined]) {
    const out = plan(empty);
    assert.deepEqual(out, { due: [], queried: [], recent: [], noEmail: [] });
  }
});

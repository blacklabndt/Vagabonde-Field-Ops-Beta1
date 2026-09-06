// Tests for the hash routes — the pair of functions that decide what the
// address bar says and what the app does with what it finds there.
//
// Run with: node --test src/route.test.mjs
//
// What is worth guarding here is mostly what must NOT be read as a route.
// The app shares its hash with Supabase Auth: a password-reset link lands as
// `#access_token=…&type=recovery`, and a refused one as `#error=…`. Reading
// either as a screen would put somebody on the wrong page at the exact moment
// they are trying to get back into their account. The other half is the house
// rule from CLAUDE.md — a contextual screen (job, jha, upload, ticket) only
// opens with its job — which is a rule about URLs too, now that a URL can ask
// for one.

import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute, formatRoute, landingRoute, historyStep } from "./route.js";
import { TABS, CONTEXT_TABS } from "./data.js";

test("a plain section is its own address, both ways", () => {
  assert.deepEqual(parseRoute("#/board"), { screen: "board", job: null });
  assert.deepEqual(parseRoute("#/chat"), { screen: "chat", job: null });
  assert.equal(formatRoute({ screen: "board" }), "#/board");
  assert.equal(formatRoute({ screen: "timesheets" }), "#/timesheets");
});

test("every section in the menu round-trips", () => {
  for (const t of TABS) {
    if (CONTEXT_TABS.includes(t.key)) continue;
    const url = formatRoute({ screen: t.key });
    assert.equal(parseRoute(url).screen, t.key, `${t.key} did not survive the round trip`);
  }
});

test("a job is named in the address and comes back whole", () => {
  assert.deepEqual(parseRoute("#/job/S-10113"), { screen: "job", job: "S-10113" });
  assert.equal(formatRoute({ screen: "job", job: "S-10113" }), "#/job/S-10113");
});

test("a job number is escaped, because job numbers are freeform", () => {
  // They are typed by people and are not required to look like S-10113 —
  // a space or a slash in one must not become part of the route's grammar.
  const url = formatRoute({ screen: "job", job: "A/B 12" });
  assert.equal(url, "#/job/A%2FB%2012");
  assert.deepEqual(parseRoute(url), { screen: "job", job: "A/B 12" });
});

test("the screens that hang off a job carry it with them", () => {
  assert.deepEqual(parseRoute("#/job/S-10113/ticket"), { screen: "ticket", job: "S-10113" });
  assert.equal(formatRoute({ screen: "jha", job: "S-10113" }), "#/job/S-10113/jha");
});

test("a contextual screen with no job has no address at all", () => {
  // That state is the "No job selected — pick one from Home" panel, which is
  // a thing the app is showing rather than somewhere it is standing.
  for (const key of CONTEXT_TABS) assert.equal(formatRoute({ screen: key }), null);
});

test("a contextual screen cannot be asked for on its own", () => {
  assert.equal(parseRoute("#/ticket"), null);
  assert.equal(parseRoute("#/jha"), null);
  assert.equal(parseRoute("#/job"), null, "a job screen with no job is not a place");
});

test("Auth's own hashes are not routes", () => {
  // The whole reason the app's routes start with a slash.
  assert.equal(parseRoute("#access_token=abc&type=recovery"), null);
  assert.equal(parseRoute("#error=access_denied&error_code=otp_expired"), null);
  assert.equal(parseRoute("#type=recovery"), null);
});

test("nothing, nonsense and a broken escape are all no route", () => {
  assert.equal(parseRoute(""), null);
  assert.equal(parseRoute("#"), null);
  assert.equal(parseRoute("#/"), null);
  assert.equal(parseRoute(undefined), null);
  assert.equal(parseRoute("#/nowhere"), null);
  assert.equal(parseRoute("#/board/extra"), null);
  assert.equal(parseRoute("#/job/S-1/ticket/more"), null);
  assert.equal(parseRoute("#/job/%E0%A4%A"), null, "a stray percent sign is not a crash");
  assert.equal(formatRoute({ screen: "nowhere" }), null);
  assert.equal(formatRoute({}), null);
});

test("a cold load can open a job, and stops there", () => {
  // A ticket is half-entered work living in the editor: the address says
  // which job, never which draft. So the deep link lands on the job's page,
  // where the ticket is opened from anyway.
  assert.deepEqual(landingRoute(parseRoute("#/job/S-10113")), { screen: "job", job: "S-10113" });
  assert.deepEqual(landingRoute(parseRoute("#/job/S-10113/ticket")), { screen: "job", job: "S-10113" });
  assert.deepEqual(landingRoute(parseRoute("#/job/S-10113/jha")), { screen: "job", job: "S-10113" });
  assert.deepEqual(landingRoute(parseRoute("#/job/S-10113/upload")), { screen: "job", job: "S-10113" });
});

test("a plain section lands as itself, and nothing lands as nothing", () => {
  assert.deepEqual(landingRoute(parseRoute("#/contacts")), { screen: "contacts", job: null });
  assert.equal(landingRoute(null), null);
});

test("a job and its own screens share one history entry", () => {
  const job = { screen: "job", job: "S-1" };
  assert.equal(historyStep(job, { screen: "ticket", job: "S-1" }), "replace");
  assert.equal(historyStep({ screen: "ticket", job: "S-1" }, { screen: "jha", job: "S-1" }), "replace");
  assert.equal(historyStep({ screen: "ticket", job: "S-1" }, job), "replace");
  assert.equal(historyStep({ screen: "board", job: null }, job), "push");
  assert.equal(historyStep(job, { screen: "job", job: "S-2" }), "push");
  assert.equal(historyStep(job, { screen: "chat", job: null }), "push");
  assert.equal(historyStep(null, job), "push");
});

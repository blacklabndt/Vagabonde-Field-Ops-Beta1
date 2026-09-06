// Tests for the "Half-entered on this device" strip's reading half.
//
// Run with: node --test src/wipDrafts.test.mjs
//
// The thing under test is a naming convention two other screens own: the
// ticket editor keys its recovery copy by the draft it is editing OR by the
// job when the ticket is new, and the JHA builder always keys by the job.
// Get that wrong and the strip either points at the wrong job or quietly
// drops a copy — which is the state the strip exists to end.

import test from "node:test";
import assert from "node:assert/strict";
import { parseWipKey, looksLikeJobDbId, jobDbIdsOf, buildWipRows, wipJobLabel, wipWhen } from "./wipDrafts.js";

const JOB_A = "6f1a2b3c-4d5e-4f60-8a91-b2c3d4e5f607";
const JOB_B = "11112222-3333-4444-5555-666677778888";

test("a ticket copy keyed by a job is a job, keyed by a ticket is a ticket", () => {
  assert.deepEqual(parseWipKey("ticket.wip." + JOB_A),
    { key: "ticket.wip." + JOB_A, kind: "ticket", jobDbId: JOB_A, ticketId: null });
  assert.deepEqual(parseWipKey("ticket.wip.KK-0905-01"),
    { key: "ticket.wip.KK-0905-01", kind: "ticket", jobDbId: null, ticketId: "KK-0905-01" });
});

test("an assessment copy is always its job's, whatever the suffix looks like", () => {
  const parsed = parseWipKey("jha.wip." + JOB_B);
  assert.equal(parsed.kind, "jha");
  assert.equal(parsed.jobDbId, JOB_B);
  assert.equal(parsed.ticketId, null);
});

test("keys that are not recovery copies are not rows", () => {
  for (const k of ["job." + JOB_A, "jha.last." + JOB_A, "cache.owner", "", null, undefined, 7]) {
    assert.equal(parseWipKey(k), null, `${k} is not a half-entered copy`);
  }
});

test("a key built from a job with no id is not offered as a job to open", () => {
  // The editors build their key by interpolation, so this is what a job that
  // arrived without a dbId would leave behind. A row for it would offer to
  // open nothing.
  assert.equal(parseWipKey("ticket.wip.undefined"), null);
  assert.equal(parseWipKey("jha.wip.null"), null);
  assert.equal(parseWipKey("ticket.wip."), null);
});

test("a ticket id is never mistaken for a job id", () => {
  assert.ok(looksLikeJobDbId(JOB_A));
  assert.ok(!looksLikeJobDbId("KK-0905-01"));
  assert.ok(!looksLikeJobDbId("S-12105"));
  assert.ok(!looksLikeJobDbId(""));
});

test("each job is looked up once however many copies name it", () => {
  const entries = [
    { key: "ticket.wip." + JOB_A, at: 3 },
    { key: "jha.wip." + JOB_A, at: 2 },
    { key: "jha.wip." + JOB_B, at: 1 },
    { key: "ticket.wip.KK-0905-01", at: 4 },
    { key: "contacts", at: 5 }
  ];
  assert.deepEqual(jobDbIdsOf(entries), [JOB_A, JOB_B]);
});

test("rows name the job through the job record, newest copy first", () => {
  const jobs = {
    [JOB_A]: { dbId: JOB_A, id: "S-12105", project: "Mainline tie-in", client: "Northgate" },
    [JOB_B]: { dbId: JOB_B, id: "S-12220", project: "Compressor station", client: "Peace Energy" }
  };
  const rows = buildWipRows([
    { key: "jha.wip." + JOB_B, at: 100 },
    { key: "ticket.wip." + JOB_A, at: 900 }
  ], { jobs });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].what, "Billing ticket");
  assert.equal(rows[0].jobNumber, "S-12105");
  assert.equal(rows[0].project, "Mainline tie-in");
  assert.equal(rows[0].jobRecord, jobs[JOB_A]);
  assert.equal(rows[1].what, "Hazard assessment");
  assert.equal(rows[1].jobNumber, "S-12220");
});

test("a copy keyed by a reopened draft takes its job from the drafts already on screen", () => {
  const tickets = [{ id: "KK-0905-01", job: "S-12105", project: "Mainline tie-in", client: "Northgate", status: "Draft" }];
  const [row] = buildWipRows([{ key: "ticket.wip.KK-0905-01", at: 5 }], { tickets });
  assert.equal(row.jobNumber, "S-12105");
  assert.equal(row.project, "Mainline tie-in");
  assert.equal(row.ticketId, "KK-0905-01");
  // No job record, so the screen has nothing to open the job by but its
  // number — which is the door openJobByNumber exists for.
  assert.equal(row.jobRecord, null);
});

test("a copy nothing can name is still listed, under what is known of it", () => {
  const [byJob] = buildWipRows([{ key: "jha.wip." + JOB_A, at: 5 }], {});
  assert.equal(byJob.jobNumber, "");
  assert.equal(wipJobLabel(byJob), `job ${JOB_A}`);
  const [byTicket] = buildWipRows([{ key: "ticket.wip.KK-0905-01", at: 5 }], {});
  assert.equal(wipJobLabel(byTicket), "ticket KK-0905-01");
});

test("an undated copy sorts last rather than to the top", () => {
  const rows = buildWipRows([
    { key: "jha.wip." + JOB_A, at: null },
    { key: "ticket.wip." + JOB_B, at: 10 }
  ], {});
  assert.equal(rows[0].jobDbId, JOB_B);
  assert.equal(rows[1].at, null);
});

test("when it was kept reads as today, yesterday, or a date", () => {
  const now = new Date(2026, 8, 5, 16, 30).getTime();
  assert.match(wipWhen(new Date(2026, 8, 5, 14, 32).getTime(), now), /^kept today at /);
  assert.match(wipWhen(new Date(2026, 8, 4, 8, 12).getTime(), now), /^kept yesterday at /);
  assert.match(wipWhen(new Date(2026, 7, 30, 8, 12).getTime(), now), /^kept Aug 30 at /);
  // A record with no stamp still gets a sentence rather than "Invalid Date".
  assert.equal(wipWhen(null, now), "kept on this device");
});

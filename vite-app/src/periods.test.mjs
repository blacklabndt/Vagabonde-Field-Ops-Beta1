// The dose ledger's periods and the tracker's "chased recently" rule.
import test from "node:test";
import assert from "node:assert/strict";
import { recentQuarters, recentYears, quarterOf, withinDays } from "./data.js";

test("quarters run backwards from the current one, on calendar boundaries", () => {
  const qs = recentQuarters(5, new Date(2026, 8, 3)); // 3 September 2026 is in Q3
  assert.equal(qs[0].label, "Q3 2026");
  assert.equal(qs[0].start, "2026-07-01");
  assert.equal(qs[0].end, "2026-09-30");
  assert.equal(qs[1].label, "Q2 2026");
  assert.equal(qs[1].end, "2026-06-30");
  assert.equal(qs[3].label, "Q4 2025");
  assert.equal(qs[3].end, "2025-12-31");
  assert.equal(qs[4].start, "2025-07-01");
  assert.ok(qs.every(q => q.kind === "quarter"));
});

test("years are calendar years, newest first", () => {
  const ys = recentYears(3, new Date(2026, 0, 15));
  assert.deepEqual(ys.map(y => y.label), ["2026", "2025", "2024"]);
  assert.equal(ys[0].start, "2026-01-01");
  assert.equal(ys[0].end, "2026-12-31");
  assert.equal(ys[2].end, "2024-12-31");
});

test("a work date knows its quarter", () => {
  assert.equal(quarterOf("2026-01-31"), 1);
  assert.equal(quarterOf("2026-03-31"), 1);
  assert.equal(quarterOf("2026-04-01"), 2);
  assert.equal(quarterOf("2026-09-03"), 3);
  assert.equal(quarterOf("2026-12-25"), 4);
});

test("chased in the last three days counts as chased", () => {
  const ago = days => new Date(Date.now() - days * 86400000).toISOString();
  assert.equal(withinDays(ago(2), 3), true);
  assert.equal(withinDays(ago(4), 3), false);
  assert.equal(withinDays(null, 3), false);
  assert.equal(withinDays("not a date", 3), false);
});

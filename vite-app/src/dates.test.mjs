// Tests for the date arithmetic every ticket and every timesheet depends on.
//
// Run with: node --test src/dates.test.mjs
//
// These are the calculations that decide which day a ticket is filed under and
// which fortnight somebody is paid for. They are pure, they are small, and
// until now they had no coverage at all — the risk is not that they are
// obviously broken, it is that a later tidy-up quietly moves a boundary and
// nothing says so. The semi-monthly split in particular has four edge cases
// (the 15th/16th boundary, month rollover, year rollover, February) that no
// amount of clicking around the app would reliably exercise.

import test from "node:test";
import assert from "node:assert/strict";
import {
  localDate, dayMonth, ticketDateStamp, initialsOf,
  payPeriodLabel, recentPayPeriods, hours, ageInDays,
  GST_RATE, gstOn
} from "./data.js";

// ── localDate ────────────────────────────────────────────────────────────
// Parses YYYY-MM-DD as local midday. Midday matters: at midnight, a DST
// transition can land the value on the neighbouring day.

test("localDate reads a plain date as local, not UTC", () => {
  const d = localDate("2026-08-15");
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7);      // August
  assert.equal(d.getDate(), 15);
});

test("localDate sits at midday so a DST shift cannot move the day", () => {
  // Canada springs forward on the second Sunday in March.
  for (const s of ["2026-03-08", "2026-11-01", "2026-01-01", "2026-12-31"]) {
    const d = localDate(s);
    assert.equal(d.getHours(), 12, `${s} should parse at midday`);
    assert.equal(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      s,
      `${s} must come back as the same calendar day`
    );
  }
});

test("localDate on rubbish gives an invalid date rather than a wrong one", () => {
  assert.ok(Number.isNaN(+localDate("")));
  assert.ok(Number.isNaN(+localDate(null)));
  assert.ok(Number.isNaN(+localDate("not-a-date")));
});

// ── ticketDateStamp ──────────────────────────────────────────────────────

test("ticketDateStamp is MMDD-YY and pads", () => {
  assert.equal(ticketDateStamp(new Date(2026, 7, 15, 12)), "0815-26");
  assert.equal(ticketDateStamp(new Date(2026, 0, 1, 12)), "0101-26");
  assert.equal(ticketDateStamp(new Date(2026, 11, 31, 12)), "1231-26");
});

test("dayMonth is a padded day and a short month, no full stop", () => {
  assert.equal(dayMonth(new Date(2026, 7, 5, 12)), "05 Aug");
  assert.equal(dayMonth(new Date(2026, 11, 25, 12)), "25 Dec");
  assert.ok(!dayMonth(new Date(2026, 8, 1, 12)).includes("."));
});

// ── initialsOf ───────────────────────────────────────────────────────────
// Feeds the ticket number, and next_ticket_number now rejects anything that
// is not one to four letters — so this must never emit punctuation or digits.

test("initialsOf gives letters only, capped at three", () => {
  assert.equal(initialsOf("Kyle Keith"), "KK");
  assert.equal(initialsOf("Mark Cline"), "MC");
  assert.equal(initialsOf("Jean-Luc Picard"), "JP");
  assert.equal(initialsOf("a b c d e"), "ABC");
  assert.equal(initialsOf("Dave  Chapman"), "DC");
});

test("initialsOf survives names the ticket number would otherwise choke on", () => {
  for (const name of ["O'Brien", "Smith & Sons", "李 Wang", "%", "3M Ltd", ""]) {
    const out = initialsOf(name);
    assert.ok(/^[A-Z]{0,3}$/.test(out), `${JSON.stringify(name)} produced ${JSON.stringify(out)}`);
  }
});

// ── pay periods ──────────────────────────────────────────────────────────
// Semi-monthly: the 1st–15th, then the 16th to the end of the month.

const first = (from) => recentPayPeriods(1, from)[0];

test("the 15th is the last day of the first half", () => {
  assert.deepEqual(first(new Date(2026, 7, 15, 12)), { start: "2026-08-01", end: "2026-08-15" });
});

test("the 16th starts the second half", () => {
  assert.deepEqual(first(new Date(2026, 7, 16, 12)), { start: "2026-08-16", end: "2026-08-31" });
});

test("the second half ends on the real last day of the month", () => {
  assert.equal(first(new Date(2026, 8, 20, 12)).end, "2026-09-30", "September has 30 days");
  assert.equal(first(new Date(2026, 1, 20, 12)).end, "2026-02-28", "February 2026 has 28");
  assert.equal(first(new Date(2028, 1, 20, 12)).end, "2028-02-29", "February 2028 is a leap year");
});

test("periods walk backwards without skipping or repeating", () => {
  const list = recentPayPeriods(6, new Date(2026, 0, 3, 12)); // early January
  assert.deepEqual(list, [
    { start: "2026-01-01", end: "2026-01-15" },
    { start: "2025-12-16", end: "2025-12-31" },
    { start: "2025-12-01", end: "2025-12-15" },
    { start: "2025-11-16", end: "2025-11-30" },
    { start: "2025-11-01", end: "2025-11-15" },
    { start: "2025-10-16", end: "2025-10-31" }
  ], "must roll back across the new year without a gap");
});

test("every period is contiguous with the one before it", () => {
  const list = recentPayPeriods(24, new Date(2026, 6, 20, 12));
  for (let i = 0; i < list.length - 1; i++) {
    const olderEnd = localDate(list[i + 1].end);
    const newerStart = localDate(list[i].start);
    const gapDays = Math.round((newerStart - olderEnd) / 86400000);
    assert.equal(gapDays, 1, `${list[i + 1].end} -> ${list[i].start} should be one day apart`);
  }
});

test("no period is ever empty or inverted", () => {
  const list = recentPayPeriods(30, new Date(2026, 1, 28, 12));
  for (const p of list) {
    assert.ok(localDate(p.start) <= localDate(p.end), `${p.start}..${p.end} is inverted`);
  }
});

test("payPeriodLabel reads as a date range with the year once", () => {
  assert.equal(payPeriodLabel({ start: "2026-08-01", end: "2026-08-15" }), "01 Aug – 15 Aug 2026");
  assert.equal(payPeriodLabel({ start: "2026-02-16", end: "2026-02-28" }), "16 Feb – 28 Feb 2026");
});

// ── hours ────────────────────────────────────────────────────────────────

test("hours always shows two decimals", () => {
  assert.equal(hours(8), "8.00");
  assert.equal(hours(7.5), "7.50");
  assert.equal(hours(0), "0.00");
  assert.equal(hours(0.25), "0.25");
  assert.equal(hours("3.256"), "3.26");
  // Not asserted: an exact half at the third decimal (1.005) rounds down
  // here, because 1.005 * 100 is 100.49999999999999 in binary floating
  // point. Hours are entered in quarter- and half-hour steps, so no real
  // entry reaches a third decimal — unlike GST, where the same arithmetic
  // did cost a cent and is tested below.
});

test("hours treats nonsense as zero rather than NaN on a timesheet", () => {
  assert.equal(hours(undefined), "0.00");
  assert.equal(hours(null), "0.00");
  assert.equal(hours("abc"), "0.00");
});

// ── ageInDays ────────────────────────────────────────────────────────────
// Drives the "over 7 days" flag on the billing tracker, so it must count
// calendar days rather than 24-hour blocks.

test("ageInDays counts from local midnight, not elapsed hours", () => {
  const now = new Date();
  const lateYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 30);
  assert.equal(ageInDays(lateYesterday.toISOString()), 1,
    "half an hour ago across midnight is still one day old");
  const earlyToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 5);
  assert.equal(ageInDays(earlyToday.toISOString()), 0);
});

test("ageInDays is zero for nothing rather than NaN", () => {
  assert.equal(ageInDays(null), 0);
  assert.equal(ageInDays(""), 0);
  assert.equal(ageInDays("not a date"), 0);
});

// ── GST ──────────────────────────────────────────────────────────────────
// Three copies of this arithmetic exist — data.js (the app), invoice.ts (the
// client's page and its emailed copy) and send-ticket-approval (the covering
// note). They quote the same client the same bill, so they have to agree to
// the cent.

test("GST is five percent", () => {
  assert.equal(GST_RATE, 0.05);
});

test("GST rounds a half-cent up, not down", () => {
  // Each of these lands exactly on a half-cent and used to come out a cent
  // low, because the multiply was done in dollars.
  assert.equal(gstOn(0.70), 0.04);
  assert.equal(gstOn(2.90), 0.15);
  assert.equal(gstOn(20.70), 1.04);
  assert.equal(gstOn(42.30), 2.12);
});

test("GST on ordinary amounts is exact", () => {
  assert.equal(gstOn(0), 0);
  assert.equal(gstOn(100), 5);
  assert.equal(gstOn(1299), 64.95);
  assert.equal(gstOn(2490), 124.5);
  assert.equal(gstOn(2316), 115.8);
});

test("no whole-cent subtotal is ever mis-rounded", () => {
  // The property the four cases above are examples of: for every subtotal in
  // whole cents, GST must equal the subtotal's cents times the rate, rounded
  // half-up. This is what catches a future "simplification" back to dollars.
  let wrong = 0;
  for (let c = 1; c <= 200000; c++) {
    const subtotal = c / 100;
    const expected = Math.round(c * GST_RATE) / 100;
    if (Math.abs(gstOn(subtotal) - expected) > 1e-9) wrong++;
  }
  assert.equal(wrong, 0, `${wrong} subtotals round the wrong way`);
});

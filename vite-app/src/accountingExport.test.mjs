// The two Billing tracker exports, as rows.
//
// Run with: node --test src/accountingExport.test.mjs
//
// The money is the whole reason the columns exist, so the rounding is pinned
// against data.js's own gstOn rather than against a handful of expected
// numbers: the CSV and the client's printed invoice must quote the same tax to
// the cent or the office is reconciling two different bills.

import test from "node:test";
import assert from "node:assert/strict";
import { gstOn, lineTotal } from "./data.js";
import {
  gstCentsOn, ticketMoney, ticketExportRows, lineExportRows,
  TICKET_COLUMNS, LINE_COLUMNS
} from "./accountingExport.js";

// common.jsx's csvCell, restated here because a node test cannot load a JSX
// module. It is the tracker's downloadCsv that quotes cells, not this module —
// these tests use it to show that a label handed over verbatim survives the
// trip, and that nothing in the module needs to pre-escape anything.
const csvCell = v => {
  const s = String(v == null ? "" : v);
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

const ticket = extra => ({
  id: "T-1", client: "Acme Pipeline", job: "J-100", project: "Line 4 tie-in",
  workDate: "2026-03-14", date: "14 Mar", status: "Invoiced", amount: 100,
  invoicedAt: "2026-03-20T18:00:00.000Z", ...extra
});

// The header block is three or four lines of caption before the columns; the
// tickets start after it.
const bodyOf = rows => rows.slice(rows.findIndex(r => r[0] === "Client") + 1);
const linesOf = rows => rows.slice(rows.findIndex(r => r[0] === "Ticket" && r.length > 2) + 1);
const col = (row, columns, name) => row[columns.indexOf(name)];

test("the half cent rounds up, not down — $0.70 at 5% is $0.04", () => {
  // The whole reason the cents live in this module: 0.70 * 0.05 * 100 is
  // 3.4999999999999996 in binary, and rounding that gives the client three
  // cents of GST on a seventy-cent charge.
  assert.equal(gstCentsOn(70, 5), 4);
  const row = bodyOf(ticketExportRows([ticket({ amount: 0.7 })]))[0];
  assert.equal(col(row, TICKET_COLUMNS, "Subtotal"), "0.70");
  assert.equal(col(row, TICKET_COLUMNS, "GST"), "0.04");
  assert.equal(col(row, TICKET_COLUMNS, "Total"), "0.74");
});

test("the cents agree with data.js gstOn at every whole cent under $5,000", () => {
  // A sweep rather than a sample, because the class of failure is a handful of
  // subtotals scattered through the range — $0.70, $2.90, $20.70, $42.30 — and
  // any sample small enough to read misses them.
  for (let cents = 1; cents <= 500000; cents++) {
    const dollars = cents / 100;
    assert.equal(gstCentsOn(cents, 5) / 100, gstOn(dollars, 5),
      `GST disagreed with gstOn at $${dollars.toFixed(2)}`);
  }
});

test("an exempt client is charged nothing, and the total is the subtotal", () => {
  const money = ticketMoney({ amount: 1234.56, gst_rate: 0 });
  assert.deepEqual(money, { subtotal: 123456, gst: 0, total: 123456 });
  const row = bodyOf(ticketExportRows([ticket({ amount: 1234.56, gstRate: 0 })]))[0];
  assert.equal(col(row, TICKET_COLUMNS, "GST"), "0.00");
  assert.equal(col(row, TICKET_COLUMNS, "Total"), "1234.56");
});

test("a rate the row does not carry is the ordinary 5%, never exempt", () => {
  // Guessing exempt is the guess that undercharges, so an older row — one from
  // a backup, or a database the per-client rate has not reached — is billed
  // the way it always was.
  assert.deepEqual(ticketMoney({ amount: 100 }), { subtotal: 10000, gst: 500, total: 10500 });
  assert.equal(ticketMoney({ amount: 100, gst_rate: null }).gst, 500);
  assert.equal(ticketMoney({ amount: 100, gst_rate: "" }).gst, 500);
});

test("a client rate that is neither camel nor snake case is still read", () => {
  assert.equal(ticketMoney({ amount: 100, gstRate: 12 }).gst, 1200);
  assert.equal(ticketMoney({ amount: 100, gst_rate: 12 }).gst, 1200);
});

test("null money is three blank cells, not a row of zeros", () => {
  // search_tickets hands a role that may not see prices a null total. "0.00"
  // against real work is a figure somebody would reconcile against.
  const money = ticketMoney({ amount: null });
  assert.deepEqual(money, { subtotal: null, gst: null, total: null });
  const row = bodyOf(ticketExportRows([ticket({ amount: null })]))[0];
  assert.equal(col(row, TICKET_COLUMNS, "Subtotal"), "");
  assert.equal(col(row, TICKET_COLUMNS, "GST"), "");
  assert.equal(col(row, TICKET_COLUMNS, "Total"), "");
});

test("commas, quotes and newlines in a label reach the CSV helper unaltered", () => {
  const client = 'Smith, Jones & "Co"';
  const label = 'RT weld, 6"\nsecond pass';
  const rows = lineExportRows([ticket({ client })], {
    lines: { "T-1": [{ kind: "weld", label, unit: "each", quantity: 2, unit_rate: 12.5 }] }
  });
  const row = linesOf(rows)[0];
  // Verbatim in the row — this module escapes nothing, because downloadCsv's
  // csvCell is the one place that knows how a CSV is quoted.
  assert.equal(col(row, LINE_COLUMNS, "Client"), client);
  assert.equal(col(row, LINE_COLUMNS, "Line"), label);
  // And the helper's own rule turns them into one field each, with the inner
  // quotes doubled and the newline living inside the quoted cell.
  assert.equal(csvCell(client), '"Smith, Jones & ""Co"""');
  assert.equal(csvCell(label), '"RT weld, 6""\nsecond pass"');
});

test("the ticket export carries the invoice number and the day it was invoiced", () => {
  const rows = ticketExportRows([ticket({})], {
    caption: "Status: Invoiced", exportedOn: "2026-03-31",
    invoices: { "T-1": { number: "INV-0042", invoicedAt: "2026-03-21T00:00:00.000Z" } }
  });
  assert.equal(rows[0][0], "Status: Invoiced");
  assert.equal(rows[1][0], "Exported 2026-03-31 · 1 ticket");
  const row = bodyOf(rows)[0];
  assert.equal(col(row, TICKET_COLUMNS, "Invoice number"), "INV-0042");
  // The batched read's own date wins over the tracker row's, since it is the
  // one read in the same breath as the number.
  assert.equal(col(row, TICKET_COLUMNS, "Invoiced on"), "2026-03-21");
  assert.equal(col(row, TICKET_COLUMNS, "Work date"), "2026-03-14");
});

test("a database with no invoice_number column says so instead of leaving a silent blank", () => {
  const rows = ticketExportRows([ticket({})], { invoiceNumbers: false });
  assert.ok(rows.some(r => /Invoice numbers are not on this database yet/.test(r[0] || "")));
  assert.equal(col(bodyOf(rows)[0], TICKET_COLUMNS, "Invoice number"), "");
});

test("a client id the row does not carry is blank, never invented", () => {
  assert.equal(col(bodyOf(ticketExportRows([ticket({})]))[0], TICKET_COLUMNS, "Client id"), "");
  assert.equal(col(bodyOf(ticketExportRows([ticket({ clientId: "c-9" })]))[0], TICKET_COLUMNS, "Client id"), "c-9");
});

test("lines come out in the export's ticket order, each ticket's own order kept", () => {
  const tickets = [ticket({ id: "T-2" }), ticket({ id: "T-1" })];
  const rows = lineExportRows(tickets, {
    lines: {
      "T-1": [{ kind: "weld", label: "First", quantity: 1, unit_rate: 1 }],
      "T-2": [{ kind: "charge", label: "A", quantity: 1, unit_rate: 1 },
              { kind: "charge", label: "B", quantity: 1, unit_rate: 1 }]
    }
  });
  assert.deepEqual(linesOf(rows).map(r => [col(r, LINE_COLUMNS, "Ticket"), col(r, LINE_COLUMNS, "Line")]),
    [["T-2", "A"], ["T-2", "B"], ["T-1", "First"]]);
});

test("a line's total is quantity times rate, rounded the way the invoice rounds it", () => {
  const rows = lineExportRows([ticket({})], {
    lines: { "T-1": [{ kind: "weld", label: "Half hour", unit: "hour", quantity: 0.5, unit_rate: 9.25 }] }
  });
  const row = linesOf(rows)[0];
  assert.equal(col(row, LINE_COLUMNS, "Quantity"), "0.5");
  assert.equal(col(row, LINE_COLUMNS, "Rate"), "9.25");
  // 4.625 to the cent — the same round() the database's total trigger applies.
  assert.equal(col(row, LINE_COLUMNS, "Line total"), (lineTotal(0.5, 9.25)).toFixed(2));
  assert.equal(col(row, LINE_COLUMNS, "Line total"), "4.63");
});

test("a ticket with no lines is left out of the line export and counted out of it", () => {
  const rows = lineExportRows([ticket({ id: "T-1" }), ticket({ id: "T-2" })], {
    exportedOn: "2026-03-31",
    lines: { "T-1": [{ kind: "weld", label: "One", quantity: 1, unit_rate: 2 }] }
  });
  assert.equal(rows[1][0], "Exported 2026-03-31 · 1 line on 1 of 2 tickets");
  assert.equal(linesOf(rows).length, 1);
});

test("the line export says in the file that it carries no GST", () => {
  const rows = lineExportRows([], {});
  assert.ok(rows.some(r => /no GST on a line/.test(r[0] || "")));
});

test("an empty export is still a file with its caption and columns", () => {
  const rows = ticketExportRows([], { caption: "Status: Draft", exportedOn: "2026-03-31" });
  assert.equal(rows[1][0], "Exported 2026-03-31 · 0 tickets");
  assert.deepEqual(bodyOf(rows), []);
  assert.deepEqual(rows[rows.length - 1], TICKET_COLUMNS);
});

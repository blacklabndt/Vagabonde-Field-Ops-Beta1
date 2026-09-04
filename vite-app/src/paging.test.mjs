// Tests for the two ways the app asks for "all of them".
//
// Run with: node --test src/paging.test.mjs
//
// The rule under test is invisible by definition: a row that a read skipped
// looks exactly like a row that was never there. A timesheet short by one
// crew entry is somebody's afternoon, and nothing on the screen says so —
// which is why the pager that people are paid from is the one pinned here.

import test from "node:test";
import assert from "node:assert/strict";
import { fetchAllPages, fetchAllKeyset, RESPONSE_ROW_CAP } from "./paging.js";

// A source of `n` rows with ids 1..n, deletable mid-walk. Offset reads slice
// the live array (which is what the database does); keyset reads take the
// first `cap` rows whose id is greater than the cursor. `cap` is the API's
// max-rows setting — 1000 unless a test lowers it, which is the thing the
// walk must not mistake for the end of the rows.
function source(n, cap = RESPONSE_ROW_CAP) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  return {
    rows,
    remove(id) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1); },
    // The offset read, shaped exactly like db.js's: the walk says which block
    // and how big a block is, the query asks for that span, and the API hands
    // back no more than `cap` of it however much was asked for.
    page(p, size) {
      const from = p * size;
      return { rows: rows.slice(from, from + Math.min(size, cap)), total: rows.length };
    },
    after(key) {
      const start = key == null ? 0 : rows.findIndex(r => r.id > key);
      if (start < 0) return [];
      return rows.slice(start, start + cap);
    }
  };
}

test("keyset paging walks every row of a multi-page read", async () => {
  const s = source(RESPONSE_ROW_CAP * 2 + 7);
  const all = await fetchAllKeyset(key => s.after(key));
  assert.equal(all.length, RESPONSE_ROW_CAP * 2 + 7);
  assert.deepEqual(all.map(r => r.id).slice(0, 3), [1, 2, 3]);
  assert.equal(all[all.length - 1].id, RESPONSE_ROW_CAP * 2 + 7);
});

test("keyset paging keeps every surviving row when one is deleted mid-walk", async () => {
  // Two full pages plus a tail. A row on the second page is deleted after the
  // first page comes back — exactly what an admin cancelling a ticket while
  // an export runs does.
  const s = source(RESPONSE_ROW_CAP * 2 + 5);
  let seen = 0;
  const all = await fetchAllKeyset(key => {
    if (seen === 1) s.remove(RESPONSE_ROW_CAP + 500);
    seen++;
    return s.after(key);
  });
  const ids = new Set(all.map(r => r.id));
  // Every row still on file came back. The deleted one is allowed to be
  // absent; nothing else is.
  for (const r of s.rows) assert.ok(ids.has(r.id), `row ${r.id} was skipped`);
});

test("offset paging reads every page of a still source, in order", async () => {
  // Three pages, asked for concurrently and reassembled: the CSV inherits the
  // query's order, so "all of them" is only half the promise — "in this
  // order" is the other half, and it is the half concurrency could break.
  const s = source(RESPONSE_ROW_CAP * 2 + 3);
  let asked = 0;
  const all = await fetchAllPages(async (p, size) => { asked++; return s.page(p, size); });
  assert.equal(asked, 3);
  assert.equal(all.length, RESPONSE_ROW_CAP * 2 + 3);
  assert.deepEqual(all.map(r => r.id), s.rows.map(r => r.id));
});

test("offset paging reads every row when the source caps pages below the constant", async () => {
  // The API's max-rows lowered to 250, the same setting the keyset walk has
  // to survive. Page 0 asks for the cap and gets 250, and a walk that took
  // the constant for the page size would then have asked for rows 1000-1249
  // next — reading 387 of 1137 rows and calling it the whole reference list,
  // with nothing on screen to say so.
  const s = source(RESPONSE_ROW_CAP + 137, 250);
  const all = await fetchAllPages(async (p, size) => s.page(p, size));
  assert.equal(all.length, RESPONSE_ROW_CAP + 137);
  assert.deepEqual(all.map(r => r.id), s.rows.map(r => r.id));
});

test("a source that gives no total is taken at its first page", async () => {
  // PostgREST omits the count unless the read asks for one. The pager used to
  // divide by that missing number and hand `new Array` a NaN length, which
  // throws — a reference list that answered nothing at all rather than the
  // thousand rows it did have.
  let asked = 0;
  const rows = Array.from({ length: RESPONSE_ROW_CAP }, (_, i) => ({ id: i + 1 }));
  const all = await fetchAllPages(async () => { asked++; return { rows }; });
  assert.equal(asked, 1, "nothing to page towards when nobody said how many there are");
  assert.equal(all.length, RESPONSE_ROW_CAP);

  const nulled = await fetchAllPages(async () => ({ rows: [{ id: 1 }], total: null }));
  assert.deepEqual(nulled.map(r => r.id), [1]);
});

test("offset paging skips a row when one is deleted mid-walk", async () => {
  // The reason the paid-from reads moved off it: this is not a hypothetical.
  const s = source(RESPONSE_ROW_CAP * 2 + 5);
  let seen = 0;
  const all = await fetchAllPages(async (p, size) => {
    if (seen === 1) s.remove(1);
    seen++;
    return s.page(p, size);
  });
  const ids = new Set(all.map(r => r.id));
  const missed = s.rows.filter(r => !ids.has(r.id));
  assert.ok(missed.length > 0, "offset paging is expected to lose a row here");
});

test("keyset paging stops rather than spinning when the key never advances", async () => {
  // A caller whose order and key disagree would otherwise ask for the same
  // thousand rows for ever. It has to terminate with what it has.
  const stuck = Array.from({ length: RESPONSE_ROW_CAP }, () => ({ id: 7 }));
  const all = await fetchAllKeyset(() => stuck);
  assert.equal(all.length, RESPONSE_ROW_CAP * 2);
});

test("keyset paging walks every row when the source caps pages below the constant", async () => {
  // The API's max-rows lowered to 250. Every page then comes back "short",
  // and a walk that trusted the constant would have stopped at 250 rows and
  // called that the whole timesheet.
  const s = source(RESPONSE_ROW_CAP, 250);
  const all = await fetchAllKeyset(key => s.after(key));
  assert.equal(all.length, RESPONSE_ROW_CAP);
  assert.equal(all[all.length - 1].id, RESPONSE_ROW_CAP);
});

test("keyset paging ends when the rows run out", async () => {
  // The price of learning the page size from the first page: a source whose
  // rows run out exactly on a page boundary is asked once more and answers
  // with nothing. Two requests, not one — and never fewer rows than exist.
  let calls = 0;
  const all = await fetchAllKeyset(key => { calls++; return key == null ? [{ id: 1 }, { id: 2 }] : []; });
  assert.equal(calls, 2);
  assert.equal(all.length, 2);
});

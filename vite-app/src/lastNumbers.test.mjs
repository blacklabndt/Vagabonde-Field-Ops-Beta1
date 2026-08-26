// The "Last numbers" prefill: film and MPI numbering read off a report's
// text. The fixtures echo real report rows — joint, weld letter, number,
// technique — because the traps this parser exists to dodge (procedure
// designations that look like inspection numbers) came off real pages.
//
// The answer is contiguous runs, never one span over a gap: a report
// holding MT-66 and MT-70..71 does not hold MT-67..69, and the contractor
// reconciles these against the film in the envelope.

import test from "node:test";
import assert from "node:assert/strict";
import { lastNumbers } from "./data.js";

test("an unbroken run of film numbers becomes a range", () => {
  assert.equal(
    lastNumbers("CN-909 C XF-1 CZ 4 STD\nCN-909 B XF-2 CZ 4\nCN-909 A XF-3 CZ 4"),
    "XF-1 to XF-3"
  );
});

test("a gap splits the runs instead of being papered over", () => {
  // The case straight from the field: MT-66 on its own, then MT-70..71.
  // "MT-66 to MT-71" would claim four welds this report does not hold.
  assert.equal(
    lastNumbers("CN-950 A MT-66 M 1\"\nCN-951 A MT-70 M 1\"\nCN-951 B MT-71 M 1\""),
    "MT-66, MT-70 to MT-71"
  );
});

test("several gaps, several runs", () => {
  assert.equal(
    lastNumbers("XF-16 XF-17 XF-18 XF-29 XF-30 XF-44"),
    "XF-16 to XF-18, XF-29 to XF-30, XF-44"
  );
});

test("a single number stands alone rather than as a range to itself", () => {
  assert.equal(lastNumbers("one weld today: XF-12 and done"), "XF-12");
});

test("both prefixes, XF first regardless of document order", () => {
  assert.equal(
    lastNumbers("MT-5 TOL 1\" A BH\nMT-6 WOL\nCN-913 G XF-16 FG\nXF-17 FG"),
    "XF-16 to XF-17, MT-5 to MT-6"
  );
});

test("the unhyphenated procedure designation does not count", () => {
  // "MT 1" and "MT1" are the procedure revision block, not welds — this
  // exact collision exists on the real reports, same page as real MT rows.
  assert.equal(
    lastNumbers("Procedure, Tech. Rev.#: MT1 T1 Rev. 11\nMT 1 Rev 11\nMT-1 TOL\nMT-2 WOL"),
    "MT-1 to MT-2"
  );
});

test("the hyphenated, zero-padded procedure does not count either", () => {
  // The third spelling found in the wild, verbatim from a real MPI page
  // whose welds are MT-6..MT-9: the field must not read from MT-1.
  const page = "MT-01 REV 2 ASME V, ART. 1 & 7\nCN-915 A MT-6 M 1\" 3M\nCN-914 G MT-7 M\nCN-914 H MT-8 M\nCN-916 H MT-9 FG";
  assert.equal(lastNumbers(page), "MT-6 to MT-9");
});

test("a number followed by REV is paperwork whatever its padding", () => {
  assert.equal(lastNumbers("MT-3 REV 2 procedures\nMT-6 WOL\nMT-7 TOL"), "MT-6 to MT-7");
});

test("zero-padded numbers are dropped even without REV after them", () => {
  assert.equal(lastNumbers("Procedure: MT-01\nMT-6 WOL"), "MT-6");
});

test("duplicates collapse and order does not matter", () => {
  // the same number seen on the report page and again on the repairs page
  assert.equal(lastNumbers("XF-30 XF-16 XF-30 XF-17"), "XF-16 to XF-17, XF-30");
});

test("case survives a sloppy report", () => {
  assert.equal(lastNumbers("xf-3 and Xf-4"), "XF-3 to XF-4");
});

test("ultrasonic and the radiographic variants count too", () => {
  assert.equal(
    lastNumbers("UT-3 CN-920 A\nUT-4 CN-921 B\nXS-2 spot\nXT-5 tangent\nXT-6"),
    "XS-2, XT-5 to XT-6, UT-3 to UT-4"
  );
});

test("the UT procedure pulls the same trick and meets the same guards", () => {
  assert.equal(
    lastNumbers("UT-01 REV 4 ASME V ART. 4\nUT-3 CN-920\nUT-4 CN-922"),
    "UT-3 to UT-4"
  );
});

test("every prefix reports in paperwork order regardless of page order", () => {
  assert.equal(
    lastNumbers("UT-2\nMT-4\nXT-9\nXS-1\nXF-30"),
    "XF-30, XS-1, XT-9, MT-4, UT-2"
  );
});

test("film numbers in the hundreds, straight off a real report", () => {
  // the Whitecap May 30 report runs XF-534 to XF-545 without a gap
  const rows = Array.from({ length: 12 }, (_, i) => `XF-${534 + i} W${i + 1}`).join("\n");
  assert.equal(lastNumbers(rows), "XF-534 to XF-545");
});

test("no numbers means an empty answer, not a broken one", () => {
  assert.equal(lastNumbers("a hardness survey, no film"), "");
  assert.equal(lastNumbers(""), "");
  assert.equal(lastNumbers(null), "");
});

test("lookalikes without the word boundary stay out", () => {
  // AXF-3 is a tag, XF-4b is not a plain number
  assert.equal(lastNumbers("AXF-3 something XF-4b"), "");
});

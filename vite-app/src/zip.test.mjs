// Tests for the ZIP writer.
//
//   node --test src/zip.test.mjs
//
// A hand-written binary format either parses or it does not, and the failure
// mode is an archive that downloads fine and refuses to open — by which point
// it is on somebody's desktop and the person who built it has moved on. The
// central-directory size was wrong the first time this ran, measured after the
// trailer had started being written rather than before, and every reader
// rejected the file with "Bad magic number for central directory". These
// assertions are the cheap version of finding that out.
//
// Structure is checked by reading the bytes back, because that is what an
// operating system does. Anything these miss is caught by opening the output
// with a real zip implementation, which is worth doing whenever this changes.

import test from "node:test";
import assert from "node:assert/strict";
import { makeZip, safeFilename } from "./zip.js";

const enc = new TextEncoder();
const file = (name, text) => ({ name, data: enc.encode(text) });

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

// The trailer is the last 22 bytes when there is no archive comment.
function eocd(b) {
  const at = b.length - 22;
  assert.equal(u32(b, at), 0x06054B50, "no end-of-central-directory signature");
  return {
    at,
    entries: u16(b, at + 10),
    size: u32(b, at + 12),
    offset: u32(b, at + 16)
  };
}

test("an empty archive is still a valid archive", async () => {
  const b = await bytesOf(makeZip([]));
  const end = eocd(b);
  assert.equal(end.entries, 0);
  assert.equal(end.size, 0);
  assert.equal(b.length, 22, "nothing but the trailer");
});

test("the central directory is where the trailer says it is", async () => {
  // This is the one that was wrong: the size was measured after the trailer
  // had begun, reporting twelve bytes too many, and readers refused the file.
  const b = await bytesOf(makeZip([file("a.txt", "one"), file("b.txt", "two")]));
  const end = eocd(b);
  assert.equal(u32(b, end.offset), 0x02014B50, "offset does not point at a central header");
  assert.equal(end.offset + end.size, end.at,
    "the directory must end exactly where the trailer begins");
});

test("every entry is announced and described once", async () => {
  const b = await bytesOf(makeZip([file("a.txt", "one"), file("b.txt", "two"), file("c.txt", "three")]));
  assert.equal(eocd(b).entries, 3);
  assert.equal(u32(b, 0), 0x04034B50, "first local header signature");
});

test("each central header points at its own local header", async () => {
  const b = await bytesOf(makeZip([file("first.txt", "1"), file("second.txt", "22")]));
  const end = eocd(b);
  let at = end.offset;
  for (let i = 0; i < end.entries; i++) {
    assert.equal(u32(b, at), 0x02014B50, `central header ${i}`);
    const nameLen = u16(b, at + 28);
    const localAt = u32(b, at + 42);
    assert.equal(u32(b, localAt), 0x04034B50, `entry ${i} points at a local header`);
    // The name in both places must agree, or a reader lists one and extracts another.
    const centralName = new TextDecoder().decode(b.slice(at + 46, at + 46 + nameLen));
    const localNameLen = u16(b, localAt + 26);
    const localName = new TextDecoder().decode(b.slice(localAt + 30, localAt + 30 + localNameLen));
    assert.equal(centralName, localName, `entry ${i} name`);
    at += 46 + nameLen;
  }
});

test("sizes are stored, not compressed", async () => {
  const text = "x".repeat(500);
  const b = await bytesOf(makeZip([file("big.txt", text)]));
  assert.equal(u16(b, 8), 0, "method must be 0 (stored)");
  assert.equal(u32(b, 18), 500, "compressed size");
  assert.equal(u32(b, 22), 500, "uncompressed size");
});

test("names are flagged as UTF-8 so accents survive", async () => {
  const b = await bytesOf(makeZip([file("Ünicode café.txt", "x")]));
  assert.equal(u16(b, 6) & 0x0800, 0x0800, "bit 11 must be set");
  const nameLen = u16(b, 26);
  const name = new TextDecoder().decode(b.slice(30, 30 + nameLen));
  assert.equal(name, "Ünicode café.txt");
});

test("the CRC is a real CRC-32", async () => {
  // "123456789" has a published CRC-32 of 0xCBF43926 — the standard check
  // value, so this catches a table built with the wrong polynomial.
  const b = await bytesOf(makeZip([file("check.txt", "123456789")]));
  assert.equal(u32(b, 14), 0xCBF43926);
});

test("binary content survives byte for byte", async () => {
  const data = new Uint8Array(256);
  for (let i = 0; i < 256; i++) data[i] = i;          // every byte value, including 0
  const b = await bytesOf(makeZip([{ name: "raw.bin", data }]));
  const nameLen = u16(b, 26);
  const stored = b.slice(30 + nameLen, 30 + nameLen + 256);
  assert.deepEqual([...stored], [...data], "a stored entry must be the bytes it was given");
});

// ── safeFilename ─────────────────────────────────────────────────────────
// Names come from the profiles table, which is free text.

test("safeFilename removes what a filesystem refuses", async () => {
  assert.equal(safeFilename('a\\b/c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
});

test("safeFilename keeps ordinary names intact", () => {
  assert.equal(safeFilename("Kyle Keith"), "Kyle Keith");
  assert.equal(safeFilename("O'Brien"), "O'Brien");
  assert.equal(safeFilename("Jean-Luc Picard"), "Jean-Luc Picard");
});

test("safeFilename collapses whitespace and strips trailing dots", () => {
  // Windows silently drops both, so two people differing only there would
  // otherwise collide inside the archive.
  assert.equal(safeFilename("Dave  Chapman "), "Dave Chapman");
  assert.equal(safeFilename("Someone Jr."), "Someone Jr");
  assert.equal(safeFilename("  padded  "), "padded");
});

test("safeFilename never returns nothing", () => {
  assert.equal(safeFilename(""), "unnamed");
  assert.equal(safeFilename(null), "unnamed");
  assert.equal(safeFilename("///"), "unnamed");
  assert.equal(safeFilename("...", "no name"), "no name");
});

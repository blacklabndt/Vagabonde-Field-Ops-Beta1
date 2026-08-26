// A minimal ZIP writer — enough to put a handful of files in one download.
//
// Written here rather than pulled in, because the alternative is a second
// <script> from a CDN injected into a page that holds a signed-in session.
// SheetJS is already loaded that way and that is one supply-chain surface more
// than ideal; adding another to concatenate a few files is not a trade worth
// making. The format below is the 1989 PKZIP layout that every operating
// system still opens natively.
//
// Stored, not deflated. Everything this zips is already a .xlsx, which is
// itself a deflated zip — compressing it again would spend CPU on a phone or
// an office laptop to save nothing. The cost is a few hundred bytes of headers.
//
// Not implemented on purpose: Zip64, encryption, directories, and any entry
// over 4 GB. A pay period of timesheets is measured in tens of kilobytes; if
// that ever stops being true this file should be replaced rather than extended.

// CRC-32, the same polynomial the format has always used. Table built once on
// first use rather than at module load, so a screen that never exports a zip
// never pays for it.
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[i] = c >>> 0;
  }
  return CRC_TABLE;
}

function crc32(bytes) {
  const table = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS packed date and time, which is what the format stores. Two-second
// resolution, and years count from 1980 — a quirk of the era, not a mistake.
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// Names are stored as UTF-8 and flagged as such (bit 11), so an accented name
// is not mangled by whatever code page the opening machine happens to use.
const utf8 = s => new TextEncoder().encode(s);

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  bytes(b) { this.parts.push(b); this.length += b.length; }
  u16(n) { this.bytes(new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF])); }
  u32(n) { this.bytes(new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF])); }
  join() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

// files: [{ name, data: Uint8Array }] -> Blob
export function makeZip(files, when = new Date()) {
  const { time, date } = dosStamp(when);
  const w = new Writer();
  const central = [];

  for (const f of files) {
    const name = utf8(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const offset = w.length;

    // Local file header
    w.u32(0x04034B50);
    w.u16(20);            // version needed: 2.0
    w.u16(0x0800);        // flags: UTF-8 names
    w.u16(0);             // method: stored
    w.u16(time); w.u16(date);
    w.u32(crc);
    w.u32(data.length);   // compressed size == uncompressed, stored
    w.u32(data.length);
    w.u16(name.length);
    w.u16(0);             // no extra field
    w.bytes(name);
    w.bytes(data);

    central.push({ name, crc, size: data.length, offset });
  }

  const centralStart = w.length;
  for (const e of central) {
    w.u32(0x02014B50);
    w.u16(20);            // version made by
    w.u16(20);            // version needed
    w.u16(0x0800);
    w.u16(0);
    w.u16(time); w.u16(date);
    w.u32(e.crc);
    w.u32(e.size); w.u32(e.size);
    w.u16(e.name.length);
    w.u16(0); w.u16(0);   // extra, comment
    w.u16(0);             // disk number
    w.u16(0);             // internal attrs
    w.u32(0);             // external attrs
    w.u32(e.offset);
    w.bytes(e.name);
  }

  // Measured before the trailer is written. Taking w.length after the
  // signature and counts have gone in reports the directory as twelve bytes
  // longer than it is, and every reader rejects the archive outright:
  // "Bad magic number for central directory".
  const centralSize = w.length - centralStart;

  // End of central directory
  w.u32(0x06054B50);
  w.u16(0); w.u16(0);
  w.u16(central.length); w.u16(central.length);
  w.u32(centralSize);
  w.u32(centralStart);
  w.u16(0);               // no comment

  return new Blob([w.join()], { type: "application/zip" });
}

// Anything that could confuse a filesystem, plus the characters Windows
// refuses outright. Trailing dots and spaces are stripped because Explorer
// silently drops them and two people whose names differ only there would
// otherwise collide inside the archive.
export function safeFilename(s, fallback = "unnamed") {
  const cleaned = String(s || "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  // A name that survives as nothing but separators — "///" becoming "---" —
  // is a legal filename and a useless one. These end up as entries somebody
  // has to pick through in a bundle, so anything with no letter or digit left
  // in it gets the fallback instead.
  return /[a-z0-9]/i.test(cleaned) ? cleaned : fallback;
}

// Hands the browser a file to save. Kept here so the revoke is not forgotten:
// an object URL left behind pins its blob in memory for the life of the tab,
// which for a bundle of workbooks is megabytes.
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

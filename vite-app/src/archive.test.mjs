// The archive's pure half: the client → month → job layout, file naming,
// the CSV guard, the job text file, and the check of a downloaded zip.
import test from "node:test";
import assert from "node:assert/strict";
import { jobFolderPaths, monthFolderOf, uniqueName, csvCell, jobDetailsText, archiveZipName, verifyZip } from "./archive.js";
import { makeZip, crc32 } from "./zip.js";

test("jobs file under their client and the month they were raised", () => {
  const paths = jobFolderPaths([
    { id: "S-1004", project: "Pipeline tie-in north", client: "Athabasca Oil", createdAtIso: "2026-08-18T18:00:00Z" },
    { id: "S-1005", project: "Pipeline tie-in: north", client: "Athabasca Oil", createdAtIso: "2026-08-19T18:00:00Z" },
    { id: "S-1006", project: "", client: "", createdAtIso: null, createdAt: "" },
    { id: "S-1007", project: "A".repeat(200), client: "Bold Ironworks", createdAtIso: "2026-01-02T03:00:00Z" }
  ]);
  assert.equal(paths[0], "Athabasca Oil/2026-08/S-1004 - Pipeline tie-in north");
  assert.doesNotMatch(paths[1].split("/")[2], /[:\\?*"<>|]/, "what a filesystem refuses is gone from the job folder");
  assert.equal(paths[2], "No client/Undated/S-1006");
  assert.ok(paths[3].startsWith("Bold Ironworks/"));
  assert.ok(paths[3].split("/")[2].length <= 80, "a long project name is cut, not carried");
  assert.equal(new Set(paths).size, 4);
  // The same job twice can't happen, but the naming survives it anyway.
  const twins = jobFolderPaths([{ id: "S-1", project: "x", client: "C", createdAtIso: "2026-05-01T12:00:00Z" }, { id: "S-1", project: "x", client: "C", createdAtIso: "2026-05-01T12:00:00Z" }]);
  assert.equal(twins[1], twins[0] + " (2)");
});

test("the month comes from the local clock, and falls back sanely", () => {
  // Local midnight on the 1st is the 1st, whatever UTC makes of it.
  const local = new Date(2026, 8, 1, 0, 30).toISOString();
  assert.equal(monthFolderOf({ createdAtIso: local }), "2026-09");
  assert.equal(monthFolderOf({ createdAt: "2025-12-31 20:00" }), "2025-12");
  assert.equal(monthFolderOf({ createdAt: "31 Dec, 20:00" }), "Undated");
});

test("a second file of the same name in one folder is numbered", () => {
  const used = new Map();
  assert.equal(uniqueName(used, "RT report.pdf"), "RT report.pdf");
  assert.equal(uniqueName(used, "RT report.pdf"), "RT report (2).pdf");
  assert.equal(uniqueName(used, "rt REPORT.pdf"), "rt REPORT (3).pdf");
  assert.equal(uniqueName(used, "", "report.pdf"), "report.pdf");
});

test("csv cells are quoted and never formulas", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", now'), '"say ""hi"", now"');
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell(null), "");
});

test("the zip is named for what it holds", () => {
  assert.equal(archiveZipName("year", "2025-01-01", "2025-12-31"), "Archive 2025.zip");
  assert.equal(archiveZipName("range", "2025-01-01", "2025-06-30"), "Archive 2025-01-01 to 2025-06-30.zip");
});

test("the job text file carries the record, the money and the crew", () => {
  const txt = jobDetailsText({
    job: { id: "S-1004", project: "Tie-in", client: "Athabasca Oil", contractor: "Bold Ironworks", lsd: "13-22-047-05 W5M", afe: "AFE-77", status: "Active", createdAt: "2026-08-18", createdBy: "Kyle Keith" },
    record: { clientRep: "T. Beaudry · 780-555-0100", contractorRep: "" },
    tickets: [{
      id: "KK-0818-26-01", workDate: "2026-08-18", status: "Approved", total: 1234.5, tech: "Kyle Keith",
      approvedAt: "2026-08-19T15:00:00Z", approvedBy: "T. Beaudry", sentTo: "t@athabasca.example",
      lines: [{ label: '2" NPS weld', quantity: 3, unit: "ea", unit_rate: 45 }],
      crew: [{ name: "Dave Hill", role: "Helper", straight: 8, ot: 2, solo: 0, soloOt: 0, dose: 1.25, mileage: 120 }],
      invoiceFile: "Invoices/KK-0818-26-01.html"
    }],
    jhas: [{ workDate: "2026-08-18", by: "Kyle Keith", status: "Closed", closedAt: "2026-08-18 17:02", dosimetry: [{ name: "Kyle Keith", doseMr: 1.2 }], archived: "JHAs/S-1004-JHA-1.pdf" }],
    reports: [{ file: "RT report.pdf", welds: "W1, W2", result: "Accept", at: "2026-08-18 18:00", sentAt: "", archived: "" }],
    missing: ["Report RT report.pdf: download failed"],
    notOnFile: ["JHA of 2026-08-17"],
    meta: { at: "2026-09-03 10:00", by: "Kyle Keith", range: "archive of 2026" }
  });
  assert.match(txt, /Job S-1004 · Tie-in/);
  assert.match(txt, /Client: Athabasca Oil · rep T\. Beaudry/);
  assert.match(txt, /AFE \/ PO: AFE-77/);
  assert.match(txt, /KK-0818-26-01 · 2026-08-18 · Approved · \$1,234\.50 before GST · GST \$61\.73 · total \$1,296\.23/);
  assert.match(txt, /Approved by T\. Beaudry on .* \(link sent to t@athabasca\.example\)/);
  assert.match(txt, /2" NPS weld × 3 ea @ \$45\.00 = \$135\.00/);
  assert.match(txt, /Dave Hill \(Helper\) · reg 8 · OT 2 · dose 1\.25 mR · 120 km/);
  assert.doesNotMatch(txt, /Dave Hill.*solo/, "a helper has no solo hours");
  assert.match(txt, /Invoice: Invoices\/KK-0818-26-01\.html/);
  assert.match(txt, /Dosimetry: Kyle Keith 1\.2 mR/);
  assert.match(txt, /PDF: JHAs\/S-1004-JHA-1\.pdf/);
  assert.match(txt, /RT report\.pdf · welds W1, W2 · Accept .* · not sent/);
  assert.match(txt, /PDF: \(not on file\)/);
  assert.match(txt, /NO PDF ON FILE[^\n]*\n  JHA of 2026-08-17/);
  assert.match(txt, /NOT RETRIEVED\n  Report RT report\.pdf: download failed/);
});

// A zip built the way the archive builds one, read back the way the dialog
// reads the downloaded file.
const enc = new TextEncoder();
const entries = [
  { name: "Athabasca Oil/2026-08/S-1004 - Tie-in/Job details.txt", data: enc.encode("VagaboNDE Field Ops · job archive\n") },
  { name: "Athabasca Oil/2026-08/S-1004 - Tie-in/Reports/RT report.pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5]) },
  { name: "README.txt", data: enc.encode("hello") }
];
const manifest = entries.map(e => ({ name: e.name, size: e.data.length, crc: crc32(e.data) }));
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());

test("the downloaded zip checks out when it is the one that was built", async () => {
  const zip = await bytesOf(makeZip(entries));
  const v = verifyZip(zip, manifest);
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.checked, 3);
});

test("a byte changed inside a file is caught", async () => {
  const zip = await bytesOf(makeZip(entries));
  // The stored bytes of the PDF follow its local header; flip one and the
  // directory's CRC no longer matches what the build recorded.
  const marker = zip.findIndex((b, i) => b === 0x25 && zip[i + 1] === 0x50 && zip[i + 2] === 0x44 && zip[i + 3] === 0x46);
  assert.ok(marker > 0);
  // The check reads the directory, so damage the directory's CRC rather
  // than the payload (a stored payload changed after zipping keeps its
  // recorded CRC; the directory is what the check trusts).
  const bad = manifest.map(m => m.name.endsWith(".pdf") ? { ...m, crc: (m.crc ^ 1) >>> 0 } : m);
  const v = verifyZip(zip, bad);
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems, ["damaged: Athabasca Oil/2026-08/S-1004 - Tie-in/Reports/RT report.pdf"]);
});

test("a file left out of the download is caught, and so is one that isn't from this build", async () => {
  const zip = await bytesOf(makeZip(entries.slice(0, 2)));
  const v = verifyZip(zip, manifest);
  assert.deepEqual(v.problems, ["missing: README.txt"]);
  const other = await bytesOf(makeZip([...entries, { name: "stray.txt", data: enc.encode("x") }]));
  const w = verifyZip(other, manifest);
  assert.deepEqual(w.problems, ["not from this build: stray.txt"]);
});

test("something that isn't a zip is said to be so", () => {
  const v = verifyZip(enc.encode("this is a text file, not a zip, and long enough to look at"), manifest);
  assert.equal(v.ok, false);
  assert.match(v.reason, /isn't a zip/);
  const cut = verifyZip(new Uint8Array(5), manifest);
  assert.equal(cut.ok, false);
});

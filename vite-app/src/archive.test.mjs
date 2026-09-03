// The archive's pure half: folder and file naming, the CSV guard, and the
// job text file.
import test from "node:test";
import assert from "node:assert/strict";
import { jobFolderNames, uniqueName, csvCell, jobDetailsText, archiveZipName } from "./archive.js";

test("one folder per job, safe and unique", () => {
  const names = jobFolderNames([
    { id: "S-1004", project: "Pipeline tie-in north" },
    { id: "S-1005", project: "Pipeline tie-in: north" },
    { id: "S-1006", project: "" },
    { id: "S-1007", project: "A".repeat(200) }
  ]);
  assert.equal(names[0], "S-1004 - Pipeline tie-in north");
  assert.doesNotMatch(names[1], /[:\\/?*"<>|]/, "what a filesystem refuses is gone");
  assert.equal(names[2], "S-1006");
  assert.ok(names[3].length <= 80, "a long project name is cut, not carried");
  assert.equal(new Set(names).size, 4);
  // The same number twice can't happen, but the naming survives it anyway.
  const twins = jobFolderNames([{ id: "S-1", project: "x" }, { id: "S-1", project: "x" }]);
  assert.deepEqual(twins, ["S-1 - x", "S-1 - x (2)"]);
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
  assert.match(txt, /NOT RETRIEVED\n  Report RT report\.pdf: download failed/);
});

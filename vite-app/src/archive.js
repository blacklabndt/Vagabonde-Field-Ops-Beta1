// The archive: every job raised in a chosen period, with its details as a
// text file, its hazard assessments and reports as the PDFs on file, and
// each ticket's field invoice as HTML — filed client → month → job, zipped
// in the browser. Built for the owner's year-end from the Admin screen:
// download the year, check the zip that landed, then (if they choose) clear
// those jobs from the app and start fresh.
//
// Everything here except buildArchive is pure, so the folder naming, the
// text file and the zip check are unit-tested without a database — which is
// also why this module never imports the data layer: buildArchive is handed
// it (`db`) by the dialog, and the tests never load config.js's browser-only
// env.

import { money, gstOn } from "./data.js";
import { makeZip, safeFilename, crc32 } from "./zip.js";

const enc = new TextEncoder();
const text = s => enc.encode(String(s ?? ""));

export function archiveZipName(mode, from, to) {
  if (mode === "year") return `Archive ${String(from).slice(0, 4)}.zip`;
  return `Archive ${from} to ${to}.zip`;
}

// The month a job was raised, as a folder: "2026-08". From the raw instant
// on the local clock (the crew's, Edmonton); a job with no usable date files
// under "Undated" rather than under the wrong month.
export function monthFolderOf(job) {
  const iso = job.createdAtIso;
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  const m = /^(\d{4})-(\d{2})/.exec(String(job.createdAt || ""));
  return m ? `${m[1]}-${m[2]}` : "Undated";
}

// One folder per job, under its client and the month it was raised:
//   Athabasca Oil/2026-08/S-1004 - Pipeline tie-in
// Safe for every filesystem, unique even when two jobs share a project
// name, and kept short — a zip path that runs past what Windows Explorer
// will open is an archive nobody can read.
export function jobFolderPaths(jobs) {
  const used = new Map();
  return jobs.map(j => {
    const client = safeFilename(String(j.client || ""), "").slice(0, 48).trim() || "No client";
    const month = monthFolderOf(j);
    const number = safeFilename(String(j.id || ""), "job");
    const project = safeFilename(String(j.project || ""), "").slice(0, 48).trim();
    const leaf = (project ? `${number} - ${project}` : number).slice(0, 80).trim();
    const base = `${client}/${month}/${leaf}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
}

// A file name that is unique inside its folder — two reports called
// "RT report.pdf" on one job are "RT report.pdf" and "RT report (2).pdf".
export function uniqueName(used, name, fallback = "file") {
  const clean = safeFilename(name, fallback);
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  const n = (used.get(clean.toLowerCase()) || 0) + 1;
  used.set(clean.toLowerCase(), n);
  return n > 1 ? `${stem} (${n})${ext}` : clean;
}

const cents = n => Math.round((Number(n) || 0) * 100);
const dollars = c => c / 100;
const lineAmount = (qty, rate) => Math.round(cents(qty) * (Number(rate) || 0)) / 100;
const hrs = n => String(Math.round((Number(n) || 0) * 100) / 100);
const fmtWhen = iso => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
};
const row = (label, value) => (value ? `${label}: ${value}` : null);

// A CSV cell: quoted, and never a formula (a client name starting with
// "=" is a spreadsheet's to run otherwise).
export function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
}
export const csv = rows => rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function jobDetailsText({ job, record = {}, tickets = [], jhas = [], reports = [], missing = [], notOnFile = [], meta = {} }) {
  const out = [];
  out.push("VagaboNDE Field Ops · job archive");
  out.push(`Job ${job.id}${job.project ? ` · ${job.project}` : ""}`);
  out.push("");
  const withRep = (org, rep) => [org, rep ? `rep ${rep}` : ""].filter(Boolean).join(" · ");
  [
    row("Client", withRep(job.client, record.clientRep)),
    row("Contractor", withRep(job.contractor, record.contractorRep)),
    row("Site · LSD", job.lsd),
    row("AFE / PO", job.afe),
    row("Area", job.area),
    row("Method", job.method),
    row("Procedure", job.procedure),
    row("Status", job.status),
    row("Raised", [job.createdAt, job.createdBy ? `by ${job.createdBy}` : ""].filter(Boolean).join(" ")),
    row("Archived", [meta.at, meta.by ? `by ${meta.by}` : "", meta.range ? `· ${meta.range}` : ""].filter(Boolean).join(" "))
  ].filter(Boolean).forEach(l => out.push(l));

  out.push("", `TICKETS (${tickets.length})`);
  if (!tickets.length) out.push("  none");
  for (const t of tickets) {
    const sub = cents(t.total);
    const gst = cents(gstOn(dollars(sub)));
    out.push(`  ${t.id} · ${t.workDate || ""} · ${t.status} · ${money(dollars(sub))} before GST · GST ${money(dollars(gst))} · total ${money(dollars(sub + gst))}`);
    const who = [t.tech ? `Technician ${t.tech}` : "", t.clientContact ? `Client rep ${t.clientContact}` : "", t.contractorContact ? `Contractor rep ${t.contractorContact}` : ""].filter(Boolean).join(" · ");
    if (who) out.push(`    ${who}`);
    if (t.approvedAt) out.push(`    Approved by ${t.approvedBy || "—"} on ${fmtWhen(t.approvedAt)}${t.sentTo ? ` (link sent to ${t.sentTo})` : ""}`);
    else if (t.sentAt) out.push(`    Sent for approval ${fmtWhen(t.sentAt)}${t.sentTo ? ` to ${t.sentTo}` : ""}`);
    if (t.invoicedAt) out.push(`    Invoiced ${fmtWhen(t.invoicedAt)}`);
    if (t.queriedAt) out.push(`    Queried by ${t.queryBy || "—"} on ${fmtWhen(t.queriedAt)}: ${t.queryText || ""}`);
    if (t.delays) out.push(`    Delays: ${t.delays}`);
    if (t.lines && t.lines.length) {
      out.push("    Lines:");
      for (const l of t.lines) {
        out.push(`      ${l.label} × ${l.quantity}${l.unit ? ` ${l.unit}` : ""} @ ${money(Number(l.unit_rate) || 0)} = ${money(lineAmount(l.quantity, l.unit_rate))}`);
      }
    }
    if (t.crew && t.crew.length) {
      out.push("    Crew:");
      for (const c of t.crew) {
        const solo = c.role === "Helper" ? "" : ` · solo ${hrs(c.solo)} · solo OT ${hrs(c.soloOt)}`;
        out.push(`      ${c.name} (${c.role}) · reg ${hrs(c.straight)} · OT ${hrs(c.ot)}${solo} · dose ${hrs(c.dose)} mR · ${hrs(c.mileage)} km`);
      }
    }
    if (t.invoiceFile) out.push(`    Invoice: ${t.invoiceFile}`);
  }

  out.push("", `HAZARD ASSESSMENTS (${jhas.length})`);
  if (!jhas.length) out.push("  none");
  for (const j of jhas) {
    out.push(`  ${j.workDate || j.at || ""} · signed by ${j.by || "—"} · ${j.status}${j.closedAt ? ` ${j.closedAt}` : ""}${j.siteRep ? ` · site rep ${j.siteRep}` : ""}${j.unitNumber ? ` · unit ${j.unitNumber}` : ""}`);
    if (j.dosimetry && j.dosimetry.length) {
      const doses = j.dosimetry.map(d => {
        const who = d.name || d.worker || d.person || "—";
        const mr = d.doseMr != null && d.doseMr !== "" ? `${d.doseMr} mR` : (d.endReading != null && d.endReading !== "" ? `${d.endReading} mR` : "no end reading");
        return `${who} ${mr}`;
      });
      out.push(`    Dosimetry: ${doses.join("; ")}`);
    }
    if (j.sentAt) out.push(`    Sent ${j.sentAt}${j.sentTo ? ` to ${j.sentTo}` : ""}`);
    out.push(`    PDF: ${j.archived || "(not on file)"}`);
  }

  out.push("", `REPORTS (${reports.length})`);
  if (!reports.length) out.push("  none");
  for (const r of reports) {
    out.push(`  ${r.file} · welds ${r.welds || "—"} · ${r.result || ""} · uploaded ${r.at || ""}${r.sentAt ? ` · sent ${r.sentAt}${r.sentTo ? ` to ${r.sentTo}` : ""}` : " · not sent"}`);
    out.push(`    PDF: ${r.archived || "(not on file)"}`);
  }

  if (notOnFile.length) {
    out.push("", "NO PDF ON FILE (the details above are the record)");
    notOnFile.forEach(m => out.push(`  ${m}`));
  }
  if (missing.length) {
    out.push("", "NOT RETRIEVED");
    missing.forEach(m => out.push(`  ${m}`));
  }
  return out.join("\n") + "\n";
}

// Reads everything, builds the zip. `db` is the data layer (Db), handed in
// by the caller; the progress callback drives the dialog's status line. The
// manifest — every entry's name, size and CRC — is what verifyZip checks
// the downloaded file against.
export async function buildArchive({ jobs, mode, from, to, by = "", onProgress = () => {}, db }) {
  if (!db) throw new Error("buildArchive needs the data layer.");
  const paths = jobFolderPaths(jobs);
  const files = [];
  const manifest = [];
  const summary = {
    jobs: jobs.length, tickets: 0, awaiting: 0, approved: 0, jhas: 0, reports: 0, invoices: 0,
    // Retrieval failures: the archive is not complete while any exist.
    missing: [],
    // Assessments and reports with no PDF ever filed: nothing to retrieve;
    // their details are in the job text file.
    notOnFile: [],
    bytes: 0, beforeGstCents: 0, clients: new Set()
  };
  const range = mode === "year" ? `archive of ${String(from).slice(0, 4)}` : `archive of ${from} to ${to}`;
  const meta = { at: fmtWhen(new Date().toISOString()), by, range };
  const add = (name, data) => {
    files.push({ name, data });
    manifest.push({ name, size: data.length, crc: crc32(data) });
    summary.bytes += data.length;
  };
  const index = [["Client", "Month", "Job", "Project", "Contractor", "Status", "Raised", "Tickets", "Before GST", "JHAs", "Reports", "Folder"]];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const folder = paths[i];
    summary.clients.add(job.client || "No client");
    const say = step => onProgress({ index: i, count: jobs.length, job: job.id, step, bytes: summary.bytes });
    say("reading the job");
    const [record, jhas, reports, ticketRows] = await Promise.all([
      db.getJobRecord(job), db.listJhasForJob(job.dbId), db.listReportsForJob(job.dbId), db.listTicketsForJob(job.dbId)
    ]);
    const missing = [];
    const notOnFile = [];
    const used = new Map();

    for (const j of jhas) {
      if (!j.pdfKey) { notOnFile.push(`JHA of ${j.workDate || j.at}`); continue; }
      say(`JHA ${j.workDate || ""}`);
      try {
        const bytes = await db.downloadObject("jhas", j.pdfKey);
        const name = uniqueName(used, j.file || "jha.pdf", "jha.pdf");
        add(`${folder}/JHAs/${name}`, bytes);
        j.archived = `JHAs/${name}`;
        summary.jhas++;
      } catch (e) {
        missing.push(`JHA ${j.file || j.pdfKey}: ${e.message || "download failed"}`);
      }
    }
    for (const r of reports) {
      if (!r.pdfKey) { notOnFile.push(`Report ${r.file}`); continue; }
      say(`report ${r.file}`);
      try {
        const bytes = await db.downloadObject("reports", r.pdfKey);
        const name = uniqueName(used, r.file || "report.pdf", "report.pdf");
        add(`${folder}/Reports/${name}`, bytes);
        r.archived = `Reports/${name}`;
        summary.reports++;
      } catch (e) {
        missing.push(`Report ${r.file}: ${e.message || "download failed"}`);
      }
    }

    const tickets = [];
    let jobCents = 0;
    for (const t of ticketRows) {
      say(`ticket ${t.id}`);
      const [full, crew] = await Promise.all([db.getTicketForArchive(t.id), db.listCrewForTicket(t.id)]);
      let invoiceFile = "";
      try {
        const html = await db.renderTicketInvoice(t.id);
        const name = uniqueName(used, `${t.id}.html`, "invoice.html");
        add(`${folder}/Invoices/${name}`, text(html));
        invoiceFile = `Invoices/${name}`;
        summary.invoices++;
      } catch (e) {
        missing.push(`Invoice ${t.id}: ${e.message || "render failed"}`);
      }
      tickets.push({ ...full, crew, invoiceFile });
      summary.tickets++;
      if (full.status === "Awaiting approval") summary.awaiting++;
      if (full.status === "Approved" || full.status === "Invoiced") summary.approved++;
      jobCents += cents(full.total);
    }
    summary.beforeGstCents += jobCents;

    add(`${folder}/Job details.txt`, text(jobDetailsText({ job, record, tickets, jhas, reports, missing, notOnFile, meta })));
    summary.missing.push(...missing.map(m => `${job.id}: ${m}`));
    summary.notOnFile.push(...notOnFile.map(m => `${job.id}: ${m}`));
    index.push([job.client || "No client", monthFolderOf(job), job.id, job.project || "", job.contractor || "", job.status || "", job.createdAt || "",
      String(tickets.length), money(dollars(jobCents)), String(jhas.length), String(reports.length), folder]);
  }

  add("Index.csv", text(csv(index)));
  add("README.txt", text([
    "VagaboNDE Field Ops · job archive",
    `Built ${meta.at}${by ? ` by ${by}` : ""} · ${range}`,
    "",
    `${summary.jobs} job(s) for ${summary.clients.size} client(s): ${summary.tickets} ticket(s), ${summary.jhas} hazard assessment PDF(s), ${summary.reports} report PDF(s), ${summary.invoices} invoice(s).`,
    "Filed client → month raised → job (see Index.csv). In each job's folder: Job details.txt (the job record, every ticket with its lines and crew hours, every assessment and report), JHAs/ and Reports/ (the PDFs as filed), Invoices/ (each ticket's field invoice as HTML — open in any browser).",
    "Jobs were chosen by the day they were raised. Amounts are before GST unless marked.",
    summary.notOnFile.length ? "" : null,
    summary.notOnFile.length ? "No PDF was ever filed for (their details are in the job text files):" : null,
    ...summary.notOnFile.map(m => `  ${m}`),
    summary.missing.length ? "" : null,
    summary.missing.length ? "NOT RETRIEVED — this archive is not complete:" : null,
    ...summary.missing.map(m => `  ${m}`)
  ].filter(l => l !== null).join("\n") + "\n"));

  onProgress({ index: jobs.length, count: jobs.length, job: "", step: "zipping", bytes: summary.bytes });
  summary.clients = summary.clients.size;
  return { blob: makeZip(files), summary, manifest };
}

// Reads a zip's central directory and checks every entry the build wrote is
// there, at the same size, with the same CRC — the proof that the file on
// the owner's disk is the archive that was built, before anything is
// cleared. Stored entries only (which is all makeZip writes); no zip64.
export function verifyZip(bytes, manifest) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = o => dv.getUint16(o, true);
  const u32 = o => dv.getUint32(o, true);
  if (u8.length < 22) return { ok: false, reason: "This isn't a zip file — it is too short to be one.", checked: 0, problems: [] };
  // The end-of-central-directory record sits at the end, behind a comment of
  // at most 65,535 bytes.
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (u32(i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, reason: "This isn't a zip file, or the download was cut short.", checked: 0, problems: [] };
  const total = u16(eocd + 10);
  const cdOffset = u32(eocd + 16);
  const found = new Map();
  const dec = new TextDecoder();
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > u8.length || u32(p) !== 0x02014B50) {
      return { ok: false, reason: "The zip's directory is damaged — the download may have been cut short.", checked: 0, problems: [] };
    }
    const crc = u32(p + 16);
    const size = u32(p + 24);
    const nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    found.set(name, { crc, size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const problems = [];
  const expected = new Set();
  for (const m of manifest) {
    expected.add(m.name);
    const f = found.get(m.name);
    if (!f) problems.push(`missing: ${m.name}`);
    else if (f.size !== m.size || f.crc !== m.crc) problems.push(`damaged: ${m.name}`);
  }
  for (const name of found.keys()) if (!expected.has(name)) problems.push(`not from this build: ${name}`);
  return { ok: problems.length === 0, reason: "", checked: manifest.length, problems };
}

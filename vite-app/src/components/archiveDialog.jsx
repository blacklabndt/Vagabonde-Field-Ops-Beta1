import React, { useState, useEffect, useRef } from "react";
import { Db } from "../db.js";
import { money } from "../data.js";
import { Btn, Dialog, ErrorBox, Field } from "./common.jsx";
import { saveBlob } from "../zip.js";
import { buildArchive, archiveZipName, verifyZip } from "../archive.js";

// Archive — the Admin screen's dropdown. A year, or a date range; every job
// raised in it is read in full and handed back as one zip, filed client →
// month → job (details as text, the JHA and report PDFs, each ticket's
// invoice). Then the check: the owner picks the zip that landed on disk and
// every file in it is compared with what was built. Only a zip that checks
// out — and a build with nothing left unretrieved — unlocks the question
// they asked for: clear those jobs from the app to start fresh? That is
// the one bulk delete in the app, so it is behind a typed word as well as
// a button, and it says exactly what it is about to remove, including any
// ticket still out for a client's signature.

const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mb = bytes => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function ArchiveDialog({ mode, currentUser, onClose, onCleared }) {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => thisYear - i);
  const [year, setYear] = useState(thisYear - (new Date().getMonth() < 2 ? 1 : 0));
  const [from, setFrom] = useState(isoDay(new Date(thisYear, 0, 1)));
  const [to, setTo] = useState(isoDay(new Date()));
  const rangeFrom = mode === "year" ? `${year}-01-01` : from;
  const rangeTo = mode === "year" ? `${year}-12-31` : to;
  const rangeOk = /^\d{4}-\d{2}-\d{2}$/.test(rangeFrom) && /^\d{4}-\d{2}-\d{2}$/.test(rangeTo) && rangeFrom <= rangeTo;

  // What the range holds, counted before anything is built — the number is
  // the sanity check ("342 jobs?" means the wrong year).
  const [jobs, setJobs] = useState(null);
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    if (!rangeOk) { setJobs(null); return undefined; }
    const mine = ++seq.current;
    setCounting(true);
    const t = setTimeout(() => {
      Db.listJobsCreatedBetween(rangeFrom, rangeTo)
        .then(rows => { if (mine === seq.current) { setJobs(rows); setError(""); } })
        .catch(e => { if (mine === seq.current) { setJobs(null); setError(e.message || "Couldn't count the jobs in that range."); } })
        .finally(() => { if (mine === seq.current) setCounting(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [rangeFrom, rangeTo, rangeOk]);

  // pick → building → built (check the download) → clearing → cleared
  const [stage, setStage] = useState("pick");
  const [progress, setProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [zipName, setZipName] = useState("");
  const [checking, setChecking] = useState(false);
  const [verified, setVerified] = useState(null);
  const [confirmWord, setConfirmWord] = useState("");
  const [cleared, setCleared] = useState(null);
  const busy = stage === "building" || stage === "clearing" || checking;
  const complete = !!summary && summary.missing.length === 0;
  const canClear = complete && !!verified && verified.ok;

  const build = async () => {
    if (!jobs || !jobs.length) return;
    setStage("building");
    setError("");
    setVerified(null);
    setConfirmWord("");
    setProgress({ index: 0, count: jobs.length, job: jobs[0].id, step: "starting", bytes: 0 });
    try {
      const { blob, summary: s, manifest: m } = await buildArchive({
        jobs, mode, from: rangeFrom, to: rangeTo, by: currentUser ? currentUser.name : "",
        onProgress: setProgress, db: Db
      });
      const name = archiveZipName(mode, rangeFrom, rangeTo);
      saveBlob(blob, name);
      setZipName(name);
      setSummary(s);
      setManifest(m);
      setStage("built");
    } catch (e) {
      setError(e.message || "The archive couldn't be built.");
      setStage("pick");
    }
  };

  // The proof: the file the owner picks is read back and every entry the
  // build wrote must be there, the same size, with the same checksum.
  const checkDownload = async file => {
    if (!file || !manifest) return;
    setChecking(true);
    setVerified(null);
    setError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setVerified({ ...verifyZip(bytes, manifest), file: file.name, size: bytes.length });
    } catch (e) {
      setError(e.message || "Couldn't read that file.");
    }
    setChecking(false);
  };

  const clear = async () => {
    if (!jobs || !canClear || confirmWord.trim().toUpperCase() !== "CLEAR") return;
    setStage("clearing");
    setError("");
    try {
      const result = await Db.archiveClearJobs(jobs.map(j => j.dbId));
      setCleared(result);
      setStage("cleared");
      if (onCleared) onCleared(result);
    } catch (e) {
      setError(e.message || "The jobs couldn't be cleared.");
      setStage("built");
    }
  };

  const title = mode === "year" ? "Archive a year" : "Archive a date range";
  const rangeLabel = mode === "year" ? String(year) : `${rangeFrom} to ${rangeTo}`;
  const count = jobs ? jobs.length : 0;

  const actions = stage === "pick" ? (
    <>
      <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
      <Btn variant="primary" onClick={build} disabled={!rangeOk || counting || !count}>
        {counting ? "Counting…" : count ? `Build the archive · ${plural(count, "job")}` : "Nothing to archive"}
      </Btn>
    </>
  ) : stage === "building" ? (
    <Btn variant="secondary" disabled>Building…</Btn>
  ) : stage === "built" ? (
    <>
      <Btn variant="secondary" onClick={onClose}>Keep the jobs</Btn>
      <Btn variant="primary" onClick={clear} disabled={!canClear || confirmWord.trim().toUpperCase() !== "CLEAR"}
        title={!complete ? "The archive is not complete — see above" : !verified ? "Check the downloaded zip first" : !verified.ok ? "The downloaded zip did not check out" : undefined}>
        Clear {plural(count, "job")} from the app
      </Btn>
    </>
  ) : stage === "clearing" ? (
    <Btn variant="secondary" disabled>Clearing…</Btn>
  ) : (
    <Btn variant="primary" onClick={onClose}>Done</Btn>
  );

  return (
    <Dialog title={title} maxWidth={580} onClose={busy ? () => {} : onClose} actions={actions}>
      <ErrorBox>{error}</ErrorBox>

      {stage === "pick" && (<>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
          Every job raised in the period, filed client → month → job: the job's details as a text file, its hazard
          assessments and reports as the PDFs on file, and each ticket's field invoice, in one zip. Jobs are picked by
          the day they were raised. Nothing is changed in the app by building the archive.
        </div>
        {mode === "year" ? (
          <Field label="Year">
            <select className="input" value={year} onChange={e => setYear(Number(e.target.value))}>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </Field>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="From"><input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
            <Field label="To"><input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
          </div>
        )}
        <div style={{ fontSize: 14 }}>
          {!rangeOk ? "Pick a range that starts before it ends."
            : counting ? "Counting the jobs…"
            : jobs ? (count ? `${plural(count, "job")} raised in ${rangeLabel}.` : `No jobs were raised in ${rangeLabel}.`)
            : ""}
        </div>
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
          Building reads every PDF over the connection, so a whole year can take a few minutes on a desk and is not
          something to start on a phone. Keep this dialog open until the download appears — the next step checks it.
        </div>
      </>)}

      {stage === "building" && progress && (
        <div>
          <div style={{ fontSize: 14, marginBottom: 6 }}>
            {progress.step === "zipping"
              ? "Zipping…"
              : `Job ${Math.min(progress.index + 1, progress.count)} of ${progress.count} · ${progress.job} · ${progress.step}`}
          </div>
          <div style={{ height: 6, background: "color-mix(in srgb, var(--color-text) 10%, transparent)" }}>
            <div style={{ height: "100%", width: `${Math.round((Math.min(progress.index, progress.count) / Math.max(1, progress.count)) * 100)}%`, background: "var(--color-accent)", transition: "width .2s" }} />
          </div>
          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginTop: 6 }}>{mb(progress.bytes)} so far</div>
        </div>
      )}

      {(stage === "built" || stage === "clearing") && summary && (<>
        <div style={{ fontSize: 14 }}>
          <strong>Built and downloaded as {zipName}</strong> — {plural(summary.jobs, "job")} for {plural(summary.clients, "client")}:
          {" "}{plural(summary.tickets, "ticket")} ({money(summary.beforeGstCents / 100)} before GST), {plural(summary.jhas, "assessment PDF")},
          {" "}{plural(summary.reports, "report PDF")}, {plural(summary.invoices, "invoice")} · {mb(summary.bytes)}.
        </div>
        {summary.notOnFile.length > 0 && (
          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            {plural(summary.notOnFile.length, "assessment or report has", "assessments or reports have")} no PDF on file — nothing to retrieve; their details are in the job text files and the README names them.
          </div>
        )}
        {!complete && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px" }}>
            <strong>This archive is not complete.</strong> {plural(summary.missing.length, "item")} could not be retrieved and {summary.missing.length === 1 ? "is" : "are"} listed in the zip's README.txt.
            Clearing is off. Build it again once the connection is better; if the same items fail, they need looking at before anything is removed.
          </div>
        )}

        <div style={{ fontSize: 13, marginTop: 4 }}>
          <strong>Check the download.</strong> Pick the zip that just landed on this computer. Every file in it is
          compared with what was built — {plural(manifest ? manifest.length : 0, "file")} — before clearing is offered.
        </div>
        <Field label="The downloaded zip">
          <input className="input" type="file" accept=".zip,application/zip" disabled={checking || stage === "clearing"}
            onChange={e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; checkDownload(f); }} />
        </Field>
        {checking && <div style={{ fontSize: 13 }}>Checking…</div>}
        {verified && verified.ok && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent)", padding: "8px 10px" }}>
            <strong>Verified.</strong> {verified.file} ({mb(verified.size)}) holds all {plural(verified.checked, "file")} that {verified.checked === 1 ? "was" : "were"} built, each intact.
          </div>
        )}
        {verified && !verified.ok && (
          <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px" }}>
            <strong>That file did not check out.</strong> {verified.reason || `${plural(verified.problems.length, "problem")}:`}
            {verified.problems.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
                {verified.problems.slice(0, 8).map(p => <li key={p}>{p}</li>)}
                {verified.problems.length > 8 && <li>…and {verified.problems.length - 8} more</li>}
              </ul>
            )}
            <div style={{ marginTop: 6, fontSize: 12 }}>Make sure you picked the zip this dialog just downloaded; if it was, download it again by building again.</div>
          </div>
        )}

        {canClear && (<>
          <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginTop: 4 }}>
            Clearing removes these {plural(summary.jobs, "job")} and everything filed against them — tickets{summary.awaiting ? ` (${summary.awaiting} still out for the client's signature)` : ""},
            {" "}assessments, reports and their PDFs — from the app. The zip on this computer is then the only copy. This can't be undone.
          </div>
          <Field label="Type CLEAR to confirm">
            <input className="input" value={confirmWord} onChange={e => setConfirmWord(e.target.value)} placeholder="CLEAR" autoComplete="off" disabled={stage === "clearing"} />
          </Field>
        </>)}
      </>)}

      {stage === "cleared" && cleared && (
        <div style={{ fontSize: 14 }}>
          <strong>Cleared.</strong> {plural(cleared.jobs, "job")}, {plural(cleared.tickets, "ticket")}, {plural(cleared.jhas, "assessment")} and {plural(cleared.reports, "report")} are gone from the app.
          {cleared.filesLeft ? ` ${plural(cleared.filesLeft, "PDF")} couldn't be removed from storage and can be cleaned up from the Supabase dashboard.` : " Their PDFs were removed from storage too."}
        </div>
      )}
    </Dialog>
  );
}

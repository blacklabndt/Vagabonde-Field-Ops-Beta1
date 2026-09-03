import React, { useState, useEffect, useRef } from "react";
import { Db } from "../db.js";
import { money } from "../data.js";
import { Btn, Dialog, ErrorBox, Field } from "./common.jsx";
import { saveBlob } from "../zip.js";
import { buildArchive, archiveZipName } from "../archive.js";

// Archive — Home's Admin-only dropdown. A year, or a date range; every job
// raised in it is read in full and handed back as one zip (a folder per
// job: details as text, the JHA and report PDFs, each ticket's invoice).
// Then, and only then, the question the owner asked for: clear those jobs
// from the app to start fresh? That is the one bulk delete in the app, so
// it is behind a typed word as well as a button, and it says exactly what
// it is about to remove — including any ticket still out for signature.

const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const mb = bytes => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;

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

  // pick → building → built → clearing → cleared
  const [stage, setStage] = useState("pick");
  const [progress, setProgress] = useState(null);
  const [summary, setSummary] = useState(null);
  const [confirmWord, setConfirmWord] = useState("");
  const [cleared, setCleared] = useState(null);
  const busy = stage === "building" || stage === "clearing";

  const build = async () => {
    if (!jobs || !jobs.length) return;
    setStage("building");
    setError("");
    setProgress({ index: 0, count: jobs.length, job: jobs[0].id, step: "starting", bytes: 0 });
    try {
      const { blob, summary: s } = await buildArchive({
        jobs, mode, from: rangeFrom, to: rangeTo, by: currentUser.name,
        onProgress: setProgress, db: Db
      });
      saveBlob(blob, archiveZipName(mode, rangeFrom, rangeTo));
      setSummary(s);
      setStage("built");
    } catch (e) {
      setError(e.message || "The archive couldn't be built.");
      setStage("pick");
    }
  };

  const clear = async () => {
    if (!jobs || confirmWord.trim().toUpperCase() !== "CLEAR") return;
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
        {counting ? "Counting…" : count ? `Build the archive · ${count} job${count === 1 ? "" : "s"}` : "Nothing to archive"}
      </Btn>
    </>
  ) : stage === "building" ? (
    <Btn variant="secondary" disabled>Building…</Btn>
  ) : stage === "built" ? (
    <>
      <Btn variant="secondary" onClick={onClose}>Keep the jobs</Btn>
      <Btn variant="primary" onClick={clear} disabled={confirmWord.trim().toUpperCase() !== "CLEAR"}>
        Clear {count} job{count === 1 ? "" : "s"} from the app
      </Btn>
    </>
  ) : stage === "clearing" ? (
    <Btn variant="secondary" disabled>Clearing…</Btn>
  ) : (
    <Btn variant="primary" onClick={onClose}>Done</Btn>
  );

  return (
    <Dialog title={title} maxWidth={560} onClose={busy ? () => {} : onClose} actions={actions}>
      <ErrorBox>{error}</ErrorBox>

      {stage === "pick" && (<>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
          Every job raised in the period, with its details as a text file, its hazard assessments and reports as the
          PDFs on file, and each ticket's field invoice — one folder per job, in one zip. Jobs are picked by the day
          they were raised. Nothing is changed in the app by building the archive.
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
            : jobs ? (count ? `${count} job${count === 1 ? "" : "s"} raised in ${rangeLabel}.` : `No jobs were raised in ${rangeLabel}.`)
            : ""}
        </div>
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
          Building reads every PDF over the connection, so a whole year can take a few minutes on a desk and is not
          something to start on a phone. Keep this dialog open until the download appears.
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
          <strong>Archive downloaded</strong> — {summary.jobs} job{summary.jobs === 1 ? "" : "s"}, {summary.tickets} ticket{summary.tickets === 1 ? "" : "s"}
          {" "}({money(summary.beforeGstCents / 100)} before GST), {summary.jhas} assessment PDF{summary.jhas === 1 ? "" : "s"}, {summary.reports} report PDF{summary.reports === 1 ? "" : "s"},
          {" "}{summary.invoices} invoice{summary.invoices === 1 ? "" : "s"} · {mb(summary.bytes)}.
        </div>
        {summary.missing.length > 0 && (
          <div style={{ fontSize: 12, border: "1px solid var(--color-accent-700)", padding: "8px 10px" }}>
            {summary.missing.length} item{summary.missing.length === 1 ? " was" : "s were"} not retrieved and {summary.missing.length === 1 ? "is" : "are"} listed in the zip's README.txt. Check that before clearing anything.
          </div>
        )}
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
          Open the zip and make sure it is what you expect before going on. Clearing removes these {summary.jobs} job{summary.jobs === 1 ? "" : "s"}
          {" "}and everything filed against them — tickets{summary.awaiting ? ` (${summary.awaiting} still out for the client's signature)` : ""},
          {" "}assessments, reports and their PDFs — from the app. The archive on your computer is then the only copy. This can't be undone.
        </div>
        <Field label='Type CLEAR to confirm'>
          <input className="input" value={confirmWord} onChange={e => setConfirmWord(e.target.value)} placeholder="CLEAR" autoComplete="off" disabled={stage === "clearing"} />
        </Field>
      </>)}

      {stage === "cleared" && cleared && (
        <div style={{ fontSize: 14 }}>
          <strong>Cleared.</strong> {cleared.jobs} job{cleared.jobs === 1 ? "" : "s"}, {cleared.tickets} ticket{cleared.tickets === 1 ? "" : "s"}, {cleared.jhas} assessment{cleared.jhas === 1 ? "" : "s"} and {cleared.reports} report{cleared.reports === 1 ? "" : "s"} are gone from the app.
          {cleared.filesLeft ? ` ${cleared.filesLeft} PDF${cleared.filesLeft === 1 ? "" : "s"} couldn't be removed from storage and can be cleaned up from the Supabase dashboard.` : " Their PDFs were removed from storage too."}
        </div>
      )}
    </Dialog>
  );
}

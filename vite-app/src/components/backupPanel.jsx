import React, { useState, useEffect, useCallback, useRef } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, Field, ErrorBox, Loading, TagX } from "./common.jsx";
import { BACKUP_PROVIDERS, PROVIDER_LABEL, redirectUriFor, readBackupOutcome } from "../backupPanelLogic.js";
import { describeSchedule, WEEKDAY_NAMES, nextRunAt, BACKUP_ZONE } from "../backupSchedule.js";

// Automatic backup — the Admin screen's Archive block, below the year-end
// dropdown, because they are the same question asked two ways: what happens
// to this work when the app is not the only copy of it any more.
//
// Everything real happens server-side. This screen connects a drive, sets a
// schedule, and reads back what the functions have been doing; it never
// holds a token, never holds a backup, and cannot see a client secret it
// has already saved — the state RPC answers "a secret is set", not the
// secret. So a blank secret box is the ordinary state and saving with one
// blank leaves the stored value alone.

const SECTION_TITLE = { fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16, marginBottom: 4 };
const SECTION_HELP = { fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 12, lineHeight: 1.5 };
const QUIET = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" };

const REGISTRATION = {
  google: {
    where: "console.cloud.google.com/apis/credentials",
    steps: "Create a project, turn on the Google Drive API, then Credentials → Create credentials → OAuth client ID → Web application. Paste the redirect URI below into “Authorised redirect URIs”."
  },
  microsoft: {
    where: "entra.microsoft.com → App registrations",
    steps: "New registration, accounts in any organisational directory and personal Microsoft accounts. Add a Web platform with the redirect URI below, then Certificates & secrets → New client secret."
  },
  dropbox: {
    where: "dropbox.com/developers/apps",
    steps: "Create app → Scoped access → Full Dropbox. On Permissions tick files.content.write, files.content.read and files.metadata.read. Add the redirect URI below under OAuth 2."
  }
};

const capitalise = p => `${p[0].toUpperCase()}${p.slice(1)}`;

const mb = bytes => `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
// Every other time in this feature is Grande Prairie's — the schedule the
// Admin sets, the folder each backup is stamped with, the hour the cron
// fires. A last-run line drawn on the browser's own clock would disagree
// with the folder name sitting beside it the moment anybody opened the panel
// from anywhere else.
const when = iso => iso
  ? new Date(iso).toLocaleString("en-CA", {
      timeZone: BACKUP_ZONE, day: "2-digit", month: "short", hour: "numeric", minute: "2-digit"
    })
  : "—";

// A run's phase, said the way somebody who has not read the code would say
// it. The restore's own phases are in here too, because the same progress
// box shows a restore.
const PHASE_WORDS = {
  tables: "copying the records",
  files: "copying the PDFs and pictures",
  manifest: "writing the index",
  retention: "tidying up old backups",
  safety: "taking a backup first",
  wipe: "emptying the app",
  accounts: "putting the accounts back",
  done: "finishing"
};

const KIND_WORDS = {
  backup: "Backup",
  before_restore: "Safety backup",
  restore_all: "Restore",
  restore_jobs: "Restoring jobs"
};

const rowsIn = counts => Object.values((counts && counts.rows) || {}).reduce((n, v) => n + Number(v || 0), 0);
const filesIn = counts => Number((counts && counts.files) || 0);
const bytesIn = counts => Number((counts && counts.bytes) || 0);

// While something is in flight the panel looks every few seconds; when
// nothing is, it looks rarely — this screen is left open.
const POLL_BUSY_MS = 4000;
const POLL_IDLE_MS = 20000;
// A nudge is a whole function invocation, so it is not sent on every poll.
// The slice chain does the work; this is for when the chain drops.
const NUDGE_EVERY_MS = 15000;

export function AutomaticBackupPanel() {
  const [state, setState] = useState(null);
  const [loadState, setLoadState] = useState("loading"); // loading | ready | failed
  const [error, setError] = useState("");
  // How the last connection ended, as the drive's own redirect reported it.
  // It is kept apart from `error` on purpose: `load()` clears `error` the
  // moment a read succeeds, and the read that follows the callback always
  // succeeds — so a reason put in `error` was wiped a heartbeat later and the
  // Admin was left reading "No drive connected." with nothing said about why.
  const [outcomeError, setOutcomeError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState("");
  const [showRegistration, setShowRegistration] = useState(false);
  const [form, setForm] = useState({
    frequency: "daily", weekday: 0, hour: 2, keep: 14,
    clientIdGoogle: "", clientSecretGoogle: "",
    clientIdMicrosoft: "", clientSecretMicrosoft: "",
    clientIdDropbox: "", clientSecretDropbox: ""
  });

  // A run in flight, and the poll that watches it. It is in a ref as well as
  // in state because the poll reschedules itself out of a closure: reading
  // `run` there would read whatever it was when the effect was set up, and
  // the interval would never change from idle to busy.
  const [run, setRun] = useState(null);
  const runRef = useRef(null);
  const nudgedAt = useRef(0);
  const [lastRuns, setLastRuns] = useState([]);
  const [starting, setStarting] = useState(false);

  const showRun = value => { runRef.current = value; setRun(value); };

  // `seed` is what makes this safe to call on a timer: the schedule boxes
  // are filled from the server once, and after that only a Save resets them.
  // Refreshing them on every read would rewrite what the Admin is halfway
  // through typing.
  const load = useCallback((seed = false) => {
    setLoadState(s => (s === "ready" ? s : "loading"));
    Db.backupState()
      .then(row => {
        setState(row);
        if (seed) {
          setForm(f => ({
            ...f,
            frequency: row.frequency || "daily",
            weekday: Number(row.weekday) || 0,
            hour: Number(row.hour) || 0,
            keep: Number(row.keep) || 14,
            clientIdGoogle: row.client_id_google || "",
            clientIdMicrosoft: row.client_id_microsoft || "",
            clientIdDropbox: row.client_id_dropbox || ""
          }));
          // backup_state answers with the run in flight, so the progress box
          // is there on the first paint rather than one poll later.
          if (runRef.current === null) showRun(row.active_run || null);
        }
        setLoadState("ready");
        setError("");
      })
      .catch(e => {
        setError(e.message || "Couldn't read the backup settings.");
        setLoadState("failed");
      });
  }, []);

  useEffect(() => { load(true); }, [load]);

  useEffect(() => {
    let alive = true;
    let timer = null;
    const look = async () => {
      try {
        const open = await Db.currentBackupRun();
        if (!alive) return;
        const had = runRef.current;
        showRun(open);
        if (open) {
          if (Date.now() - nudgedAt.current > NUDGE_EVERY_MS) {
            nudgedAt.current = Date.now();
            Db.nudgeBackup();
          }
        } else if (had) {
          // Something finished while this screen was open: what it says now
          // is the last-run line and the list behind it.
          setLastRuns(await Db.listBackupRuns(5));
          load();
        }
      } catch { /* a failed poll is not worth an error box */ }
      if (alive) timer = setTimeout(look, runRef.current ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    Db.listBackupRuns(5).then(rows => { if (alive) setLastRuns(rows); }).catch(() => {});
    look();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [load]);

  const backUpNow = async () => {
    setStarting(true);
    setError("");
    try {
      await Db.backupNow();
      showRun(await Db.currentBackupRun());
    } catch (e) {
      setError(e.message || "The backup couldn't be started.");
    } finally {
      setStarting(false);
    }
  };

  // Coming back from the drive's consent screen. The function redirects to
  // /?backup=connected (or =denied, or =failed&why=…); say so, then take the
  // query off the address bar so a refresh does not repeat the message.
  useEffect(() => {
    const { outcome, why, rest } = readBackupOutcome(window.location.search);
    if (!outcome) return;
    if (outcome === "connected") setNotice("The drive is connected. The first backup runs at the next scheduled time.");
    else if (outcome === "denied") setNotice("The drive was not connected: the consent screen was cancelled.");
    else setOutcomeError(why || "The drive couldn't be connected.");
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));
    load();
  }, [load]);

  const set = (key, value) => { setForm(p => ({ ...p, [key]: value })); setError(""); };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await Db.saveBackupSettings({ ...form, connected: !!(state && state.connected) });
      // The secrets were written; forget the typed copies so the boxes go
      // back to their ordinary blank state.
      setForm(f => ({ ...f, clientSecretGoogle: "", clientSecretMicrosoft: "", clientSecretDropbox: "" }));
      // A Save is the one thing that refills these boxes from the server:
      // what comes back is the schedule as the database clamped it.
      load(true);
    } catch (e) {
      setError(e.message || "Couldn't save the backup settings.");
    } finally {
      setSaving(false);
    }
  };

  const connect = async provider => {
    setConnecting(provider);
    setError("");
    // A fresh attempt: how the last one ended is no longer the answer.
    setOutcomeError("");
    setNotice("");
    try {
      window.location.assign(await Db.backupOauthStartUrl(provider));
    } catch (e) {
      setError(e.message || "Couldn't start the connection.");
      setConnecting("");
    }
  };

  const disconnect = async () => {
    setError("");
    setOutcomeError("");
    setNotice("");
    try { await Db.disconnectBackup(); load(); }
    catch (e) { setError(e.message || "Couldn't disconnect the drive."); }
  };

  if (loadState === "loading") {
    return <Blueprint style={{ padding: "18px 20px", marginTop: 16 }}><Loading label="Loading the backup settings…" /></Blueprint>;
  }

  const s = state || {};
  const connected = !!s.connected;

  return (
    <Blueprint style={{ padding: "18px 20px", marginTop: 16 }}>
      <div style={SECTION_TITLE}>Automatic backup</div>
      <div style={SECTION_HELP}>
        A copy of everything &mdash; every job, ticket, assessment, report and their PDFs &mdash; written to one
        drive account of your own on a schedule, and restorable from the same place. The app does the
        copying on its own server: nothing is downloaded to this computer and nothing is uploaded from it.
        The backup contains the crew&rsquo;s hours and dose readings and every client&rsquo;s pricing, so
        connect an account that belongs to the business.
      </div>

      {/* Two boxes, on purpose. The first is how the connection attempt ended
          — it arrived on the address bar and is only ever cleared by pressing
          Connect or Disconnect again. The second is this screen's own reading
          and saving, which clears itself. */}
      <ErrorBox>{outcomeError}</ErrorBox>
      <ErrorBox>{error}</ErrorBox>
      {notice && <div style={{ fontSize: 13, marginBottom: 12, color: "var(--color-accent)" }}>{notice}</div>}

      {/* The provider row. Only one drive is ever connected, so while one is
          there the other two are not offered: switching means Disconnect
          first, which is also what clears the old drive's token. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        {connected ? (
          <>
            <TagX variant="outline">{PROVIDER_LABEL[s.provider] || s.provider}</TagX>
            <span style={{ fontSize: 14 }}>Connected as <strong>{s.account || "—"}</strong></span>
            <Btn variant="secondary" style={{ marginLeft: "auto" }} onClick={disconnect}>Disconnect</Btn>
          </>
        ) : (
          <>
            <span style={{ fontSize: 14 }}>No drive connected.</span>
            {BACKUP_PROVIDERS.map(p => (
              <Btn key={p} variant="secondary" disabled={!!connecting} onClick={() => connect(p)}>
                {connecting === p ? "Opening…" : `Connect ${PROVIDER_LABEL[p]}`}
              </Btn>
            ))}
          </>
        )}
      </div>

      {s.connection_error && (
        <div style={{ fontSize: 13, border: "1px solid var(--color-accent-700)", padding: "8px 10px", marginBottom: 10 }}>
          <strong>The drive needs reconnecting.</strong> {s.connection_error} Press Disconnect and connect it again;
          backups are not running until you do.
        </div>
      )}

      {/* Schedule */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 12 }}>
        <Field label="How often">
          <select className="input" value={form.frequency} onChange={e => set("frequency", e.target.value)}>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays only</option>
            <option value="weekly">Once a week</option>
            <option value="monthly">Once a month</option>
          </select>
        </Field>
        {form.frequency === "weekly" && (
          <Field label="Day">
            <select className="input" value={form.weekday} onChange={e => set("weekday", Number(e.target.value))}>
              {WEEKDAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </Field>
        )}
        <Field label="At">
          <select className="input" value={form.hour} onChange={e => set("hour", Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
            ))}
          </select>
        </Field>
        <Field label="Keep this many">
          <input className="input" type="number" min="1" max="365" value={form.keep}
            onChange={e => set("keep", e.target.value)} />
        </Field>
      </div>

      <div style={{ ...QUIET, marginBottom: 12 }}>
        {describeSchedule(form)}. Older backups beyond the {plural(Number(form.keep) || 14, "most recent")} are
        removed after each successful run &mdash; except the copies taken automatically just before a restore,
        which are never tidied away.
        {connected && <> Next due <strong>{when(s.next_run_at || nextRunAt(form, Date.now()))}</strong>.</>}
      </div>

      {/* Back up now, and what happened last time */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <Btn variant="secondary" disabled={!connected || starting || !!run} onClick={backUpNow}>
          {starting ? "Starting…" : run ? "A run is already going" : "Back up now"}
        </Btn>
        {!connected && <span style={QUIET}>Connect a drive first.</span>}
      </div>

      {run && (
        <div style={{ border: "1px solid var(--color-accent)", padding: "10px 12px", marginBottom: 12, fontSize: 13 }}>
          <strong>{KIND_WORDS[run.kind] || run.kind} in progress</strong>
          {run.folder_name ? <> &middot; {run.folder_name}</> : null}
          <div style={{ marginTop: 4 }}>
            {PHASE_WORDS[run.phase] || run.phase || "starting"} &middot; {plural(rowsIn(run.counts), "record")},
            {" "}{plural(filesIn(run.counts), "file")} ({mb(bytesIn(run.counts))}) so far.
          </div>
          <div style={{ ...QUIET, marginTop: 4 }}>
            It keeps going on the server whether this screen is open or not &mdash; a big first backup can take an hour.
          </div>
        </div>
      )}

      {!run && s.last_run && (
        <div style={{ fontSize: 13, marginBottom: 12 }}>
          <strong>Last {(KIND_WORDS[s.last_run.kind] || "run").toLowerCase()}:</strong>{" "}
          {s.last_run.status === "complete" ? (
            <>finished {when(s.last_run.finished_at)} &middot; {s.last_run.folder_name} &middot;{" "}
              {plural(rowsIn(s.last_run.counts), "record")}, {plural(filesIn(s.last_run.counts), "file")}{" "}
              ({mb(bytesIn(s.last_run.counts))}).</>
          ) : (
            <span style={{ color: "var(--color-accent-700)" }}>
              failed {when(s.last_run.finished_at)} &mdash; {s.last_run.error || "no reason recorded"}. The next
              scheduled backup will still run.
            </span>
          )}
        </div>
      )}

      {lastRuns.length > 1 && (
        <details style={{ marginBottom: 12 }}>
          <summary style={QUIET}>Earlier runs</summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {lastRuns.map(r => (
              <div key={r.id} style={{ fontSize: 12, display: "flex", gap: 8, alignItems: "center" }}>
                <TagX variant="outline">{KIND_WORDS[r.kind] || r.kind}</TagX>
                <span>{r.folder_name || "—"}</span>
                <span style={{ marginLeft: "auto" }}>{r.status} &middot; {when(r.finished_at || r.created_at)}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* App registration — collapsed, because it is done once and never
          again, and it is the fiddliest thing on this screen. */}
      <Btn variant="secondary" onClick={() => setShowRegistration(v => !v)}>
        {showRegistration ? "Hide app registration" : "App registration"}
      </Btn>

      {showRegistration && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={SECTION_HELP}>
            Each drive needs its own free app registration under your account &mdash; that is what lets this app
            write to it. Do the one you mean to use and ignore the other two. Paste the redirect URI shown
            beneath each one into that provider&rsquo;s registration exactly as it appears.
          </div>
          {BACKUP_PROVIDERS.map(p => {
            const r = REGISTRATION[p];
            const idKey = `clientId${capitalise(p)}`;
            const secretKey = `clientSecret${capitalise(p)}`;
            const hasSecret = !!s[`has_secret_${p}`];
            return (
              <div key={p} style={{ border: "1px solid var(--color-neutral-300)", padding: "12px 14px" }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{PROVIDER_LABEL[p]}</div>
                <div style={{ ...QUIET, marginBottom: 10 }}>{r.where} &mdash; {r.steps}</div>
                <Field label="Redirect URI (paste this into the registration)">
                  <input className="input" readOnly value={redirectUriFor(s, p, window.location.origin)}
                    onFocus={e => e.target.select()} style={{ width: "100%" }} />
                </Field>
                {!String(s.approval_base_url || "").trim() && (
                  <div style={{ ...QUIET, marginTop: 4 }}>
                    App address is blank above, so that line is this window&rsquo;s own address. If the app is
                    reached on some other address, fill in App address first &mdash; the drive compares the two
                    character for character.
                  </div>
                )}
                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                  <Field label="Client ID">
                    <input className="input" value={form[idKey]} autoComplete="off"
                      onChange={e => set(idKey, e.target.value)} style={{ width: "100%" }} />
                  </Field>
                  <Field label="Client secret">
                    <input className="input" type="password" value={form[secretKey]} autoComplete="off"
                      placeholder={hasSecret ? "saved — leave blank to keep it" : "from the registration"}
                      onChange={e => set(secretKey, e.target.value)} style={{ width: "100%" }} />
                  </Field>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
        {loadState === "failed" && <Btn variant="secondary" onClick={load}>Try loading again</Btn>}
        <Btn variant="primary" disabled={saving || loadState !== "ready"} onClick={save}>
          {saving ? "Saving…" : "Save backup settings"}
        </Btn>
      </div>
    </Blueprint>
  );
}

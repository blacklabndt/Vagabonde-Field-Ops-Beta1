import React, { useState, useEffect, useCallback } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, Field, ErrorBox, Loading, TagX } from "./common.jsx";
import { BACKUP_PROVIDERS, PROVIDER_LABEL, redirectUriFor, readBackupOutcome } from "../backupPanelLogic.js";

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

export function AutomaticBackupPanel() {
  const [state, setState] = useState(null);
  const [loadState, setLoadState] = useState("loading"); // loading | ready | failed
  const [error, setError] = useState("");
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

  const load = useCallback(() => {
    setLoadState(s => (s === "ready" ? s : "loading"));
    Db.backupState()
      .then(row => {
        setState(row);
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
        setLoadState("ready");
        setError("");
      })
      .catch(e => {
        setError(e.message || "Couldn't read the backup settings.");
        setLoadState("failed");
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Coming back from the drive's consent screen. The function redirects to
  // /?backup=connected (or =denied, or =failed&why=…); say so, then take the
  // query off the address bar so a refresh does not repeat the message.
  useEffect(() => {
    const { outcome, why, rest } = readBackupOutcome(window.location.search);
    if (!outcome) return;
    if (outcome === "connected") setNotice("The drive is connected. The first backup runs at the next scheduled time.");
    else if (outcome === "denied") setNotice("The drive was not connected: the consent screen was cancelled.");
    else setError(why || "The drive couldn't be connected.");
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
      load();
    } catch (e) {
      setError(e.message || "Couldn't save the backup settings.");
    } finally {
      setSaving(false);
    }
  };

  const connect = async provider => {
    setConnecting(provider);
    setError("");
    try {
      window.location.assign(await Db.backupOauthStartUrl(provider));
    } catch (e) {
      setError(e.message || "Couldn't start the connection.");
      setConnecting("");
    }
  };

  const disconnect = async () => {
    setError("");
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

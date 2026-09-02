import React, { useState, useEffect } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, Field, ErrorBox, Loading } from "./common.jsx";

// Admin — every key and address the app needs to be fully alive, in one
// screen, each with the instructions for getting it. The software ships to
// a client whose admin will never run a CLI: what used to be Supabase
// secrets is now this screen writing the app_settings row, with the env
// secrets left as silent fallback for anything a column leaves blank.
//
// The sections are ordered by how much the crew feels their absence:
// email first (reports and billing approvals), then the approval-link
// address, then chat GIFs. Push notifications close it out read-only —
// their keys are baked into the app at build time and are not a thing an
// admin obtains from a vendor.

const SECTION_TITLE = { fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16, marginBottom: 4 };
const SECTION_HELP = { fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 12, lineHeight: 1.5 };

export function AdminSetupScreen() {
  const [form, setForm] = useState({
    resendApiKey: "", fromReports: "", fromBilling: "", replyTo: "",
    klipyApiKey: "", approvalBaseUrl: ""
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    let live = true;
    Db.getAppSettings()
      .then(row => {
        if (!live) return;
        setForm({
          resendApiKey: row.resend_api_key || "",
          fromReports: row.from_reports || "",
          fromBilling: row.from_billing || "",
          replyTo: row.reply_to || "",
          klipyApiKey: row.klipy_api_key || "",
          approvalBaseUrl: row.approval_base_url || ""
        });
      })
      .catch(e => { if (live) setError(e.message || "Couldn't load the settings."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const set = (key, value) => { setForm(p => ({ ...p, [key]: value })); setError(""); };

  const save = async () => {
    setSaving(true);
    setError("");
    try { await Db.saveAppSettings(form); }
    catch (e) { setError(e.message || "Couldn't save the settings."); }
    finally { setSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    setError("");
    setTestResult(null);
    try { setTestResult(await Db.sendTestEmail(testTo)); }
    catch (e) { setError(e.message || "The test send failed."); }
    finally { setTesting(false); }
  };

  const emailTestingMode = !form.fromReports.trim();

  if (loading) return <div className="page"><Loading label="Loading settings…" /></div>;

  return (
    <div className="page">
      <div style={{ marginBottom: 6 }}>
        <h2 style={{ fontSize: 34, margin: 0 }}>Admin</h2>
      </div>
      <p style={{ maxWidth: 640, marginTop: 0, fontSize: 14, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
        The keys and addresses the app needs to be fully working, and where each one comes from.
        Everything here is Admin-only; save applies immediately, no restart needed.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
        <ErrorBox>{error}</ErrorBox>

        <Blueprint style={{ padding: "18px 20px" }}>
          <div style={SECTION_TITLE}>Email — reports &amp; billing approvals</div>
          <div style={SECTION_HELP}>
            Sent through <a href="https://resend.com" target="_blank" rel="noreferrer">Resend</a>.
            Create a free account (3,000 emails/month), then <strong>API Keys → Create API Key</strong> with
            sending access, and paste it here — that alone sends test emails to the Resend account&rsquo;s
            own inbox, today. To email clients for real: <strong>Domains → Add Domain</strong>, add the DNS
            records Resend shows you at your domain host, wait for it to verify, then fill in the two
            sending addresses below.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Resend API key">
              <input className="input" type="password" value={form.resendApiKey}
                onChange={e => set("resendApiKey", e.target.value)}
                placeholder="re_…" autoComplete="off" style={{ width: "100%" }} />
            </Field>
            <Field label="Reports come from">
              <input className="input" value={form.fromReports}
                onChange={e => set("fromReports", e.target.value)}
                placeholder="reports@your-domain.ca — blank until the domain is verified"
                style={{ width: "100%" }} />
            </Field>
            <Field label="Billing comes from">
              <input className="input" value={form.fromBilling}
                onChange={e => set("fromBilling", e.target.value)}
                placeholder="billing@your-domain.ca — blank until the domain is verified"
                style={{ width: "100%" }} />
            </Field>
            <Field label="Replies go to">
              <input className="input" value={form.replyTo}
                onChange={e => set("replyTo", e.target.value)}
                placeholder="a real mailbox someone reads, so a contractor can just hit reply"
                style={{ width: "100%" }} />
            </Field>
            {emailTestingMode && form.resendApiKey.trim() && (
              <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                No sending address yet, so mail goes out from Resend&rsquo;s onboarding sender —
                deliverable only to the Resend account owner&rsquo;s own email until the domain is
                verified. Right for testing, not for clients.
              </div>
            )}
          </div>
        </Blueprint>

        <Blueprint style={{ padding: "18px 20px" }}>
          <div style={SECTION_TITLE}>Approval links — the app&rsquo;s public address</div>
          <div style={SECTION_HELP}>
            A billing approval email carries a link the client&rsquo;s rep taps to sign. That link
            points at the address below — the URL this app is hosted at, with no path on the end.
            Left blank, links fall back to a plain, unstyled page that still works but looks like a
            technical document rather than an invoice.
          </div>
          <Field label="App address">
            <input className="input" value={form.approvalBaseUrl}
              onChange={e => set("approvalBaseUrl", e.target.value)}
              placeholder={window.location.origin}
              style={{ width: "100%" }} />
          </Field>
          <div style={{ fontSize: 12, marginTop: 8, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            You&rsquo;re reading the app at <span className="tabular">{window.location.origin}</span> right
            now — that&rsquo;s almost always the value to put here.
          </div>
        </Blueprint>

        <Blueprint style={{ padding: "18px 20px" }}>
          <div style={SECTION_TITLE}>Team chat GIFs</div>
          <div style={SECTION_HELP}>
            The chat&rsquo;s GIF picker searches <a href="https://klipy.com" target="_blank" rel="noreferrer">KLIPY</a>.
            Sign up for their free developer account, create an app, and paste its API key here.
            Entirely optional — without it, chat works fine and the GIF button explains itself.
          </div>
          <Field label="KLIPY API key">
            <input className="input" type="password" value={form.klipyApiKey}
              onChange={e => set("klipyApiKey", e.target.value)}
              placeholder="from klipy.com — optional" autoComplete="off" style={{ width: "100%" }} />
          </Field>
        </Blueprint>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save settings"}</Btn>
        </div>

        <Blueprint style={{ padding: "18px 20px" }}>
          <div style={SECTION_TITLE}>Send a test email</div>
          <div style={SECTION_HELP}>
            Goes through the same path as a real report, so a delivered test means the email setup is
            done. Save the settings first.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="input" value={testTo} onChange={e => setTestTo(e.target.value)}
              placeholder="you@example.com" style={{ flex: "1 1 240px", minWidth: 200 }} />
            <Btn variant="secondary" disabled={testing || !testTo.trim()} onClick={sendTest}>
              {testing ? "Sending…" : "Send test email"}
            </Btn>
          </div>
          {testResult && (
            <div style={{ fontSize: 13, marginTop: 10, color: "var(--color-accent)" }}>
              Sent, from {testResult.from}. {String(testResult.from).includes("resend.dev")
                ? "That's the test sender — it only reaches the Resend account owner's inbox until the domain is verified."
                : "Check the inbox (and spam, the first time)."}
            </div>
          )}
        </Blueprint>

        <Blueprint style={{ padding: "18px 20px" }}>
          <div style={SECTION_TITLE}>Push notifications — nothing to do here</div>
          <div style={{ ...SECTION_HELP, marginBottom: 0 }}>
            Chat notifications are already configured: their signing keys are built into the app
            itself and the matching secret lives on the server, set up when the app was deployed.
            There&rsquo;s no vendor account and no key to paste — each person just allows
            notifications on their own device from Team chat. If they ever need to change, that&rsquo;s
            a developer task (new keys mean every device re-allows notifications), not a setting here.
          </div>
        </Blueprint>

        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
          Two settings live outside the app, in the Supabase dashboard, because they guard sign-in
          itself: the <strong>Site URL</strong> (Authentication → URL Configuration — where
          password-reset links land) and <strong>leaked-password protection</strong> (Authentication →
          Policies). The setup document covers both.
        </div>
      </div>
    </div>
  );
}

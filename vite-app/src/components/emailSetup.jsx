import React, { useState, useEffect } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, Field, ErrorBox, Loading } from "./common.jsx";

// Email setup — the Admin screen that replaces a developer's terminal.
//
// The app ships to a client whose admin will never run a CLI: everything
// the send functions need lives in the mail_settings row this screen
// edits, and the "Send test email" button proves the pipework through the
// exact path real reports and approvals take.
//
// Two stages, and the copy explains which one you're in:
// - Key only: sends work immediately from Resend's onboarding sender, but
//   only to the Resend account owner's own inbox — enough to see it work
//   today.
// - Domain verified + addresses filled in: mail goes anywhere, from the
//   company's own name.
export function EmailSetupScreen() {
  const [form, setForm] = useState({ resendApiKey: "", fromReports: "", fromBilling: "", replyTo: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    let live = true;
    Db.getMailSettings()
      .then(row => {
        if (!live) return;
        setForm({
          resendApiKey: row.resend_api_key || "",
          fromReports: row.from_reports || "",
          fromBilling: row.from_billing || "",
          replyTo: row.reply_to || ""
        });
      })
      .catch(e => { if (live) setError(e.message || "Couldn't load the email settings."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const set = (key, value) => { setForm(p => ({ ...p, [key]: value })); setError(""); };

  const save = async () => {
    setSaving(true);
    setError("");
    try { await Db.saveMailSettings(form); }
    catch (e) { setError(e.message || "Couldn't save the email settings."); }
    finally { setSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    setError("");
    setTestResult(null);
    try {
      const res = await Db.sendTestEmail(testTo);
      setTestResult(res);
    } catch (e) {
      setError(e.message || "The test send failed.");
    } finally { setTesting(false); }
  };

  const testingMode = !form.fromReports.trim();

  if (loading) return <div className="page"><Loading label="Loading email settings…" /></div>;

  return (
    <div className="page">
      <div style={{ marginBottom: 6 }}>
        <h2 style={{ fontSize: 34, margin: 0 }}>Email setup</h2>
      </div>
      <p style={{ maxWidth: 640, marginTop: 0, fontSize: 14, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
        Report emails and billing approval links are sent through{" "}
        <a href="https://resend.com" target="_blank" rel="noreferrer">Resend</a>. Create a free
        account there, make an API key (API Keys → Create, sending access), and paste it below —
        that alone is enough to send test emails to the Resend account&rsquo;s own inbox. To email
        clients and contractors for real, also verify your company&rsquo;s domain in Resend
        (Domains → Add, then add the records it shows to your DNS) and fill in the sending
        addresses.
      </p>

      <Blueprint style={{ padding: "18px 20px", maxWidth: 640 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <ErrorBox>{error}</ErrorBox>
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
          {testingMode && form.resendApiKey.trim() && (
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              No sending address yet, so mail goes out from Resend&rsquo;s onboarding sender —
              deliverable only to the Resend account owner&rsquo;s own email until the domain is
              verified. Right for testing, not for clients.
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn variant="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save settings"}</Btn>
          </div>
        </div>
      </Blueprint>

      <Blueprint style={{ padding: "18px 20px", maxWidth: 640, marginTop: 16 }}>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, marginBottom: 8 }}>
          Send a test email
        </div>
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 10 }}>
          Goes through the same path as a real report, so a delivered test means the setup is done.
          Save the settings first.
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
    </div>
  );
}

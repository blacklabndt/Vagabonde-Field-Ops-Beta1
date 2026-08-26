import React, { useState } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, TagX, ErrorBox, emailIn, NoJobSelected, ConnectionBar, QueuedPanel } from "./common.jsx";
import { OfflineQueue } from "../offlineQueue.js";

export function UploadMobileScreen({ job, jobRecord, currentUser, onSent }) {
  const [items, setItems] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(false);
  // Typed inline rather than through prompt(): a native prompt is a no-op in
  // some embedded preview hosts (it returns immediately with no dialog), and
  // on a phone it hides the file it is asking about behind a system sheet.
  // Declared before the early returns below — hooks must run in the same
  // order every render, and the moment setQueued(true) fired, the next
  // render returned early, called one hook fewer, and React threw instead
  // of showing the queued panel.
  const [weldDraft, setWeldDraft] = useState({});
  if (queued) return <QueuedPanel what="the report" onDone={onSent} />;
  if (!job) return <NoJobSelected what="a report" />;

  const attach = e => {
    const f = e.target.files[0];
    // Clear the input, or picking the same file twice in a row fires no
    // change event and looks like the app ignored the second tap.
    e.target.value = "";
    if (!f) return;
    // A stable key per attachment, not the array index: everything below —
    // the row, its weld chips, its half-typed draft — is keyed by it, so
    // removing one file can't shift another file's state onto the wrong row.
    const key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    setItems(p => [...p, { key, file: f, welds: [], state: "Queued" }]);
  };
  const addWeld = key => {
    const w = (weldDraft[key] || "").trim();
    if (!w) return;
    setItems(p => p.map(it => it.key === key ? { ...it, welds: [...it.welds, w] } : it));
    setWeldDraft(p => ({ ...p, [key]: "" }));
  };
  const removeWeld = (key, weld) =>
    setItems(p => p.map(it => it.key === key ? { ...it, welds: it.welds.filter(w => w !== weld) } : it));
  const removeItem = key => {
    setItems(p => p.filter(it => it.key !== key));
    setWeldDraft(p => { const next = { ...p }; delete next[key]; return next; });
  };

  const recipient = emailIn(jobRecord.contractorRep);

  const sendAll = async () => {
    if (!items.length) return;
    setSending(true);
    setError("");
    let failedAt = null;
    let queuedCount = 0;
    try {
      for (const it of items) {
        try {
          // Each file leaves the list the moment it is safely stored (or
          // queued), not when the whole loop finishes — a failure on the
          // second file used to keep the first one in the list, and the
          // retry filed it again, report row, email and all.
          // `send` stamps `sent_at` on the row; it does not send anything. This
          // screen used to pass `send: true` and no email, so every report from
          // a phone was recorded as delivered to the contractor while nothing
          // ever left the building. Store first, then actually email.
          const report = await Db.uploadReport({
            jobDbId: job.dbId, jobNumber: job.id, file: it.file,
            welds: it.welds.join(", "), result: "Accept", interpretedBy: currentUser.name,
            send: false, sendTo: recipient
          });
          if (recipient) {
            try {
              await Db.sendReportEmail({ reportId: report.id, to: recipient, cc: "", message: "" });
            } catch (mailErr) {
              failedAt = mailErr.message || "the email service didn't respond.";
            }
          }
        } catch (e) {
          if (!OfflineQueue.isNetworkError(e)) throw e;
          await OfflineQueue.enqueue("report", {
            jobDbId: job.dbId, jobNumber: job.id, file: it.file,
            welds: it.welds.join(", "), interpretedBy: currentUser.name, recipient
          });
          queuedCount++;
        }
        // Stored or queued — either way this file is accounted for. Only a
        // thrown non-network error skips this, leaving exactly the
        // unaccounted files in the list for the retry.
        removeItem(it.key);
      }
      if (queuedCount) {
        setQueued(true);
      } else if (!recipient) {
        setError("Uploaded. No contractor email is on this job, so nothing was sent — add one in the job record and send from Job detail.");
      } else if (failedAt) {
        setError(`Uploaded, but the email didn't go out: ${failedAt} The reports are on file and show as Pending.`);
      } else {
        onSent();
      }
    } catch (e) {
      setError(e.message || "Couldn't upload — try again.");
    }
    setSending(false);
  };

  return (
    <div className="page">
      <div className="phone-shell">
        <Blueprint className="phone-frame">
          <ConnectionBar />
          <div>
            <div className="kicker">{job.id} · Report upload</div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 22 }}>{job.project}</div>
          </div>

          <div className="blueprint" style={{ borderStyle: "dashed", padding: 16, textAlign: "center", position: "relative", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
            Tap to attach a PDF
            <input type="file" accept="application/pdf" style={{ position: "absolute", inset: 0, opacity: 0 }} onChange={attach} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map(it => (
              <div key={it.key} className="blueprint" style={{ padding: 10, position: "relative" }}>
                <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="pdf-glyph" style={{ width: 20, height: 26 }}>PDF</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.file.name}</div>
                    <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{(it.file.size / 1e6).toFixed(1)} MB · {currentUser.name}</div>
                  </div>
                  <TagX variant="neutral">{it.state}</TagX>
                  <button type="button" className="row-x" aria-label={`Remove ${it.file.name}`}
                    onClick={() => removeItem(it.key)}>×</button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
                  {it.welds.map(w => (
                    <button key={w} type="button" className="tag tag-neutral"
                      title={`Remove ${w}`} aria-label={`Remove weld ${w}`}
                      style={{ cursor: "pointer", background: "none" }}
                      onClick={() => removeWeld(it.key, w)}>{w} ×</button>
                  ))}
                  <input className="input" value={weldDraft[it.key] || ""} placeholder="+ weld"
                    aria-label={`Add a weld ID to ${it.file.name}`}
                    style={{ width: 110, minHeight: 34, fontSize: 12 }}
                    onChange={e => setWeldDraft(p => ({ ...p, [it.key]: e.target.value }))}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addWeld(it.key); } }}
                    onBlur={() => addWeld(it.key)} />
                </div>
              </div>
            ))}
            {items.length === 0 && <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Nothing attached yet.</div>}
          </div>

          <div style={{ fontSize: 11, color: recipient ? "color-mix(in srgb, var(--color-text) 55%, transparent)" : "var(--color-accent-700)" }}>
            {recipient
              ? `To: ${jobRecord.contractorRep}`
              : "No contractor email on this job — files will upload, but nothing will be sent."}
          </div>
          <ErrorBox>{error}</ErrorBox>
          <Btn variant="primary" block style={{ minHeight: 56, fontSize: 15 }} onClick={sendAll} disabled={sending || !items.length}>
            {sending ? "Sending…" : `Send package (${items.length} files)`}
          </Btn>
        </Blueprint>

        <div className="phone-explain">
          <p>The phone equivalent of the upload dialog — attach the interpreted PDF, tag which welds it covers, send. Each file uploads to the private <code>reports</code> storage bucket and writes a real row.</p>
        </div>
      </div>
    </div>
  );
}


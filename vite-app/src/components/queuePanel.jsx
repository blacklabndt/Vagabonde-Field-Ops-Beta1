import React, { useState } from "react";
import { Blueprint, Btn, TagX, Dialog, ErrorBox } from "./common.jsx";
import { OfflineQueue } from "../offlineQueue.js";

// What's still waiting to reach the database, and — the part that was missing
// — what has stopped trying.
//
// The queue already recorded why an item failed; nothing ever showed it. A
// ticket that will never sync (its job was completed while the crew was out
// of range) counted in the same "3 queued" badge as one that was about to go
// through, and the panel promised both would send automatically. The person
// who raised it found out when the invoice didn't.

const LABELS = {
  job: "New job",
  jha: "Hazard assessment",
  report: "Radiographic report",
  ticket: "Billing ticket"
};

const describe = item => {
  const what = LABELS[item.type] || item.type;
  const p = item.payload || {};
  if (item.type === "job") return `${what} ${p.jobNumber || ""}${p.project ? " · " + p.project : ""}`.trim();
  if (item.type === "ticket") return `${what}${p.ticketId ? " " + p.ticketId : ""}${p.workDate ? " · " + p.workDate : ""}`;
  if (item.type === "report") return `${what}${p.file && p.file.name ? " · " + p.file.name : ""}${p.jobNumber ? " · " + p.jobNumber : ""}`;
  return what;
};

const ago = ts => {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
};

// The top-bar badge. Two states, deliberately different: waiting is
// reassurance, stuck is a call to action.
export function QueueBadge({ items, onOpen }) {
  const stuck = items.filter(i => i.lastError);
  if (!items.length) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={stuck.length ? "tag tag-accent" : "tag tag-outline"}
      style={{ cursor: "pointer", background: stuck.length ? undefined : "none", font: "inherit" }}
      title={stuck.length
        ? `${stuck.length} item${stuck.length === 1 ? "" : "s"} couldn't sync — tap for the reason`
        : "Saved on this device — syncing automatically once you're back in range"}
    >
      {stuck.length ? `${stuck.length} won't sync` : `${items.length} queued`}
    </button>
  );
}

export function QueueDialog({ items, onRetry, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stuck = items.filter(i => i.lastError);
  const waiting = items.filter(i => !i.lastError);

  const retry = async () => {
    setBusy(true);
    setError("");
    try { await onRetry(); }
    catch (e) { setError(e.message || "Still couldn't sync."); }
    setBusy(false);
  };

  const discard = async item => {
    if (!confirm(`Discard this ${(LABELS[item.type] || item.type).toLowerCase()}? It has never reached the database, and nothing else holds a copy of it. This can't be undone.`)) return;
    setError("");
    try { await OfflineQueue.remove(item.id); }
    catch (e) { setError(e.message || "Couldn't discard that item."); }
  };

  return (
    <Dialog title="Waiting to sync" maxWidth={560} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
        <Btn variant="primary" onClick={retry} disabled={busy || !items.length}>
          {busy ? "Trying…" : "Try again now"}
        </Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>

      {!items.length && (
        <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
          Everything has synced. Nothing is waiting on this device.
        </div>
      )}

      {stuck.length > 0 && (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)" }}>
            Stopped — needs a decision
          </div>
          <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            These reached the database and were refused, so waiting for signal won't help. Fix what the message describes and try again, or discard the item if it is no longer wanted.
          </div>
          {stuck.map(item => (
            <Blueprint key={item.id} style={{ padding: "12px 14px", display: "grid", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>{describe(item)}</span>
                <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>saved {ago(item.createdAt)}</span>
                <Btn variant="ghost" style={{ marginLeft: "auto" }} onClick={() => discard(item)}>Discard</Btn>
              </div>
              <div style={{ fontSize: 13, color: "var(--color-accent-700)" }}>{item.lastError}</div>
            </Blueprint>
          ))}
        </>
      )}

      {waiting.length > 0 && (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            Waiting for signal
          </div>
          {waiting.map(item => (
            <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, padding: "4px 0" }}>
              <TagX variant="outline">queued</TagX>
              <span>{describe(item)}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>saved {ago(item.createdAt)}</span>
            </div>
          ))}
        </>
      )}
    </Dialog>
  );
}

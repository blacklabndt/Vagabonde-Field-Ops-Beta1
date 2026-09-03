import React from "react";
import { Blueprint, Btn, TableScroll, StatusTag } from "./common.jsx";
import { money, seesPrices } from "../data.js";

// Open tickets — the tickets this person still has to send out to the
// client: their drafts, and nothing else. Per Kyle. A ticket that has gone
// out is the client's to sign and the office's to chase (the Billing tracker
// covers every technician's tickets); once it has left the truck it has no
// business on this list, and the drawer badge counts the same set.

export function OpenTicketsScreen({ tickets, loading, onOpenTicket, currentUser, openJhas = [], onOpenJob = null }) {
  const open = tickets.filter(t => t.status === "Draft");
  // Integer-cents sum, per the house money rule (gstOn in data.js) — never
  // a running float of dollars, which drifts a half-cent low at some totals.
  const sum = arr => arr.reduce((s, t) => s + Math.round(t.amount * 100), 0) / 100;
  // The one price rule (data.js): Admins and Technicians see amounts, nobody
  // else does. This screen used to say Admin-or-Coordinator, which hid a
  // technician's own totals and showed a Coordinator figures the database
  // refuses them everywhere else.
  const showAmounts = seesPrices(currentUser);
  const oldest = open.reduce((m, t) => Math.max(m, t.age || 0), 0);

  return (
    <div className="page">
      <div style={{ marginBottom: 20 }}>
        <div className="kicker">My tickets</div>
        <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Open tickets</h2>
        <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginTop: 4 }}>
          Your tickets that still have to go out to the client. Once a ticket is sent it leaves this list.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16, marginBottom: 20 }} className="grid-2col">
        <Blueprint className="stat-tile">
          <div className="stat-label">Still to send</div>
          <div className="stat-figure" style={{ color: open.length ? "var(--color-accent-700)" : "inherit" }}>{open.length}</div>
          <div className="stat-note">{showAmounts && open.length ? `${money(sum(open))} not yet sent` : "drafts waiting to go out"}</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Oldest</div>
          <div className="stat-figure">{open.length ? (oldest === 0 ? "today" : `${oldest} d`) : "—"}</div>
          <div className="stat-note">since the oldest draft was raised</div>
        </Blueprint>
      </div>

      {/* An open hazard assessment is a dose record with no end reading, and
          until now nothing listed them anywhere but the job it was filed
          on. This is the technician's own list, across every job. */}
      {openJhas.length > 0 && (
        <Blueprint style={{ padding: "6px 18px 14px", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "8px 0 4px" }}>
            <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Open hazard assessments</span>
            <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              {openJhas.length === 1 ? "one assessment" : `${openJhas.length} assessments`} still waiting for end readings
            </span>
          </div>
          <TableScroll><table className="table table-wide">
            <thead>
              <tr><th>Job</th><th>Project + client</th><th>Filed</th><th>Age</th><th></th></tr>
            </thead>
            <tbody>
              {openJhas.map(j => (
                <tr key={j.id}>
                  <td style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>{j.job}</td>
                  <td>{j.project}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{j.client}</div></td>
                  <td>{j.workDate || ""}</td>
                  <td className="tabular">{j.age === 0 ? "today" : j.age + " d"}</td>
                  <td>{onOpenJob && <Btn variant="secondary" onClick={() => onOpenJob(j)}>Close out</Btn>}</td>
                </tr>
              ))}
            </tbody>
          </table></TableScroll>
        </Blueprint>
      )}

      <Blueprint style={{ padding: "6px 18px 14px" }}>
        {loading && <div style={{ padding: "12px 4px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Loading your tickets…</div>}
        <TableScroll><table className="table table-wide">
          <thead>
            <tr><th>Ticket</th><th>Date</th><th>Age</th><th>Job</th><th>Project + client</th>{showAmounts && <th>Amount</th>}<th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {!loading && !open.length && (
              <tr><td colSpan={showAmounts ? 8 : 7} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                Nothing to send — every ticket you've raised has gone out to the client.
              </td></tr>
            )}
            {!loading && open.map(t => (
              <tr key={t.id}>
                {/* The way into a ticket, and it answered only to a mouse.
                    Same shape as the ticket rows on Job detail: a button in
                    a cell, Enter or Space to open. */}
                <td className="clickable" style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}
                  title="Open this draft to finish and send it"
                  tabIndex={0}
                  role="button"
                  aria-label={`Open draft ticket ${t.id}`}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenTicket(t); } }}
                  onClick={() => onOpenTicket(t)}>{t.id}</td>
                <td>{t.date}</td>
                <td className="tabular">{t.age === 0 ? "today" : t.age + " d"}</td>
                <td>{t.job}</td>
                <td>{t.project}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{t.client}</div></td>
                {showAmounts && <td className="tabular">{money(t.amount)}</td>}
                <td><StatusTag status={t.status} /></td>
                <td><Btn variant="secondary" onClick={() => onOpenTicket(t)}>Finish &amp; send</Btn></td>
              </tr>
            ))}
          </tbody>
        </table></TableScroll>
      </Blueprint>
    </div>
  );
}

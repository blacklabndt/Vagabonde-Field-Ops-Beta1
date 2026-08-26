import React from "react";
import { Blueprint, Btn, TableScroll, StatusTag } from "./common.jsx";
import { money } from "../data.js";

// Open tickets — a technician's own tickets that haven't been sent out for
// billing yet (anything short of Invoiced): drafts to finish, and tickets
// awaiting the client's signature to chase. The admin-facing Billing tracker
// covers every technician's tickets; this is the same idea narrowed to "my
// tickets, my desk."

export function OpenTicketsScreen({ tickets, loading, onOpenTicket, currentUser }) {
  const open = tickets.filter(t => t.status !== "Invoiced");
  const drafts = open.filter(t => t.status === "Draft");
  const awaiting = open.filter(t => t.status === "Awaiting approval");
  const approved = open.filter(t => t.status === "Approved");
  const sum = arr => arr.reduce((s, t) => s + t.amount, 0);
  // Amounts are an office concern (billing, chasing signatures) — a
  // technician just needs to see what's open and finish it.
  const showAmounts = currentUser.role === "Admin" || currentUser.role === "Coordinator";

  return (
    <div className="page">
      <div style={{ marginBottom: 20 }}>
        <div className="kicker">My tickets</div>
        <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Open tickets</h2>
        <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginTop: 4 }}>
          Your tickets that haven't gone out for billing yet.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 20 }} className="grid-2col">
        <Blueprint className="stat-tile">
          <div className="stat-label">Drafts</div>
          <div className="stat-figure">{drafts.length}</div>
          <div className="stat-note">still need to be finished</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Awaiting signature</div>
          <div className="stat-figure" style={{ color: "var(--color-accent-700)" }}>{awaiting.length}</div>
          <div className="stat-note">{showAmounts ? `${money(sum(awaiting))} waiting on the client` : "waiting on the client"}</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Approved</div>
          <div className="stat-figure">{approved.length}</div>
          <div className="stat-note">{showAmounts ? `${money(sum(approved))} ready for billing` : "ready for billing"}</div>
        </Blueprint>
      </div>

      <Blueprint style={{ padding: "6px 18px 14px" }}>
        {loading && <div style={{ padding: "12px 4px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Loading your tickets…</div>}
        <TableScroll><table className="table table-wide">
          <thead>
            <tr><th>Ticket</th><th>Date</th><th>Age</th><th>Job</th><th>Project + client</th>{showAmounts && <th>Amount</th>}<th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {!loading && !open.length && (
              <tr><td colSpan={showAmounts ? 8 : 7} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                Nothing open — every ticket you've raised is billed.
              </td></tr>
            )}
            {!loading && open.map(t => (
              <tr key={t.id}>
                <td className="clickable" style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}
                  title={t.status === "Draft" ? "Open this draft to finish it" : "Open the job this ticket is on"}
                  onClick={() => onOpenTicket(t)}>{t.id}</td>
                <td>{t.date}</td>
                <td className="tabular">{t.age === 0 ? "today" : t.age + " d"}</td>
                <td>{t.job}</td>
                <td>{t.project}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{t.client}</div></td>
                {showAmounts && <td className="tabular">{money(t.amount)}</td>}
                <td><StatusTag status={t.status} /></td>
                <td>{t.status === "Draft" && <Btn variant="secondary" onClick={() => onOpenTicket(t)}>Finish</Btn>}</td>
              </tr>
            ))}
          </tbody>
        </table></TableScroll>
      </Blueprint>
    </div>
  );
}

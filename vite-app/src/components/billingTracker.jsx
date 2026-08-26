import React, { useState, useEffect, useRef } from "react";
import { todayLocal, money } from "../data.js";
import { Db } from "../db.js";
import { Blueprint, Btn, TableScroll, StatusTag, ErrorBox, downloadCsv, emailIn, RowsPerPage, useRowsPerPage } from "./common.jsx";

const TRACKER_FILTERS = ["All", "Draft", "Awaiting approval", "Approved", "Invoiced", "Over 7 days"];

function exportTickets(tickets) {
  downloadCsv(`Tickets ${todayLocal()}.csv`, [
    ["Ticket", "Date", "Age (days)", "Job", "Project", "Client", "Technician", "Amount", "Status"],
    ...tickets.map(t => [t.id, t.date, t.age, t.job, t.project, t.client, t.tech, t.amount, t.status])
  ]);
}

export function BillingTrackerScreen({ onOpenTicket }) {
  const [filter, setFilter] = useState("All");
  const [chased, setChased] = useState({});
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useRowsPerPage();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [chasing, setChasing] = useState(false);
  const [chaseResult, setChaseResult] = useState("");

  // The four tiles are computed over every ticket, independent of the page
  // showing below — loaded once and refreshed whenever the visible page
  // changes, since a status flip elsewhere in the app would move a ticket
  // between buckets.
  useEffect(() => {
    Db.getTicketTrackerStats().then(setStats).catch(e => setError(e.message || "Couldn't load the tracker totals."));
  }, []);

  // A request token, so a slow earlier page cannot land after a newer one.
  // Tapping through filters or pages fires overlapping reads, and whichever
  // returns last used to win — repainting stale rows together with a total
  // that belongs to a different query, so the pager and the table disagreed.
  const loadSeq = useRef(0);
  const fetchPage = async (p, f) => {
    const mine = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const { rows: r, total: t } = await Db.searchTickets({ page: p, pageSize, status: f });
      if (mine !== loadSeq.current) return;
      setRows(r);
      setTotal(t);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setError(e.message || "Couldn't reach the database. Check your connection and reload.");
    }
    if (mine === loadSeq.current) setLoading(false);
  };
  // Filter and page in one effect: as two, opening the tracker (and every
  // filter tap made while already on page 1) fetched the same page twice.
  const lastFilter = useRef(null);
  useEffect(() => {
    if (lastFilter.current !== null && lastFilter.current !== filter && page !== 0) {
      lastFilter.current = filter;
      setPage(0);
      return;
    }
    lastFilter.current = filter;
    fetchPage(page, filter);
  }, [filter, page, pageSize]);

  const sum = arr => arr.reduce((s, t) => s + t.amount, 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Local bookkeeping only: this flags a ticket as chased so the admin can
  // keep their place down a long list. It does not send anything — sending is
  // still to be wired to the approval Edge Function — so the label says
  // "Flag", not "Remind".
  const flagChased = id => {
    setChased(p => ({ ...p, [id]: !p[id] }));
  };
  const flaggedCount = Object.values(chased).filter(Boolean).length;

  const exportCurrentFilter = async () => {
    setExporting(true);
    setError("");
    try {
      // Every ticket matching the filter, not just the page on screen. Asking
      // for one enormous page looked like it did that and didn't: PostgREST
      // caps a response at 1000 rows without complaining, so the CSV came out
      // short and looked whole.
      const all = await Db.listTicketsForExport(filter);
      exportTickets(all);
    } catch (e) {
      setError(e.message || "Couldn't build the export.");
    }
    setExporting(false);
  };

  // Resends the approval-link email for every ticket still awaiting
  // signature, in one pass, rather than opening each one individually. A
  // ticket with no client email on file is skipped and counted separately
  // — it can't be chased until a rep is added, but the rest shouldn't wait.
  const chaseAllUnsigned = async () => {
    setChasing(true);
    setChaseResult("");
    setError("");
    try {
      const list = await Db.listUnsignedTicketContacts();
      let sent = 0, skipped = 0, failed = 0;
      const justChased = {};
      for (const t of list) {
        const to = emailIn(t.contactLabel);
        if (!to) { skipped++; continue; }
        try { await Db.sendTicketApproval({ ticketId: t.id, to }); sent++; justChased[t.id] = true; }
        catch (e) { failed++; }
      }
      setChased(p => ({ ...p, ...justChased }));
      const parts = [`Sent to ${sent} of ${list.length}`];
      if (skipped) parts.push(`${skipped} skipped — no client email on file`);
      if (failed) parts.push(`${failed} failed to send`);
      setChaseResult(parts.join(" · "));
      fetchPage(page, filter);
    } catch (e) {
      setError(e.message || "Couldn't chase unsigned tickets.");
    }
    setChasing(false);
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <div className="kicker">Admin · All jobs</div>
          <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Billing tracker</h2>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Btn variant="secondary" onClick={exportCurrentFilter} disabled={exporting || !total}>{exporting ? "Building…" : "Export to accounting"}</Btn>
          <Btn variant="primary" onClick={chaseAllUnsigned} disabled={chasing || !(stats && stats.unsigned.count)}
            title="Resends the approval-link email to every ticket still awaiting signature.">
            {chasing ? "Sending…" : "Chase all unsigned"}
          </Btn>
        </div>
      </div>

      <ErrorBox>{error}</ErrorBox>
      {chaseResult && !error && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 14 }}>{chaseResult}</div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 20 }} className="grid-2col">
        <Blueprint className="stat-tile">
          <div className="stat-label">Unsigned</div>
          <div className="stat-figure" style={{ color: "var(--color-accent-700)" }}>{stats ? money(stats.unsigned.total) : "—"}</div>
          <div className="stat-note">{stats ? stats.unsigned.count : "…"} tickets awaiting signature</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Over 7 days</div>
          <div className="stat-figure">{stats ? stats.over7.count : "—"}</div>
          <div className="stat-note">{stats ? money(stats.over7.total) : "…"} at risk</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Approved, not invoiced</div>
          <div className="stat-figure">{stats ? stats.approved.count : "—"}</div>
          <div className="stat-note">{stats ? money(stats.approved.total) : "…"} ready to bill</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Invoiced</div>
          <div className="stat-figure">{stats ? stats.invoiced.count : "—"}</div>
          <div className="stat-note">{stats ? money(stats.invoiced.total) : "…"} out the door</div>
        </Blueprint>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {TRACKER_FILTERS.map(f => (
          <button key={f} className={`pill${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
        <RowsPerPage style={{ marginLeft: "auto" }} value={pageSize} onChange={n => { setPageSize(n); setPage(0); }} />
      </div>

      <Blueprint style={{ padding: "6px 18px 14px" }}>
        {loading && <div style={{ padding: "12px 4px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Loading tickets…</div>}
        <TableScroll><table className="table table-wide">
          <thead>
            <tr><th>Ticket</th><th>Date</th><th>Age</th><th>Job</th><th>Project + client</th><th>Technician</th><th>Amount</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {!loading && !rows.length && (
              <tr><td colSpan={9} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                {filter === "All" ? "No tickets raised yet." : `No tickets are ${filter.toLowerCase()}.`}
              </td></tr>
            )}
            {!loading && rows.map(t => {
              const overdue = t.age > 7 && t.status === "Awaiting approval";
              const flagged = !!chased[t.id];
              return (
                <tr key={t.id}>
                  <td className="clickable" style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}
                    title={t.status === "Draft" ? "Open this draft to finish it" : "Open the job this ticket is on"}
                    onClick={() => onOpenTicket(t)}>{t.id}</td>
                  <td>{t.date}</td>
                  <td className="tabular" style={{ color: overdue ? "var(--color-accent-700)" : "inherit" }}>{t.age === 0 ? "today" : t.age + " d"}</td>
                  <td>{t.job}</td>
                  <td>{t.project}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{t.client}</div></td>
                  <td>{t.tech}</td>
                  <td className="tabular">{money(t.amount)}</td>
                  <td><StatusTag status={t.status} /></td>
                  <td>
                    {t.status === "Awaiting approval" && (
                      <Btn variant="secondary" onClick={() => flagChased(t.id)}
                        title="Marks this ticket as chased in your view.">
                        {flagged ? "✓ Flagged" : "Flag as chased"}
                      </Btn>
                    )}
                    {t.status === "Draft" && <Btn variant="secondary" onClick={() => onOpenTicket(t)}>Finish</Btn>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></TableScroll>
        {!loading && pageCount > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 4px 4px" }}>
            <Btn variant="secondary" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>← Previous</Btn>
            <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>Page {page + 1} of {pageCount}</span>
            <Btn variant="secondary" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next →</Btn>
          </div>
        )}
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 10 }}>
          {total} ticket{total === 1 ? "" : "s"} · {money(sum(rows))} on this page
          {flaggedCount > 0 && ` · ${flaggedCount} flagged as chased`}
        </div>
      </Blueprint>
    </div>
  );
}

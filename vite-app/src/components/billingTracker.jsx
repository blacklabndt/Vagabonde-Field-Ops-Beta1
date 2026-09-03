import React, { useState, useEffect, useRef } from "react";
import { todayLocal, money, seesPrices, withinDays } from "../data.js";
import { Db } from "../db.js";
import { Blueprint, Btn, TableScroll, StatusTag, TagX, ErrorBox, downloadCsv, emailIn, RowsPerPage, useRowsPerPage } from "./common.jsx";
import { Toasts } from "../toastBus.js";

const TRACKER_FILTERS = ["All", "Draft", "Awaiting approval", "Approved", "Invoiced", "Over 7 days"];

const shortDate = iso => iso ? new Date(iso).toLocaleDateString("en-CA", { day: "2-digit", month: "short" }) : "";

function exportTickets(tickets) {
  downloadCsv(`Tickets ${todayLocal()}.csv`, [
    ["Ticket", "Date", "Age (days)", "Job", "Project", "Client", "Technician", "Amount", "Status", "Chased", "Invoiced"],
    ...tickets.map(t => [t.id, t.date, t.age, t.job, t.project, t.client, t.tech, t.amount, t.status,
      t.chasedAt ? t.chasedAt.slice(0, 10) : "", t.invoicedAt ? t.invoicedAt.slice(0, 10) : ""])
  ]);
}

export function BillingTrackerScreen({ onOpenTicket, currentUser }) {
  // The one price rule (data.js). The database already hands this screen
  // null totals for any other role; the tiles and the column follow suit
  // rather than printing "$0.00" against every ticket.
  const priced = seesPrices(currentUser);
  const [filter, setFilter] = useState("All");
  // Search and a work-date window, sent to the server with the status — the
  // tracker holds every ticket ever raised, and finding one by client or
  // job used to mean paging.
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // The approved tickets ticked for a bulk "Mark invoiced". Only meaningful
  // on the Approved filter; cleared whenever the page or filter changes.
  const [picked, setPicked] = useState({});
  const [marking, setMarking] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useRowsPerPage();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  // The money across everything the filter matches — what "how much is this
  // client's month?" wants, which the page's own sum never answered.
  const [filteredTotal, setFilteredTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [chasing, setChasing] = useState(false);
  const [chaseResult, setChaseResult] = useState("");

  // The four tiles are computed over every ticket, independent of the page
  // showing below — loaded on mount and refreshed whenever the visible page
  // or filter changes, since a status flip elsewhere in the app would move a
  // ticket between buckets. (The empty-deps version never re-ran, so the
  // tiles silently drifted from the table below them.)
  const loadStats = () =>
    Db.getTicketTrackerStats().then(setStats).catch(e => setError(e.message || "Couldn't load the tracker totals."));
  useEffect(() => { loadStats(); }, [page, filter]);

  // A request token, so a slow earlier page cannot land after a newer one.
  // Tapping through filters or pages fires overlapping reads, and whichever
  // returns last used to win — repainting stale rows together with a total
  // that belongs to a different query, so the pager and the table disagreed.
  const loadSeq = useRef(0);
  const fetchPage = async (p, f, search = q, dFrom = from, dTo = to) => {
    const mine = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const { rows: r, total: t, filteredTotal: ft } = await Db.searchTickets({ page: p, pageSize, status: f, q: search, from: dFrom, to: dTo });
      if (mine !== loadSeq.current) return;
      setRows(r);
      setTotal(t);
      setFilteredTotal(ft == null ? null : ft);
      setPicked({});
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setError(e.message || "Couldn't reach the database. Check your connection and reload.");
    }
    if (mine === loadSeq.current) setLoading(false);
  };
  // Filter, search, dates and page in one effect: as several, opening the
  // tracker (and every filter tap made while already on page 1) fetched the
  // same page twice. A changed filter or search lands on page 1; typing
  // waits for a pause so each keystroke isn't a request.
  const lastQuery = useRef(null);
  useEffect(() => {
    const key = [filter, q, from, to].join("\u0000");
    if (lastQuery.current !== null && lastQuery.current !== key && page !== 0) {
      lastQuery.current = key;
      setPage(0);
      return;
    }
    lastQuery.current = key;
    const t = setTimeout(() => fetchPage(page, filter, q, from, to), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [filter, q, from, to, page, pageSize]);

  // Integer-cents sum, never a running float total — the house money rule
  // (see gstOn in data.js). Summing dollars directly drifts a half-cent low
  // at certain boundaries; summing cents and dividing once is exact.
  const sum = arr => arr.reduce((s, t) => s + Math.round(t.amount * 100), 0) / 100;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // "Chased" is a fact about the ticket now (tickets.chased_at), not a memory
  // this page loses on reload. The flag does not send anything — "Chase all
  // unsigned" does that — it records that the client was nudged, and when.
  const flagChased = async id => {
    setError("");
    try {
      await Db.markTicketChased(id);
      const stamp = new Date().toISOString();
      setRows(p => p.map(r => r.id === id ? { ...r, chasedAt: stamp } : r));
    } catch (e) {
      setError(e.message || "Couldn't flag that ticket.");
    }
  };
  const flaggedCount = rows.filter(r => r.chasedAt).length;

  // Approved → Invoiced (and back, for a slip). Admin-only in the database;
  // the tracker is where the office decides a ticket has been billed, and
  // nothing wrote that status before — "approved, not invoiced" grew for
  // ever and Open tickets never emptied.
  const setInvoiced = async (ids, invoiced) => {
    if (!ids.length) return;
    if (invoiced && !confirm(`Mark ${ids.length === 1 ? `ticket ${ids[0]}` : `${ids.length} tickets`} as invoiced? ${ids.length === 1 ? "It" : "They"} leave Open tickets and the ready-to-bill total.`)) return;
    setMarking(true);
    setError("");
    try {
      const n = invoiced ? await Db.markTicketsInvoiced(ids) : await Db.unmarkTicketsInvoiced(ids);
      if (n < ids.length) setError(`${ids.length - n} of ${ids.length} didn't change — ${invoiced ? "only approved tickets can be marked invoiced" : "only invoiced tickets can go back"}; the rest may have moved meanwhile.`);
      await fetchPage(page, filter);
      loadStats();
    } catch (e) {
      setError(e.message || "Couldn't update those tickets.");
    }
    setMarking(false);
  };
  const pickedIds = Object.keys(picked).filter(id => picked[id]);
  const approvedOnPage = rows.filter(r => r.status === "Approved");

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
    // One tap emails every client with an unsigned ticket, and the only undo
    // is a phone call — so it asks first, like every other outward action.
    const n = stats && stats.unsigned ? stats.unsigned.count : 0;
    if (!confirm(`Email an approval reminder for ${n} unsigned ticket${n === 1 ? "" : "s"} now? Each client rep on file gets a fresh link.`)) return;
    setChasing(true);
    setChaseResult("");
    setError("");
    try {
      const list = await Db.listUnsignedTicketContacts();
      let sent = 0, skipped = 0, failed = 0, recent = 0;
      // Muted around the loop: sendTicketApproval fires an "Approval sent"
      // toast per call, so chasing N tickets would stack N toasts over the
      // one summary line this button is meant to show. Same pattern as
      // OfflineQueue.flush and saveArcadeScore.
      Toasts.mute();
      try {
        for (const t of list) {
          // Chased in the last three days is chased: a client nudged on
          // Tuesday does not need the same email again on Thursday.
          if (withinDays(t.chasedAt, 3)) { recent++; continue; }
          const to = emailIn(t.contactLabel);
          if (!to) { skipped++; continue; }
          try {
            await Db.sendTicketApproval({ ticketId: t.id, to });
            sent++;
            // Recorded on the ticket, so the flag survives a reload and the
            // next person to open the tracker sees who was already nudged.
            await Db.markTicketChased(t.id).catch(() => {});
          }
          catch (e) { failed++; }
        }
      } finally { Toasts.unmute(); }
      const parts = [`Sent to ${sent} of ${list.length}`];
      if (recent) parts.push(`${recent} left alone — chased in the last 3 days`);
      if (skipped) parts.push(`${skipped} skipped — no client email on file`);
      if (failed) parts.push(`${failed} failed to send`);
      setChaseResult(parts.join(" · "));
      // The chase moved tickets Draft/Awaiting → Awaiting approval, so both
      // the table page and the tiles (and this button's own disabled
      // predicate, which reads stats.unsigned.count) are now stale.
      fetchPage(page, filter);
      loadStats();
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
          <div className="stat-figure" style={{ color: "var(--color-accent-700)" }}>{stats ? (priced ? money(stats.unsigned.total) : stats.unsigned.count) : "—"}</div>
          <div className="stat-note">{priced ? `${stats ? stats.unsigned.count : "…"} tickets awaiting signature` : "tickets awaiting signature"}</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Over 7 days</div>
          <div className="stat-figure">{stats ? stats.over7.count : "—"}</div>
          <div className="stat-note">{priced ? `${stats ? money(stats.over7.total) : "…"} at risk` : "unsigned for over a week"}</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Approved, not invoiced</div>
          <div className="stat-figure">{stats ? stats.approved.count : "—"}</div>
          <div className="stat-note">{priced ? `${stats ? money(stats.approved.total) : "…"} ready to bill` : "signed, not yet invoiced"}</div>
        </Blueprint>
        <Blueprint className="stat-tile">
          <div className="stat-label">Invoiced</div>
          <div className="stat-figure">{stats ? stats.invoiced.count : "—"}</div>
          <div className="stat-note">{priced ? `${stats ? money(stats.invoiced.total) : "…"} out the door` : "invoiced"}</div>
        </Blueprint>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {TRACKER_FILTERS.map(f => (
          <button key={f} className={`pill${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
        <RowsPerPage style={{ marginLeft: "auto" }} value={pageSize} onChange={n => { setPageSize(n); setPage(0); }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <input className="input" type="search" value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search ticket, job, project, client or technician…" aria-label="Search tickets"
          style={{ flex: "1 1 260px", minHeight: 36 }} />
        <label style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", display: "flex", alignItems: "center", gap: 6 }}>
          Worked from
          <input className="input" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} aria-label="Work date from" style={{ minHeight: 36, width: 150 }} />
        </label>
        <label style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", display: "flex", alignItems: "center", gap: 6 }}>
          to
          <input className="input" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} aria-label="Work date to" style={{ minHeight: 36, width: 150 }} />
        </label>
        {(q || from || to) && (
          <Btn variant="ghost" style={{ minHeight: 36 }} onClick={() => { setQ(""); setFrom(""); setTo(""); }}>Clear</Btn>
        )}
        {filter === "Approved" && (
          <Btn variant="primary" style={{ minHeight: 36, marginLeft: "auto" }} disabled={marking || !pickedIds.length}
            onClick={() => setInvoiced(pickedIds, true)}
            title="Moves the ticked tickets from Approved to Invoiced.">
            {marking ? "Marking…" : pickedIds.length ? `Mark ${pickedIds.length} invoiced` : "Mark invoiced"}
          </Btn>
        )}
      </div>

      <Blueprint style={{ padding: "6px 18px 14px" }}>
        {loading && <div style={{ padding: "12px 4px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Loading tickets…</div>}
        <TableScroll><table className="table table-wide">
          <thead>
            <tr>
              {filter === "Approved" && (
                <th style={{ width: 34 }}>
                  <input type="checkbox" aria-label="Select every approved ticket on this page"
                    checked={approvedOnPage.length > 0 && approvedOnPage.every(r => picked[r.id])}
                    onChange={e => setPicked(e.target.checked ? Object.fromEntries(approvedOnPage.map(r => [r.id, true])) : {})} />
                </th>
              )}
              <th>Ticket</th><th>Date</th><th>Age</th><th>Job</th><th>Project + client</th><th>Technician</th>{priced && <th>Amount</th>}<th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {!loading && !rows.length && (
              <tr><td colSpan={filter === "Approved" ? 10 : 9} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                {(q || from || to) ? "No tickets match that search." : filter === "All" ? "No tickets raised yet." : `No tickets are ${filter.toLowerCase()}.`}
              </td></tr>
            )}
            {!loading && rows.map(t => {
              const overdue = t.age > 7 && t.status === "Awaiting approval";
              const flagged = !!t.chasedAt;
              return (
                <tr key={t.id}>
                  {filter === "Approved" && (
                    <td>
                      {t.status === "Approved" && (
                        <input type="checkbox" aria-label={`Select ticket ${t.id}`} checked={!!picked[t.id]}
                          onChange={e => setPicked(p => ({ ...p, [t.id]: e.target.checked }))} />
                      )}
                    </td>
                  )}
                  {/* The ticket number is the way in, and it was reachable by
                      mouse alone. Same shape as the ticket rows on Job
                      detail: a button in a cell, Enter or Space to open. */}
                  <td className="clickable" style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}
                    title={t.status === "Draft" ? "Open this draft to finish it" : "Open the job this ticket is on"}
                    tabIndex={0}
                    role="button"
                    aria-label={t.status === "Draft" ? `Open draft ticket ${t.id}` : `Open the job for ticket ${t.id}`}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenTicket(t); } }}
                    onClick={() => onOpenTicket(t)}>{t.id}</td>
                  <td>{t.date}</td>
                  {/* Overdue was the accent colour and nothing else, which is
                      no answer to anyone who can't see the difference — or to
                      anyone reading it in daylight through a windscreen. */}
                  <td className="tabular" style={{ color: overdue ? "var(--color-accent-700)" : "inherit", whiteSpace: "nowrap" }}>
                    {t.age === 0 ? "today" : t.age + " d"}
                    {overdue && <TagX variant="accent" style={{ marginLeft: 6 }}>overdue</TagX>}
                  </td>
                  <td>{t.job}</td>
                  <td>{t.project}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{t.client}</div></td>
                  <td>{t.tech}</td>
                  {priced && <td className="tabular">{money(t.amount)}</td>}
                  <td>
                    <StatusTag status={t.status} />
                    {/* The rep pressed "Query this ticket" instead of
                        signing: what they said, in the office's face until
                        the ticket is fixed and resent (a resend clears it). */}
                    {t.queriedAt && t.status !== "Approved" && t.status !== "Invoiced" && (
                      <div style={{ marginTop: 4 }}>
                        <TagX variant="accent" title={`Queried ${new Date(t.queriedAt).toLocaleString("en-CA")}`}>Queried{t.queryBy ? ` by ${t.queryBy}` : ""}</TagX>
                        {t.queryText && <div style={{ fontSize: 11, marginTop: 3, maxWidth: 320, whiteSpace: "pre-wrap" }}>{t.queryText}</div>}
                      </div>
                    )}
                    {t.status === "Invoiced" && t.invoicedAt && (
                      <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{shortDate(t.invoicedAt)}</div>
                    )}
                  </td>
                  <td>
                    {t.status === "Awaiting approval" && (
                      flagged
                        ? <TagX variant="outline" title={`Chased ${new Date(t.chasedAt).toLocaleString("en-CA")}`}>Chased {shortDate(t.chasedAt)}</TagX>
                        : <Btn variant="secondary" onClick={() => flagChased(t.id)}
                            title="Records that the client has been nudged about this ticket — it doesn't send anything.">
                            Flag as chased
                          </Btn>
                    )}
                    {t.status === "Draft" && <Btn variant="secondary" onClick={() => onOpenTicket(t)}>Finish</Btn>}
                    {t.status === "Approved" && (
                      <Btn variant="secondary" disabled={marking} onClick={() => setInvoiced([t.id], true)}
                        title="Moves this ticket from Approved to Invoiced.">Mark invoiced</Btn>
                    )}
                    {t.status === "Invoiced" && (
                      <Btn variant="ghost" disabled={marking} onClick={() => setInvoiced([t.id], false)}
                        title="Back to Approved — for a ticket marked invoiced by mistake.">Back to approved</Btn>
                    )}
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
          {total} ticket{total === 1 ? "" : "s"}{(q || from || to) ? " matching" : ""}{priced ? (filteredTotal != null && total > rows.length
            ? ` · ${money(filteredTotal)} across all ${total} · ${money(sum(rows))} on this page`
            : ` · ${money(filteredTotal != null ? filteredTotal : sum(rows))} in total`) : ""}
          {flaggedCount > 0 && ` · ${flaggedCount} chased`}
        </div>
      </Blueprint>
    </div>
  );
}

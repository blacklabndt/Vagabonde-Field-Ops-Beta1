import React, { useState, useEffect, useMemo } from "react";
import { Blueprint, Btn, TableScroll, StatusTag, RowsPerPage, useRowsPerPage } from "./common.jsx";
import { money, seesPrices } from "../data.js";
import { Db } from "../db.js";
import { OfflineCache } from "../offlineCache.js";
import { TICKET_WIP_PREFIX, JHA_WIP_PREFIX, jobDbIdsOf, buildWipRows, wipJobLabel, wipWhen } from "../wipDrafts.js";

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

  // The same pager every sibling screen has (Home, Timesheets, Contacts, the
  // tracker) and the same remembered rows-per-page. This was the one screen
  // without it: a seeded account with 155 drafts rendered thirteen screens of
  // table in one go, and it is the screen a technician opens most.
  const [pageSize, setPageSize] = useRowsPerPage();
  const [page, setPage] = useState(0);
  // Over the list already in hand, not a server search — these are this
  // person's own drafts, they are all here, and a draft list is worth
  // narrowing by the job you were on rather than by scrolling.
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? open.filter(t => [t.job, t.project, t.client, t.id].some(v => String(v || "").toLowerCase().includes(needle)))
    : open;
  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  // Clamped rather than reset: deleting the last row of the last page, or
  // typing another letter into the filter, would otherwise leave the table
  // empty on a page that no longer exists.
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = shown.slice(safePage * pageSize, safePage * pageSize + pageSize);

  // ── Half-entered on this device ────────────────────────────────────────
  // The ticket editor and the JHA builder each keep a recovery copy of what
  // is being typed, and the app already thinks those copies matter enough to
  // warn about at sign-out — but nothing listed them. After a refresh you
  // land on Home, and the only way back to a day's welds was to remember
  // which job they were on and open a ticket there again for the "Brought
  // back…" banner to fire. This strip is the signpost.
  //
  // No filtering by person, and none needed: the cache belongs to one account
  // at a time (OfflineCache's cache.owner / claimFor empties the store when
  // anybody else signs in on the tablet), so every copy in it is this
  // account's own.
  const [wipEntries, setWipEntries] = useState([]);
  const [wipJobs, setWipJobs] = useState({});
  useEffect(() => {
    let live = true;
    (async () => {
      const keys = [...await OfflineCache.keys(TICKET_WIP_PREFIX), ...await OfflineCache.keys(JHA_WIP_PREFIX)];
      // The record's own saved-at stamp is the whole point of the read — the
      // key list carries no times. A copy that has just gone (discarded on
      // the screen it belongs to) reads back as nothing and is skipped.
      const found = [];
      for (const key of keys) {
        const hit = await OfflineCache.read(key).catch(() => null);
        if (hit) found.push({ key, at: hit.at || null });
      }
      if (live) setWipEntries(found);
    })().catch(() => { if (live) setWipEntries([]); });
    return () => { live = false; };
    // Read once per visit to the screen. The copies are written by screens
    // that are not on top of this one, so re-reading as the drafts reload
    // would be a walk over IndexedDB for an answer that cannot have changed.
  }, []);
  useEffect(() => {
    let live = true;
    (async () => {
      // One read per job, not per copy, and Db.getJob goes through the cache
      // — so a job this device has already opened still names itself with no
      // signal. A job it has never seen stays unnamed rather than blocking
      // the row; buildWipRows says what is known of it instead.
      for (const dbId of jobDbIdsOf(wipEntries)) {
        try {
          const job = await Db.getJob(dbId);
          if (!live) return;
          if (job) setWipJobs(prev => (prev[dbId] ? prev : { ...prev, [dbId]: job }));
        } catch (e) { /* no signal and never cached, or the job is gone */ }
      }
    })();
    return () => { live = false; };
  }, [wipEntries]);
  const wipRows = useMemo(() => buildWipRows(wipEntries, { tickets, jobs: wipJobs }), [wipEntries, tickets, wipJobs]);

  const openWipJob = row => {
    if (!onOpenJob) return;
    // The record when we have it (it carries the dbId, so no second read),
    // and the job number when the drafts list was all that named it.
    if (row.jobRecord) onOpenJob(row.jobRecord);
    else if (row.jobNumber) onOpenJob({ job: row.jobNumber });
  };
  // Same shape as the app's other one-tap destructions (the error log, the
  // sign-out warning): a plain confirm, saying what goes and that it is gone.
  const discardWip = async row => {
    const what = row.kind === "ticket" ? "half-entered ticket" : "half-built hazard assessment";
    if (!window.confirm(`Discard the ${what} for ${wipJobLabel(row)}? None of it has been saved, and it cannot be brought back.`)) return;
    await OfflineCache.remove(row.key);
    setWipEntries(prev => prev.filter(e => e.key !== row.key));
  };

  return (
    <div className="page">
      <div style={{ marginBottom: 20 }}>
        <div className="kicker">My tickets</div>
        <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Open tickets</h2>
        <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginTop: 4 }}>
          Your tickets that still have to go out to the client. Once a ticket is sent it leaves this list.
        </div>
      </div>

      {/* Above the tiles on purpose: unsaved work is the most perishable
          thing on the screen, and the tiles are about tickets that already
          exist in the database. */}
      {wipRows.length > 0 && (
        <Blueprint style={{ padding: "6px 18px 14px", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "8px 0 4px", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Half-entered on this device</span>
            <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              {wipRows.length === 1 ? "one copy" : `${wipRows.length} copies`} of work that was never saved — open the job, start the ticket or assessment there, and it comes back with what you typed
            </span>
          </div>
          <TableScroll><table className="table table-wide">
            <thead>
              <tr><th>What</th><th>Job</th><th>Project + client</th><th>Kept</th><th></th></tr>
            </thead>
            <tbody>
              {wipRows.map(r => (
                <tr key={r.key}>
                  <td>{r.what}{r.ticketId && <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>changes to {r.ticketId}</div>}</td>
                  <td style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>
                    {r.jobNumber || <span style={{ fontWeight: 400, fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{wipJobLabel(r)}</span>}
                  </td>
                  <td>{r.project}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{r.client}</div></td>
                  <td>{wipWhen(r.at)}</td>
                  <td style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {/* No door to the job when nothing here could name it —
                        this device has never read that job and has no signal
                        to read it now. The copy stays listed, and stays
                        discardable, which is the honest pair of answers. */}
                    {onOpenJob && (r.jobRecord || r.jobNumber) &&
                      <Btn variant="secondary" onClick={() => openWipJob(r)}>Open job</Btn>}
                    <Btn variant="secondary" onClick={() => discardWip(r)}>Discard</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></TableScroll>
        </Blueprint>
      )}

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

      {/* The tiles above stay the whole list's figures — "still to send" is
          about every draft, not about whatever is typed in the box. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <input className="input" value={filter} aria-label="Filter your drafts"
          placeholder="Filter by job, project or client…"
          style={{ flex: 1, minWidth: 200, maxWidth: 340, minHeight: 38 }}
          onChange={e => { setFilter(e.target.value); setPage(0); }} />
        <RowsPerPage value={pageSize} onChange={n => { setPageSize(n); setPage(0); }} />
        <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", whiteSpace: "nowrap" }}>
          {needle ? `${shown.length} of ${open.length} shown` : `${open.length} draft${open.length === 1 ? "" : "s"}`}
        </span>
      </div>

      <Blueprint style={{ padding: "6px 18px 14px" }}>
        {loading && <div style={{ padding: "12px 4px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Loading your tickets…</div>}
        <TableScroll><table className="table table-wide">
          <thead>
            <tr><th>Ticket</th><th>Date</th><th>Age</th><th>Job</th><th>Project + client</th>{showAmounts && <th>Amount</th>}<th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {!loading && !shown.length && (
              <tr><td colSpan={showAmounts ? 8 : 7} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                {open.length
                  ? `No draft matches "${filter.trim()}" — clear the filter to see all ${open.length}.`
                  : "Nothing to send — every ticket you've raised has gone out to the client."}
              </td></tr>
            )}
            {!loading && pageRows.map(t => (
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
        {/* Hidden at one page, exactly as on the board and the tracker. */}
        {!loading && pageCount > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 4px 4px" }}>
            <Btn variant="secondary" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}>← Previous</Btn>
            <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              Page {safePage + 1} of {pageCount}
            </span>
            <Btn variant="secondary" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1}>Next →</Btn>
          </div>
        )}
      </Blueprint>
    </div>
  );
}

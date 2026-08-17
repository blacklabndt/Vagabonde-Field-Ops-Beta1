import React, { useState, useEffect, useRef } from "react";
import { money, todayLocal, localDate, dayMonth, initialsOf, ticketDateStamp, lastNumbers, JOB_FIELDS } from "../data.js";
import { Db } from "../db.js";
import { OfflineCache } from "../offlineCache.js";
import { Blueprint, Btn, TableScroll, TagX, Field, PdfGlyph, PdfLink, Dialog, ErrorBox, emailIn, contactLabel, splitContact, StatusTag, useMissingFields, SearchSelect, Loading, LoadingRow } from "./common.jsx";

export function JobDetailScreen({ job, currentUser, onStartJha, onOpenTicket, jobRecord, setJobRecord, onJobChanged, onJobDeleted }) {
  const [showUpload, setShowUpload] = useState(false);
  const [showTicket, setShowTicket] = useState(false);
  const [editingRecord, setEditingRecord] = useState(false);
  const [draft, setDraft] = useState(jobRecord);
  const [savingRecord, setSavingRecord] = useState(false);
  const [recordError, setRecordError] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [closingJha, setClosingJha] = useState(null);
  // The assessment being emailed — holds the row so the dialog can name the
  // file it's about to send.
  const [sendingJha, setSendingJha] = useState(null);
  const [deletingJhaId, setDeletingJhaId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // A ticket opened to be read rather than edited. Holds the ticket id; the
  // dialog fetches its lines and crew itself.
  const [viewingTicket, setViewingTicket] = useState(null);
  // Rendering the PDF is best-effort in the background, so a failure used to
  // be invisible — the link simply wouldn't open. This puts the function's
  // own error on screen and lets it be retried.
  const [rendering, setRendering] = useState(null);
  // Keyed by JHA id, not a single string: one message in screen state was
  // drawn beside every row on the table, so a failure on one assessment read
  // as a failure on all of them.
  const [jhaRenderError, setJhaRenderError] = useState({});

  // A completed job is a closed book: nothing can be added to it until an admin
  // reopens it. Only admins see the switch — closing a job decides what a
  // client gets invoiced for, so it isn't a field decision.
  const complete = job && job.status === "Complete";
  const isAdmin = currentUser.role === "Admin";
  // Admins and technicians — the techs who file assessments clean up their
  // own. Matches the jhas delete policy; a helper doesn't get the button
  // because the database would refuse them anyway.
  const canDeleteJha = isAdmin || currentUser.role === "Technician";

  const toggleComplete = async () => {
    if (!complete && !confirm(`Mark ${job.id} complete? No more JHAs, reports or tickets can be added to it until it's reopened.`)) return;
    setStatusBusy(true);
    setStatusError("");
    try {
      await Db.setJobComplete(job.dbId, !complete);
      if (onJobChanged) await onJobChanged();
    } catch (e) {
      setStatusError(e.message || "Couldn't change the job's status.");
    }
    setStatusBusy(false);
  };

  const [jhas, setJhas] = useState([]);
  const [reports, setReports] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  // Split so a mutation on one card (uploading a report, closing a JHA)
  // only reloads that one list, not all three — a job with a long history
  // used to re-download its whole JHA/report/ticket record after every
  // single save.
  const refreshJhas = () => Db.listJhasForJob(job.dbId).then(setJhas).catch(e => console.error("Failed to load JHAs:", e.message));

  // Removing an assessment. confirm() rather than a dialog of its own: one
  // row, named by its file, and the database re-checks who may do it.
  const deleteJha = async j => {
    if (!confirm(`Delete ${j.file}? The assessment and its PDF are removed for good.`)) return;
    setDeletingJhaId(j.id);
    setJhaRenderError(p => ({ ...p, [j.id]: "" }));
    try { await Db.deleteJha(j.id); await refreshJhas(); }
    catch (e) { setJhaRenderError(p => ({ ...p, [j.id]: e.message || "Couldn't delete the assessment." })); }
    setDeletingJhaId(null);
  };
  const refreshReports = () => Db.listReportsForJob(job.dbId).then(setReports).catch(e => console.error("Failed to load reports:", e.message));
  const refreshTickets = () => Db.listTicketsForJob(job.dbId).then(setTickets).catch(e => console.error("Failed to load tickets:", e.message));
  const refresh = async () => {
    setLoading(true);
    await Promise.all([refreshJhas(), refreshReports(), refreshTickets()]);
    setLoading(false);
  };
  useEffect(() => { if (job && job.dbId) refresh(); }, [job ? job.dbId : null]);

  // The record is derived from the job row and the contact directory, so it
  // reloads whenever you open a different job instead of showing the last one.
  useEffect(() => {
    if (!job || !job.dbId) return;
    let live = true;
    Db.getJobRecord(job)
      // Guard against an out-of-order response: opening two jobs quickly used
      // to leave whichever request finished last in the panel, regardless of
      // which job was actually on screen.
      .then(r => { if (live) setJobRecord(r); })
      .catch(e => console.error("Failed to load job record:", e.message));
    return () => { live = false; };
  }, [job ? job.dbId : null]);

  // The contact directory, so the record's rep fields can be picked rather
  // than retyped. Db caches it, so this costs nothing on a second open.
  const [contacts, setContacts] = useState([]);
  useEffect(() => { Db.listContacts().then(setContacts).catch(() => setContacts([])); }, []);
  const forOrg = (type, id) => (id ? contacts.filter(c => c.org_type === type && c.org_id === id) : [])
    .slice().sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || (a.name || "").localeCompare(b.name || ""));
  // The contractor can be retyped in the same edit, and a contractor that
  // isn't on file yet has no people on file either — so the rep list follows
  // the draft, not the saved job.
  const contractorRenamed = draft && (draft.contractor || "").trim().toLowerCase() !== (job.contractor || "").trim().toLowerCase();
  const contractorIdForDraft = contractorRenamed ? null : job.contractorId;

  // Confirmation that the save actually landed, rather than the panel just
  // flipping back to read-only and leaving you to guess.
  const [savedNote, setSavedNote] = useState(false);
  const savedTimer = useRef(null);
  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const saveRecord = async () => {
    setSavingRecord(true);
    setRecordError("");
    try {
      await Db.updateJobRecord(job, draft);
      // Rebuild the joined display strings from the parts just edited — the
      // read-only view and the ticket dialog both read those, so reusing the
      // draft's stale ones would show the old rep until the next reload.
      const fmtRep = r => r ? [r.name, r.phone, r.email].filter(Boolean).join(" · ") : "";
      setJobRecord({
        ...draft,
        clientRep: fmtRep(draft.clientRepDetail),
        contractorRep: fmtRep(draft.contractorRepDetail)
      });
      setEditingRecord(false);
      setSavedNote(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedNote(false), 4000);
      // A rep edit can add someone to the directory, so the picker shouldn't
      // still be showing yesterday's list.
      Db.listContacts().then(setContacts).catch(() => {});
      // Pull the jobs list again so the dispatch board's Contractor column
      // reflects what was just typed here.
      if (onJobChanged) await onJobChanged();
    } catch (e) {
      setRecordError(e.message || "Couldn't save the job record.");
    }
    setSavingRecord(false);
  };

  // The most recent filed JHA, for the "Signed …" tag and template beside the
  // panel heading. Nothing else is read off it now — the hazards it covered
  // are on the assessment itself rather than summarised here.
  const latestJha = jhas[0];
  const ticketTotal = tickets.reduce((s, t) => s + t.amount, 0);
  const awaitingApproval = tickets.some(t => t.status === "Awaiting approval");

  // Who may remove this job.
  //
  // An admin, always. Otherwise the person who raised it, until something has
  // left the building: once a ticket has gone to a client for approval, or
  // been approved or invoiced, the job it names has to stay put. A draft is
  // the technician's own unsent work and goes with the job.
  //
  // The same rules are enforced in delete_job — this decides whether to offer
  // the button, not whether the delete is allowed.
  const raisedByMe = !!job.createdById && job.createdById === currentUser.id;
  const billedSomething = tickets.some(t =>
    t.status === "Awaiting approval" || t.status === "Approved" || t.status === "Invoiced");
  const canDelete = isAdmin || (raisedByMe && !billedSomething);

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 34, margin: 0 }}>{job.project}</h2>
        <StatusTag status={job.status} />
        {isAdmin && (
          <Btn variant={complete ? "secondary" : "primary"} style={{ marginLeft: "auto" }}
            disabled={statusBusy} onClick={toggleComplete}>
            {statusBusy ? "Saving…" : complete ? "Reopen job" : "Mark complete"}
          </Btn>
        )}
      </div>
      <ErrorBox>{statusError}</ErrorBox>
      {complete && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)", marginBottom: 18 }}>
          This job is complete — it's kept as a record and nothing further can be added.{isAdmin ? " Reopen it to make changes." : " An admin can reopen it."}
        </div>
      )}

      {/* One column: the job record leads (order: -1), then the work filed
         against it. The record used to sit in a 320px rail beside all of it,
         which pushed the whole page wider than the header. */}
      {/* minmax(0, 1fr), never bare 1fr: a 1fr track floors at its widest
          child's min-content, so one table stretched the whole screen past
          a phone. Zero lets the track shrink and the TableScrolls inside
          actually scroll. */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Hazard assessment */}
          <Blueprint style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: 19 }}>Hazard assessment</h4>
              {latestJha && <TagX variant="accent">Signed {latestJha.at}</TagX>}
              {latestJha && latestJha.template && (
                <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{latestJha.template}</span>
              )}
              <Btn variant="primary" style={{ marginLeft: "auto" }} disabled={complete} onClick={onStartJha}>+ New JHA</Btn>
            </div>
            {/* The hazards from the last JHA used to be listed here as a grid
                of chips. They are on the assessment itself, which is one tap
                away and is the copy that counts — repeating a summary of them
                on the job invited reading the panel as the current state of
                the job rather than as a record of what was filed. The list of
                assessments is what this panel is for. */}
            <TableScroll><table className="table">
              <thead><tr><th>File</th><th>Signed</th><th>Signer</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {loading && <LoadingRow cols={5} />}
                {!loading && jhas.length === 0 && <tr><td colSpan={5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>None on file yet.</td></tr>}
                {jhas.map((j, i) => (
                  <tr key={j.id || i}>
                    <td>
                      <PdfLink file={j.file} pdfKey={j.pdfKey} bucket="jhas" />
                      {j.backdated && (
                        <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                          covers {dayMonth(localDate(j.workDate))}
                        </div>
                      )}
                      {j.sentAt && (
                        <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                          Sent {j.sentAt}{j.sentTo ? " · " + j.sentTo.split(",").join(", ") : ""}
                        </div>
                      )}
                    </td>
                    <td>{j.at}</td>
                    <td>{j.by}</td>
                    <td>{j.status === "Open"
                      ? <TagX variant="outline">Open — no end readings</TagX>
                      : <TagX variant="neutral">Closed {j.closedAt}</TagX>}</td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                        {jhaRenderError[j.id] && <span style={{ fontSize: 11, color: "var(--color-accent-700)", maxWidth: 320, textAlign: "left" }}>{jhaRenderError[j.id]}</span>}
                        <Btn variant="ghost" disabled={rendering === j.id} onClick={async () => {
                          setRendering(j.id);
                          setJhaRenderError(p => ({ ...p, [j.id]: "" }));
                          try { await Db.renderJhaPdf(j.id); await refreshJhas(); }
                          catch (e) { setJhaRenderError(p => ({ ...p, [j.id]: e.message || "The PDF didn't render." })); }
                          setRendering(null);
                        }}>{rendering === j.id ? "Rendering…" : "Re-render PDF"}</Btn>
                        {j.status === "Open" && !complete && (
                          <Btn variant="secondary" onClick={() => setClosingJha(j)}>Close out</Btn>
                        )}
                        <Btn variant="secondary" disabled={!j.pdfKey}
                          title={j.pdfKey ? undefined : "Render the PDF first"}
                          onClick={() => setSendingJha(j)}>Send to…</Btn>
                        {canDeleteJha && (
                          <Btn variant="ghost" disabled={complete || deletingJhaId === j.id}
                            title={complete ? "Reopen the job first" : undefined}
                            onClick={() => deleteJha(j)}>{deletingJhaId === j.id ? "Deleting…" : "Delete"}</Btn>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></TableScroll>
          </Blueprint>

          {/* Radiographic reports */}
          <Blueprint style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: 19 }}>Radiographic reports</h4>
              <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{reports.length} on file</span>
              <Btn variant="primary" style={{ marginLeft: "auto" }} disabled={complete} onClick={() => setShowUpload(true)}>+ Upload report</Btn>
            </div>
            <TableScroll><table className="table">
              <thead><tr><th>File</th><th>Last numbers</th><th>Uploaded</th><th>Sent</th></tr></thead>
              <tbody>
                {loading && <LoadingRow cols={4} />}
                {!loading && reports.length === 0 && <tr><td colSpan={4} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>None on file yet.</td></tr>}
                {reports.map((r, i) => (
                  <tr key={i}><td><PdfLink file={r.file} pdfKey={r.pdfKey} bucket="reports" /></td><td>{r.welds}</td><td>{r.at}</td><td>{r.sent}</td></tr>
                ))}
              </tbody>
            </table></TableScroll>
          </Blueprint>

          {/* Daily billing */}
          <Blueprint style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: 19 }}>Daily billing</h4>
              {awaitingApproval && <TagX variant="outline">Awaiting client approval</TagX>}
              <Btn variant="primary" style={{ marginLeft: "auto" }} disabled={complete} onClick={() => setShowTicket(true)}>+ Create ticket</Btn>
            </div>
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 10 }}>
              {complete
                ? "This job is complete. Tap a ticket to read it or send it to the client again."
                : "Tap a draft to add the day's welds, hours and crew. Tap a sent ticket to read it."}
            </div>
            <TableScroll><table className="table">
              <thead><tr><th>Ticket</th><th>Date</th><th>Technician</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {loading && <LoadingRow cols={5} />}
                {!loading && tickets.length === 0 && <tr><td colSpan={5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>None raised yet.</td></tr>}
                {tickets.map(t => {
                  // A draft on an open job is still being built, so its row
                  // opens the billing screen. Everything else opens read-only.
                  //
                  // It used to open nothing at all: a sent or approved ticket
                  // was inert, and on a completed job so was every row. That
                  // is right about not offering an editor that would refuse to
                  // save, and wrong about the rest — a finished job is exactly
                  // where someone needs to look up what was billed, and chase
                  // a client who never signed. Reading is not editing.
                  const editable = t.status === "Draft" && !complete;
                  const open = editable ? () => onOpenTicket(t.id) : () => setViewingTicket(t.id);
                  return (
                    <tr key={t.id} onClick={open}
                      tabIndex={0}
                      role="button"
                      title={editable ? "Open this draft to add the day's charges" : "Read this ticket"}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
                      style={{ cursor: "pointer" }}>
                      <td style={{ fontFamily: "var(--font-heading)", fontWeight: 600, color: "var(--color-accent)" }}>{t.id}</td>
                      <td>{t.date}</td><td>{t.tech}</td><td className="tabular">{money(t.amount)}</td>
                      <td><StatusTag status={t.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></TableScroll>
            <div className="strip" style={{ gridTemplateColumns: "repeat(2, 1fr)", marginTop: 14 }}>
              <div><div className="strip-label">Tickets raised</div><div className="strip-value">{tickets.length}</div></div>
              <div><div className="strip-label">Ticket total</div><div className="strip-value">{money(ticketTotal)}</div></div>
            </div>
          </Blueprint>
        </div>

        {/* Job record */}
        <Blueprint style={{ padding: "18px 20px", order: -1 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <h4 style={{ margin: 0, fontSize: 19 }}>Job record</h4>
            {savedNote && !editingRecord && (
              <span style={{ marginLeft: 10, fontSize: 13, fontWeight: 600, color: "var(--color-accent-700)" }}>✓ Saved to this job</span>
            )}
            {!editingRecord
              ? <Btn variant="secondary" style={{ marginLeft: "auto" }} disabled={complete} onClick={() => { setDraft(jobRecord); setSavedNote(false); setEditingRecord(true); }}>Edit</Btn>
              : <span style={{ marginLeft: "auto", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Editing — changes aren't kept until you save</span>}
          </div>
          {!editingRecord ? (
            // Three fixed columns, read down: identifier, client, contractor —
            // fixed rather than auto-fit, because auto-fit reflowed to four
            // columns on a wide screen and scrambled the pairings.
            // Kept as three columns at every width, same as desktop, rather
            // than collapsing to one on a phone.
            <div className="job-record-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
              <RecordCell label="Job #" value={jobRecord.job} />
              <RecordCell label="LSD" value={jobRecord.lsd} />
              <RecordCell label="AFE" value={jobRecord.afe} />

              <RecordCell label="Client" value={jobRecord.client} />
              <RecordCell label="Contractor" value={jobRecord.contractor} />
              {/* The operator's own name for where the work is — it prints on
                  the client's field invoice, and is not the LSD or the
                  internal project name. */}
              <RecordCell label="Area" value={jobRecord.area} />

              <RecordCell label="Client rep" value={jobRecord.clientRep} />
              <RecordCell label="Contractor rep" value={jobRecord.contractorRep} />
              <RecordCell label="Started" value={jobRecord.started} />
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
                {JOB_FIELDS.filter(f => f.key !== "clientRep" && f.key !== "contractorRep").map(f => (
                  <Field key={f.key} label={f.label}>
                    <input className="input" value={draft[f.key] || ""}
                      disabled={f.key === "job" || f.key === "client" || f.key === "started"}
                      onChange={e => setDraft(p => ({ ...p, [f.key]: e.target.value }))} />
                  </Field>
                ))}
              </div>

              {/* The two reps, picked from the directory rather than retyped.
                  Same pattern as New job and Create ticket, and the parts are
                  three boxes because nobody should have to type a "·". */}
              <RepEditor
                heading="Client representative"
                options={forOrg("client", job.clientId)}
                value={draft.clientRepDetail}
                onChange={v => setDraft(p => ({ ...p, clientRepDetail: v }))}
                emptyNote={job.clientId ? "" : "No client on this job."}
              />
              <RepEditor
                heading="Contractor representative"
                options={forOrg("contractor", contractorIdForDraft)}
                value={draft.contractorRepDetail}
                onChange={v => setDraft(p => ({ ...p, contractorRepDetail: v }))}
                emptyNote={contractorIdForDraft ? "" : "Name a contractor above first — their people are filed against them."}
              />
              <ErrorBox>{recordError}</ErrorBox>
              {/* Save sits under the fields it commits, on its own line, so
                  it reads as the end of the form rather than another control
                  in it. */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, paddingTop: 14, borderTop: "1px solid color-mix(in srgb, var(--color-text) 12%, transparent)" }}>
                <Btn variant="primary" onClick={saveRecord} disabled={savingRecord}>{savingRecord ? "Saving…" : "Save job record"}</Btn>
                <Btn variant="secondary" onClick={() => setEditingRecord(false)} disabled={savingRecord}>Cancel</Btn>
                <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                  Saves the reps against this job — other jobs for the same client keep theirs.
                </span>
              </div>
            </>
          )}
        </Blueprint>
      </div>

      {/* Removing the job sits at the very bottom, past everything the job is
          actually for. It is the last thing on the page because it is the last
          thing you should reach for, and nothing below it can be mis-clicked
          on the way somewhere else. */}
      {canDelete && (
        <div style={{
          marginTop: 28, paddingTop: 16,
          borderTop: "1px solid color-mix(in srgb, var(--color-text) 12%, transparent)",
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap"
        }}>
          <Btn variant="secondary" disabled={statusBusy} onClick={() => setDeleting(true)}>Delete job</Btn>
          <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {isAdmin
              ? "Anything filed against this job can be moved to another one first."
              : "You raised this job and nothing has been billed from it yet."}
          </span>
        </div>
      )}

      {/* Said out loud rather than leaving the button quietly missing, so the
          person who raised a job knows why they can't remove it. */}
      {!canDelete && raisedByMe && billedSomething && (
        <div style={{
          marginTop: 28, paddingTop: 16,
          borderTop: "1px solid color-mix(in srgb, var(--color-text) 12%, transparent)",
          fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)"
        }}>
          A ticket from this job has already gone out for billing, so it can't be deleted. An admin can still remove it.
        </div>
      )}

      {showUpload && (
        <UploadReportDialog job={job} jobRecord={jobRecord} currentUser={currentUser} onClose={() => setShowUpload(false)}
          onSubmit={async () => { setShowUpload(false); await refreshReports(); }} />
      )}
      {showTicket && (
        <CreateTicketDialog job={job} jobRecord={jobRecord} currentUser={currentUser} onClose={() => setShowTicket(false)}
          onSubmit={async ticketId => { setShowTicket(false); await refreshTickets(); if (ticketId) onOpenTicket(ticketId); }} />
      )}
      {deleting && (
        <DeleteJobDialog job={job} jhas={jhas} reports={reports} tickets={tickets} isAdmin={isAdmin}
          onClose={() => setDeleting(false)}
          onDeleted={movedTo => { setDeleting(false); onJobDeleted(movedTo); }} />
      )}

      {closingJha && (
        <JhaCloseOutDialog jha={closingJha} currentUser={currentUser}
          onClose={() => setClosingJha(null)}
          onDone={async () => { setClosingJha(null); await refreshJhas(); }} />
      )}

      {sendingJha && (
        <SendJhaDialog job={job} jha={sendingJha}
          clientContacts={forOrg("client", job.clientId)}
          contractorContacts={forOrg("contractor", job.contractorId)}
          onClose={() => setSendingJha(null)}
          onSent={async () => { setSendingJha(null); await refreshJhas(); }} />
      )}

      {viewingTicket && (
        <TicketViewDialog ticketId={viewingTicket} jobRecord={jobRecord}
          onClose={() => setViewingTicket(null)}
          onSent={async () => { setViewingTicket(null); await refreshTickets(); }} />
      )}

    </div>
  );
}

// A ticket opened to be read, not edited.
//
// The billing screen is an editor: every button on it saves, and it refuses
// outright on a completed job or an approved ticket. That left the commonest
// question — "what did we actually bill them for?" — with nowhere to be
// asked, and no way to chase a client who never signed once the job was
// closed. This answers it without offering a single control that writes to
// the ticket.
//
// The one thing it does write is the approval email, which changes nothing on
// the ticket except that it has been sent again.
function TicketViewDialog({ ticketId, jobRecord, onClose, onSent }) {
  const [ticket, setTicket] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sentNote, setSentNote] = useState("");
  // The rendered invoice, and the frame showing it.
  const [invoiceHtml, setInvoiceHtml] = useState("");
  const frameRef = useRef(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // Crew is a nice-to-have beside the charges; a ticket raised before
        // crew was recorded simply has none, and that must not read as a
        // failure to load the ticket.
        // The invoice is rendered server-side by the same code the client's
        // copy uses, and it carries the crew and the totals itself — so this
        // reads the ticket only for its status, date and contact, which the
        // dialog's own header and send button need.
        const [t, html] = await Promise.all([
          Db.getTicket(ticketId),
          Db.renderTicketInvoice(ticketId).catch(() => "")
        ]);
        if (!live) return;
        setTicket(t);
        setInvoiceHtml(html);
      } catch (e) {
        if (live) setError(e.message || "Couldn't load that ticket.");
      }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
  }, [ticketId]);

  // tickets.client_contact is jsonb holding a single label string under
  // `name` — "Rep · phone · email" — not a plain column. Reading it as a
  // string stringifies the object and quietly matches no email at all, which
  // would have hidden the send button rather than failing loudly.
  const contactLine = (ticket && ticket.client_contact && ticket.client_contact.name) || "";

  // Where the approval request goes. The ticket carries the contact it was
  // raised against, which is the one the client rep already saw; the job's
  // current rep is the fallback for a ticket raised before anyone was named.
  const recipient = emailIn(contactLine)
    || (jobRecord && jobRecord.clientRepDetail && jobRecord.clientRepDetail.email)
    || "";

  const signed = ticket && (ticket.status === "Approved" || ticket.status === "Invoiced");
  const canSend = !!ticket && !signed && !!recipient && Number(ticket.total) > 0;

  // The frame is given its content's full height so the *dialog* scrolls and
  // the iframe never does. A scrollbar inside a scrollbar is miserable to use
  // on a phone, which is where these get read.
  //
  // Measured from an effect rather than from onLoad alone: with srcDoc the
  // load event can beat the parse, and measuring then reports the empty
  // document — the frame sat at its placeholder 360px while the invoice
  // inside it was 1410.
  // The invoice is shown in a fixed viewport that scrolls, the way any
  // document viewer works.
  //
  // Sizing the frame to its content was tried and abandoned. srcDoc parses
  // asynchronously so onLoad measures an empty document; resizing the frame
  // reflows the responsive invoice inside it, so a poll settles on the height
  // the content had at the previous width (measured 1410, applied it, content
  // became 1528); and the dialog body is a flex column, so the measured height
  // was applied inline at 1419px and laid out at 360 until flex-shrink was
  // pinned. Three fixes deep for a scrollbar in a slightly nicer place is not
  // a good trade.


  // Prints the invoice on its own, not the app around it.
  const printInvoice = () => {
    const win = frameRef.current && frameRef.current.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  };

  const send = async () => {
    setSending(true);
    setError("");
    try {
      await Db.sendTicketApproval({ ticketId, to: recipient });
      setSentNote(`Approval request sent to ${recipient}.`);
      // The document now says "Awaiting approval"; re-render so the copy on
      // screen matches the one that just went out.
      setInvoiceHtml(await Db.renderTicketInvoice(ticketId).catch(() => invoiceHtml));
      if (onSent) await onSent();
    } catch (e) {
      setError(e.message || "Couldn't send that approval request.");
      setSending(false);
    }
  };

  // Why the button isn't there, rather than an unexplained absence.
  const cannotSendBecause =
    signed ? `This ticket is ${String(ticket.status).toLowerCase()} — the client has already signed it, so there is nothing to send.`
    : !recipient ? "No client email on file for this ticket. Add a client rep to the job record and it can be sent."
    : ticket && Number(ticket.total) <= 0 ? "This ticket has nothing on it yet, so there is nothing to approve."
    : "";

  return (
    <Dialog title={`Field invoice ${ticketId}`} maxWidth={900} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
        {canSend && (
          <Btn variant="primary" disabled={sending || !!sentNote} onClick={send}>
            {sending ? "Sending…"
              : sentNote ? "Sent"
              : ticket.status === "Awaiting approval" ? "Send again" : "Send for approval"}
          </Btn>
        )}
      </>}>
      {loading && <Loading />}
      {error && <ErrorBox>{error}</ErrorBox>}
      {sentNote && (
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-accent-700)", marginBottom: 12 }}>
          ✓ {sentNote}
        </div>
      )}

      {ticket && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <StatusTag status={ticket.status} />
            <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              Work performed {dayMonth(localDate(ticket.work_date))}
            </span>
            {invoiceHtml && (
              <Btn variant="ghost" style={{ marginLeft: "auto" }} onClick={printInvoice}>Print</Btn>
            )}
          </div>

          {/* The invoice itself, not a description of it.
              This panel used to re-list the charges in its own little table
              with its own totals — a second rendering of the same bill, which
              is one more thing that can disagree with what the client signed.
              It is now the document, rendered by the same code that renders
              the client's copy, in an iframe so the invoice's own stylesheet
              cannot leak into the app or the app's into it. */}
          {/* Sandboxed with everything but same-origin and modals withheld.
              The renderer escapes every field, but this frame is srcDoc in
              the app's own origin: without a sandbox, an escaping regression
              would hand whatever got injected the signed-in session. With
              one, scripts in the document simply never run — no allow-scripts
              means a regression renders as text instead of executing.
              allow-same-origin is safe on its own (dangerous only paired
              with allow-scripts) and keeps contentWindow reachable for the
              Print button; allow-modals is what lets print() open a dialog. */}
          {invoiceHtml
            ? <iframe
                title={`Field invoice ${ticketId}`}
                srcDoc={invoiceHtml}
                sandbox="allow-same-origin allow-modals"
                ref={frameRef}
                style={{
                  width: "100%",
                  height: "min(70vh, 900px)",
                  // An iframe is a flex item like any other, and the dialog body
                  // is a flex column: without this it gets shrunk to fit rather
                  // than keeping the height it was given.
                  flexShrink: 0,
                  border: "1px solid var(--color-divider)", background: "#fff", display: "block"
                }} />
            : !loading && !error && (
                <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                  Couldn't render this invoice.
                </div>
              )}

          {cannotSendBecause && !sentNote && (
            <div style={{ marginTop: 14, fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
              {cannotSendBecause}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

// One field of the job record: label over value, so a long contact string wraps
// under its own label instead of colliding with the next column.
function RecordCell({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginBottom: 3 }}>{label}</div>
      <div className="tabular" style={{ fontSize: 14, textWrap: "pretty" }}>
        {value || <span style={{ color: "color-mix(in srgb, var(--color-text) 35%, transparent)" }}>—</span>}
      </div>
    </div>
  );
}

// Closing out a JHA: the end readings, taken off each worker's DRD at the end
// of the day. Start is always 0, so what's typed here is the dose that person
// took on this assessment.
// Deleting a job, once it has things filed against it.
//
// A job raised by mistake should be removable, but "delete" on a job that
// carries eight JHAs and a fortnight of tickets is not one decision — it is
// two. This asks the second one out loud: does what is on it move somewhere,
// or go with it.
//
// The counts come from the screen behind, which has already loaded them. The
// database counts again and refuses if they don't add up, so this is the
// explanation rather than the enforcement.
function DeleteJobDialog({ job, jhas, reports, tickets, isAdmin, onClose, onDeleted }) {
  const [mode, setMode] = useState("transfer");
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");

  const attached = jhas.length + reports.length + tickets.length;
  // Billing the client has agreed to does not move and does not vanish. Said
  // here as well as in the database, so it isn't discovered after choosing.
  const locked = tickets.filter(t => t.status === "Approved" || t.status === "Invoiced");

  const confirmWord = job.id;
  const canDelete = !busy
    && locked.length === 0
    && (attached === 0 || (mode === "transfer" ? !!target : typed.trim() === confirmWord));

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await Db.deleteJob({
        jobId: job.dbId,
        transferToId: attached > 0 && mode === "transfer" ? target.dbId : null,
        discard: attached > 0 && mode === "discard"
      });
      onDeleted(mode === "transfer" ? target : null);
    } catch (e) {
      setBusy(false);
      setError(e.message || "Couldn't delete that job.");
    }
  };

  const Count = ({ n, one, many }) => (
    <li style={{ marginBottom: 2 }}>{n} {n === 1 ? one : many}</li>
  );

  return (
    <Dialog title={`Delete ${job.id}?`} maxWidth={560} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn variant="primary" onClick={run} disabled={!canDelete}>
          {busy ? "Deleting…" : attached && mode === "transfer" ? "Transfer and delete" : "Delete job"}
        </Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>

      {locked.length > 0 ? (
        <div style={{ fontSize: 14 }}>
          <p style={{ marginTop: 0 }}>
            This job has <strong>{locked.length} approved or invoiced ticket{locked.length === 1 ? "" : "s"}</strong> on it.
          </p>
          <p style={{ color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
            That is the record of what the client agreed to pay, against this job. It can't be moved to a
            different job or deleted, so this job has to stay. If it was raised in error, mark it complete
            instead — it leaves the board without touching the billing.
          </p>
        </div>
      ) : attached === 0 ? (
        <div style={{ fontSize: 14 }}>
          Nothing has been filed against {job.id} — no hazard assessments, reports or tickets. Deleting it
          removes the job and nothing else.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 14, marginBottom: 4 }}>{job.id} still has:</div>
          <ul style={{ margin: "0 0 14px 18px", padding: 0, fontSize: 14 }}>
            {jhas.length > 0 && <Count n={jhas.length} one="hazard assessment" many="hazard assessments" />}
            {reports.length > 0 && <Count n={reports.length} one="radiographic report" many="radiographic reports" />}
            {tickets.length > 0 && <Count n={tickets.length} one="billing ticket" many="billing tickets" />}
          </ul>

          {/* Destroying a filed record is an admin's. Someone clearing up
              their own mistake moves it to the right job instead. */}
          {isAdmin ? (
            <div className="seg" role="group" aria-label="What happens to them" style={{ marginBottom: 12 }}>
              <button type="button" className={`seg-opt${mode === "transfer" ? " active" : ""}`}
                aria-pressed={mode === "transfer"} onClick={() => setMode("transfer")}>Move them to another job</button>
              <button type="button" className={`seg-opt${mode === "discard" ? " active" : ""}`}
                aria-pressed={mode === "discard"} onClick={() => setMode("discard")}>Delete them too</button>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 12 }}>
              These move to another job — they aren't deleted. Ask an admin if they shouldn't be kept.
            </div>
          )}

          {mode === "transfer" ? (
            <Field label="Move them to">
              <SearchSelect
                style={{ maxWidth: "none" }}
                listId="transfer-job-list"
                ariaLabel="Search jobs to transfer to"
                placeholder={target ? `${target.id} — search to change…` : "Search by job #, project or site…"}
                search={async text => {
                  const res = await Db.searchJobs({ page: 0, pageSize: 25, search: text, searchField: "any" });
                  // Never offer the job being deleted as its own destination.
                  return { rows: res.rows.filter(j => j.dbId !== job.dbId), total: res.total };
                }}
                optionKey={j => j.dbId}
                onPick={setTarget}
                onError={setError}
                renderOption={j => (
                  <>
                    <div style={{ fontSize: 15 }}>{j.id} — {j.project || "No project name"}</div>
                    <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                      {j.client}{j.lsd ? ` · ${j.lsd}` : ""}
                    </div>
                  </>
                )}
              />
            </Field>
          ) : (
            <Field label={`Type ${confirmWord} to confirm`}>
              <input className="input" value={typed} onChange={e => setTyped(e.target.value)}
                placeholder={confirmWord} autoComplete="off" />
            </Field>
          )}

          <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            {mode === "transfer"
              ? "Everything above moves to that job, then this one is deleted. Nothing is lost."
              : "Everything above is deleted with the job. Hazard assessments are a safety record — this can't be undone."}
          </div>
        </>
      )}
    </Dialog>
  );
}

function JhaCloseOutDialog({ jha, currentUser, onClose, onDone }) {
  const [rows, setRows] = useState(() =>
    (jha.dosimetry || []).map(d => ({ ...d, endReading: d.endReading == null ? "" : String(d.endReading) })));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const set = (i, v) => setRows(p => p.map((r, idx) => idx === i ? { ...r, endReading: v } : r));

  const submit = async () => {
    // Named rather than counted: with a helper on the assessment there are two
    // fields, and "enter an end reading" gave no clue which one was still
    // blank — it read like the value just typed hadn't registered.
    const missing = rows.filter(r => String(r.endReading).trim() === "");
    if (missing.length) {
      setErr(`No end reading yet for ${missing.map(r => `${r.name || "worker"} (worker ${r.slot})`).join(" and ")}. Enter 0 if they took no dose.`);
      return;
    }
    const bad = rows.filter(r => {
      const n = Number(String(r.endReading).replace(",", "."));
      return isNaN(n) || n < 0;
    });
    if (bad.length) {
      setErr(`“${bad[0].endReading}” isn't a reading in mR — use digits and one decimal point.`);
      return;
    }
    setSaving(true);
    setErr("");
    try {
      await Db.closeOutJha({
        jhaId: jha.id,
        dosimetry: rows.map(r => ({ ...r, endReading: String(r.endReading).replace(",", ".") })),
        closedBy: currentUser.id
      });
      await onDone();
    } catch (e) {
      setSaving(false);
      setErr(e.message || "Couldn't close out that assessment.");
    }
  };

  return (
    <Dialog title="Close out JHA" maxWidth={520} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Close out"}</Btn>
      </>}>
      <ErrorBox>{err}</ErrorBox>
      <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 65%, transparent)" }}>
        Filed {jha.at} by {jha.by}. Start readings were 0, so the end reading is the dose recorded against each worker.
      </div>
      {!rows.length && (
        <div style={{ fontSize: 13 }}>
          This assessment has no workers recorded on it — closing out will simply mark it done.
        </div>
      )}
      {rows.map((r, i) => (
        <div key={r.profileId || i} style={{ border: "1px solid var(--color-divider)", padding: "12px 14px", display: "grid", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16 }}>{r.name}</span>
            <TagX variant="outline">Nuclear energy worker ({r.slot})</TagX>
          </div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            Unit {r.unit || "—"} · TLD {r.tld || "—"} · DRD {r.drd || "—"} · Alarm {r.alarm || "—"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="Start reading (mR)"><input className="input" value="0" disabled /></Field>
            <Field label="End reading (mR)">
              {/* A text input with a decimal keypad, not type="number": a
                  number input hands back "" for anything the browser considers
                  half-typed or locale-wrong (a comma decimal, a stray key), so
                  a reading that was clearly on screen arrived here empty. */}
              <input className="input" type="text" inputMode="decimal" autoFocus={i === 0}
                value={r.endReading}
                style={{ borderColor: String(r.endReading).trim() === "" ? undefined : "var(--color-accent)" }}
                onChange={e => set(i, e.target.value.replace(/[^\d.,]/g, ""))} />
            </Field>
          </div>
          <div style={{ fontSize: 12, color: "var(--color-accent)" }}>
            Dose recorded: {String(r.endReading).trim() === "" ? "—" : Number(String(r.endReading).replace(",", ".")) + " mR"}
          </div>
        </div>
      ))}
    </Dialog>
  );
}

// Emails an assessment to whoever needs it on file. Recipients are picked
// off the job's own client and contractor people — searchable, since a big
// outfit keeps a long directory — plus a typed address for anyone not on
// file. The send itself happens in the send-jha function, which re-checks
// the caller's session and stamps sent_at/sent_to on the row.
function SendJhaDialog({ job, jha, clientContacts, contractorContacts, onClose, onSent }) {
  const [picked, setPicked] = useState([]);
  const [custom, setCustom] = useState("");
  const [message, setMessage] = useState("Attached: the signed hazard assessment for the work noted below. Let us know if you have questions.");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const muted = "color-mix(in srgb, var(--color-text) 55%, transparent)";

  // Picking someone without an email is answered out loud rather than by a
  // chip that silently can't be sent to.
  const addPick = c => {
    const email = (c.email || "").trim();
    if (!email) {
      setError(`${c.name} has no email on file — add one on the Contacts screen, or type the address below.`);
      return;
    }
    setError("");
    setPicked(p => p.some(x => x.email.toLowerCase() === email.toLowerCase())
      ? p : [...p, { key: c.org_type + ":" + c.id, name: c.name, email }]);
  };

  // A local filter, not a server search — the directory for one job's client
  // and contractor is already in hand.
  const searchIn = list => text => {
    const q = text.trim().toLowerCase();
    return list.filter(c => !q || [c.name, c.title, c.email].some(v => (v || "").toLowerCase().includes(q)));
  };
  const renderContact = c => (
    <>
      <div style={{ fontSize: 15 }}>{c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}</div>
      <div style={{ fontSize: 11, color: c.email ? muted : "var(--color-accent-700)" }}>{c.email || "No email on file"}</div>
    </>
  );

  const send = async () => {
    // The custom field takes "name@co.com" or a pasted "Joe <name@co.com>" —
    // whatever part looks like an address is what gets used.
    const extra = emailIn(custom);
    if (custom.trim() && !extra) { setError(`"${custom.trim()}" doesn't look like an email address.`); return; }
    const to = [...picked.map(p => p.email), ...(extra ? [extra] : [])];
    if (!to.length) { setError("Pick at least one contact, or type an address."); return; }
    setSending(true);
    setError("");
    try {
      await Db.sendJhaEmail({ jhaId: jha.id, to: to.join(", "), cc: "", message: message.trim() });
      onSent();
    } catch (e) {
      setSending(false);
      setError(e.message || "Couldn't send the assessment.");
    }
  };

  return (
    <Dialog title="Send assessment" maxWidth={540} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose} disabled={sending}>Cancel</Btn>
        <Btn variant="primary" onClick={send} disabled={sending}>{sending ? "Sending…" : "Send"}</Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      <div style={{ fontSize: 13 }}>
        <PdfGlyph /> {jha.file}
        <span style={{ color: muted }}> — {job.id} · {job.project}</span>
      </div>

      {picked.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {picked.map(p => (
            <TagX key={p.key} variant="accent">
              {p.name} · {p.email}
              <button type="button" aria-label={`Remove ${p.name}`}
                onClick={() => setPicked(list => list.filter(x => x.key !== p.key))}
                style={{ background: "none", border: 0, cursor: "pointer", color: "inherit", font: "inherit", padding: "0 0 0 6px" }}>
                ×
              </button>
            </TagX>
          ))}
        </div>
      )}

      <Field label={`Client contacts${job.client ? " — " + job.client : ""}`}>
        {clientContacts.length ? (
          <SearchSelect style={{ maxWidth: "none" }} listId="send-jha-client-list"
            ariaLabel="Search client contacts" placeholder="Search by name, title or email…"
            search={searchIn(clientContacts)} optionKey={c => c.id}
            onPick={addPick} renderOption={renderContact} />
        ) : (
          <div style={{ fontSize: 12, color: muted }}>No client contacts on file for this job.</div>
        )}
      </Field>
      <Field label={`Contractor contacts${job.contractor ? " — " + job.contractor : ""}`}>
        {contractorContacts.length ? (
          <SearchSelect style={{ maxWidth: "none" }} listId="send-jha-contractor-list"
            ariaLabel="Search contractor contacts" placeholder="Search by name, title or email…"
            search={searchIn(contractorContacts)} optionKey={c => c.id}
            onPick={addPick} renderOption={renderContact} />
        ) : (
          <div style={{ fontSize: 12, color: muted }}>No contractor contacts on file for this job.</div>
        )}
      </Field>
      <Field label="Someone else">
        <input className="input" type="email" value={custom} placeholder="name@company.com"
          onChange={e => { setError(""); setCustom(e.target.value); }} />
      </Field>
      <Field label="Message"><textarea className="input" value={message} onChange={e => setMessage(e.target.value)} /></Field>
    </Dialog>
  );
}

// pdf.js is ~350 KB and only the Upload dialog wants it, so it loads from
// the CDN on the first dropped PDF — the same bargain the timesheet page
// strikes with SheetJS. A failed load clears the promise so the next drop
// retries instead of staying poisoned. 3.11.174 is the last build that
// loads by script tag; 4.x is ESM-only.
let pdfjsPromise = null;
function loadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
      tag.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      tag.onerror = () => { pdfjsPromise = null; reject(new Error("Couldn't load the PDF reader.")); };
      document.head.appendChild(tag);
    });
  }
  return pdfjsPromise;
}

// The text layer of every page, joined. A report is a handful of pages; the
// cap is for the day somebody drops a welding procedures manual by mistake,
// so the dialog shrugs instead of chewing through three hundred pages.
async function pdfText(file, maxPages = 40) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  try {
    let out = "";
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      out += content.items.map(it => it.str).join(" ") + "\n";
    }
    return out;
  } finally { doc.destroy(); }
}

function UploadReportDialog({ job, jobRecord, currentUser, onClose, onSubmit }) {
  const [file, setFile] = useState(null);
  const [welds, setWelds] = useState("");
  const [to, setTo] = useState(() => emailIn(jobRecord.contractorRep));
  const [cc, setCc] = useState("");
  const [message, setMessage] = useState("Attached: interpreted RT report for the welds noted below. Let us know if you have questions.");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const miss = useMissingFields();

  // Reading the numbers off the dropped report. The scan fills the field but
  // never owns it: a value the tech typed, or edited after a fill, stays put
  // — the fill only lands on an empty field or over its own previous answer.
  // Every failure is silent (no text layer, CDN unreachable, scanned paper):
  // the field simply stays manual, which is what it was yesterday.
  const autoFill = useRef("");
  const scanSeq = useRef(0);
  const scanForNumbers = async f => {
    const seq = ++scanSeq.current;
    try {
      const found = lastNumbers(await pdfText(f));
      if (!found || seq !== scanSeq.current) return;   // a newer drop wins
      setWelds(w => {
        if (w && w !== autoFill.current) return w;     // hand-typed: theirs
        autoFill.current = found;
        return found;
      });
      miss.fixed("welds");
    } catch { /* stays manual */ }
  };

  const submit = async sent => {
    if (!file) { miss.flag("file"); setError("Attach the interpreted PDF first."); return; }
    if (!welds.trim()) { miss.flag("welds"); setError("Note which welds this report covers."); return; }
    if (sent && !emailIn(to)) { miss.flag("to"); setError("Add an email address to send to, or use Upload only."); return; }
    miss.clear();
    setSaving(true);
    setError("");
    try {
      const report = await Db.uploadReport({
        jobDbId: job.dbId, jobNumber: job.id, file, welds: welds.trim(), result: "Accept",
        interpretedBy: currentUser.name, send: false, sendTo: to.trim()
      });
      // The row is stored first, then emailed — so a Postmark outage costs the
      // send, not the upload. The report shows as Pending and can be resent.
      if (sent) {
        setSaving("Sending…");
        await Db.sendReportEmail({
          reportId: report.id, to: to.trim(), cc: cc.trim(), message: message.trim()
        });
      }
      onSubmit();
    } catch (e) {
      setSaving(false);
      setError(e.message || "Couldn't upload — try again.");
    }
  };

  return (
    <Dialog title="Upload report" maxWidth={540} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={() => submit(false)} disabled={!!saving}>Upload only</Btn>
        <Btn variant="primary" onClick={() => submit(true)} disabled={!!saving}>{saving === true ? "Uploading…" : saving || "Upload & send"}</Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      {/* The drop zone is not an .input, so it takes the same ring by hand
          rather than being the one required thing that doesn't light up. */}
      <div className="blueprint" style={{
        borderStyle: "dashed", padding: "22px", textAlign: "center", position: "relative",
        ...(miss.is("file") ? {
          borderColor: "var(--color-accent-700)",
          boxShadow: "0 0 0 2px color-mix(in srgb, var(--color-accent) 30%, transparent)",
          background: "color-mix(in srgb, var(--color-accent) 7%, transparent)"
        } : null)
      }}>
        <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>Drop the interpreted PDF here, or click to browse</div>
        <input type="file" accept="application/pdf" aria-label="Interpreted PDF" aria-invalid={miss.is("file") || undefined}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
          onChange={e => {
            const f = e.target.files[0] || null;
            miss.fixed("file");
            setFile(f);
            if (f) scanForNumbers(f);
            e.target.value = "";
          }} />
        {file && <div style={{ marginTop: 8, fontSize: 12 }}><PdfGlyph /> {file.name}</div>}
      </div>
      <Field label="Last numbers" missing={miss.is("welds")}>
        <input {...miss.props("welds")} value={welds} onChange={e => { miss.fixed("welds"); setWelds(e.target.value); }} placeholder="XF-47 to XF-54, MT-1 to MT-15" />
      </Field>

      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginTop: 4 }}>Send to contractor</div>
      <Field label="To" missing={miss.is("to")}>
        <input {...miss.props("to")} value={to} onChange={e => { miss.fixed("to"); setTo(e.target.value); }} />
      </Field>
      <Field label="Cc"><input className="input" value={cc} onChange={e => setCc(e.target.value)} /></Field>
      <Field label="Message"><textarea className="input" value={message} onChange={e => setMessage(e.target.value)} /></Field>
    </Dialog>
  );
}

function CreateTicketDialog({ job, jobRecord, currentUser, onClose, onSubmit }) {
  const miss = useMissingFields();
  const [workDate, setWorkDate] = useState(todayLocal);
  // Raising a ticket means work happened, and work needs a hazard assessment
  // filed for the day. This reminds rather than blocks — the JHA may have been
  // filed on paper, or by the other tech on the crew.
  const [jhaMissing, setJhaMissing] = useState(false);
  useEffect(() => {
    if (!job || !job.dbId) return;
    Db.jhaFiledToday(job.dbId).then(ok => setJhaMissing(!ok)).catch(() => setJhaMissing(false));
  }, [job ? job.dbId : null]);
  const [clientRep, setClientRep] = useState(() => splitContact(jobRecord.clientRep));
  const [contractorRep, setContractorRep] = useState(() => splitContact(jobRecord.contractorRep));
  // What the number will be if this ticket is raised now. The real one is
  // minted by the database at save time — see Db.createTicket — so this is a
  // preview, and it can move if someone else raises a ticket first.
  const [preview, setPreview] = useState("");
  const [provisional, setProvisional] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => OfflineCache.subscribe(s => setProvisional(s.servingCached)), []);
  // The directory, so both rep fields can offer everyone on file for this
  // job's client and contractor rather than only the job's primary.
  const [contacts, setContacts] = useState([]);
  useEffect(() => { Db.listContacts().then(setContacts).catch(() => setContacts([])); }, []);

  const forOrg = (type, id) => (id ? contacts.filter(c => c.org_type === type && c.org_id === id) : [])
    .slice().sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || (a.name || "").localeCompare(b.name || ""));
  const clientContacts = forOrg("client", job.clientId);
  const contractorContacts = forOrg("contractor", job.contractorId);

  const d = localDate(workDate);
  const initials = initialsOf(currentUser.name);
  const longDate = d.toLocaleDateString("en-CA", { weekday: "short", day: "2-digit", month: "long", year: "numeric" });
  const seq = preview ? preview.slice(preview.lastIndexOf("-") + 1) : "";

  useEffect(() => {
    if (isNaN(d)) return;
    let live = true;
    Db.nextTicketNumber(initials, workDate)
      .then(n => { if (live) setPreview(n); })
      .catch(() => { if (live) setPreview(""); });
    return () => { live = false; };
  }, [initials, workDate]);

  const submit = async () => {
    if (isNaN(d)) { miss.flag("workDate"); setError("Pick a valid work date."); return; }
    miss.clear();
    setSaving(true);
    setError("");
    try {
      // An empty ticket to start — the billing-ticket screen (per-weld and
      // other-charge lines) is where the amount actually gets built up;
      // this dialog just opens the draft. The number comes back from the
      // insert rather than being decided here, so what opens is whatever the
      // database actually stored.
      const { id } = await Db.createTicket({
        initials, jobDbId: job.dbId, technicianId: currentUser.id, workDate,
        clientContact: { name: contactLabel(clientRep) }, contractorContact: { name: contactLabel(contractorRep) },
        lines: [], status: "Draft"
      });
      onSubmit(id);
    } catch (e) {
      setSaving(false);
      setError(e.message || "Couldn't create the ticket — try again.");
    }
  };

  return (
    <Dialog title="Create ticket" maxWidth={520} onClose={onClose}
      actions={<><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Creating…" : "Create ticket"}</Btn></>}>
      <ErrorBox>{error}</ErrorBox>
      {jhaMissing && (
        <div style={{ border: "1px solid var(--color-accent)", padding: "10px 12px", fontSize: 13 }}>
          No JHA has been filed for this job today — start one before the crew works. The ticket can still be raised now.
        </div>
      )}
      <div className="blueprint" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 16, position: "relative" }}>
        <i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" />
        <div>
          <div style={{ fontSize: 10, textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Ticket number</div>
          <div className="tabular" style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 32 }}>{preview || "…"}</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right", fontSize: 12 }}>
          <div className="tabular">{initials} · {ticketDateStamp(d)} · {longDate}</div>
          <div style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {seq ? `Ticket ${seq} of the day for ${initials}` : "Reserving a number…"}
          </div>
          {provisional && (
            <div style={{ color: "var(--color-accent-700)", marginTop: 2 }}>
              Provisional — offline, confirmed on sync
            </div>
          )}
        </div>
      </div>
      <Field label="Work date" missing={miss.is("workDate")}>
        <input {...miss.props("workDate")} type="date" value={workDate}
          onChange={e => { miss.fixed("workDate"); setWorkDate(e.target.value); }} />
      </Field>
      <Field label="Technician"><input className="input" value={currentUser.name} disabled /></Field>

      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginTop: 4 }}>
        Contacts for this ticket only — the job's contacts on file are untouched
      </div>
      <Field label="Client representative">
        {clientContacts.length > 0 && (
          <select className="input" style={{ marginBottom: 6 }} aria-label="Client contact on file"
            value={(clientContacts.find(c => contactLabel(c) === contactLabel(clientRep)) || {}).id || ""}
            onChange={e => {
              const c = clientContacts.find(x => String(x.id) === String(e.target.value));
              setClientRep(c ? { name: c.name, phone: c.phone || "", email: c.email || "" } : { name: "", phone: "", email: "" });
            }}>
            <option value="">Someone else — type below…</option>
            {clientContacts.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        )}
        <ContactParts value={clientRep} onChange={setClientRep} />
      </Field>
      <Field label="Contractor representative">
        {contractorContacts.length > 0 && (
          <select className="input" style={{ marginBottom: 6 }} aria-label="Contractor contact on file"
            value={(contractorContacts.find(c => contactLabel(c) === contactLabel(contractorRep)) || {}).id || ""}
            onChange={e => {
              const c = contractorContacts.find(x => String(x.id) === String(e.target.value));
              setContractorRep(c ? { name: c.name, phone: c.phone || "", email: c.email || "" } : { name: "", phone: "", email: "" });
            }}>
            <option value="">Someone else — type below…</option>
            {contractorContacts.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        )}
        <ContactParts value={contractorRep} onChange={setContractorRep} />
      </Field>
    </Dialog>
  );
}

// Name, phone and email as three fields rather than one — the ticket still
// stores the joined string, but nobody should have to type a · to record a
// phone number.
function ContactParts({ value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, minWidth: 0 }} className="grid-2col">
      <input className="input" style={{ gridColumn: "1 / -1", minWidth: 0 }} value={value.name} placeholder="Name"
        aria-label="Name" onChange={e => set("name", e.target.value)} />
      <input className="input" style={{ minWidth: 0 }} type="tel" value={value.phone} placeholder="Phone"
        aria-label="Phone" onChange={e => set("phone", e.target.value)} />
      <input className="input" style={{ minWidth: 0 }} type="email" value={value.email} placeholder="Email"
        aria-label="Email" onChange={e => set("email", e.target.value)} />
    </div>
  );
}

// One rep on the job record: pick them off the organisation's list, or type
// someone who isn't on it yet. Unlike the ticket dialog — which takes a
// one-off contact for that ticket alone — this names the person for the job,
// so it does write back to the directory.
function RepEditor({ heading, options, value, onChange, emptyNote }) {
  const rep = value || { id: "", name: "", email: "", phone: "" };
  const muted = "color-mix(in srgb, var(--color-text) 55%, transparent)";

  const pick = id => {
    const c = options.find(x => String(x.id) === String(id));
    onChange(c
      ? { id: c.id, name: c.name || "", phone: c.phone || "", email: c.email || "" }
      : { id: "", name: "", phone: "", email: "" });
  };

  const edit = v => {
    const picked = rep.id && options.find(c => String(c.id) === String(rep.id));
    // Correcting a picked person's phone or email updates them. Typing over
    // the *name* means somebody else entirely, so the link is dropped rather
    // than renaming the contact everyone else's jobs point at.
    const stillThem = !picked || (v.name || "").trim().toLowerCase() === (picked.name || "").trim().toLowerCase();
    onChange({ ...rep, ...v, id: stillThem ? rep.id : "" });
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginBottom: 6 }}>
        {heading}
      </div>
      {options.length > 0 ? (
        <select className="input" style={{ marginBottom: 6 }} aria-label={heading + " on file"}
          value={rep.id || ""} onChange={e => pick(e.target.value)}>
          <option value="">Someone else — type below…</option>
          {options.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}
            </option>
          ))}
        </select>
      ) : (
        <div style={{ fontSize: 12, color: muted, marginBottom: 6 }}>
          {emptyNote || "Nobody on file for them yet — typing a name here adds one."}
        </div>
      )}
      <ContactParts value={rep} onChange={edit} />
      <div style={{ fontSize: 12, color: muted, marginTop: 4 }}>
        {rep.id
          ? "Correcting the phone or email updates them in Contacts."
          : "A name that isn't on file is added to Contacts when you save."}
      </div>
    </div>
  );
}


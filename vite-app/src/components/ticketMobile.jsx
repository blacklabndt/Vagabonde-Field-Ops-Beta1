import React, { useState, useEffect, useMemo, useRef } from "react";
import { money, todayLocal, localDate, dayMonth, initialsOf, crewRoleFor, hours, METHODS, WELD_ITEMS, SERVICES } from "../data.js";
import { Db } from "../db.js";
import { Blueprint, Btn, TagX, Field, ErrorBox, round1, emailIn, NoJobSelected, QueuedPanel, NumField , Loading } from "./common.jsx";
import { OfflineQueue } from "../offlineQueue.js";
import { OfflineCache } from "../offlineCache.js";

function rateForWeldItem(item, rates) {
  if (item.isWeld) return rates[item.mode][item.weldIdx];
  const idx = METHODS.findIndex(m => m.key === item.methodKey);
  return rates.methods[idx];
}
function rateForService(svc, rates) {
  if (svc.rateIdx != null) return rates.exp[svc.rateIdx];
  return svc.rate;
}

// Stored ticket lines back into the two on-screen lists. Matched by label,
// which is what a ticket stores — a line whose label is no longer in the rate
// card is left off rather than guessed at.
//
// `keepQuantities` is the difference between reopening a draft (which must
// come back exactly as it was left) and copying yesterday's ticket forward
// (which must not).
function linesToForm(lines, keepQuantities) {
  const weldKeyByLabel = Object.fromEntries(WELD_ITEMS.map(w => [w.label, w.key]));
  const serviceKeyByLabel = Object.fromEntries(SERVICES.map(s => [s.label, s.key]));
  const welds = [], others = [];
  (lines || []).forEach(l => {
    const qty = keepQuantities ? Number(l.quantity) : 0;
    if (l.kind === "weld") {
      const key = weldKeyByLabel[l.label];
      if (key) welds.push({ key, qty });
    } else {
      const key = serviceKeyByLabel[l.label];
      if (key) others.push({ key, qty });
    }
  });
  return { welds, others };
}

// Everything a crew row carries that is a measurement of today.
const CREW_FIGURES = ["straight", "ot", "solo", "soloOt", "dose", "mileage"];
const hasEntries = (weldLines, otherLines, crew) =>
  weldLines.some(l => l.qty > 0) ||
  otherLines.some(l => l.qty > 0) ||
  crew.some(c => CREW_FIGURES.some(k => c[k] > 0));

export function TicketMobileScreen({ job, jobRecord, currentUser, onSaved, ticket }) {
  const [rates, setRates] = useState(null);
  const [loadError, setLoadError] = useState("");
  // Both belong to the in-progress-ticket recovery further down, but they are
  // read by the crew-seeding effect above it, so they are declared here.
  //
  // wipReady stops the writer running before the reader has had its turn,
  // which would persist an empty form over the very thing being recovered.
  const wipReady = useRef(false);
  // wipRestored stops the crew-seeding effect from resetting a recovered crew
  // when the recovered work date re-runs it.
  const wipRestored = useRef(false);
  const [ticketId, setTicketId] = useState(ticket || "");
  // A reopened draft has to finish loading before its zeros can be trusted as
  // zeros rather than as "not read yet".
  const [loadingTicket, setLoadingTicket] = useState(!!ticket);

  // Every ticket starts empty, per Kyle. The usual lines used to be laid out
  // ready to step up, but a pre-laid line is a claim waiting to be skimmed
  // past — every charge on a ticket is now one somebody picked from the
  // dropdown on purpose. (Reopened drafts and "start from last ticket" still
  // bring their own lines; this is only what a blank ticket opens with.)
  const [weldLines, setWeldLines] = useState([]);
  const [weldPick, setWeldPick] = useState(WELD_ITEMS[0].key);
  const [otherLines, setOtherLines] = useState([]);
  const [servicePick, setServicePick] = useState(SERVICES[0].key);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [queued, setQueued] = useState(false);
  // Set once the ticket row exists, so a retry emails rather than re-inserts.
  // A reopened draft is already in the database, so it starts true and every
  // save is an update.
  const [created, setCreated] = useState(!!ticket);
  // Whether the last attempt got the ticket saved but failed to email it — the
  // only case where the primary button should offer a retry rather than a send.
  const [emailFailed, setEmailFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // The contact this ticket was actually raised against. A reopened draft may
  // name a different rep than the job's current primary — that is the whole
  // point of the per-ticket contacts — so the approval email follows the ticket,
  // not the job.
  const [ticketClientContact, setTicketClientContact] = useState("");
  // A JHA left open at the end of the day is the thing most easily forgotten,
  // and the moment someone closes out their billing is when they're thinking
  // about the day ending. Reminder only — it never blocks the ticket.
  const [openJha, setOpenJha] = useState(null);
  useEffect(() => {
    if (!job || !job.dbId) return;
    Db.openJhaForJob(job.dbId).then(setOpenJha).catch(() => setOpenJha(null));
  }, [job ? job.dbId : null]);

  // Crew: who was on this ticket, and how the billed hours land on each
  // person's timesheet. Seeded with whoever is raising the ticket.
  const [people, setPeople] = useState([]);
  const [crew, setCrew] = useState([]);
  const [crewPick, setCrewPick] = useState("");

  // The date this ticket is filed against — captured once when the screen
  // opens, in local time, so a ticket built either side of midnight UTC still
  // carries the day the work was actually done. A reopened draft keeps the day
  // it was raised for, not today.
  const [workDate, setWorkDate] = useState(todayLocal);
  // Standby, waiting on the line, road bans. Prints on the client's field
  // invoice, so it belongs to the day rather than to the job.
  const [delays, setDelays] = useState("");
  // A number worked out on this device rather than handed over by the
  // database. It usually matches what gets stored, but it can be overtaken,
  // so it must not read like a settled fact — this is the number a technician
  // might write on the day's paperwork.
  const [provisionalNumber, setProvisionalNumber] = useState(false);
  useEffect(() => OfflineCache.subscribe(s => setProvisionalNumber(!ticket && s.servingCached)), [ticket]);

  useEffect(() => {
    if (!job) return;
    (async () => {
      try {
        const r = await Db.getPublishedRatesForClient(job.clientId);
        if (!r) { setLoadError("No published rate schedule for this client yet — set one up in Rate admin first."); return; }
        setRates(r);
      } catch (e) {
        // Rates come from the offline cache when there's no signal, so getting
        // here with a network error means this client's card has never been
        // loaded on this device. Say that, rather than "Couldn't load rates".
        setLoadError(OfflineQueue.isNetworkError(e)
          ? "No connection, and this client's rates haven't been opened on this device yet. Open this job once in range and the ticket screen works offline from then on."
          : (e.message || "Couldn't load rates."));
      }
    })();
    // A preview only: the number that actually gets stored is minted by the
    // database when this is saved, which is what keeps a ticket built offline
    // this morning from colliding with one raised in the meantime.
    if (!ticket) {
      Db.nextTicketNumber(initialsOf(currentUser.name), workDate)
        .then(setTicketId)
        .catch(e => setLoadError(e.message || "Couldn't reserve a ticket number."));
    }

    Db.listProfiles()
      .then(list => {
        setPeople(list);
        const first = list.find(p => p.id !== currentUser.id);
        if (first) setCrewPick(first.id);
        // A reopened draft brings its own crew rows; seeding "just me" here
        // would overwrite them the moment the loaded work date re-ran this.
        // Same for a recovered entry — its work date re-runs this effect, and
        // without the guard the crew it came back with is wiped.
        if (ticket || wipRestored.current) return;
        const me = list.find(p => p.id === currentUser.id);
        setCrew([{
          profileId: currentUser.id,
          name: me ? me.displayName : currentUser.name,
          isSub: me ? me.is_subcontractor : false,
          role: "Lead", straight: 0, ot: 0, solo: 0, soloOt: 0, dose: 0, mileage: 0
        }]);
      })
      .catch(e => console.error("Couldn't load crew list:", e.message));
  }, [job ? job.clientId : null, workDate]);

  // Reopening a draft: pull its lines and crew back into the form. Lines
  // are matched by label, which is what the ticket stores — a line whose label
  // no longer exists in the rate card is left off rather than guessed at.
  useEffect(() => {
    if (!ticket) return;
    (async () => {
      try {
        const [row, savedCrew] = await Promise.all([Db.getTicket(ticket), Db.listCrewForTicket(ticket)]);
        const { welds, others } = linesToForm(row.ticket_lines, true);
        if (welds.length) setWeldLines(welds);
        if (others.length) setOtherLines(others);
        if (row.work_date) setWorkDate(row.work_date);
        if (row.delays) setDelays(row.delays);
        if (row.client_contact && row.client_contact.name) setTicketClientContact(row.client_contact.name);
        if (savedCrew.length) setCrew(savedCrew);
      } catch (e) {
        setLoadError(e.message || "Couldn't open that ticket.");
      }
      setLoadingTicket(false);
    })();
  }, [ticket]);

  // ── Start from the last ticket ─────────────────────────────────────────
  // Offered, never applied on its own: a ticket must never arrive carrying
  // shape nobody asked for.
  const [lastTicket, setLastTicket] = useState(null);
  const [copiedFrom, setCopiedFrom] = useState("");
  useEffect(() => {
    if (!job || !job.dbId) return;
    let live = true;
    Db.lastTicketForJob(job.dbId, ticket)
      .then(t => { if (live) setLastTicket(t); })
      // Nothing to offer is the normal case on a job's first ticket, and
      // offline it can't be answered. Either way the button just isn't there.
      .catch(() => { if (live) setLastTicket(null); });
    return () => { live = false; };
  }, [job ? job.dbId : null, ticket]);

  const startFromLast = () => {
    if (!lastTicket) return;
    const { welds, others } = linesToForm(lastTicket.lines, false);
    if (welds.length) setWeldLines(welds);
    if (others.length) setOtherLines(others);
    if (lastTicket.crew.length) {
      // The people and their roles carry over; their hours do not. Copying
      // the figures would mean a tired crew could file yesterday's numbers by
      // tapping straight through — the whole point is to skip the picking,
      // not the counting.
      setCrew(lastTicket.crew.map(c => ({
        ...c, ...Object.fromEntries(CREW_FIGURES.map(k => [k, 0]))
      })));
    }
    setCopiedFrom(lastTicket.id);
  };

  // ── Don't lose a half-entered ticket ───────────────────────────────────
  // Save draft is a deliberate act and is disabled until there is a total, so
  // a tab evicted by the phone halfway through entering a day's welds used to
  // take the lot with it. This keeps a copy on the device as it is typed.
  //
  // Keyed by the draft being edited, or by the job when it is a new ticket, so
  // two jobs on the go don't overwrite each other.
  const wipKey = `ticket.wip.${ticket || (job && job.dbId)}`;
  const [recovered, setRecovered] = useState(null);

  useEffect(() => {
    if (!job || loadingTicket) return;
    let live = true;
    OfflineCache.read(wipKey)
      .then(hit => {
        if (!live) return;
        const w = hit && hit.value;
        if (w && hasEntries(w.weldLines || [], w.otherLines || [], w.crew || [])) {
          wipRestored.current = true;
          if (w.weldLines) setWeldLines(w.weldLines);
          if (w.otherLines) setOtherLines(w.otherLines);
          if (w.crew) setCrew(w.crew);
          if (w.workDate) setWorkDate(w.workDate);
          if (w.delays) setDelays(w.delays);
          setRecovered(hit.at || null);
        }
        wipReady.current = true;
      })
      .catch(() => { wipReady.current = true; });
    return () => { live = false; };
  }, [job ? job.dbId : null, ticket, loadingTicket]);

  useEffect(() => {
    if (!job || loadingTicket || !wipReady.current) return;
    // Only what someone actually entered is worth keeping. An untouched form
    // is cleared instead, so opening the screen and backing out doesn't leave
    // a phantom to recover next time.
    if (!hasEntries(weldLines, otherLines, crew)) { OfflineCache.remove(wipKey); return; }
    const t = setTimeout(() => {
      OfflineCache.put(wipKey, { weldLines, otherLines, crew, workDate, delays });
    }, 700);
    return () => clearTimeout(t);
  }, [weldLines, otherLines, crew, workDate, delays, loadingTicket]);

  const discardRecovered = () => {
    OfflineCache.remove(wipKey);
    setRecovered(null);
    // Back to what a fresh ticket opens with: nothing.
    setWeldLines([]);
    setOtherLines([]);
    setCrew(p => p.map(c => ({ ...c, ...Object.fromEntries(CREW_FIGURES.map(k => [k, 0])) })));
  };

  // Constant maps — rebuilt on every keystroke before, for no reason.
  const weldItemsByKey = useMemo(() => Object.fromEntries(WELD_ITEMS.map(w => [w.key, w])), []);
  const serviceByKey = useMemo(() => Object.fromEntries(SERVICES.map(s => [s.key, s])), []);

  if (!job) return <NoJobSelected what="a billing ticket" />;
  if (queued) return <QueuedPanel what="this ticket" onDone={onSaved} />;
  if (loadError) {
    return <div className="page"><Blueprint style={{ padding: 20 }}><ErrorBox>{loadError}</ErrorBox></Blueprint></div>;
  }
  if (!rates || loadingTicket) {
    return <div className="page"><Loading label={loadingTicket ? "Opening ticket…" : "Loading rates…"} /></div>;
  }

  const weldCount = weldLines.filter(l => weldItemsByKey[l.key].isWeld).reduce((s, l) => s + l.qty, 0);
  const weldDollars = weldLines.reduce((s, l) => s + l.qty * rateForWeldItem(weldItemsByKey[l.key], rates), 0);
  const otherDollars = otherLines.reduce((s, l) => s + l.qty * rateForService(serviceByKey[l.key], rates), 0);
  const total = weldDollars + otherDollars;

  const availableWeld = WELD_ITEMS.filter(w => !weldLines.some(l => l.key === w.key));
  const availableService = SERVICES.filter(s => !otherLines.some(l => l.key === s.key));

  // What the client is billed for hours — the figure the crew split is
  // measured against. A crew line can legitimately differ from it (crew-hours
  // billed once, worked by two people), so this informs rather than enforces.
  // Solo hours are a rate distinction inside those hours, not extra time, so
  // they're excluded from the comparison.
  const billedStraight = (otherLines.find(l => l.key === "straight") || {}).qty || 0;
  const billedOt = (otherLines.find(l => l.key === "ot") || {}).qty || 0;
  const assignedStraight = crew.reduce((s, c) => s + (c.straight || 0), 0);
  const assignedOt = crew.reduce((s, c) => s + (c.ot || 0), 0);
  const availablePeople = people.filter(p => !crew.some(c => c.profileId === p.id));
  const availableHelpers = availablePeople.filter(p => crewRoleFor(p) === "Helper");
  const availableTechs = availablePeople.filter(p => crewRoleFor(p) !== "Helper");

  const setCrewField = (profileId, key, value) =>
    setCrew(p => p.map(c => c.profileId === profileId ? { ...c, [key]: Math.max(0, value) } : c));

  // Two conventions, one tap each: hours divided among the crew, or each
  // person credited the full day (crew-rate billing).
  const splitEvenly = () => setCrew(p => p.length ? p.map(c => ({
    ...c,
    straight: round1(billedStraight / p.length),
    ot: round1(billedOt / p.length)
  })) : p);
  const fullHoursEach = () => setCrew(p => p.map(c => ({ ...c, straight: billedStraight, ot: billedOt })));

  const setWeldQty = (key, qty) => setWeldLines(p => p.map(l => l.key === key ? { ...l, qty: Math.max(0, qty) } : l));
  const setOtherQty = (key, qty) => setOtherLines(p => p.map(l => l.key === key ? { ...l, qty: Math.max(0, qty) } : l));
  const removeWeld = key => setWeldLines(p => p.filter(l => l.key !== key));
  const removeOther = key => setOtherLines(p => p.filter(l => l.key !== key));

  const buildLines = () => [
    ...weldLines.map(l => { const it = weldItemsByKey[l.key]; return { kind: "weld", label: it.label, unit: "weld", quantity: l.qty, unit_rate: rateForWeldItem(it, rates) }; }),
    ...otherLines.map(l => { const svc = serviceByKey[l.key]; return { kind: "charge", label: svc.label, unit: svc.unit, quantity: l.qty, unit_rate: rateForService(svc, rates) }; })
  ];

  const save = async sendForApproval => {
    if (total <= 0) {
      setSaveError("This ticket has no charges on it yet — enter the day's quantities first.");
      return;
    }
    // If sending is the goal, find the address before writing anything: a
    // missing rep email used to surface only after the ticket was already in
    // the database, and the retry then collided with its own primary key.
    let to = null;
    if (sendForApproval) {
      try { to = approvalEmail(ticketClientContact || jobRecord.clientRep); }
      catch (e) { setSaveError(e.message); return; }
    }

    setSaving(true);
    setSaveError("");
    setEmailFailed(false);
    try {
      // Saved first, emailed second — and saved as a Draft either way.
      //
      // This used to write "Awaiting approval" here, before the send was
      // attempted, so a send that failed left a ticket claiming the client
      // had it. With Postmark unconfigured that is every send, and the
      // tracker showed tickets waiting on a signature nobody had been asked
      // for. send-ticket-approval promotes the status itself once the mail
      // is actually away, so there is one place that decides it and it is
      // the one that knows whether anything left the building.
      // `created` records that the write landed, so a retry after a failed
      // send doesn't try to insert the same ticket number twice.
      // Everything after the insert has to use the number the database
      // actually minted, not the preview this screen has been showing.
      let savedId = ticketId;
      if (!created) {
        const saved = await Db.createTicket({
          initials: initialsOf(currentUser.name), jobDbId: job.dbId, technicianId: currentUser.id, workDate,
          clientContact: { name: jobRecord.clientRep }, contractorContact: { name: jobRecord.contractorRep },
          lines: buildLines(), status: "Draft",
          delays
        });
        savedId = saved.id;
        setTicketId(savedId);
        await Db.saveCrewForTicket(savedId, crew);
        setCreated(true);
      } else {
        // Already in the database — either a reopened draft, or a retry after
        // the approval email failed. Both want the same thing: write what is on
        // screen now over what is stored.
        await Db.updateTicket({
          ticketId: savedId, lines: buildLines(),
          status: "Draft",
          delays
        });
        await Db.saveCrewForTicket(savedId, crew);
      }
      if (sendForApproval) await Db.sendTicketApproval({ ticketId: savedId, to });
      // Safely stored — the on-device copy has nothing left to protect, and
      // leaving it would offer this ticket back as unsaved work next time.
      await OfflineCache.remove(wipKey);
      onSaved();
    } catch (e) {
      if (OfflineQueue.isNetworkError(e)) {
        await OfflineQueue.enqueue("ticket", {
          // No ticketId on a ticket that was never created: the number is
          // minted when this replays, so hours offline can't reserve a number
          // somebody else has since been given.
          ticketId: created ? ticketId : null,
          initials: initialsOf(currentUser.name),
          jobDbId: job.dbId, technicianId: currentUser.id, workDate,
          clientContact: { name: jobRecord.clientRep }, contractorContact: { name: jobRecord.contractorRep },
          lines: buildLines(), status: "Draft",
          crew, delays, alreadyCreated: created, sendForApproval, approvalTo: to
        });
        // Queued counts as safe: the work is on the device in the outbox now,
        // which is a better home for it than the recovery copy.
        await OfflineCache.remove(wipKey);
        setQueued(true);
        return;
      }
      setSaving(false);
      if (created) setEmailFailed(true);
      setSaveError(created
        ? `Ticket ${ticketId} is saved, but the approval email didn't go out: ${e.message || "the email service didn't respond."} It's in the billing tracker — you can chase it from there.`
        : (e.message || "Couldn't save the ticket — try again."));
    }
  };

  // The job record stores the rep as a display string ("T. Beaudry · (780)…"),
  // so pull the address out of it rather than mailing the whole label.
  function approvalEmail(rep) {
    const found = emailIn(rep);
    if (!found) throw new Error("No client rep email to send to — add one on this ticket, or in the job record, first.");
    return found;
  }

  // Cancelling a ticket raised by mistake. Only offered once the ticket exists
  // — before that, leaving the screen is the cancel.
  async function cancelTicket() {
    if (!confirm(`Cancel ticket ${ticketId}? It is deleted outright, along with any hours and dose recorded on it. This can't be undone.`)) return;
    setCancelling(true);
    setSaveError("");
    try {
      await Db.deleteTicket(ticketId);
      onSaved();
    } catch (e) {
      setCancelling(false);
      setSaveError(e.message || "Couldn't cancel that ticket.");
    }
  }

  return (
    <div className="page">
      <div className="phone-shell">
        <Blueprint className="phone-frame">
          <div style={{ display: "flex", alignItems: "center", fontSize: 11, textTransform: "uppercase" }}>
            <span style={{ width: 7, height: 7, background: "var(--color-accent)", marginRight: 6, flex: "none" }} />
            Draft ticket
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="tabular" style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 20 }}>{ticketId || "…"}</span>
              {provisionalNumber && <TagX variant="outline">provisional</TagX>}
            </div>
            {provisionalNumber && (
              <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                Worked out on this device while offline. The final number is set when this ticket syncs — check it before writing it on paperwork.
              </div>
            )}
            {/* The work date is on the face of the ticket now — it decides
                which pay period the crew's hours land in. */}
            <div className="tabular" style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              {dayMonth(localDate(workDate))} · {job.client}{jobRecord.afe ? ` · ${jobRecord.afe}` : ""}{jobRecord.lsd ? ` · ${jobRecord.lsd}` : ""}
            </div>
          </div>

          {/* Work found on the device that never made it to the database.
              Brought back automatically — losing a day's entry is the bad
              outcome here, and an untouched form is never stored — but said
              out loud, with a way to throw it away. */}
          {recovered && (
            <div style={{
              fontSize: 12, padding: "8px 10px",
              border: "1px solid var(--color-accent-700)",
              background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap"
            }}>
              <span>Brought back what you were entering{recovered ? ` at ${new Date(recovered).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" })}` : ""} — it was never saved.</span>
              <button type="button" onClick={discardRecovered}
                style={{ marginLeft: "auto", background: "none", border: "none", textDecoration: "underline", cursor: "pointer", color: "inherit", font: "inherit", padding: 0 }}>
                Start empty
              </button>
            </div>
          )}

          {/* Multi-day jobs repeat. This copies the shape of the last ticket
              — which lines, which crew — and nothing else. */}
          {lastTicket && !copiedFrom && !recovered && (
            <Btn variant="secondary" block onClick={startFromLast}
              title="Copies the lines and crew from the last ticket on this job. Quantities and hours start at zero.">
              Start from {lastTicket.id}{lastTicket.workDate ? ` · ${dayMonth(localDate(lastTicket.workDate))}` : ""}
            </Btn>
          )}
          {copiedFrom && (
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              Lines and crew copied from {copiedFrom}. Quantities and hours start at zero — enter today's.
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>Per-weld charges</span>
            <span className="tabular" style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-accent)" }}>{weldCount} welds · {money(weldDollars)}</span>
          </div>
          {weldLines.length === 0 && (
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              Nothing billed yet — pick a line below and tap Add.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {weldLines.map(l => {
              const item = weldItemsByKey[l.key];
              const rate = rateForWeldItem(item, rates);
              return (
                <div key={l.key} style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)", paddingBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15 }}>{item.label}</div>
                    <div className="tabular" style={{ fontSize: 10, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{money(rate)} / weld</div>
                  </div>
                  {/* Typed, like Other charges below. These were − / + only,
                      so a day of 40 welds was 40 taps. */}
                  <NumField style={{ width: 66, textAlign: "right" }} value={l.qty}
                    aria-label={item.label} onChange={v => setWeldQty(l.key, v)} />
                  <span style={{ fontSize: 11, width: 22 }}>welds</span>
                  <span className="tabular" style={{ width: 62, textAlign: "right", fontSize: 14 }}>{money(l.qty * rate)}</span>
                  <button onClick={() => removeWeld(l.key)} style={{ background: "none", border: "none", cursor: "pointer", color: "color-mix(in srgb, var(--color-text) 50%, transparent)", fontSize: 16 }}>×</button>
                </div>
              );
            })}
          </div>
          {availableWeld.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              <select className="input" value={weldPick} onChange={e => setWeldPick(e.target.value)} style={{ flex: 1 }}>
                {availableWeld.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
              </select>
              <Btn variant="secondary" onClick={() => { setWeldLines(p => [...p, { key: weldPick, qty: 1 }]); const rest = availableWeld.filter(w => w.key !== weldPick); if (rest[0]) setWeldPick(rest[0].key); }}>Add</Btn>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", marginTop: 6 }}>
            <span style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>Other charges</span>
            <span className="tabular" style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-accent)" }}>{money(otherDollars)}</span>
          </div>
          {otherLines.length === 0 && (
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              Nothing billed yet — pick a line below and tap Add.
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {otherLines.map(l => {
              const svc = serviceByKey[l.key];
              const rate = rateForService(svc, rates);
              return (
                <div key={l.key} style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)", paddingBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14 }}>{svc.label}</div>
                    <div className="tabular" style={{ fontSize: 10, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{money(rate)} / {svc.unit}</div>
                  </div>
                  <NumField style={{ width: 66, textAlign: "right" }} step={svc.step || 1} value={l.qty}
                    onChange={v => setOtherQty(l.key, v)} />
                  <span style={{ fontSize: 11, width: 22 }}>{svc.unit}</span>
                  <span className="tabular" style={{ width: 62, textAlign: "right", fontSize: 14 }}>{money(l.qty * rate)}</span>
                  <button onClick={() => removeOther(l.key)} style={{ background: "none", border: "none", cursor: "pointer", color: "color-mix(in srgb, var(--color-text) 50%, transparent)", fontSize: 16 }}>×</button>
                </div>
              );
            })}
          </div>
          {availableService.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              <select className="input" value={servicePick} onChange={e => setServicePick(e.target.value)} style={{ flex: 1 }}>
                {availableService.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <Btn variant="secondary" onClick={() => { setOtherLines(p => [...p, { key: servicePick, qty: 1 }]); const rest = availableService.filter(s => s.key !== servicePick); if (rest[0]) setServicePick(rest[0].key); }}>Add</Btn>
            </div>
          )}

          <Blueprint style={{ padding: "12px 14px", background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Ticket total</div>
            <div className="tabular" style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 30 }}>{money(total)}</div>
          </Blueprint>

          <div style={{ display: "flex", alignItems: "center", marginTop: 6 }}>
            <span style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>Crew &amp; dose</span>
            <span className="tabular" style={{ marginLeft: "auto", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              billed {hours(billedStraight)} + {hours(billedOt)} OT
            </span>
          </div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: -4 }}>
            Hours here go to each person's timesheet. Solo hours are hours worked without an assistant — part of the regular figure, not on top of it. Dose is per person, in mR.
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {crew.map(c => (
              <div key={c.profileId} style={{ borderBottom: "1px solid color-mix(in srgb, var(--color-text) 8%, transparent)", paddingBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>{c.name}</span>
                  {c.role === "Helper" && <TagX variant="neutral">Helper</TagX>}
                  {c.isSub && <TagX variant="outline">Sub</TagX>}
                  {crew.length > 1 && (
                    <button onClick={() => setCrew(p => p.filter(x => x.profileId !== c.profileId))}
                      aria-label={`Remove ${c.name}`}
                      style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", color: "color-mix(in srgb, var(--color-text) 50%, transparent)", fontSize: 16 }}>×</button>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  <Field label="Reg hrs">
                    <NumField step="0.5" style={{ textAlign: "right" }} value={c.straight}
                      onChange={v => setCrewField(c.profileId, "straight", v)} />
                  </Field>
                  <Field label="OT hrs">
                    <NumField step="0.5" style={{ textAlign: "right" }} value={c.ot}
                      onChange={v => setCrewField(c.profileId, "ot", v)} />
                  </Field>
                  <Field label="Solo reg hrs">
                    <NumField step="0.5" style={{ textAlign: "right" }} value={c.solo}
                      onChange={v => setCrewField(c.profileId, "solo", v)} />
                  </Field>
                  <Field label="Solo OT hrs">
                    <NumField step="0.5" style={{ textAlign: "right" }} value={c.soloOt}
                      onChange={v => setCrewField(c.profileId, "soloOt", v)} />
                  </Field>
                  <Field label="Dose mR">
                    <NumField step="0.1" style={{ textAlign: "right" }} value={c.dose}
                      onChange={v => setCrewField(c.profileId, "dose", v)} />
                  </Field>
                  {c.isSub && (
                    <Field label="Mileage km">
                      <NumField step="1" style={{ textAlign: "right" }} value={c.mileage}
                        onChange={v => setCrewField(c.profileId, "mileage", v)} />
                    </Field>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            <Btn variant="secondary" style={{ flex: 1, fontSize: 12 }} onClick={splitEvenly}>Split evenly</Btn>
            <Btn variant="secondary" style={{ flex: 1, fontSize: 12 }} onClick={fullHoursEach}>Full hours each</Btn>
          </div>

          {(assignedStraight !== billedStraight || assignedOt !== billedOt) && (
            <div className="tabular" style={{ fontSize: 11, color: "var(--color-accent-700)" }}>
              Crew totals {hours(assignedStraight)} + {hours(assignedOt)} OT — differs from what's billed. Fine for crew-rate work; worth a second look otherwise.
            </div>
          )}

          {availablePeople.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              {/* Grouped rather than two dropdowns: helpers are picked the same
                  way as anyone else on the crew, and the group they come from
                  decides the crew role, so it cannot be set wrong. */}
              <select className="input" value={crewPick} onChange={e => setCrewPick(e.target.value)} style={{ flex: 1 }}>
                {availableTechs.length > 0 && (
                  <optgroup label="Technicians">
                    {availableTechs.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                  </optgroup>
                )}
                {availableHelpers.length > 0 && (
                  <optgroup label="Helpers">
                    {availableHelpers.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                  </optgroup>
                )}
              </select>
              <Btn variant="secondary" onClick={() => {
                const p = people.find(x => x.id === crewPick);
                if (!p) return;
                setCrew(c => [...c, { profileId: p.id, name: p.displayName, isSub: p.is_subcontractor, role: crewRoleFor(p), straight: 0, ot: 0, solo: 0, soloOt: 0, dose: 0, mileage: 0 }]);
                const rest = availablePeople.filter(x => x.id !== crewPick);
                if (rest[0]) setCrewPick(rest[0].id);
              }}>Add</Btn>
            </div>
          )}

          {/* Job delays — standby, waiting on the line, a road ban. It prints
              on the client's field invoice under the crew, which is where the
              rep expects to read it when they are asked to sign for a day
              that ran long. Free text on purpose: the reason is never one of
              a fixed five. */}
          <div style={{ marginTop: 4 }}>
            <span style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>Job delays</span>
            <textarea className="input" rows={2} value={delays}
              onChange={e => setDelays(e.target.value)}
              placeholder="Standby, waiting on the line, road ban… — leave blank if the day ran clean"
              style={{ marginTop: 6, resize: "vertical", fontFamily: "inherit" }} />
          </div>

          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {(ticketClientContact || jobRecord.clientRep)
              ? `Approval link will go to ${ticketClientContact || jobRecord.clientRep}`
              : "No client rep on this ticket yet — add one when raising it, or in the job record, before sending for approval."}
          </div>
          <ErrorBox>{saveError}</ErrorBox>
          {openJha && (
            <div style={{ border: "1px solid var(--color-accent)", padding: "10px 12px", fontSize: 12 }}>
              The JHA for this job is still open. Close it out on Job detail once you have the end readings off the DRDs.
            </div>
          )}
          <Btn variant="primary" block style={{ minHeight: 56, fontSize: 15 }} onClick={() => save(true)} disabled={saving || !ticketId || total <= 0}>
            {saving ? "Saving…" : emailFailed ? "Retry approval email" : "Email for approval"}
          </Btn>
          <Btn variant="secondary" block style={{ minHeight: 48 }} onClick={() => save(false)} disabled={saving || !ticketId || total <= 0}>Save draft</Btn>
          {created && (
            <Btn variant="ghost" block style={{ minHeight: 44, marginTop: 4 }} disabled={saving || cancelling} onClick={cancelTicket}>
              {cancelling ? "Cancelling…" : "Cancel this ticket"}
            </Btn>
          )}
        </Blueprint>

        <div className="phone-explain">
          <p>Build the day's billing in a truck at dusk. Type the count straight in — every weld line and time/expense line is quantity × the client's on-file rate, pulled live from the published rate schedule.</p>
          <p>The crew block is what feeds Timesheets: each person's hours, their dose in mR, and — for subcontractors — their own mileage to lift into an invoice.</p>
        </div>
      </div>
    </div>
  );
}


import React, { useState, useEffect, useRef } from "react";
import { STANDARD_RATE_LINES } from "../data.js";
import { Db, DEFAULT_SCHEDULE } from "../db.js";
import { Toasts } from "../toastBus.js";
import { Blueprint, Btn, useDebounced, TagX, Field, Dialog, ErrorBox, Switch, NumField, useMissingFields, SearchSelect, TableScroll, Loading } from "./common.jsx";

export function RateAdminScreen() {
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [lines, setLines] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [justPublished, setJustPublished] = useState(false);
  const [showNewClient, setShowNewClient] = useState(false);
  const [showNewOverride, setShowNewOverride] = useState(false);

  const loadClients = async () => {
    try {
      const cs = await Db.listClients();
      setClients(cs);
      setSelected(s => s || DEFAULT_SCHEDULE);
    } catch (e) { setError(e.message || "Couldn't load clients."); }
  };
  const loadOverrides = async () => {
    try { setOverrides(await Db.listOverrides()); }
    catch (e) { console.error("Couldn't load overrides:", e.message); }
  };

  useEffect(() => { loadClients(); loadOverrides(); }, []);

  // The `live` flag on the effect below only stops a *later* load starting —
  // once one is in flight its setState is unguarded, so switching clients
  // quickly could paint one client's rates under another's name. These are
  // the figures the client gets billed at, so the last request wins and the
  // rest are dropped.
  const loadSeq = useRef(0);
  const loadSchedule = async () => {
    if (!selected) return;
    const mine = ++loadSeq.current;
    setLoading(true);
    setError("");
    try {
      const { schedule: s, lines: l } = await Db.getEditableSchedule(selected);
      // A card that follows the house card displays the house card — the
      // client's own dormant lines would read as what they're billed, and
      // they aren't while the switch is on.
      let shown = l;
      if (s.follows_default && selected !== DEFAULT_SCHEDULE) {
        const def = await Db.getEditableSchedule(DEFAULT_SCHEDULE);
        shown = def.lines;
      }
      if (mine !== loadSeq.current) return;
      setSchedule(s); setLines(shown);
    } catch (e) {
      if (mine !== loadSeq.current) return;
      setError(e.message || "Couldn't load rates.");
    }
    if (mine === loadSeq.current) setLoading(false);
  };
  // Switching schedules writes out anything still sitting in the debounce
  // first. Each pending write is keyed by rate-line id so it lands on the
  // right schedule either way, but flushing here means the grid that loads
  // next can't show a stale figure for a rate just typed.
  useEffect(() => {
    let live = true;
    (async () => {
      await persistRate.flush();
      if (live) loadSchedule();
    })();
    return () => { live = false; };
  }, [selected]);

  const isDefault = selected === DEFAULT_SCHEDULE;
  const client = clients.find(c => c.id === selected);
  const line = (kind, label) => lines.find(l => l.kind === kind && l.label === label);
  const customLines = kind => lines.filter(l => l.kind === kind);
  // The switch: this client's tickets price from the house card, and the
  // lines on screen are the house card's, read-only here.
  const following = !isDefault && !!(schedule && schedule.follows_default);
  // A group's rates render as plain figures when it can't be edited —
  // while its rows are being reordered, or while the card follows the
  // house card.
  const locked = group => following || reorderGroup === group;

  // ── Row order ──────────────────────────────────────────────────────────
  // Each group's rows follow rate_lines.position, dragged into place below.
  // Lines from before the position column existed have none and fall back to
  // the standard order, so nothing ever jumps around unprompted.
  const posOf = l => (l && l.position != null ? l.position : Infinity);
  const stdIdx = (kind, label) => {
    const i = STANDARD_RATE_LINES.findIndex(s => s.kind === kind && s.label === label);
    return i < 0 ? 900 : i;
  };
  const byPos = (a, b) => a.pos - b.pos || a.fallback - b.fallback || (a.label || "").localeCompare(b.label || "");

  const SIZE_KINDS = ["rt_film", "rt_cr", "rt_dr"];
  // One row per size — its three kind-lines move as one — with custom weld
  // lines interleaved wherever they were dragged.
  const sizeRows = (() => {
    const bySize = new Map();
    lines.filter(l => SIZE_KINDS.includes(l.kind)).forEach(l => {
      const seen = bySize.has(l.label) ? bySize.get(l.label) : Infinity;
      bySize.set(l.label, Math.min(seen, posOf(l)));
    });
    return [
      ...[...bySize.entries()].map(([label, pos]) => ({
        key: "size:" + label, label, pos, fallback: stdIdx("rt_film", label),
        ids: SIZE_KINDS.map(k => line(k, label)).filter(Boolean).map(l => l.id)
      })),
      ...customLines("custom_weld").map(c => ({
        key: "cw:" + c.id, label: c.label, pos: posOf(c), fallback: 950, line: c, ids: [c.id]
      }))
    ].sort(byPos);
  })();

  const rowsOf = (standardKind, customKind) => lines
    .filter(l => l.kind === standardKind || l.kind === customKind)
    .map(l => ({
      key: l.kind + ":" + l.id, label: l.label, pos: posOf(l),
      fallback: l.kind === standardKind ? stdIdx(standardKind, l.label) : 950,
      line: l, ids: [l.id]
    }))
    .sort(byPos);
  const methodRows = rowsOf("method", "custom_method");
  // Data-driven where it used to be a fixed five-label list — which is also
  // what finally puts the two Travel lines on screen: they have been on
  // every schedule since the travel migration, priced tickets through
  // rates.exp, and had no row here to edit them by.
  const expenseRows = rowsOf("expense", "custom_expense");

  // ── Reordering ─────────────────────────────────────────────────────────
  // One group at a time. The button under a group swaps its remove buttons
  // for up/down arrows; every move writes the whole group's positions
  // through the same saving/saved status the rates use.
  //
  // Arrows, after two rounds of drag-and-drop: the HTML5 drag API never
  // fires from a touch at all, and the pointer-events rewrite still lost
  // the gesture to page scrolling on a real phone. A tap on an arrow has no
  // gesture for the browser to argue about.
  const [reorderGroup, setReorderGroup] = useState("");

  const persistOrder = async rows => {
    const updates = rows.flatMap((r, i) => r.ids.map(id => ({ id, position: i })));
    setLines(p => p.map(l => {
      const u = updates.find(x => x.id === l.id);
      return u ? { ...l, position: u.position } : l;
    }));
    setJustPublished(false);
    inFlight.current++;
    setSaveState("saving");
    try {
      await Db.reorderRateLines(updates);
      if (--inFlight.current === 0) setSaveState("saved");
    } catch (e) {
      inFlight.current--;
      setSaveState("failed");
      setError(e.message || "Couldn't save the new order.");
      await loadSchedule();
    }
  };

  const moveRow = (rows, i, delta) => {
    const j = i + delta;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    persistOrder(next);
  };

  const MoveButtons = ({ rows, i }) => (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <button className="row-x" aria-label="Move up" disabled={i === 0}
        style={i === 0 ? { opacity: .25, cursor: "default" } : undefined}
        onClick={() => moveRow(rows, i, -1)}>↑</button>
      <button className="row-x" aria-label="Move down" disabled={i === rows.length - 1}
        style={i === rows.length - 1 ? { opacity: .25, cursor: "default" } : undefined}
        onClick={() => moveRow(rows, i, 1)}>↓</button>
    </span>
  );

  const ReorderToggle = ({ group }) => (
    <Btn variant={reorderGroup === group ? "primary" : "secondary"} style={{ whiteSpace: "nowrap", marginTop: 6 }}
      onClick={() => setReorderGroup(g => (g === group ? "" : group))}>
      {reorderGroup === group ? "Done" : "Reorder"}
    </Btn>
  );

  // The follows-the-house-card switch. On: this client's tickets price from
  // Default rates, live, and the card below shows the house card read-only.
  // Off: their own card prices again — topped up from the house card first,
  // so a client coming off house rates starts from the figures they were
  // just on rather than a sheet of zeros. Their own edits are never
  // overwritten by the top-up.
  const [switching, setSwitching] = useState(false);
  const toggleFollow = async () => {
    if (!schedule || isDefault || switching) return;
    const name = client ? client.name : "this client";
    if (!following && !confirm(`Price ${name}'s new tickets from the house card? Their own rates stay saved and come back when the switch is turned off.`)) return;
    await persistRate.flush();
    setSwitching(true);
    setError("");
    try {
      if (following) {
        await Db.setFollowsDefault(schedule.id, false);
        Toasts.mute();
        try { await Db.copyDefaultInto(schedule.id); }
        finally { Toasts.unmute(); }
      } else {
        await Db.setFollowsDefault(schedule.id, true);
      }
      await loadSchedule();
    } catch (e) { setError(e.message || "Couldn't change who prices this client's tickets."); }
    setSwitching(false);
  };

  // There is no save button on this screen because there is nothing to save:
  // every rate is written as you type. That is only reassuring if you can see
  // it happening, hence the status beside the heading — without it the screen
  // looks identical whether the last figure reached the database or not.
  const [saveState, setSaveState] = useState("idle");
  const inFlight = useRef(0);

  // The grid updates immediately; the write waits until typing stops. Keyed
  // by line id, so editing two rates in quick succession doesn't cancel one.
  const persistRate = useDebounced(async (id, rate) => {
    inFlight.current++;
    setSaveState("saving");
    try {
      await Db.setRateLine(id, rate);
      // Only settles once the last outstanding write lands, so editing several
      // rates quickly gets one confirmation at the end rather than a queue of
      // them, and never claims "saved" while others are still in flight.
      if (--inFlight.current === 0) {
        setSaveState("saved");
      }
    } catch (e) {
      inFlight.current--;
      setSaveState("failed");
      setError(e.message || "Couldn't save that rate.");
      await loadSchedule();
    }
  }, 500);

  const setRate = (id, rate) => {
    setLines(p => p.map(l => l.id === id ? { ...l, rate } : l));
    setJustPublished(false);
    setSaveState("saving");
    persistRate(id, rate);
  };

  const addCustom = async (kind, label, unit) => {
    if (!label || !schedule) return;
    // New lines land at the end of their group's dragged order.
    const groupKinds = {
      custom_weld: [...SIZE_KINDS, "custom_weld"],
      custom_method: ["method", "custom_method"],
      custom_expense: ["expense", "custom_expense"]
    }[kind] || [kind];
    const ps = lines.filter(l => groupKinds.includes(l.kind) && l.position != null).map(l => l.position);
    try {
      const created = await Db.addRateLine({
        scheduleId: schedule.id, kind, label,
        unit: unit || (kind === "custom_expense" ? "ea" : "per weld"), rate: 0,
        position: ps.length ? Math.max(...ps) + 1 : null
      });
      setLines(p => [...p, created]);
      setJustPublished(false);
    } catch (e) { setError(e.message || "Couldn't add that line."); }
  };
  const removeCustom = async id => {
    try { await Db.deleteRateLine(id); setLines(p => p.filter(l => l.id !== id)); setJustPublished(false); }
    catch (e) { setError(e.message || "Couldn't remove that line."); }
  };

  // A new size is a real size: all three RT kinds at once, like the
  // standards. Adding one used to create a single film-only custom line
  // with no CR or DR cell to type into. (Lines added back then keep their
  // one cell — remove and re-add to get the full row.)
  const addSizeRow = async label => {
    if (!label || !schedule) return;
    const clean = label.trim();
    if (SIZE_KINDS.some(k => line(k, clean)) || customLines("custom_weld").some(c => c.label === clean)) {
      setError(`"${clean}" is already on this schedule.`);
      return;
    }
    const ps = lines.filter(l => (SIZE_KINDS.includes(l.kind) || l.kind === "custom_weld") && l.position != null).map(l => l.position);
    const position = ps.length ? Math.max(...ps) + 1 : null;
    try {
      const created = await Promise.all(SIZE_KINDS.map(kind =>
        Db.addRateLine({ scheduleId: schedule.id, kind, label: clean, unit: "weld", rate: 0, position })));
      setLines(p => [...p, ...created]);
      setJustPublished(false);
    } catch (e) {
      setError(e.message || "Couldn't add that size.");
      // One of the three inserts failing would leave a partial row on
      // screen; the reload shows what actually landed.
      await loadSchedule();
    }
  };

  // An RT size is three lines (film, CR, DR) shown as one row, so removing it
  // has to take all three — otherwise the row half-disappears.
  const removeSizeRow = async label => {
    const ids = ["rt_film", "rt_cr", "rt_dr"].map(k => line(k, label)).filter(Boolean).map(l => l.id);
    if (!ids.length) return;
    try {
      await Promise.all(ids.map(id => Db.deleteRateLine(id)));
      setLines(p => p.filter(l => !ids.includes(l.id)));
      setJustPublished(false);
    } catch (e) { setError(e.message || "Couldn't remove that size."); }
  };

  // Anything removed can be brought back: re-adds every standard line this
  // schedule is missing, at zero, so a mis-click is not permanent.
  const [restoring, setRestoring] = useState(false);
  const restoreStandard = async () => {
    if (!schedule) return;
    await persistRate.flush();
    setRestoring(true);
    setError("");
    const wanted = STANDARD_RATE_LINES;
    const missing = wanted.filter(w => !lines.some(l => l.kind === w.kind && l.label === w.label));
    try {
      // In parallel — twenty sequential round trips was a visible stall.
      await Promise.all(missing.map(m => Db.addRateLine({ scheduleId: schedule.id, ...m, rate: 0 })));
      await loadSchedule();
      if (!missing.length) setError("Nothing to restore — every standard line is already on this schedule.");
    } catch (e) { setError(e.message || "Couldn't restore the standard lines."); }
    setRestoring(false);
  };

  const publish = async () => {
    if (!schedule) return;
    // Publishing is what every new ticket prices against, so it gets a
    // confirmation — it was a single click with no way back.
    const who = isDefault ? "the house default schedule" : `${client ? client.name : "this client"}'s schedule`;
    if (!confirm(`Publish ${who}? New tickets will price against these rates from now on.`)) return;
    await persistRate.flush();
    setPublishing(true);
    setError("");
    try {
      await Db.publishSchedule(schedule.id);
      setJustPublished(true);
      await loadSchedule();
    }
    catch (e) { setError(e.message || "Couldn't publish."); }
    setPublishing(false);
  };

  const removeOverride = async o => {
    if (o.locked) {
      setError("That override is locked — a ticket on the job has already been approved against it.");
      return;
    }
    if (!confirm(`Remove the ${o.description || "override"} on ${o.jobs ? o.jobs.job_number : "this job"}? Tickets already raised keep the rate they were priced at.`)) return;
    setError("");
    try { await Db.deleteOverride(o.id); setOverrides(p => p.filter(x => x.id !== o.id)); }
    catch (e) { setError(e.message || "Couldn't remove that override."); await loadOverrides(); }
  };

  const toggleOverride = async o => {
    setOverrides(p => p.map(x => x.id === o.id ? { ...x, active: !x.active } : x));
    try { await Db.toggleOverrideActive(o.id, !o.active); }
    catch (e) { setError(e.message || "Couldn't update that override — it may be locked."); await loadOverrides(); }
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <div className="kicker">Admin · Rate schedules</div>
          <h2 style={{ fontSize: 34, margin: "2px 0 0" }}>Billing rates</h2>
        </div>
        <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
          {following ? "Follows the house card"
            : justPublished ? "Published just now"
            : schedule && schedule.published_at ? "Published — edits go live as they save"
            : "Not yet published"}
        </span>
        {/* Two different things, deliberately worded apart: rates are saved
            the moment you type them, but they don't price anything until the
            schedule is published. */}
        <span aria-live="polite" style={{
          fontSize: 12, fontWeight: 600,
          color: saveState === "failed" ? "var(--color-accent-700)"
            : saveState === "saved" ? "var(--color-accent-700)"
            : "color-mix(in srgb, var(--color-text) 50%, transparent)"
        }}>
          {saveState === "saving" ? "Saving…"
            : saveState === "saved" ? "✓ Rates saved"
            : saveState === "failed" ? "Not saved — see above"
            : "Rates save as you type"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Btn variant="secondary" onClick={() => setShowHistory(true)} disabled={!schedule}>Rate history</Btn>
          {/* Publishing matters exactly once per card — it's the gate that
              lets tickets price from it at all; after that, every edit is
              live the moment it saves. So the button only exists while
              there is a gate to open: never-published, and not following
              the house card (a follower prices from the house card's own
              publish). Per Kyle — a permanent button implied a step that
              wasn't there. */}
          {schedule && !schedule.published_at && !following && (
            <Btn variant="primary" onClick={publish} disabled={publishing}>
              {publishing ? "Publishing…" : "Publish schedule"}
            </Btn>
          )}
        </div>
      </div>
      <ErrorBox>{error}</ErrorBox>

      {/* Whose rates: one search box, with the house card as the first row
          of the list rather than a button beside it — per Kyle. Clients are
          already loaded in full, so the search runs here rather than going
          back to the server for a list it already has. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <SearchSelect
          // Narrower than the default so the box and "+ New client" stay on
          // one line down to a small laptop; the search box is the thing
          // that can afford to give up the width.
          style={{ flex: "1 1 200px", maxWidth: 380 }}
          listId="rate-client-list"
          ariaLabel="Search clients"
          placeholder={isDefault ? "Default rates — search to change…"
            : client ? `${client.name} — search to change…` : "Search clients…"}
          search={text => {
            const q = text.trim().toLowerCase();
            const matched = q
              ? clients.filter(c => (c.name || "").toLowerCase().includes(q) || (c.agreement_ref || "").toLowerCase().includes(q))
              : clients;
            // The house card leads the list whenever it fits what was typed
            // — an empty box always shows it first.
            const withDefault = !q || "default rates house card".includes(q) || q.includes("default")
              ? [{ id: DEFAULT_SCHEDULE, isDefaultCard: true }, ...matched]
              : matched;
            // Sliced, but the true count goes back so the list can say how
            // many it is not showing.
            return { rows: withDefault.slice(0, 25), total: withDefault.length };
          }}
          optionKey={c => c.id}
          onPick={c => setSelected(c.id)}
          onError={setError}
          renderOption={c => {
            if (c.isDefaultCard) {
              return (
                <>
                  <div style={{ fontSize: 15 }}>Default rates</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    <TagX variant="accent">House rate card</TagX>
                    <span>What a new client starts on</span>
                  </div>
                </>
              );
            }
            const n = overrides.filter(o => o.jobs && o.jobs.client_id === c.id).length;
            return (
              <>
                <div style={{ fontSize: 15 }}>{c.name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                  <span>{c.agreement_ref}</span>
                  {n > 0 && <TagX variant="outline">{n} override{n > 1 ? "s" : ""}</TagX>}
                </div>
              </>
            );
          }}
        />
        <Btn variant="secondary" style={{ whiteSpace: "nowrap" }}
          onClick={() => setShowNewClient(true)}>+ New client</Btn>
      </div>

      <div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {loading || (!client && !isDefault) ? (
            <Blueprint style={{ padding: 20 }}><Loading /></Blueprint>
          ) : (
            <Blueprint style={{ padding: "18px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                <h4 style={{ margin: 0, fontSize: 19 }}>{isDefault ? "Default rates" : client.name}</h4>
                {isDefault
                  ? <TagX variant="accent">House rate card</TagX>
                  : <TagX variant="neutral">{client.agreement_ref}</TagX>}
                {!isDefault && client.effective_from && <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>effective {client.effective_from}</span>}
                {!isDefault && (
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, opacity: switching ? 0.6 : 1 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: following ? "var(--color-accent-700)" : "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                      {switching ? "Saving…" : "Follows the house card"}
                    </span>
                    <Switch on={following} onClick={toggleFollow} label="Follows the house card" />
                  </div>
                )}
              </div>
              <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 4 }}>
                {isDefault
                  ? "The house rate card. What a new client starts on, and what every client with the switch on prices from — edit a rate here and their next tickets follow it."
                  : following
                    ? "This client's tickets price from the house card, live — the rates below are Default rates, read-only here. Turn the switch off to give them their own card; it starts from these figures."
                    : "This client has their own card. Turning the switch on prices their tickets from the house card instead; nothing here is lost, and it comes back when the switch is turned off."}
              </div>



              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "14px 0 6px" }}>RT rate per weld by size</div>
              <div>
              {/* Wrapped like every other table — bare, this one stretched a
                  phone's viewport to 397px and the whole screen panned. */}
              <TableScroll><table className="table">
                <thead><tr><th>Size</th><th style={{ width: 92 }}>Film</th><th style={{ width: 92 }}>CR</th><th style={{ width: 92 }}>DR</th><th style={{ width: 44 }}></th></tr></thead>
                <tbody>
                  {sizeRows.map((r, i) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      {r.line ? (
                        <>
                          <td>{locked("sizes")
                            ? <span className="tabular">{r.line.rate}</span>
                            : <RateInput value={r.line.rate} onChange={v => setRate(r.line.id, v)} />}</td>
                          <td></td>
                          <td></td>
                        </>
                      ) : (
                        SIZE_KINDS.map(kind => {
                          const l = line(kind, r.label);
                          return <td key={kind}>{l && (locked("sizes")
                            ? <span className="tabular">{l.rate}</span>
                            : <RateInput value={l.rate} onChange={v => setRate(l.id, v)} />)}</td>;
                        })
                      )}
                      <td style={{ textAlign: "right" }}>
                        {following ? null
                          : reorderGroup === "sizes"
                          ? <MoveButtons rows={sizeRows} i={i} />
                          : (r.ids.length > 0 && (
                            <button className="row-x" aria-label={`Remove ${r.label}`}
                              onClick={() => r.line ? removeCustom(r.line.id) : removeSizeRow(r.label)}>×</button>
                          ))}
                      </td>
                    </tr>
                  ))}
                  {!isDefault && <tr><td colSpan={5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Minimum call-out — {client.minimum_callout || "not set"}</td></tr>}
                </tbody>
              </table></TableScroll>
              {!following && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}><AddLineBox onAdd={addSizeRow} placeholder='e.g. 16" NPS' /></div>
                  <ReorderToggle group="sizes" />
                </div>
              )}

              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "16px 0 6px" }}>Other methods — rate per weld</div>
              <TableScroll><table className="table">
                <thead><tr><th>Method</th><th style={{ width: 92 }}>Rate</th><th style={{ width: 44 }}></th></tr></thead>
                <tbody>
                  {methodRows.map((r, i) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td>{locked("methods")
                        ? <span className="tabular">{r.line.rate}</span>
                        : <RateInput value={r.line.rate} onChange={v => setRate(r.line.id, v)} />}</td>
                      <td style={{ textAlign: "right" }}>
                        {following ? null
                          : reorderGroup === "methods"
                          ? <MoveButtons rows={methodRows} i={i} />
                          : <button className="row-x" onClick={() => removeCustom(r.line.id)} aria-label={`Remove ${r.label}`}>×</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></TableScroll>
              {!following && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}><AddLineBox onAdd={label => addCustom("custom_method", label)} placeholder="e.g. PAUT" /></div>
                  <ReorderToggle group="methods" />
                </div>
              )}

              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "16px 0 6px" }}>Time &amp; expense</div>
              <TableScroll><table className="table">
                <thead><tr><th>Item</th><th style={{ width: 92 }}>Rate</th><th style={{ width: 44 }}></th></tr></thead>
                <tbody>
                  {expenseRows.map((r, i) => (
                    <tr key={r.key}>
                      <td>{r.label}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{r.line.unit}</div></td>
                      <td>{locked("expense")
                        ? <span className="tabular">{r.line.rate}</span>
                        : <RateInput value={r.line.rate} onChange={v => setRate(r.line.id, v)} />}</td>
                      <td style={{ textAlign: "right" }}>
                        {following ? null
                          : reorderGroup === "expense"
                          ? <MoveButtons rows={expenseRows} i={i} />
                          : <button className="row-x" onClick={() => removeCustom(r.line.id)} aria-label={`Remove ${r.label}`}>×</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></TableScroll>
              {!following && (
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}><AddLineBox onAdd={(label, unit) => addCustom("custom_expense", label, unit)} units={["h", "ea", "days", "km"]} placeholder="e.g. Blended rate" /></div>
                  <ReorderToggle group="expense" />
                </div>
              )}
              </div>


              {!following && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, paddingTop: 12, borderTop: "1px solid var(--color-divider)" }}>
                  <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    Removing a line takes it off this schedule only — tickets already raised keep the rate they were priced at.
                  </span>
                  {/* Named for what it does. "Set standard lines" read like a
                      save, and it is the opposite: it puts missing standard
                      lines back at zero, ready to be priced. */}
                  <Btn variant="secondary" style={{ marginLeft: "auto", padding: "4px 12px", whiteSpace: "nowrap" }}
                    onClick={restoreStandard} disabled={restoring}
                    title="Puts back any standard line removed from this schedule, at zero. Rates already entered are untouched.">
                    {restoring ? "Restoring…" : "Restore removed lines"}
                  </Btn>
                </div>
              )}
            </Blueprint>
          )}

          <Blueprint style={{ padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <h4 style={{ margin: 0, fontSize: 19 }}>Job-level overrides</h4>
              <Btn variant="secondary" style={{ marginLeft: "auto", padding: "4px 12px" }}
                onClick={() => setShowNewOverride(true)}>+ New override</Btn>
            </div>
            <TableScroll><table className="table">
              <thead><tr><th>Job</th><th>Scope</th><th>Basis</th><th>Bid reference</th><th style={{ width: 90 }}></th></tr></thead>
              <tbody>
                {overrides.length === 0 && <tr><td colSpan={5} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>None on file.</td></tr>}
                {overrides.map(o => (
                  <tr key={o.id}>
                    <td style={{ fontFamily: "var(--font-heading)", fontWeight: 600 }}>{o.jobs ? o.jobs.job_number : ""}</td>
                    <td>{o.description}</td>
                    <td>{o.basis}<div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{o.bid_ref}</div></td>
                    <td>{o.locked && <TagX variant="outline">Locked</TagX>}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                        <Switch on={o.active} label={`Override for ${o.jobs ? o.jobs.job_number : "job"}`}
                          onClick={() => !o.locked && toggleOverride(o)} />
                        {!o.locked && (
                          <button className="row-x" aria-label={`Remove override for ${o.jobs ? o.jobs.job_number : "job"}`}
                            onClick={() => removeOverride(o)}>×</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></TableScroll>
            <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 10 }}>Overrides lock automatically once a ticket on the job is client-approved.</div>
          </Blueprint>
        </div>
      </div>

      {showNewOverride && (
        <NewOverrideDialog
          onClose={() => setShowNewOverride(false)}
          onCreated={created => {
            setShowNewOverride(false);
            setOverrides(p => [...p, created]);
          }}
        />
      )}

      {showNewClient && (
        <NewClientDialog
          onClose={() => setShowNewClient(false)}
          onCreated={async created => {
            setShowNewClient(false);
            await loadClients();
            setSelected(created.id);
          }}
        />
      )}

      {showHistory && schedule && (
        <RateHistoryDialog scheduleId={schedule.id} onClose={() => setShowHistory(false)} />
      )}

    </div>
  );
}

// The money boxes on this screen: NumField's floor at zero, in cents, at the
// width the rate columns are laid out for.
function RateInput({ value, onChange }) {
  return <NumField style={{ width: 78 }} step="0.01" value={value} onChange={onChange} />;
}

// Every rate change ever made to this client's schedule, newest first —
// backed by the trigger that logs old/new value + who + when on every
// rate_lines update (see migrations).
function RateHistoryDialog({ scheduleId, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Db.getRateLineHistory(scheduleId)
      .then(setRows)
      .catch(e => setError(e.message || "Couldn't load rate history."))
      .finally(() => setLoading(false));
  }, [scheduleId]);

  return (
    <Dialog title="Rate history" maxWidth={620} onClose={onClose} actions={<Btn variant="secondary" onClick={onClose}>Close</Btn>}>
      <ErrorBox>{error}</ErrorBox>
      {loading && <Loading />}
      {!loading && !rows.length && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
          No rate changes recorded yet for this schedule.
        </div>
      )}
      {!loading && rows.length > 0 && (
        <div style={{ display: "grid", gap: 10, maxHeight: 420, overflowY: "auto" }}>
          {rows.map(h => (
            <div key={h.id} style={{ borderBottom: "1px solid var(--color-neutral-300)", paddingBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14 }}>
                <span style={{ fontWeight: 600 }}>{h.label}</span>
                <span className="tabular">${h.oldRate.toFixed(2)} → ${h.newRate.toFixed(2)}</span>
              </div>
              <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                {h.changedBy} · {new Date(h.changedAt).toLocaleString("en-CA", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// A bid won at rates other than the client's schedule. Recorded against the
// job rather than the client, so the schedule stays the standing agreement
// and the exception is visible next to the job it belongs to.
function NewOverrideDialog({ onClose, onCreated }) {
  const [jobs, setJobs] = useState([]);
  const [form, setForm] = useState({ jobId: "", description: "", basis: "Bid rate", bidRef: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const miss = useMissingFields();
  const set = (k, v) => { miss.fixed(k); setForm(p => ({ ...p, [k]: v })); };

  useEffect(() => {
    Db.listJobs()
      .then(list => {
        setJobs(list);
        if (list[0]) set("jobId", list[0].dbId);
      })
      .catch(e => setError(e.message || "Couldn't load jobs."));
  }, []);

  const submit = async () => {
    if (!form.jobId) { miss.flag("jobId"); setError("Pick the job this override applies to."); return; }
    if (!form.description.trim()) { miss.flag("description"); setError("Say what the override covers — it is what the billing tracker shows."); return; }
    miss.clear();
    setSaving(true);
    setError("");
    try {
      const created = await Db.createOverride({
        jobId: form.jobId, description: form.description.trim(),
        basis: form.basis, bidRef: form.bidRef.trim()
      });
      onCreated(created);
    } catch (e) {
      setSaving(false);
      setError(e.message || "Couldn't add that override.");
    }
  };

  return (
    <Dialog title="New job override" maxWidth={460} onClose={onClose}
      actions={<><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Adding…" : "Add override"}</Btn></>}>
      <ErrorBox>{error}</ErrorBox>
      <Field label="Job" missing={miss.is("jobId")}>
        <select {...miss.props("jobId")} value={form.jobId} onChange={e => set("jobId", e.target.value)}>
          {jobs.length === 0 && <option value="">No jobs yet</option>}
          {jobs.map(j => <option key={j.dbId} value={j.dbId}>{j.id} — {j.project || j.client}</option>)}
        </select>
      </Field>
      <Field label="What it covers" missing={miss.is("description")}>
        <input {...miss.props("description")} autoFocus value={form.description} onChange={e => set("description", e.target.value)}
          placeholder='All 6" and 8" welds' />
      </Field>
      <Field label="Basis">
        <select className="input" value={form.basis} onChange={e => set("basis", e.target.value)}>
          <option>Bid rate</option>
          <option>Lump sum</option>
          <option>Day rate</option>
          <option>Discount</option>
        </select>
      </Field>
      <Field label="Bid reference">
        <input className="input" value={form.bidRef} onChange={e => set("bidRef", e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }} placeholder="Q-2026-114" />
      </Field>
    </Dialog>
  );
}

function NewClientDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: "", agreementRef: "", minimumCallout: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      const client = await Db.createClient(form);
      await onCreated(client);
    } catch (e) {
      setSaving(false);
      setError(e.message || "Couldn't add that client.");
    }
  };

  return (
    <Dialog title="New client" maxWidth={460} onClose={onClose}
      actions={<><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Adding…" : "Add client"}</Btn></>}>
      <ErrorBox>{error}</ErrorBox>
      <Field label="Client name">
        <input className="input" autoFocus value={form.name} onChange={e => set("name", e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }} placeholder="Peace River Midstream" />
      </Field>
      <Field label="Agreement reference">
        <input className="input" value={form.agreementRef} onChange={e => set("agreementRef", e.target.value)} placeholder="MSA-118 rev 4" />
      </Field>
      <Field label="Minimum call-out">
        <input className="input" value={form.minimumCallout} onChange={e => set("minimumCallout", e.target.value)} placeholder="4 h + mobilization" />
      </Field>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
        The client is added with an empty rate schedule — fill in their per-weld and time &amp; expense rates here, then publish. A ticket can't be raised against them until a schedule is published.
      </div>
    </Dialog>
  );
}

// `units`, when given, adds a unit picker beside the label — a custom
// expense can be hourly (a blended rate standing in for straight + OT),
// per each, per day or per km, and the unit decides how the ticket screen
// steps it. Groups whose unit is fixed (per-weld lines) just omit it.
function AddLineBox({ onAdd, placeholder, units }) {
  const [v, setV] = useState("");
  const [unit, setUnit] = useState(units ? units[0] : "");
  const add = () => { const t = v.trim(); if (!t) return; onAdd(t, unit || undefined); setV(""); };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
      <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder={placeholder} value={v}
        aria-label={placeholder}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      {units && (
        <select className="input" value={unit} aria-label="Unit" style={{ width: 76, flex: "none" }}
          onChange={e => setUnit(e.target.value)}>
          {units.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
      )}
      <Btn variant="secondary" onClick={add} disabled={!v.trim()}>Add</Btn>
    </div>
  );
}


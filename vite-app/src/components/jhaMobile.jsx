import React, { useState, useEffect, useRef } from "react";
import { JHA_TEMPLATES, SEED_HAZARDS, todayLocal, localDate, dayMonth } from "../data.js";
import { Db } from "../db.js";
import { Blueprint, Btn, CheckBox, TagX, Field, Dialog, ErrorBox, Switch, splitContact, hazardTagVariant, NoJobSelected, ConnectionBar, QueuedPanel, useMissingFields } from "./common.jsx";
import { OfflineQueue } from "../offlineQueue.js";

// The JHA (FLHA) — filed at the start of the day, closed out at the end.
//
// It follows the paper form: site information, the hazard worksheet with a
// severity / probability / frequency rating per hazard, the equipment record,
// and the two nuclear energy workers with their dosimetry. Hand signatures are
// deliberately not collected — the account that files it is the record of who
// filed it.
//
// Readings: start is always 0, so the end reading IS the dose. End readings
// don't exist yet when this is filed, which is why the assessment stays Open
// until someone closes it out (see JhaCloseOutDialog in jobDetail).

const COMM_PRESETS = ["Phone", "Road Radio"];

const PPE_CHECKS = [
  { key: "hardHat", label: "Hard hat" },
  { key: "glasses", label: "Safety glasses" },
  { key: "boots", label: "Steel toe boots" },
  { key: "fr", label: "FR coveralls" },
  { key: "gloves", label: "Gloves" }
];

// Severity, probability and frequency are each 1–3 on the form; their sum is
// the priority, banded low / medium / high.
const RATING_SCALE = [1, 2, 3];
function priorityOf(r) {
  const total = (r.s || 0) + (r.p || 0) + (r.f || 0);
  return { total, band: total <= 5 ? "Low" : total <= 7 ? "Med" : "High" };
}

export function JhaBuilderScreen({ job, jobRecord, contacts, currentUser, onSubmitted, onCancel }) {
  const [hazards, setHazards] = useState(() => SEED_HAZARDS.map(h => ({ ...h })));
  const [extra, setExtra] = useState([]);
  const [ratings, setRatings] = useState({});
  // The site rep is usually whoever the job's contractor rep is — default to
  // them; the second box adds another name alongside it (more than one
  // person on site reviewing the JHA), rather than swapping the first out.
  const [siteRep, setSiteRep] = useState(() => splitContact((jobRecord || {}).contractorRep).name);
  const [siteRepOther, setSiteRepOther] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(false);
  const miss = useMissingFields();

  // The day this assessment covers. Defaults to today, because that is what
  // it almost always is — but a JHA that got missed on site and is being
  // written up afterwards has to be able to say which day it was for, or the
  // record (and the PDF) claims the wrong one.
  const [workDate, setWorkDate] = useState(todayLocal);
  const backdated = workDate !== todayLocal();

  const [site, setSite] = useState({
    weather: "", temperature: "", communication: "", commOther: false,
    muster: "", hospital: "Grande Prairie Regional Hospital — 11205 110 St, Grande Prairie, AB",
    firstAid: ""
  });
  const [equip, setEquip] = useState({
    ppe: { hardHat: true, glasses: true, boots: true, fr: false, gloves: false },
    h2sSerial: "", h2sBumpTest: false,
    redSerial: "", redSurveyMr: "", collimator: false, emergencyKit: false
  });

  // Worker (1) is whoever is filing. Worker (2) is the helper with them, if
  // there is one — picked from the crew so their own equipment comes along.
  const [people, setPeople] = useState([]);
  const [helperId, setHelperId] = useState("");
  const [w1, setW1] = useState({ unit: "", idCode: "", tld: "", drd: "", alarm: "" });
  // Whether the tech has hand-edited worker (1)'s kit. Once they have, the
  // auto-derive effect below must not overwrite it — a corrected DRD or
  // alarm serial typed before the crew/equipment lists land would otherwise
  // be silently replaced by the default the moment those fetches resolve,
  // and the JHA's PDF would record the wrong dosimeter serial.
  const w1Touched = useRef(false);
  const editW1 = next => { w1Touched.current = true; setW1(next); };
  const [w2, setW2] = useState({ unit: "", idCode: "", tld: "", drd: "", alarm: "" });
  const [equipment, setEquipment] = useState([]);

  useEffect(() => {
    Db.listEquipment().then(setEquipment).catch(e => console.error("Couldn't load equipment assignments:", e.message));
  }, []);

  // Start each hazard at whatever this person rated it last time. Merged
  // *under* anything already set, so a rating changed on this form is never
  // overwritten by the defaults arriving a moment later.
  const [remembered, setRemembered] = useState({});
  useEffect(() => {
    Db.lastHazardRatings(currentUser.id)
      .then(defaults => {
        setRemembered(defaults);
        setRatings(prev => {
          const merged = { ...prev };
          for (const [name, rating] of Object.entries(defaults)) {
            merged[name] = { ...rating, ...(prev[name] || {}) };
          }
          return merged;
        });
      })
      .catch(e => console.warn("Couldn't load your previous hazard ratings:", e.message));
  }, [currentUser.id]);

  useEffect(() => {
    Db.listProfiles().then(setPeople)
      .catch(e => console.error("Couldn't load the crew list:", e.message));
  }, []);

  // Worker (1)'s kit, re-derived when either half of it arrives. Kept apart
  // from the fetch above so the equipment list landing doesn't re-request the
  // crew list along with it.
  useEffect(() => {
    if (w1Touched.current) return;
    const me = people.find(p => p.id === currentUser.id);
    if (me) setW1(kitOf(me, equipment));
  }, [people, equipment, currentUser.id]);

  useEffect(() => {
    const helper = people.find(p => p.id === helperId);
    setW2(helper ? kitOf(helper, equipment) : { unit: "", idCode: "", tld: "", drd: "", alarm: "" });
  }, [helperId, people, equipment]);

  // The exposure device is one shared piece of kit for the day, not per
  // worker like TLD/DRD/alarm — defaulted from whatever's assigned to
  // whoever is filing, same as the rest of their kit.
  useEffect(() => {
    const mine = equipment.find(e => e.type === "Exposure device" && e.assignedTo === currentUser.id);
    if (mine) setEquip(p => (p.redSerial ? p : { ...p, redSerial: mine.serial || "" }));
  }, [equipment, currentUser.id]);

  const toggle = i => setHazards(p => p.map((h, idx) => idx === i ? { ...h, on: !h.on } : h));
  const toggleExtra = i => setExtra(p => p.map((h, idx) => idx === i ? { ...h, on: !h.on } : h));
  const [addingExtra, setAddingExtra] = useState(false);
  const rate = (name, key, value) =>
    setRatings(p => ({ ...p, [name]: { ...(p[name] || {}), [key]: value } }));

  const commSelect = site.commOther ? "Other" : (COMM_PRESETS.includes(site.communication) ? site.communication : "");
  const selected = hazards.filter(h => h.on).concat(extra.filter(h => h.on));
  const onCount = selected.length;
  const helper = people.find(p => p.id === helperId);

  const submit = async () => {
    if (!onCount) { setError("Tick at least one hazard before filing the JHA."); return; }
    if (!siteRep.trim() && !siteRepOther.trim()) {
      // Either box satisfies this, so both are flagged — highlighting one
      // would imply the other won't do.
      miss.flag("siteRep", "siteRepOther");
      setError("Record who this was reviewed with — the contractor rep, or someone else on site.");
      return;
    }
    const siteRepJoined = [siteRep.trim(), siteRepOther.trim()].filter(Boolean).join(" & ");
    if (!w1.tld.trim() && !w1.drd.trim() && !w1.alarm.trim()) {
      miss.flag("w1tld", "w1drd", "w1alarm");
      setError("Nuclear energy worker (1) has no dosimetry recorded — fill in at least one serial, or set them up in Users & access.");
      return;
    }
    if (!job || !job.dbId) { setError("No job selected."); return; }
    miss.clear();
    setSaving(true);
    setError("");
    const dosimetry = [
      { slot: 1, profileId: currentUser.id, name: currentUser.name, ...w1, startReading: 0, endReading: null, doseMr: null }
    ];
    if (helper) {
      dosimetry.push({ slot: 2, profileId: helper.id, name: helper.displayName, ...w2, startReading: 0, endReading: null, doseMr: null });
    }
    const jhaPayload = {
      jobDbId: job.dbId, template: JHA_TEMPLATES[0],
      hazards: selected.map(h => ({ ...h, rating: ratings[h.name] || null })),
      signedBy: currentUser.id, siteRep: siteRepJoined,
      pdfKey: `${job.id}-JHA-${Date.now()}.pdf`,
      dosimetry, unitNumber: w1.unit || null,
      workDate,
      details: { site, equipment: equip }
    };
    try {
      await Db.createJha(jhaPayload);
      onSubmitted();
    } catch (e) {
      if (OfflineQueue.isNetworkError(e)) {
        await OfflineQueue.enqueue("jha", jhaPayload);
        setQueued(true);
        return;
      }
      setSaving(false);
      setError(e.message || "Couldn't file the JHA — try again.");
    }
  };

  if (queued) return <QueuedPanel what="this hazard assessment" onDone={onSubmitted} />;
  if (!job) return <NoJobSelected what="a hazard assessment" />;

  return (
    <div className="page">
      <div className="phone-shell">
        <Blueprint className="phone-frame">
          <ConnectionBar label={job.id} />
          <div>
            <div className="kicker">{job.id} · Hazard assessment</div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 22 }}>{job.project}</div>
            <div className="tabular" style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{job.lsd} · {job.client}</div>
          </div>

          <JhaSection title="Site information" />
          <Field label="Date of this assessment">
            {/* Capped at today: an assessment can be written up after the
                fact, never in advance of the work it covers. */}
            <input className="input" type="date" value={workDate} max={todayLocal()}
              onChange={e => setWorkDate(e.target.value || todayLocal())} />
          </Field>
          {backdated && (
            <div style={{ border: "1px solid var(--color-accent)", padding: "10px 12px", fontSize: 12 }}>
              Being written up for {dayMonth(localDate(workDate))}, not today. The assessment and its PDF will carry that date; the record will still show it was filed today by {currentUser.name}.
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="Weather">
              <select className="input" value={site.weather} onChange={e => setSite(p => ({ ...p, weather: e.target.value }))}>
                <option value="">Select…</option>
                {["Clear", "Cloudy", "Windy", "Foggy", "Raining", "Snowing"].map(w => <option key={w}>{w}</option>)}
              </select>
            </Field>
            <Field label="Temperature">
              <select className="input" value={site.temperature} onChange={e => setSite(p => ({ ...p, temperature: e.target.value }))}>
                <option value="">Select…</option>
                {["Hot", "Warm", "Cool", "Cold", "Freezing"].map(t => <option key={t}>{t}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Communication">
            <select className="input" value={commSelect}
              onChange={e => setSite(p => ({ ...p, communication: e.target.value === "Other" ? "" : e.target.value, commOther: e.target.value === "Other" }))}>
              <option value="">Select…</option>
              {COMM_PRESETS.map(c => <option key={c}>{c}</option>)}
              <option value="Other">Other</option>
            </select>
            {commSelect === "Other" && (
              <input className="input" style={{ marginTop: 8 }} value={site.communication} placeholder="Describe how the crew stays in contact"
                onChange={e => setSite(p => ({ ...p, communication: e.target.value }))} autoFocus />
            )}
          </Field>
          <Field label="Muster point"><input className="input" value={site.muster} onChange={e => setSite(p => ({ ...p, muster: e.target.value }))} /></Field>
          <Field label="First aid attendant on site">
            <select className="input" value={site.firstAid} onChange={e => setSite(p => ({ ...p, firstAid: e.target.value }))}>
              <option value="">Select…</option>
              <option>Yes</option>
              <option>No</option>
            </select>
          </Field>
          <Field label="Nearest hospital"><input className="input" value={site.hospital} onChange={e => setSite(p => ({ ...p, hospital: e.target.value }))} /></Field>

          <JhaSection title="Hazards" note={`${onCount} of ${hazards.length + extra.length} selected`} />
          {Object.keys(remembered).length > 0 && (
            <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: -2 }}>
              Sev, Prob and Freq start from what you rated each hazard last time. Change any that are different today.
            </div>
          )}
          <div style={{ maxHeight: 460, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {hazards.map((h, i) => (
              <HazardRow key={h.name} hazard={h} rating={ratings[h.name]} onToggle={() => toggle(i)}
                onRate={(k, v) => rate(h.name, k, v)} />
            ))}
            {extra.map((h, i) => (
              <HazardRow key={"extra" + i} hazard={h} rating={ratings[h.name]} onToggle={() => toggleExtra(i)}
                onRate={(k, v) => rate(h.name, k, v)} />
            ))}
          </div>
          <Btn variant="secondary" block style={{ minHeight: 52, borderStyle: "dashed" }} onClick={() => setAddingExtra(true)}>+ Add site-specific hazard</Btn>
          {addingExtra && (
            <AddHazardDialog onClose={() => setAddingExtra(false)}
              onAdd={h => { setExtra(p => [...p, h]); setAddingExtra(false); }} />
          )}

          <JhaSection title="Equipment record" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {PPE_CHECKS.map(p => (
              <div key={p.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                <CheckBox on={!!equip.ppe[p.key]} size={22} label={p.label}
                  onChange={() => setEquip(e => ({ ...e, ppe: { ...e.ppe, [p.key]: !e.ppe[p.key] } }))} />
                <span style={{ fontSize: 13 }}>{p.label}</span>
              </div>
            ))}
          </div>
          <Field label="H₂S gas monitor serial"><input className="input" value={equip.h2sSerial} onChange={e => setEquip(p => ({ ...p, h2sSerial: e.target.value }))} /></Field>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch on={equip.h2sBumpTest} label="Bump test performed" onClick={() => setEquip(p => ({ ...p, h2sBumpTest: !p.h2sBumpTest }))} />
            <span style={{ fontSize: 13 }}>Bump test performed</span>
          </div>
          <Field label="Exposure device (R.E.D.) serial"><input className="input" value={equip.redSerial} placeholder="Delta 880" onChange={e => setEquip(p => ({ ...p, redSerial: e.target.value }))} /></Field>
          <Field label="Device surface survey (mR/h)">
            {/* Kept as a string, not a number, so an unfilled box stays blank
                rather than reading as a surveyed 0.0 mR/h. A text input with a
                decimal keypad, not type="number" — the same lesson as the dose
                dialog and NumField: on a phone, a number input hands back ""
                for anything the browser considers half-typed or locale-wrong
                (a comma decimal, a stray key), so a reading that was visibly
                on screen arrived here empty. The filter only ever admits
                digits and separators, which also covers a pasted minus. */}
            <input className="input" type="text" inputMode="decimal" value={equip.redSurveyMr}
              onChange={e => setEquip(p => ({ ...p, redSurveyMr: e.target.value.replace(/[^\d.,]/g, "") }))} />
          </Field>
          {Number(String(equip.redSurveyMr).replace(",", ".")) > 200 && (
            <div style={{ fontSize: 12, color: "var(--color-accent-700)" }}>
              Over the 200 mR/h surface limit — the device must not be used until this is resolved.
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch on={equip.collimator} label="Collimator available" onClick={() => setEquip(p => ({ ...p, collimator: !p.collimator }))} />
            <span style={{ fontSize: 13 }}>Collimator available</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Switch on={equip.emergencyKit} label="Emergency equipment on hand" onClick={() => setEquip(p => ({ ...p, emergencyKit: !p.emergencyKit }))} />
            <span style={{ fontSize: 13 }}>Shield tunnel, tongs &amp; cutters on hand</span>
          </div>

          <JhaSection title="Nuclear energy worker (1)" note="Technician" />
          <div style={{ fontSize: 13, fontFamily: "var(--font-heading)", fontWeight: 600 }}>{currentUser.name}</div>
          <WorkerKit value={w1} onChange={editW1} missing={miss.is} onFixed={miss.clear} />

          <JhaSection title="Nuclear energy worker (2)" note="Helper — if one is on site" />
          <Field label="Worker">
            <select className="input" value={helperId} onChange={e => setHelperId(e.target.value)}>
              <option value="">Working alone today</option>
              {people.filter(p => p.id !== currentUser.id).map(p => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
          </Field>
          {helper && <WorkerKit value={w2} onChange={setW2} />}

          <JhaSection title="Review" />
          <Field label="Site rep name" missing={miss.is("siteRep")}>
            <input {...miss.props("siteRep")} value={siteRep} placeholder="Contractor rep"
              onChange={e => { miss.clear(); setSiteRep(e.target.value); }} />
          </Field>
          <Field label="Add another site rep" missing={miss.is("siteRepOther")}>
            <input {...miss.props("siteRepOther")} value={siteRepOther} placeholder="Anyone else reviewing this on site"
              onChange={e => { miss.clear(); setSiteRepOther(e.target.value); }} />
          </Field>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            Filed by {currentUser.name} — the account filing is the record, so no signature is collected.
            End readings are entered when the day is closed out.
          </div>

          <ErrorBox>{error}</ErrorBox>
          <Btn variant="primary" block style={{ minHeight: 56, fontSize: 15 }} onClick={submit} disabled={saving}>{saving ? "Filing…" : "File JHA"}</Btn>
          <Btn variant="ghost" block style={{ minHeight: 44, marginTop: 8 }} disabled={saving}
            onClick={() => { if (confirm("Discard this hazard assessment? Nothing has been filed yet.")) onCancel(); }}>
            Cancel
          </Btn>
        </Blueprint>

        <div className="phone-explain">
          <p>The FLHA as the crew fills it: site information, the hazard worksheet with a severity, probability and frequency rating each, the equipment record, and both nuclear energy workers with their dosimetry.</p>
          <p>Unit #, ID code and the three serials come from each person's profile in Users &amp; access — change one here only if equipment was swapped that day.</p>
          <p>Start readings are always 0, so the end reading is the dose. Those are entered at the end of the day: the assessment stays <strong>Open</strong> on Job detail until it's closed out.</p>
        </div>
      </div>
    </div>
  );
}

// Pull a person's assigned kit off their profile, then let anything they're
// actually assigned on the Equipment tab override the DRD and alarming
// dosimeter serials — those get swapped between people more often than the
// profile record gets updated to match.
function kitOf(p, equipment) {
  const list = equipment || [];
  const tldItem = list.find(e => e.type === "TLD / OSLD" && e.assignedTo === p.id);
  const drdItem = list.find(e => e.type === "Dosimeter" && e.assignedTo === p.id);
  const alarmItem = list.find(e => e.type === "Survey meter" && e.assignedTo === p.id);
  return {
    unit: p.unit_number || "", idCode: p.id_code || "",
    tld: (tldItem && tldItem.serial) || p.tld_serial || "",
    drd: (drdItem && drdItem.serial) || p.drd_serial || "",
    alarm: (alarmItem && alarmItem.serial) || p.alarm_serial || ""
  };
}

// A native prompt() is a no-op in some embedded preview hosts (returns
// immediately, no dialog shown) — an in-app dialog works everywhere and
// matches every other add-something flow in this app.
function AddHazardDialog({ onClose, onAdd }) {
  const [name, setName] = useState("");
  const [control, setControl] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), control: control.trim() || "Add control measure", level: "Med", on: true });
  };
  return (
    <Dialog title="Site-specific hazard" onClose={onClose}
      actions={<><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={!name.trim()}>Add</Btn></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Hazard name">
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Wildlife on lease" />
        </Field>
        <Field label="Recommended action / control measure">
          <textarea className="input" value={control} onChange={e => setControl(e.target.value)} placeholder="e.g. Bear spray, no lone work at dusk" />
        </Field>
      </div>
    </Dialog>
  );
}

function JhaSection({ title, note }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--color-divider)" }}>
      <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)" }}>{title}</span>
      {note && <span style={{ marginLeft: "auto", fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{note}</span>}
    </div>
  );
}

// Unit, ID code and the three pieces of monitoring equipment. Pre-filled from
// the profile; editable here because equipment does get swapped.
// `missing` is optional and only ever passed for worker 1 — filing needs at
// least one of that worker's three serials, so all three light up together
// rather than singling one out.
function WorkerKit({ value, onChange, missing, onFixed }) {
  const set = (k, v) => { if (onFixed) onFixed(); onChange({ ...value, [k]: v }); };
  const dos = k => ({
    className: missing && missing(k) ? "input invalid" : "input",
    "aria-invalid": (missing && missing(k)) || undefined
  });
  const bad = k => !!(missing && missing(k));
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="Unit #"><input className="input" value={value.unit} onChange={e => set("unit", e.target.value)} /></Field>
        <Field label="ID code"><input className="input" value={value.idCode} onChange={e => set("idCode", e.target.value)} /></Field>
      </div>
      <Field label="TLD / OSLD" missing={bad("w1tld")}>
        <input {...dos("w1tld")} value={value.tld} onChange={e => set("tld", e.target.value)} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="DRD" missing={bad("w1drd")}>
          <input {...dos("w1drd")} value={value.drd} onChange={e => set("drd", e.target.value)} />
        </Field>
        <Field label="Alarming dosimeter" missing={bad("w1alarm")}>
          <input {...dos("w1alarm")} value={value.alarm} onChange={e => set("alarm", e.target.value)} />
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "end" }}>
        <Field label="Start reading (mR)"><input className="input" value="0" disabled /></Field>
        <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", paddingBottom: 10 }}>
          End reading at close-out
        </div>
      </div>
    </>
  );
}

function HazardRow({ hazard, rating, onToggle, onRate }) {
  const r = rating || {};
  const pri = priorityOf(r);
  return (
    // The rating strip sits outside .hazard-row rather than wrapping inside it:
    // that row is a fixed-height flex line, and a wrapped second line overflowed
    // it and collided with the hazard underneath.
    <div style={{ border: hazard.on ? "1px solid var(--color-accent)" : "1px solid transparent", background: hazard.on ? "color-mix(in srgb, var(--color-accent) 7%, transparent)" : "transparent" }}>
      <div className="hazard-row" style={{ border: 0, background: "transparent" }}>
        <CheckBox on={hazard.on} onChange={onToggle} label={hazard.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15 }}>{hazard.name}</div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{hazard.control}</div>
        </div>
        <TagX variant={hazardTagVariant(hazard.level)}>{hazard.level}</TagX>
      </div>
      {/* Rated only once it's on the sheet — three taps, not three text fields. */}
      {hazard.on && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", padding: "0 10px 10px" }}>
          {[["s", "Sev"], ["p", "Prob"], ["f", "Freq"]].map(([key, label]) => (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em", color: "color-mix(in srgb, var(--color-text) 55%, transparent)", width: 30 }}>{label}</span>
              {RATING_SCALE.map(n => (
                <button key={n} type="button" onClick={() => onRate(key, n)}
                  aria-label={`${label} ${n} for ${hazard.name}`}
                  aria-pressed={r[key] === n}
                  style={{
                    width: 28, height: 28, cursor: "pointer", fontSize: 12,
                    fontFamily: "var(--font-heading)", fontWeight: 600,
                    border: "1px solid " + (r[key] === n ? "var(--color-accent)" : "var(--color-divider)"),
                    background: r[key] === n ? "var(--color-accent)" : "transparent",
                    color: r[key] === n ? "var(--color-bg)" : "var(--color-text)"
                  }}>{n}</button>
              ))}
            </div>
          ))}
          {pri.total > 0 && (
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-accent)", whiteSpace: "nowrap" }}>
              Priority {pri.total} · {pri.band}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

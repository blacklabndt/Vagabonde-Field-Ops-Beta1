import React, { useState, useEffect } from "react";
import { TABS, CONTEXT_TABS, ROLE_PRESETS, TECH_LEVELS } from "../data.js";
import { Db } from "../db.js";
import { UNIVERSAL_TABS, tabList, Blueprint, Btn, CheckBox, PickerRow, TagX, Field, Dialog, ErrorBox, Switch, emailIn, useMissingFields , Loading } from "./common.jsx";

export function UsersAccessScreen({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(currentUser.id);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try { setUsers(await Db.listProfiles()); }
    catch (e) { setError(e.message || "Couldn't load accounts."); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const account = users.find(u => u.id === selected) || users[0];

  const toggleTab = async key => {
    if (!account) return;
    if (account.id === currentUser.id && key === "users") return; // can't remove own admin access
    const current = tabList(account.tab_access);
    const tabs = current.includes(key) ? current.filter(t => t !== key) : [...current, key];
    setUsers(p => p.map(u => u.id === account.id ? { ...u, tab_access: tabs } : u));
    try { await Db.updateProfileTabs(account.id, tabs); }
    catch (e) { setError(e.message || "Couldn't update access."); await load(); }
  };
  // Locking yourself out is a one-way trip: once your row loses the users
  // tab, every policy gated on has_tab('users') denies you, so you cannot
  // grant it back from inside the app. The tab checkboxes already refused
  // this; the role dropdown did not.
  const wouldLockMeOut = tabs => account && account.id === currentUser.id && !tabs.includes("users");

  const setRole = async role => {
    if (!account || !ROLE_PRESETS[role]) return;
    const tabs = ROLE_PRESETS[role].slice();
    if (wouldLockMeOut(tabs)) {
      setError(`Switching your own account to ${role} would remove your access to Users & access, and only this screen can give it back. Have another admin change your role, or promote someone else first.`);
      return;
    }
    setError("");
    setUsers(p => p.map(u => u.id === account.id ? { ...u, role, tab_access: tabs } : u));
    try { await Db.updateProfileRole(account.id, role, tabs); }
    catch (e) { setError(e.message || "Couldn't update role."); await load(); }
  };
  const resetPreset = async () => {
    if (!account) return;
    const tabs = (ROLE_PRESETS[account.role] || ROLE_PRESETS.Technician).slice();
    if (wouldLockMeOut(tabs)) {
      setError("That preset doesn't include Users & access, so resetting your own account would lock you out of this screen.");
      return;
    }
    setError("");
    setUsers(p => p.map(u => u.id === account.id ? { ...u, tab_access: tabs } : u));
    try { await Db.updateProfileTabs(account.id, tabs); }
    catch (e) { setError(e.message || "Couldn't reset access."); await load(); }
  };
  const removeAccount = async () => {
    if (!account) return;
    if (account.id === currentUser.id) { setError("You can't remove your own account."); return; }
    if (!confirm(`Permanently remove ${account.displayName}'s account? They will no longer be able to sign in — this can't be undone.`)) return;
    try { await Db.deleteUserAccount(account.id); setUsers(p => p.filter(u => u.id !== account.id)); setSelected(currentUser.id); }
    catch (e) { setError(e.message || "Couldn't remove that account."); }
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 20 }}>
        <h2 style={{ fontSize: 34, margin: 0 }}>Users &amp; access</h2>
        <Btn variant="primary" style={{ marginLeft: "auto" }} onClick={() => setShowNew(true)}>+ New user</Btn>
      </div>
      <ErrorBox>{error}</ErrorBox>

      {loading ? (
        <Loading />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 20 }} className="grid-2col">
          <div>
            {users.map(u => (
              <PickerRow key={u.id} selected={selected === u.id} onSelect={() => setSelected(u.id)}
                style={{ padding: "10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16 }}>{u.displayName}</span>
                  {u.id === currentUser.id && <TagX variant="outline">you</TagX>}
                  {u.is_subcontractor && <TagX variant="neutral">sub</TagX>}
                </div>
                <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>{u.role} · {tabList(u.tab_access).length} of {TABS.length} sections</div>
              </PickerRow>
            ))}
          </div>

          {account && (
            <Blueprint style={{ padding: "18px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <h4 style={{ margin: 0, fontSize: 19 }}>{account.displayName}</h4>
                <TagX variant="accent">{account.role}</TagX>
                {account.is_subcontractor && <TagX variant="outline">Subcontractor</TagX>}
              </div>
              <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 16 }}>{account.cert}</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }} className="grid-2col">
                <div>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginBottom: 8 }}>Access</div>
                  <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 10 }}>
                    Most sections appear in the menu when ticked. The ones marked
                    “from a job” never sit in anyone's menu — they open from a
                    job's own page — but the tick still decides whether this
                    account may use them, including uploading the files they
                    produce. Unticking is not a lock on past work: nothing
                    already filed is affected, and ticking it back restores it.
                  </div>
                  {TABS.map(t => {
                    const allowed = tabList(account.tab_access).includes(t.key);
                    const lockedSelf = account.id === currentUser.id && t.key === "users";
                    // Contacts is a plain lookup everyone gets, so its box is
                    // shown ticked and disabled rather than pretending to be a
                    // switch that does nothing.
                    const universal = UNIVERSAL_TABS.includes(t.key);
                    // Contextual screens are permission-only: hidden from every
                    // menu by design after two admins hid them by unticking —
                    // which also, invisibly, revoked their upload rights.
                    const contextual = CONTEXT_TABS.includes(t.key);
                    return (
                      <div key={t.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", opacity: lockedSelf || universal ? 0.55 : 1 }}>
                        <CheckBox on={allowed} size={22} disabled={lockedSelf || universal}
                          label={`${contextual ? "Allow" : "Show"} ${t.label}`} onChange={() => toggleTab(t.key)} />
                        <span style={{ fontSize: 14, flex: 1 }}>
                          {t.label}
                          {contextual && <span style={{ fontSize: 11, marginLeft: 6, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>from a job</span>}
                        </span>
                        <TagX variant={allowed ? "accent" : "outline"}>{universal ? "Everyone" : contextual ? (allowed ? "Allowed" : "Blocked") : (allowed ? "Shown" : "Hidden")}</TagX>
                      </div>
                    );
                  })}
                  {account.id === currentUser.id && <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 6 }}>can't hide Users &amp; access from yourself</div>}
                </div>

                <div>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginBottom: 8 }}>Person</div>
                  <PersonFields key={account.id} account={account} onSaved={load} onError={setError} />

                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "18px 0 8px" }}>Role</div>
                  <Field label="Role">
                    <select className="input" value={account.role} onChange={e => setRole(e.target.value)}>
                      {Object.keys(ROLE_PRESETS).map(r => <option key={r}>{r}</option>)}
                    </select>
                  </Field>
                  <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", margin: "6px 0 10px" }}>
                    Password resets happen through Supabase Auth (dashboard or the "Forgot password" flow) — not editable here.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                    <Btn variant="secondary" onClick={resetPreset}>Reset to role preset</Btn>
                    <Btn variant="secondary" onClick={removeAccount}>Remove account</Btn>
                  </div>
                </div>
              </div>
            </Blueprint>
          )}
        </div>
      )}

      {showNew && <NewUserDialog onClose={() => setShowNew(false)} onCreated={async () => { setShowNew(false); await load(); }} />}

      <RecentErrorsPanel />
    </div>
  );
}

// What went wrong in the background — report emails, ticket approvals, PDF
// renders, account deletions — that nobody would otherwise hear about until
// a client or a tech complained. Admin-only, same as the rest of this screen.
function RecentErrorsPanel() {
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = () => {
    setLoading(true);
    Db.listFunctionErrors().then(setErrors).catch(e => setErr(e.message || "Couldn't load recent errors.")).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  return (
    <Blueprint style={{ padding: "18px 20px", marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <h4 style={{ margin: 0, fontSize: 19 }}>Recent background errors</h4>
        <Btn variant="secondary" style={{ marginLeft: "auto" }} onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Btn>
      </div>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 14 }}>
        Failures in report emails, ticket approvals, PDF rendering, and account removal — logged here so they don't go unnoticed.
      </div>
      <ErrorBox>{err}</ErrorBox>
      {!loading && !errors.length && !err && (
        <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Nothing logged — everything's been going through cleanly.</div>
      )}
      {errors.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {errors.map(e => (
            <div key={e.id} style={{ border: "1px solid var(--color-neutral-300)", padding: "10px 12px", fontSize: 13 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <TagX variant="outline">{e.function_name}</TagX>
                <span style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginLeft: "auto" }}>
                  {new Date(e.created_at).toLocaleString("en-CA", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
              <div style={{ marginTop: 4 }}>{e.message}</div>
            </div>
          ))}
        </div>
      )}
    </Blueprint>
  );
}

function PersonFields({ account, onSaved, onError }) {
  const [form, setForm] = useState({
    firstName: account.first_name || "",
    lastName: account.last_name || "",
    cert: account.cert || "",
    level: account.level || "",
    isSubcontractor: !!account.is_subcontractor,
    unitNumber: account.unit_number || "",
    idCode: account.id_code || ""
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const dirty = form.firstName !== (account.first_name || "") ||
    form.lastName !== (account.last_name || "") ||
    form.cert !== (account.cert || "") ||
    form.level !== (account.level || "") ||
    form.isSubcontractor !== !!account.is_subcontractor ||
    form.unitNumber !== (account.unit_number || "") ||
    form.idCode !== (account.id_code || "");

  const save = async () => {
    setSaving(true);
    try { await Db.updateProfileDetails(account.id, form); await onSaved(); }
    catch (e) { onError(e.message || "Couldn't save those details."); }
    setSaving(false);
  };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="First name"><input className="input" value={form.firstName} onChange={e => set("firstName", e.target.value)} /></Field>
        <Field label="Last name"><input className="input" value={form.lastName} onChange={e => set("lastName", e.target.value)} /></Field>
      </div>
      <Field label="Certification"><input className="input" value={form.cert} onChange={e => set("cert", e.target.value)} /></Field>
      {/* Both of these print on the client's field invoice beside this
          person's hours — Level in the LEVEL column, the number in CGSB #.
          Level is a picker rather than a box because the invoice prints the
          legend explaining the codes from the same list. */}
      <Field label="Level">
        <select className="input" value={form.level} onChange={e => set("level", e.target.value)}>
          <option value="">— not set —</option>
          {TECH_LEVELS.map(l => <option key={l.code} value={l.code}>{l.code} — {l.label}</option>)}
        </select>
      </Field>
      <Field label="CGSB# / NRCAN#"><input className="input" value={form.idCode} placeholder="Certification number" onChange={e => set("idCode", e.target.value)} /></Field>

      {/* Unit and dosimetry live on the person because they're assigned, not
          decided per job — the JHA pre-fills from here, so a tech in the field
          confirms rather than types. */}
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", margin: "16px 0 6px" }}>Unit</div>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginBottom: 8 }}>
        Carried onto every JHA this person files. Dosimetry serials now come from what's assigned to them on the Equipment tab.
      </div>
      <Field label="Unit #"><input className="input" value={form.unitNumber} placeholder="e.g. TR-01" onChange={e => set("unitNumber", e.target.value)} /></Field>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0 4px" }}>
        <Switch on={form.isSubcontractor} label="Subcontractor" onClick={() => set("isSubcontractor", !form.isSubcontractor)} />
        <div>
          <div style={{ fontSize: 14 }}>Subcontractor</div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Their timesheet carries mileage to invoice from</div>
        </div>
      </div>
      {dirty && <Btn variant="primary" onClick={save} disabled={saving} style={{ marginTop: 8 }}>{saving ? "Saving…" : "Save details"}</Btn>}
    </>
  );
}

function NewUserDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", password: "", role: "Technician", cert: "", level: "", isSubcontractor: false });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const miss = useMissingFields();
  const set = (k, v) => { miss.fixed(k); setForm(p => ({ ...p, [k]: v })); };

  const submit = async () => {
    // Named individually so the highlight lands on the empty one — the old
    // check tested all three together and could only say "all three".
    const gaps = [];
    if (!form.firstName.trim()) gaps.push("firstName");
    if (!form.lastName.trim()) gaps.push("lastName");
    if (!form.email.trim()) gaps.push("email");
    if (gaps.length) { miss.flag(...gaps); setError("First name, last name and email are required."); return; }
    if (!emailIn(form.email)) { miss.flag("email"); setError("That doesn't look like an email address."); return; }
    if (form.password.length < 6) { miss.flag("password"); setError("Password needs to be at least 6 characters."); return; }
    miss.clear();
    setSaving(true);
    setError("");
    try {
      await Db.createUserAccount({
        firstName: form.firstName.trim(), lastName: form.lastName.trim(),
        email: form.email.trim(), password: form.password, role: form.role,
        cert: form.cert.trim() || form.role, level: form.level || null, isSubcontractor: form.isSubcontractor
      });
      onCreated();
    } catch (e) {
      setSaving(false);
      setError(e.message || "Couldn't create the account.");
    }
  };

  return (
    <Dialog title="New user" onClose={onClose} actions={<><Btn variant="secondary" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Creating…" : "Create account"}</Btn></>}>
      <ErrorBox>{error}</ErrorBox>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
        If email confirmation is on for this project, the new person needs to confirm their email before they can sign in.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="First name" missing={miss.is("firstName")}>
          <input {...miss.props("firstName")} value={form.firstName} onChange={e => set("firstName", e.target.value)} />
        </Field>
        <Field label="Last name" missing={miss.is("lastName")}>
          <input {...miss.props("lastName")} value={form.lastName} onChange={e => set("lastName", e.target.value)} />
        </Field>
      </div>
      <Field label="Email" missing={miss.is("email")}>
        <input {...miss.props("email")} type="email" value={form.email} onChange={e => set("email", e.target.value)} />
      </Field>
      <Field label="Temporary password" missing={miss.is("password")}>
        <input {...miss.props("password")} type="password" value={form.password} onChange={e => set("password", e.target.value)} placeholder="min. 6 characters" />
      </Field>
      <Field label="Role">
        <select className="input" value={form.role} onChange={e => set("role", e.target.value)}>
          {Object.keys(ROLE_PRESETS).map(r => <option key={r}>{r}</option>)}
        </select>
      </Field>
      <Field label="Certification"><input className="input" value={form.cert} onChange={e => set("cert", e.target.value)} /></Field>
      <Field label="Level">
        <select className="input" value={form.level} onChange={e => set("level", e.target.value)}>
          <option value="">— not set —</option>
          {TECH_LEVELS.map(l => <option key={l.code} value={l.code}>{l.code} — {l.label}</option>)}
        </select>
      </Field>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Switch on={form.isSubcontractor} label="Subcontractor" onClick={() => set("isSubcontractor", !form.isSubcontractor)} />
        <span style={{ fontSize: 14 }}>Subcontractor — mileage appears on their timesheet</span>
      </div>
    </Dialog>
  );
}


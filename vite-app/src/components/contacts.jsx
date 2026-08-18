import React, { useState, useEffect, useRef } from "react";
import { Db } from "../db.js";
import { Blueprint, Btn, TagX, Field, Dialog, ErrorBox, Switch, emailIn, useMissingFields, SearchSelect , Loading } from "./common.jsx";

// Contacts — the directory of people at each client and contractor. One
// screen for both, because in the field they are asked for the same way
// ("who do I call at Athabasca?") and a contractor on one job is the client's
// prime on the next.
//
// The primary contact is the one every other screen pre-fills: New job, the
// job record panel, and the address a report or ticket approval is emailed to.
// Everyone else on file is here to be looked up.

const CONTACT_SCOPES = ["All", "Clients", "Contractors"];

export function ContactsScreen({ currentUser }) {
  // Removing someone from the directory is an admin action now — the button is
  // hidden rather than left to fail against the policy.
  const isAdmin = currentUser && currentUser.role === "Admin";
  const [scope, setScope] = useState("All");
  // The chosen organisation is held whole, not as a key into the current
  // search results. Paging kept the list and the selection in step; a search
  // box does not — type one letter after picking Athabasca and it drops out of
  // the results, which would take the panel with it.
  const [org, setOrg] = useState(null);
  const [mine, setMine] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showNewOrg, setShowNewOrg] = useState(false);
  const [error, setError] = useState("");
  const [booting, setBooting] = useState(true);

  // Opening the screen with nothing selected would be a blank panel and no
  // clue what to do, so it starts on the first organisation on file. This is
  // the only unprompted fetch — everything else is driven by the search box.
  useEffect(() => {
    let live = true;
    Db.searchOrgDirectory({ page: 0, pageSize: 1, scope: "All", search: "" })
      .then(({ rows }) => { if (live && rows[0]) setOrg(rows[0]); })
      .catch(e => { if (live) setError(e.message || "Couldn't load the contact directory."); })
      .finally(() => { if (live) setBooting(false); });
    return () => { live = false; };
  }, []);

  // Only the selected org's people are fetched — the whole point of moving
  // the picker server-side was to stop pulling every contact up front.
  // Same guard as the timesheet screen: pick two organisations quickly and
  // the first reply can arrive last, listing one company's people under
  // another company's name.
  const loadSeq = useRef(0);
  const loadContacts = async () => {
    // `seq`, not `mine` — `mine` is already the contact list on this screen.
    const seq = ++loadSeq.current;
    if (!org) { setMine([]); return; }
    setContactsLoading(true);
    try {
      const rows = await Db.listContactsForOrg(org.type, org.id);
      if (seq !== loadSeq.current) return;
      setMine(rows);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e.message || "Couldn't load contacts for this organisation.");
    }
    if (seq === loadSeq.current) setContactsLoading(false);
  };
  useEffect(() => { loadContacts(); }, [org ? org.key : null]);

  // Primary first, then alphabetical — the list answers "who do I call?"
  // before it answers "who else is there?"
  const sorted = [...mine].sort((a, b) =>
    (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || (a.name || "").localeCompare(b.name || ""));

  const withError = async fn => {
    setError("");
    try { await fn(); await loadContacts(); }
    catch (e) { setError(e.message || "That didn't save — try again."); }
  };

  const addContact = form => withError(async () => {
    await Db.createContact({ orgType: org.type, orgId: org.id, ...form });
    setAdding(false);
  });
  const saveContact = (id, form) => withError(() => Db.updateContact(id, form));
  const makePrimary = c => withError(() => Db.setPrimaryContact({ id: c.id, orgType: c.org_type, orgId: c.org_id }));
  const removeContact = c => {
    const warn = c.is_primary && mine.length > 1
      ? `${c.name} is the primary contact for ${org.name}. Remove them and no one is primary until you promote someone — new jobs won't pre-fill a rep.`
      : `Remove ${c.name} from ${org.name}?`;
    if (!confirm(warn)) return;
    withError(() => Db.deleteContact(c.id));
  };

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 6 }}>
        <h2 style={{ fontSize: 34, margin: 0 }}>Contacts</h2>
        <Btn variant="secondary" style={{ marginLeft: "auto" }} onClick={() => setShowNewOrg(true)}>+ New organisation</Btn>
        <Btn variant="primary" disabled={!org} onClick={() => setAdding(true)}>+ New contact</Btn>
      </div>
      <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 18 }}>
        Clients and contractors, and the people at each. The primary contact is what a new job, a report email and a ticket approval pre-fill.
      </div>
      <ErrorBox>{error}</ErrorBox>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        <div className="seg" role="group" aria-label="Show">
          {CONTACT_SCOPES.map(s => (
            <button key={s} type="button" className={`seg-opt${scope === s ? " active" : ""}`}
              aria-pressed={scope === s} onClick={() => setScope(s)}>{s}</button>
          ))}
        </div>
        <OrgCombo scope={scope} selected={org}
          onPick={o => { setOrg(o); setAdding(false); }}
          onError={setError} />
      </div>

      {booting ? (
        <Loading />
      ) : !org ? (
        <Blueprint style={{ padding: "22px 20px" }}>
          <div style={{ fontSize: 14, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
            No organisations on file yet. Add one with <strong>+ New organisation</strong>, or start a job — a job files its
            client and contractor into the directory automatically.
          </div>
        </Blueprint>
      ) : (
        <div>
          {org && (
            <Blueprint style={{ padding: "18px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                <h4 style={{ margin: 0, fontSize: 19 }}>{org.name}</h4>
                <TagX variant={org.type === "client" ? "accent" : "outline"}>{org.type === "client" ? "Client" : "Contractor"}</TagX>
              </div>
              <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", marginBottom: 16 }}>
                {org.type === "client"
                  ? "Who the work is billed to — their rates live on the Rate admin screen"
                  : "Subcontracted crews and prime contractors on site"}
              </div>

              {adding && (
                <ContactForm heading="New contact" org={org}
                  onCancel={() => setAdding(false)}
                  onSave={addContact} canSetPrimary={mine.length > 0} />
              )}

              {contactsLoading ? (
                <Loading />
              ) : (
                <div style={{ display: "grid", gap: 12 }}>
                  {sorted.map(c => (
                    <ContactCard key={c.id} contact={c} orgName={org.name} canRemove={isAdmin}
                      onSave={form => saveContact(c.id, form)}
                      onMakePrimary={() => makePrimary(c)}
                      onRemove={() => removeContact(c)} />
                  ))}
                </div>
              )}

              {!contactsLoading && !sorted.length && !adding && (
                <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                  No one on file for {org.name} yet. Add the site rep and they'll pre-fill the next job here.
                </div>
              )}
            </Blueprint>
          )}
        </div>
      )}

      {showNewOrg && (
        <NewOrgDialog
          onClose={() => setShowNewOrg(false)}
          onCreated={created => {
            // Select it straight from what the dialog returned rather than
            // re-searching for it. A brand-new organisation has no contacts,
            // so the form for its first one opens immediately.
            setShowNewOrg(false);
            setScope("All");
            setOrg({
              key: created.type + ":" + created.id,
              id: created.id, type: created.type, name: created.name, contactCount: 0
            });
            setAdding(true);
          }} />
      )}
    </div>
  );
}

function ContactCard({ contact, orgName, onSave, onMakePrimary, onRemove, canRemove }) {
  const [editing, setEditing] = useState(false);
  const muted = "color-mix(in srgb, var(--color-text) 60%, transparent)";

  if (editing) {
    return (
      <ContactForm heading={`Edit ${contact.name}`} contact={contact}
        onCancel={() => setEditing(false)}
        onSave={async form => { await onSave(form); setEditing(false); }} />
    );
  }

  return (
    <div style={{ border: "1px solid var(--color-neutral-300)", padding: "12px 14px", display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 17 }}>{contact.name}</span>
        {contact.is_primary && <TagX variant="accent">Primary</TagX>}
        {contact.title && <span style={{ fontSize: 13, color: muted }}>{contact.title}</span>}
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 14 }}>
        {contact.phone
          ? <a href={"tel:" + contact.phone.replace(/[^\d+]/g, "")}>{contact.phone}</a>
          : <span style={{ color: muted }}>No phone on file</span>}
        {contact.email
          ? <a href={"mailto:" + contact.email}>{contact.email}</a>
          : <span style={{ color: muted }}>No email on file</span>}
      </div>
      {contact.notes && <div style={{ fontSize: 13, color: muted, textWrap: "pretty" }}>{contact.notes}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Btn variant="secondary" onClick={() => setEditing(true)}>Edit</Btn>
        {!contact.is_primary && <Btn variant="secondary" onClick={onMakePrimary}>Make primary</Btn>}
        {canRemove && <Btn variant="ghost" onClick={onRemove}>Remove</Btn>}
        {contact.last_used_at && (
          <span style={{ fontSize: 11, color: muted, marginLeft: "auto" }}>
            last used on a job {new Date(contact.last_used_at).toLocaleDateString("en-CA", { day: "2-digit", month: "short", year: "numeric" })}
          </span>
        )}
      </div>
    </div>
  );
}

function ContactForm({ heading, contact, org, onSave, onCancel, canSetPrimary }) {
  const [form, setForm] = useState({
    name: (contact && contact.name) || "",
    title: (contact && contact.title) || "",
    email: (contact && contact.email) || "",
    phone: (contact && contact.phone) || "",
    notes: (contact && contact.notes) || "",
    isPrimary: false
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const miss = useMissingFields();
  const set = (k, v) => { miss.fixed(k); setForm(p => ({ ...p, [k]: v })); };

  const submit = async () => {
    if (!form.name.trim()) { miss.flag("name"); setErr("A name is the one thing this needs."); return; }
    // Not blocking on it: a rep whose only contact detail is a radio channel
    // is a real thing out here. But a typo'd address that silently fails to
    // receive a report is worse than a warning.
    if (form.email.trim() && !emailIn(form.email)) { miss.flag("email"); setErr("That email address doesn't look right."); return; }
    miss.clear();
    setErr("");
    setSaving(true);
    try { await onSave(form); }
    catch (e) { setErr(e.message || "Couldn't save that contact."); }
    setSaving(false);
  };

  return (
    <div style={{ border: "1px solid var(--color-accent)", padding: "14px 16px", marginBottom: 14 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginBottom: 10 }}>
        {heading}{org ? " · " + org.name : ""}
      </div>
      <ErrorBox>{err}</ErrorBox>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }} className="grid-2col">
        <Field label="Name" missing={miss.is("name")}>
          <input {...miss.props("name")} autoFocus value={form.name} onChange={e => set("name", e.target.value)} />
        </Field>
        <Field label="Title / role"><input className="input" value={form.title} placeholder="Site rep, AP clerk, night foreman" onChange={e => set("title", e.target.value)} /></Field>
        <Field label="Phone"><input className="input" type="tel" value={form.phone} placeholder="(780) 555-0148" onChange={e => set("phone", e.target.value)} /></Field>
        <Field label="Email" missing={miss.is("email")}>
          <input {...miss.props("email")} type="email" value={form.email} placeholder="name@company.ca" onChange={e => set("email", e.target.value)} />
        </Field>
      </div>
      <Field label="Notes"><input className="input" value={form.notes} placeholder="Nights only · approves tickets for the north spread" onChange={e => set("notes", e.target.value)} /></Field>
      {canSetPrimary && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0 4px" }}>
          <Switch on={form.isPrimary} label="Primary contact" onClick={() => set("isPrimary", !form.isPrimary)} />
          <div>
            <div style={{ fontSize: 14 }}>Make them the primary contact</div>
            <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>New jobs, report emails and ticket approvals pre-fill this person</div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save contact"}</Btn>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}

// The organisation picker: SearchSelect over the same server-side directory
// search, with the type tag and contact count drawn per row.
const MAX_SUGGESTIONS = 25;

function OrgCombo({ scope, selected, onPick, onError }) {
  return (
    <SearchSelect
      listId="org-combo-list"
      ariaLabel="Search clients and contractors"
      // The chosen company shows as the placeholder rather than as the value:
      // the box stays a search box, so typing never means clearing what is
      // already there first.
      placeholder={selected ? `${selected.name} — search to change…` : "Search clients and contractors…"}
      searchKey={scope}
      search={text => Db.searchOrgDirectory({ page: 0, pageSize: MAX_SUGGESTIONS, scope, search: text })}
      optionKey={o => o.key}
      onPick={onPick}
      onError={onError}
      renderOption={o => (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 15 }}>{o.name}</span>
            <TagX variant={o.type === "client" ? "accent" : "outline"}>{o.type === "client" ? "client" : "contractor"}</TagX>
          </div>
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {o.contactCount === 0 ? "No contacts on file" : o.contactCount === 1 ? "1 contact" : o.contactCount + " contacts"}
          </div>
        </>
      )}
    />
  );
}

// A contact needs an organisation to belong to, and a contractor's first job
// may not exist yet when someone hands over a card at a pre-job meeting.
function NewOrgDialog({ onClose, onCreated }) {
  const [type, setType] = useState("client");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const miss = useMissingFields();
  const submit = async () => {
    if (!name.trim()) { miss.flag("name"); setErr("Give them a name."); return; }
    miss.clear();
    setErr("");
    setSaving(true);
    try {
      const created = type === "client"
        ? await Db.createClient({ name: name.trim() })
        : await Db.createContractor({ name: name.trim() });
      // The name goes back too, so the screen can select the new organisation
      // from this alone rather than searching the directory for what it just
      // created. `created.name` when the insert returns it, the typed name
      // otherwise.
      onCreated({ type, id: created.id, name: created.name || name.trim() });
    } catch (e) {
      setSaving(false);
      setErr(e.message || "Couldn't add that organisation.");
    }
  };

  return (
    <Dialog title="New organisation" maxWidth={460} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Adding…" : "Add"}</Btn>
      </>}>
      <ErrorBox>{err}</ErrorBox>
      <Field label="Type">
        <div className="seg" role="group" aria-label="Organisation type">
          <button type="button" className={`seg-opt${type === "client" ? " active" : ""}`} aria-pressed={type === "client"} onClick={() => setType("client")}>Client</button>
          <button type="button" className={`seg-opt${type === "contractor" ? " active" : ""}`} aria-pressed={type === "contractor"} onClick={() => setType("contractor")}>Contractor</button>
        </div>
      </Field>
      <Field label="Name" missing={miss.is("name")}>
        <input {...miss.props("name")} autoFocus value={name}
          onChange={e => { miss.fixed("name"); setName(e.target.value); }}
          onKeyDown={e => { if (e.key === "Enter") submit(); }} />
      </Field>
      <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
        {type === "client"
          ? "A new client starts on the house rate card — check Rate admin before a ticket is raised against them."
          : "Contractors carry no rates of their own; they appear on the job record and the JHA."}
      </div>
    </Dialog>
  );
}

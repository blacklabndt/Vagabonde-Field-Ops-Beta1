import React, { useState, useEffect, useRef } from "react";
import { primaryContact } from "../data.js";
import { Db } from "../db.js";
import { OfflineQueue } from "../offlineQueue.js";
import { Blueprint, Btn, TableScroll, TagX, Field, Dialog, ErrorBox, StatusTag, useMissingFields, RowsPerPage, useRowsPerPage, SearchSelect } from "./common.jsx";

// What the error box calls each field, kept in step with its label above the
// box it points at — "Site · LSD is required" is no help if the label reads
// something else.
const FIELD_NAMES = { project: "Project name", client: "Client", lsd: "Site · LSD", jobNumber: "Job #" };

// A job is Active from creation until an admin marks it Complete. Those are
// the only two states — the old Unassigned/Dispatched/In progress ladder was
// never used and is folded into Active by migration.
const FILTERS = ["All", "Active", "Complete"];

// Search fields, in the order a coordinator is most likely to reach for them.
// "Anything" is first because most searches are a half-remembered fragment
// rather than a decision about which column it lives in.
const SEARCH_FIELDS = [
  { key: "any", label: "Anything" },
  { key: "project", label: "Project" },
  { key: "lsd", label: "Site · LSD" },
  { key: "id", label: "Job #" },
  { key: "client", label: "Client" },
  { key: "contractor", label: "Contractor" }
];

// "On file" is the useful half of this chip; the date is a bonus. A contact
// filed before `last_used_at` existed has none, and formatting null produced
// the literal words "Invalid Date" next to the client's name.
function lastUsedChip(contact) {
  const at = contact.last_used_at ? new Date(contact.last_used_at) : null;
  if (!at || isNaN(at)) return "On file";
  return "On file — last used " + at.toLocaleDateString("en-CA", { day: "2-digit", month: "short" });
}

export function HomeScreen({ onCreateJob, onOpenJob, onStartTicket, currentUser, clients, contractors, contacts }) {
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [searchField, setSearchField] = useState("any");
  const [showNew, setShowNew] = useState(false);
  const [showNewTicket, setShowNewTicket] = useState(false);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Recomputed per render rather than pinned at mount, so a tablet left open
  // on the board overnight doesn't still claim it's yesterday.
  const today = new Date().toLocaleDateString("en-CA", {
    weekday: "long", day: "numeric", month: "long"
  });

  const [cachedAt, setCachedAt] = useState(null);
  const [pageSize, setPageSize] = useRowsPerPage();

  const fetchPage = async (p, f, q, sf) => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await Db.searchJobs({ page: p, pageSize, status: f, search: q, searchField: sf });
      setRows(res.rows);
      setTotal(res.total);
      // Served from this device because the network is down. Not an error —
      // it is the board doing its job — so it gets a note, not a red box.
      setCachedAt(res.fromCache ? res.cachedAt : null);
    } catch (e) {
      setCachedAt(null);
      setLoadError(/failed to fetch|networkerror|load failed/i.test(e.message || "")
        ? "No connection, and nothing saved on this device yet. Once you've opened the board in range, it stays available offline."
        : (e.message || "Couldn't reach the database. Check your connection and reload."));
    }
    setLoading(false);
  };

  // One effect covering every input to the query. As three (filter, debounced
  // query, page) opening the board fired three identical requests before a
  // single row was drawn; this fires one. Typing still waits for a pause —
  // only the search box is debounced, so a filter or page tap is immediate.
  const last = useRef({ key: null, text: "" });
  useEffect(() => {
    const key = [filter, searchField, query].join("");
    const isNewQuery = last.current.key !== null && last.current.key !== key;
    const typed = last.current.text !== query;
    last.current = { key, text: query };
    // A new filter/field/search starts again at page 1. That reset is its own
    // state update, so wait for it to land rather than asking for page 5 of a
    // result set that may no longer have one.
    if (isNewQuery && page !== 0) { setPage(0); return; }
    if (!typed) { fetchPage(page, filter, query, searchField); return; }
    const t = setTimeout(() => fetchPage(page, filter, query, searchField), 350);
    return () => clearTimeout(t);
  }, [filter, searchField, query, page, pageSize]);

  const reload = () => fetchPage(page, filter, query, searchField);

  // Offline there is exactly one page — the cached total still counts every
  // job on the server, and offering "Next" for a page that can't be fetched
  // would be a button that only ever fails.
  const pageCount = cachedAt ? 1 : Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 20, gap: 16, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 34, margin: 0 }}>{today}</h2>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {/* Raising a ticket used to mean finding the job on the board and
              opening it first. From here it is two choices — whose job, and
              which one — which is how a technician thinks about it at the end
              of a day. */}
          <Btn variant="secondary" style={{ whiteSpace: "nowrap" }} onClick={() => setShowNewTicket(true)}>+ New ticket</Btn>
          <Btn variant="primary" style={{ whiteSpace: "nowrap" }} onClick={() => setShowNew(true)}>+ New job</Btn>
        </div>
      </div>

      {/* Filters, search and the count are one row: they are all the same
          question — which of these jobs am I looking at. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, flex: "none" }}>
          {FILTERS.map(f => (
            <button key={f} className={`pill${filter === f ? " active" : ""}`} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <div style={{ position: "relative", flex: "1 1 260px", minWidth: 200 }}>
          <input
            className="input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={`Search ${(SEARCH_FIELDS.find(f => f.key === searchField) || SEARCH_FIELDS[0]).label.toLowerCase()}…`}
            aria-label={`Search jobs by ${(SEARCH_FIELDS.find(f => f.key === searchField) || SEARCH_FIELDS[0]).label}`}
            style={{ width: "100%", minHeight: 38, paddingRight: 34 }}
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              aria-label="Clear search"
              style={{
                position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
                width: 24, height: 24, border: 0, background: "transparent", cursor: "pointer",
                fontSize: 15, lineHeight: 1, color: "color-mix(in srgb, var(--color-text) 55%, transparent)"
              }}
            >×</button>
          )}
        </div>
        <select
          className="input"
          value={searchField}
          onChange={e => setSearchField(e.target.value)}
          aria-label="Search by"
          style={{ width: "auto", minHeight: 38 }}
        >
          {SEARCH_FIELDS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        {/* Back to page 1 on a size change — page 5 of ten-row pages is past
            the end once the pages hold a hundred. */}
        <RowsPerPage value={pageSize} onChange={n => { setPageSize(n); setPage(0); }} />
        <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)", whiteSpace: "nowrap" }}>
          {cachedAt ? `${rows.length} saved` : `${total} job${total === 1 ? "" : "s"}`}
        </span>
      </div>

      <Blueprint style={{ padding: "6px 18px 14px" }}>
        <ErrorBox>{loadError}</ErrorBox>
        {cachedAt && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 4px 2px", fontSize: 13 }}>
            <span aria-hidden="true" style={{ width: 7, height: 7, flex: "none", background: "color-mix(in srgb, var(--color-text) 40%, transparent)" }} />
            <span style={{ color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
              Offline — showing the {rows.length} most recent job{rows.length === 1 ? "" : "s"} saved on this device at{" "}
              {new Date(cachedAt).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false })}.
              Filters and search need a connection.
            </span>
          </div>
        )}
        {loading ? (
          <div style={{ padding: "24px 4px", fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Loading jobs…</div>
        ) : (
          <TableScroll><table className="table table-wide">
            <thead>
              <tr>
                <th style={{ width: 96 }}>Job</th><th>Project</th><th style={{ width: 180 }}>Client</th>
                <th className="col-opt" style={{ width: 180 }}>Contractor</th>
                <th>Site · LSD</th><th className="col-opt" style={{ width: 170 }}>Created on</th>
                <th className="col-opt" style={{ width: 120 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {!loadError && rows.length === 0 && (
                <tr><td colSpan={7} style={{ color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                  {query ? `No jobs match “${query}”.` : "No jobs to show."}
                </td></tr>
              )}
              {rows.map(j => (
                <tr key={j.id} className="clickable" onClick={() => onOpenJob(j)}>
                  <td><span style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>{j.id}</span>
                    {/* Status rides along with the job number once its own
                        column is dropped on a phone. */}
                    <span className="row-status"><StatusTag status={j.status} /></span>
                  </td>
                  <td>{j.project}</td>
                  <td>{j.client}</td>
                  <td className="col-opt">{j.contractor || <span style={{ color: "color-mix(in srgb, var(--color-text) 40%, transparent)" }}>—</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{j.lsd}</td>
                  <td className="col-opt">
                    {j.createdAt}
                    <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>{j.createdBy}</div>
                  </td>
                  <td className="col-opt"><StatusTag status={j.status} /></td>
                </tr>
              ))}
            </tbody>
          </table></TableScroll>
        )}
        {!loading && pageCount > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 4px 4px" }}>
            <Btn variant="secondary" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>← Previous</Btn>
            <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              Page {page + 1} of {pageCount}
            </span>
            <Btn variant="secondary" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next →</Btn>
          </div>
        )}
      </Blueprint>

      {showNewTicket && (
        <NewTicketDialog
          onClose={() => setShowNewTicket(false)}
          onChosen={job => { setShowNewTicket(false); onStartTicket(job); }} />
      )}

      {showNew && (
        <NewJobDialog
          currentUser={currentUser} clients={clients} contractors={contractors} contacts={contacts}
          onClose={() => setShowNew(false)}
          onCreate={async job => { setShowNew(false); await onCreateJob(job); reload(); }}
        />
      )}
    </div>
  );
}

// Raising a ticket without going to find the job first.
//
// Two questions in order — whose job, then which one — because that is how a
// crew names the day's work. The client narrows it enough that the second
// list is usually two or three jobs, which is why it can be a plain select
// rather than a second search box.
//
// This only picks the job. Everything about the ticket itself is still the
// billing screen's business, so there is one place where a ticket is made
// rather than two that have to agree.
function NewTicketDialog({ onClose, onChosen }) {
  const [client, setClient] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobId, setJobId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!client) { setJobs([]); setJobId(""); return; }
    let live = true;
    setLoading(true);
    setError("");
    Db.listActiveJobsForClient(client.id)
      .then(rows => {
        if (!live) return;
        setJobs(rows);
        // One job is not a choice — pick it so the only thing left is Continue.
        setJobId(rows.length === 1 ? rows[0].dbId : "");
      })
      .catch(e => { if (live) setError(e.message || "Couldn't load that client's jobs."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [client ? client.id : null]);

  const job = jobs.find(j => j.dbId === jobId);

  return (
    <Dialog title="New ticket" maxWidth={520} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={!job} onClick={() => onChosen(job)}>Continue</Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>

      <Field label="Client">
        <SearchSelect
          style={{ maxWidth: "none" }}
          listId="ticket-client-list"
          ariaLabel="Search clients"
          placeholder={client ? `${client.name} — search to change…` : "Search clients…"}
          search={text => Db.searchOrgDirectory({ page: 0, pageSize: 25, scope: "Clients", search: text })}
          optionKey={o => o.key}
          onPick={setClient}
          onError={setError}
          renderOption={o => <span style={{ fontSize: 15 }}>{o.name}</span>}
        />
      </Field>

      <Field label="Job">
        <select className="input" value={jobId} disabled={!client || loading}
          aria-label="Active jobs for this client"
          onChange={e => setJobId(e.target.value)}>
          {!client && <option value="">Pick a client first…</option>}
          {client && loading && <option value="">Loading…</option>}
          {client && !loading && !jobs.length && <option value="">No active jobs for {client.name}</option>}
          {client && !loading && jobs.length > 1 && <option value="">Select a job…</option>}
          {jobs.map(j => (
            <option key={j.dbId} value={j.dbId}>
              {j.id} — {j.project || "No project name"}{j.lsd ? ` · ${j.lsd}` : ""}
            </option>
          ))}
        </select>
      </Field>

      {client && !loading && !jobs.length && (
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
          Only active jobs can be ticketed. If the job is finished it needs reopening from the job screen first.
        </div>
      )}
      {job && (
        <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
          Opens the billing screen for {job.id}. The ticket number is issued when you save it.
        </div>
      )}
    </Dialog>
  );
}

function NewJobDialog({ currentUser, clients, contractors, contacts, onClose, onCreate }) {
  const [form, setForm] = useState({
    project: "", jobNumber: "", client: "", lsd: "",
    clientRepId: "", clientRepName: "", clientRepEmail: "", clientRepPhone: "",
    contractor: "", contractorRepId: "", contractorRepName: "", contractorRepEmail: "", contractorRepPhone: ""
  });
  const [clientChip, setClientChip] = useState("");
  // A client added here is added for real, not just for this job — but the
  // parent's `clients` prop won't know about it until it refetches, so keep
  // a local list that starts from the prop and grows.
  const [clientList, setClientList] = useState(clients);
  const [addingClient, setAddingClient] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [addingBusy, setAddingBusy] = useState(false);
  // Same pattern as the client picker above, so the two fields look and behave
  // alike. Unlike a client, though, adding a contractor needs no round trip:
  // createJob already creates one by name if it doesn't recognise it, so a new
  // name is just staged here and comes into being with the job. That also
  // means it still works with no signal, which matters now that a job can be
  // started on site.
  const [contractorList, setContractorList] = useState(contractors);
  const [addingContractor, setAddingContractor] = useState(false);
  const [newContractorName, setNewContractorName] = useState("");
  const [contractorChip, setContractorChip] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [placeholderNum, setPlaceholderNum] = useState("");

  // The prop only seeded this list, so a client added elsewhere while the
  // dialog was open never showed up in it.
  useEffect(() => { setClientList(clients); }, [clients]);
  // Keep any contractor staged here but not yet saved, so re-syncing the prop
  // doesn't drop a name that's currently picked.
  useEffect(() => {
    setContractorList(prev => {
      const unsaved = prev.filter(c => !c.id && !contractors.some(k => k.name === c.name));
      return [...contractors, ...unsaved];
    });
  }, [contractors]);
  useEffect(() => { Db.getNextJobNumber().then(setPlaceholderNum).catch(() => {}); }, []);

  // Typing into a flagged field clears its highlight straight away, so fixing
  // the problem visibly works instead of staying lit until the next submit.
  const miss = useMissingFields();
  const set = (k, v) => { miss.fixed(k); setForm(p => ({ ...p, [k]: v })); };

  // The number is checked as it is typed, not only on submit. It arrives
  // pre-filled with the next one going, and the people who overwrite it are
  // usually entering a number the office issued on paper — so a clash is a
  // real possibility, and finding out after filling in the rest of the form
  // is a wasted trip.
  const [numberTaken, setNumberTaken] = useState(false);
  const intendedNumber = form.jobNumber.trim() || placeholderNum || "";
  useEffect(() => {
    if (!intendedNumber) { setNumberTaken(false); return; }
    let live = true;
    const t = setTimeout(() => {
      Db.jobNumberExists(intendedNumber)
        // Offline this can't be answered. Say nothing rather than claim the
        // number is free — the queue reports the collision on sync.
        .then(taken => { if (live) setNumberTaken(taken); })
        .catch(() => { if (live) setNumberTaken(false); });
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [intendedNumber]);

  const addClient = async () => {
    const name = newClientName.trim();
    if (!name) return;
    setAddingBusy(true);
    setError("");
    try {
      const created = await Db.createClient({ name });
      setClientList(p => [...p, created].sort((a, b) => a.name.localeCompare(b.name)));
      pickClient(created.name);
      setAddingClient(false);
      setNewClientName("");
    } catch (e) {
      setError(e.message || "Couldn't add that client.");
    }
    setAddingBusy(false);
  };

  const addContractor = () => {
    const name = newContractorName.trim();
    if (!name) return;
    const existing = contractorList.find(c => c.name.toLowerCase() === name.toLowerCase());
    if (!existing) setContractorList(p => [...p, { id: null, name }].sort((a, b) => a.name.localeCompare(b.name)));
    pickContractor(existing ? existing.name : name);
    setAddingContractor(false);
    setNewContractorName("");
  };

  const contactFor = (type, id) => primaryContact(contacts, type, id);

  // Everyone on file for an organisation, primary first — the rep dropdowns
  // are fed from this rather than from the primary alone, so a night foreman
  // who isn't the default is one pick away instead of a retype.
  const contactsFor = (type, id) => (id ? contacts.filter(c => c.org_type === type && c.org_id === id) : [])
    .slice().sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0) || (a.name || "").localeCompare(b.name || ""));

  const clientId = (clientList.find(c => c.name === form.client) || {}).id;
  const contractorId = (contractorList.find(c => c.name === form.contractor) || {}).id;
  const clientContacts = contactsFor("client", clientId);
  const contractorContacts = contactsFor("contractor", contractorId);

  // Picking a name fills the whole person. "" is the manual option: it clears
  // the three fields so the next thing typed isn't half of someone else.
  const pickClientRep = id => {
    const c = clientContacts.find(x => String(x.id) === String(id));
    setClientChip("");
    setForm(p => ({
      ...p,
      clientRepId: id,
      clientRepName: c ? c.name : "",
      clientRepEmail: c ? (c.email || "") : "",
      clientRepPhone: c ? (c.phone || "") : ""
    }));
  };
  const pickContractorRep = id => {
    const c = contractorContacts.find(x => String(x.id) === String(id));
    setContractorChip("");
    setForm(p => ({
      ...p,
      contractorRepId: id,
      contractorRepName: c ? c.name : "",
      contractorRepEmail: c ? (c.email || "") : "",
      contractorRepPhone: c ? (c.phone || "") : ""
    }));
  };

  const pickClient = name => {
    set("client", name);
    const client = clientList.find(c => c.name === name);
    const c = client && contactFor("client", client.id);
    if (c) {
      setForm(p => ({ ...p, client: name, clientRepId: c.id, clientRepName: c.name, clientRepEmail: c.email || "", clientRepPhone: c.phone || "" }));
      setClientChip(lastUsedChip(c));
    } else { setClientChip(""); }
  };
  const pickContractor = name => {
    set("contractor", name);
    const contractor = contractorList.find(c => c.name === name);
    const c = contractor && contactFor("contractor", contractor.id);
    if (c) {
      setForm(p => ({ ...p, contractor: name, contractorRepId: c.id, contractorRepName: c.name, contractorRepEmail: c.email || "", contractorRepPhone: c.phone || "" }));
      setContractorChip(lastUsedChip(c));
    } else { setContractorChip(""); }
  };

  const submit = async () => {
    // Everything missing at once, rather than one box per attempt: the old
    // checks returned on the first failure, so an empty form had to be
    // submitted three times to be told about all three fields.
    const gaps = [];
    if (!form.project.trim()) gaps.push("project");
    if (!form.client) gaps.push("client");
    if (!form.lsd.trim()) gaps.push("lsd");
    if (gaps.length) {
      miss.flag(...gaps);
      setError(gaps.length === 1
        ? `${FIELD_NAMES[gaps[0]]} is required.`
        : `Still needed: ${gaps.map(g => FIELD_NAMES[g]).join(", ")}.`);
      return;
    }
    const id = form.jobNumber.trim() || placeholderNum;
    // Offline the placeholder never arrives, because the next number can only
    // come from the database. Say that plainly instead of inserting a blank.
    if (!id) {
      miss.flag("jobNumber");
      setError("Give the job a number — one can't be suggested without a connection.");
      return;
    }
    // Asked again here rather than trusting the live check: the number could
    // have been taken in the time it took to fill in the rest of the form,
    // and the live one stays quiet when it can't reach the database. A
    // failure to answer isn't a blocker — createJob refuses on the unique
    // index either way, and now says so in plain words.
    try {
      if (await Db.jobNumberExists(id)) {
        miss.flag("jobNumber");
        setError(`Job ${id} already exists — job numbers have to be unique. Give this one a different number.`);
        return;
      }
    } catch (e) { /* offline; the queue reports the collision when it syncs */ }
    miss.clear();
    setSaving(true);
    setError("");

    const details = {
      jobNumber: id, project: form.project.trim(), clientName: form.client, lsd: form.lsd.trim(),
      createdBy: currentUser.id,
      clientRep: { name: form.clientRepName, email: form.clientRepEmail, phone: form.clientRepPhone },
      contractorName: form.contractor,
      contractorRep: { name: form.contractorRepName, email: form.contractorRepEmail, phone: form.contractorRepPhone }
    };

    // When the browser already knows there is no connection, don't spend a
    // round trip proving it — start the job on the device straight away.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      try {
        const job = await Db.queueNewJob({ ...details, clientId, createdByName: currentUser.name });
        onCreate({ id, job });
      } catch (queueErr) {
        setSaving(false);
        setError(queueErr.message || "Couldn't start that job on this device.");
      }
      return;
    }

    try {
      // The duplicate check happens above, before the spinner starts, so it
      // can flag the field. createJob still refuses on the unique index if
      // the number is taken between there and here.
      await Db.createJob(details);
      onCreate({ id });
    } catch (e) {
      // No signal — start the job on this device and let it sync. Anything
      // else is a real refusal and has to be shown.
      if (OfflineQueue.isNetworkError(e)) {
        try {
          const job = await Db.queueNewJob({
            ...details, clientId, createdByName: currentUser.name
          });
          onCreate({ id, job });
          return;
        } catch (queueErr) {
          setSaving(false);
          setError(queueErr.message || "Couldn't start that job on this device.");
          return;
        }
      }
      setSaving(false);
      setError(e.message || "Couldn't create the job — try again.");
    }
  };

  return (
    <Dialog title="New job" maxWidth={560} onClose={onClose}
      actions={<>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={submit} disabled={saving}>{saving ? "Creating…" : "Create job"}</Btn>
      </>}>
      <ErrorBox>{error}</ErrorBox>
      {/* The caps are generous — the longest real project name on file is
          under forty characters — and exist because beta testing saved a
          ten-thousand-character one, which the database accepted happily
          and every table and invoice then had to wear. */}
      <Field label="Project name" missing={miss.is("project")}>
        <input {...miss.props("project")} maxLength={140} value={form.project} onChange={e => set("project", e.target.value)} />
      </Field>
      {/* Flagged either because submit found it empty, or because the live
          check found the number already on a job. */}
      <Field label="Job #" missing={miss.is("jobNumber") || numberTaken}>
        <input value={form.jobNumber} placeholder={placeholderNum} maxLength={40}
          className={`input${miss.is("jobNumber") || numberTaken ? " invalid" : ""}`}
          aria-invalid={miss.is("jobNumber") || numberTaken || undefined}
          onChange={e => set("jobNumber", e.target.value)} />
        {numberTaken && (
          <div style={{ fontSize: 12, color: "var(--color-accent-700)", marginTop: 4 }}>
            Job {intendedNumber} already exists — this needs a different number.
          </div>
        )}
      </Field>
      <Field label="Client" missing={miss.is("client")}>
        <div style={{ display: "flex", gap: 6 }}>
          <select {...miss.props("client")} style={{ flex: 1 }} value={form.client}
            onChange={e => { miss.fixed("client"); pickClient(e.target.value); }}>
            <option value="">Select a client…</option>
            {clientList.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <Btn variant="secondary" onClick={() => setAddingClient(a => !a)}>{addingClient ? "Cancel" : "+ New"}</Btn>
        </div>
        {addingClient && (
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input className="input" style={{ flex: 1 }} autoFocus value={newClientName}
              maxLength={120} placeholder="New client name"
              onChange={e => setNewClientName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") addClient(); }} />
            <Btn variant="primary" onClick={addClient} disabled={addingBusy}>{addingBusy ? "Adding…" : "Add"}</Btn>
          </div>
        )}
        {addingClient && (
          <div style={{ fontSize: 11, color: "color-mix(in srgb, var(--color-text) 55%, transparent)", marginTop: 4 }}>
            Their rates still need setting up in Rate admin before a ticket can be raised.
          </div>
        )}
      </Field>
      <Field label="Site · LSD" missing={miss.is("lsd")}>
        <input {...miss.props("lsd")} maxLength={80} value={form.lsd} onChange={e => set("lsd", e.target.value)} placeholder="13-22-047-05 W5M" />
      </Field>
      <Field label="Created by"><input className="input" value={currentUser.name} disabled /></Field>

      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginTop: 4 }}>Client representative</div>
      {clientChip && <TagX variant="outline">{clientChip}</TagX>}
      <Field label="Name">
        {clientContacts.length > 0 && (
          <select className="input" style={{ marginBottom: 6 }} value={form.clientRepId}
            aria-label="Client contact on file" onChange={e => pickClientRep(e.target.value)}>
            <option value="">Someone else — type below…</option>
            {clientContacts.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        )}
        <input className="input" value={form.clientRepName} placeholder={form.client ? "" : "Pick a client first"}
          onChange={e => { set("clientRepName", e.target.value); set("clientRepId", ""); setClientChip(""); }} />
      </Field>
      <Field label="Email"><input className="input" value={form.clientRepEmail} onChange={e => { set("clientRepEmail", e.target.value); set("clientRepId", ""); setClientChip(""); }} /></Field>
      <Field label="Phone"><input className="input" value={form.clientRepPhone} onChange={e => { set("clientRepPhone", e.target.value); set("clientRepId", ""); setClientChip(""); }} /></Field>

      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--color-accent)", marginTop: 4 }}>Contractor</div>
      {contractorChip && <TagX variant="outline">{contractorChip}</TagX>}
      <Field label="Company">
        <div style={{ display: "flex", gap: 6 }}>
          <select className="input" style={{ flex: 1 }} value={form.contractor} onChange={e => pickContractor(e.target.value)}>
            <option value="">No contractor on this job</option>
            {contractorList.map(c => <option key={c.id || c.name} value={c.name}>{c.name}</option>)}
          </select>
          <Btn variant="secondary" onClick={() => setAddingContractor(a => !a)}>{addingContractor ? "Cancel" : "+ New"}</Btn>
        </div>
        {addingContractor && (
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input className="input" style={{ flex: 1 }} autoFocus value={newContractorName}
              placeholder="New contractor name"
              onChange={e => setNewContractorName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addContractor(); } }} />
            <Btn variant="primary" onClick={addContractor} disabled={!newContractorName.trim()}>Add</Btn>
          </div>
        )}
      </Field>
      <Field label="Rep name">
        {contractorContacts.length > 0 && (
          <select className="input" style={{ marginBottom: 6 }} value={form.contractorRepId}
            aria-label="Contractor contact on file" onChange={e => pickContractorRep(e.target.value)}>
            <option value="">Someone else — type below…</option>
            {contractorContacts.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{c.title ? " · " + c.title : ""}{c.is_primary ? " (primary)" : ""}
              </option>
            ))}
          </select>
        )}
        <input className="input" value={form.contractorRepName} placeholder={form.contractor ? "" : "Pick a contractor first"}
          onChange={e => { set("contractorRepName", e.target.value); set("contractorRepId", ""); setContractorChip(""); }} />
      </Field>
      <Field label="Rep email"><input className="input" value={form.contractorRepEmail} onChange={e => { set("contractorRepEmail", e.target.value); set("contractorRepId", ""); setContractorChip(""); }} /></Field>
      <Field label="Rep phone"><input className="input" value={form.contractorRepPhone} onChange={e => { set("contractorRepPhone", e.target.value); set("contractorRepId", ""); setContractorChip(""); }} /></Field>
    </Dialog>
  );
}

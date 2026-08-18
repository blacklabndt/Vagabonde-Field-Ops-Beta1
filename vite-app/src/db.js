import { createClient } from "@supabase/supabase-js";
import { sbClient, SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { todayLocal, localDate, dayMonth, ticketDateStamp, primaryContact, ageInDays, storageKeySafe, STANDARD_RATE_LINES } from "./data.js";
import { OfflineCache } from "./offlineCache.js";
import { Toasts } from "./toastBus.js";
import { OfflineQueue, isNetworkError } from "./offlineQueue.js";

// Thin data-access layer over the tables that are wired to Supabase so far
// (see README "What's wired"). Screens call these instead of touching
// `supabase` directly, so the swap from mock state to real queries stays
// contained to one file per domain as more screens get wired.

// Sentinel id for the house default rate schedule — a rate_schedules row
// with client_id null, edited through the same screen as a client's own.
export const DEFAULT_SCHEDULE = "__default__";

// Zero-byte object that makes an otherwise-empty folder exist in Storage.
const FOLDER_MARKER = ".keep";

// One place that turns a timestamp into the "12 Feb 06:31" the tables use, and
// returns "" rather than "Invalid Date" for a null column.
function stamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d) ? "" : d.toLocaleString("en-CA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

// Profiles carry first/last names now, but older rows may only have the
// display string — prefer the parts, fall back to what's there.
function fullName(p) {
  const joined = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return joined || p.name || "";
}

// A failed Edge Function returns its JSON body inside the error's `context`
// Response — without unwrapping it every failure reads "Edge Function returned
// a non-2xx status code", which tells the user nothing.
async function readFnError(error) {
  try {
    const body = await error.context.json();
    if (body && body.error) return body.error;
  } catch (_) { /* not JSON, fall through */ }
  return error.message || "The email service didn't respond.";
}

// Shapes a raw jobs row (with its client/contractor/created-by joins) into
// what every screen expects — shared by listJobs and the single-row lookups
// below so a job read the same way wherever it's fetched from.
function shapeJob(j) {
  return {
    dbId: j.id, id: j.job_number, project: j.project,
    client: j.clients ? j.clients.name : "", clientId: j.client_id,
    contractor: j.contractors ? j.contractors.name : "", contractorId: j.contractor_id,
    lsd: j.lsd, afe: j.afe, area: j.area, method: j.method, procedure: j.procedure,
    scope: "RT · scope TBD", status: j.status,
    // The id as well as the name: a screen has to be able to ask "did I
    // raise this", and two people can share a name.
    createdBy: j.profiles ? j.profiles.name : "", createdById: j.created_by,
    createdAt: stamp(j.created_at)
  };
}

// A light in-memory cache for the reference-data lists (clients, contractors,
// contacts, profiles) that most screens read but rarely write: switching
// Home → Contacts → Home used to re-fetch the same unchanged lists every
// time. Cached for 30s, or until something writes to that table, whichever
// comes first — short enough that a stale add elsewhere in the app isn't
// felt for long, long enough to kill the repeat-navigation round trips.
const _cache = {};
const _generation = {};
const CACHE_TTL_MS = 30000;
async function cached(key, fetcher) {
  const hit = _cache[key];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  // A read that was already in flight when something wrote to this table must
  // not be the thing that repopulates the cache — it fetched the old rows.
  // The generation counter is what tells the two apart.
  const startedAt = _generation[key] || 0;
  const value = await fetcher();
  if ((_generation[key] || 0) === startedAt) _cache[key] = { value, at: Date.now() };
  return value;
}
// Floors anything that feeds a bill — rates, quantities, hours. A negative
// prices a line below zero and silently credits the client, so the ticket
// totals up short with no error raised anywhere.
//
// Zero is a real value everywhere this is used ("not priced yet", "no hours
// today"), so this floors rather than rejects. The database enforces the same
// rule; clamping here means a stray minus is quietly dropped instead of
// surfacing a constraint violation to someone standing in a field.
function nonNegative(value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Rates and quantities both come off the ticket screen, so they are floored
// together on the way in — and the total is recomputed from the floored
// figures, never from what the caller worked out.
const cleanLine = l => ({
  kind: l.kind, label: l.label, unit: l.unit,
  quantity: nonNegative(l.quantity), unit_rate: nonNegative(l.unit_rate)
});
const totalOf = lines => lines.reduce((s, l) => s + l.quantity * l.unit_rate, 0);

// tickets.total is numeric(10,2): eight digits before the point. Found in
// beta testing by billing a nine-figure ticket — the database refused it
// with "numeric field overflow", which is not a sentence a technician can
// act on, and the two-step write left debris behind. Checked here, before
// anything is written.
const MAX_TICKET_TOTAL = 99999999.99;
const assertBillable = total => {
  if (total > MAX_TICKET_TOTAL) {
    throw new Error(
      `This ticket adds up to $${total.toLocaleString("en-CA")}, which cannot be right — check the quantities and rates against what was actually worked.`
    );
  }
};

// The same database refusal, translated, for anything that slips past the
// client-side check (a stale tab, a hand-crafted request).
const friendlyLineError = e =>
  e && e.code === "22003"
    ? new Error("A figure on this ticket is too large to bill — check the quantities and rates.")
    : e;

// 23505 is a unique violation; the constraint name tells us which one. Jobs
// have two unique columns (the id and the number), and only the number is
// something a person chose.
const isDuplicateJobNumber = error =>
  !!error && error.code === "23505" && /job_number/.test(error.message || "");

const jobNumberTakenMessage = jobNumber =>
  `Job ${jobNumber} already exists — job numbers have to be unique. Give this one a different number.`;

// Fetch every page of something that exceeds the 1000-row response cap.
//
// The two callers used to walk pages one at a time, each waiting on the last.
// That is the only safe shape when you don't know how many pages there are,
// but it costs a full round trip per 1000 rows: exporting 50,000 tickets was
// 51 sequential requests and about fourteen seconds.
//
// Page 0 comes back with the total, which is all that's needed to know how
// many pages exist and ask for them at once. Six at a time rather than all of
// them — a phone on a lease does not benefit from fifty concurrent requests,
// and PostgREST is happier too. Pages are reassembled in order, which matters:
// the underlying queries have a total order and the CSV inherits it.
const PAGE_CONCURRENCY = 6;
async function fetchAllPages(fetchPage) {
  const first = await fetchPage(0);
  const total = first.total;
  const rows = first.rows.slice();
  if (!first.rows.length || rows.length >= total) return rows;

  const pageCount = Math.ceil(total / RESPONSE_ROW_CAP);
  const pages = new Array(pageCount);
  pages[0] = first.rows;

  for (let start = 1; start < pageCount; start += PAGE_CONCURRENCY) {
    const batch = [];
    for (let p = start; p < Math.min(start + PAGE_CONCURRENCY, pageCount); p++) {
      batch.push(fetchPage(p).then(r => { pages[p] = r.rows; }));
    }
    await Promise.all(batch);
  }
  // Rows added between page 0 and the last page would land beyond `total`;
  // flat() keeps whatever actually arrived rather than trusting the estimate.
  return pages.flat();
}

function invalidate(...keys) {
  keys.forEach(k => {
    delete _cache[k];
    _generation[k] = (_generation[k] || 0) + 1;
  });
}

// Row shapers for the three lists that hang off a job. Pulled out of the
// per-job reads so the batch prefetch below stores exactly the same shape —
// two copies of this mapping would drift, and the drift would only show up
// offline, which is the worst place to find it.
// The local calendar day of a timestamp, for comparing against a plain date.
function localDay(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || isNaN(+d)) return "";
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function shapeJha(j) {
  return {
    id: j.id,
    pdfKey: j.pdf_key,
    template: j.template || "",
    dosimetry: Array.isArray(j.dosimetry) ? j.dosimetry : [],
    details: j.details || {},
    unitNumber: j.unit_number || "",
    siteRep: j.site_rep || "",
    // The day the assessment covers, which is not always the day it was
    // typed in — see the work_date migration.
    workDate: j.work_date || "",
    // Written up for a different day than it was entered — worth showing, so
    // nobody reads the filing date as the date of the work.
    backdated: !!(j.work_date && j.signed_at && j.work_date !== localDay(j.signed_at)),
    // Rows filed before the close-out step existed have no status — they are
    // finished, not waiting for readings.
    status: j.status || "Closed",
    closedAt: stamp(j.closed_at),
    file: j.pdf_key ? j.pdf_key.split("/").pop() : (j.template ? j.template.replace(/s+/g, "-") + ".pdf" : "jha.pdf"),
    at: stamp(j.signed_at),
    by: j.profiles ? j.profiles.name : "",
    sentAt: stamp(j.sent_at),
    sentTo: j.sent_to || ""
  };
}
// `hazards` is deliberately not selected. Job detail used to summarise the
// last assessment's hazards as a grid of chips and no longer does, and it
// was the only reader — a jsonb array of a dozen objects per JHA, carried
// over field data and written into the offline cache for nothing. The PDF
// renderer reads the column itself, server-side, from the row.
const JHA_COLUMNS = "id, job_id, template, pdf_key, signed_at, work_date, status, closed_at, dosimetry, details, unit_number, site_rep, sent_at, sent_to, profiles(name)";

function shapeReport(r) {
  return {
    pdfKey: r.pdf_key,
    id: r.id,
    file: r.filename, welds: r.welds, result: r.result,
    at: stamp(r.uploaded_at),
    sent: r.sent_at ? "Yes" : "Pending",
    sentAt: stamp(r.sent_at),
    sentTo: r.sent_to || ""
  };
}

function shapeJobTicket(t) {
  return {
    id: t.id, date: dayMonth(localDate(t.work_date)),
    age: ageInDays(t.created_at),
    amount: Number(t.total), status: t.status, tech: t.profiles ? t.profiles.name : "",
    // Who raised it, so the screen can offer "cancel approval" to the same
    // people the database would let do it: that technician, or an admin.
    techId: t.technician_id
  };
}
const JOB_TICKET_COLUMNS = "id, job_id, work_date, status, total, created_at, technician_id, profiles(name)";

// PostgREST will not return more than 1000 rows in a single response, no
// matter what limit is asked for — and it does not say so. A request for
// 100000 rows comes back with 1000 and looks complete.
//
// That is fine for anything paged, and quietly wrong for anything that means
// "all of them": the accounting export was writing a CSV of the first 1000
// tickets, and a pay period with more than 1000 crew rows would have dropped
// hours off a timesheet. Both now page until the source is exhausted.
const RESPONSE_ROW_CAP = 1000;

// The board is re-fetched on every filter tap and every return to Home;
// re-pulling the detail for ten jobs each time would be a lot of traffic for
// data that rarely changes within a minute.
let _lastDetailPrefetch = 0;
const DETAIL_PREFETCH_GAP_MS = 60000;

export const Db = {
  // The three reference lists every screen pre-fills from. Two layers: the
  // 30-second in-memory cache kills repeat round trips inside a session, and
  // the IndexedDB one underneath it keeps the last good copy for a day with
  // no signal.
  //
  // Paged through fetchAllPages, because these lists mean "all of them" and
  // PostgREST answers at most 1,000 rows per response, silently. The seeded
  // load test found it: 1,167 contacts came back as a directory that
  // quietly ended partway through the alphabet. Ordered by name THEN id —
  // seeded data proves duplicate names happen, and a page boundary landing
  // inside a run of one name would otherwise drop or double people.
  async _allRows(table) {
    return fetchAllPages(async page => {
      const { data, error, count } = await sbClient
        .from(table)
        .select("*", page === 0 ? { count: "exact" } : {})
        .order("name").order("id")
        .range(page * RESPONSE_ROW_CAP, (page + 1) * RESPONSE_ROW_CAP - 1);
      if (error) throw error;
      return { rows: data || [], total: count ?? (data || []).length };
    });
  },

  async listClients() {
    return cached("clients", () => OfflineCache.readThrough("clients", () => this._allRows("clients")));
  },

  async listContractors() {
    return cached("contractors", () => OfflineCache.readThrough("contractors", () => this._allRows("contractors")));
  },

  async listContacts() {
    return cached("contacts", () => OfflineCache.readThrough("contacts", () => this._allRows("contacts")));
  },

  // One organisation's people. Ordered because the Contacts screen lists them;
  // the internal callers only ever `find()` in the result, so they don't care
  // either way. There were two of these for a while — this one and an
  // unordered twin — which is a coin-flip about which query you get.
  async listContactsForOrg(orgType, orgId) {
    const { data, error } = await sbClient.from("contacts").select("*")
      .eq("org_type", orgType).eq("org_id", orgId).order("name");
    if (error) throw error;
    return data;
  },

  async searchOrgDirectory({ page = 0, pageSize = 20, scope = "All", search = "" } = {}) {
    const { data, error } = await sbClient.rpc("search_org_directory", { q: search, scope, page_num: page, page_size: pageSize });
    if (error) throw error;
    const rows = (data || []).map(o => ({
      key: o.org_type + ":" + o.org_id, type: o.org_type, id: o.org_id,
      name: o.name, agreement: o.agreement_ref, contactCount: Number(o.contact_count)
    }));
    const total = data && data.length ? Number(data[0].total_count) : 0;
    return { rows, total };
  },

  // ── Contacts directory ───────────────────────────────────────────────
  // Many contacts per organisation, one of them primary. Everything that
  // pre-fills a rep (New job, job record, ticket email) reads the primary,
  // so promoting someone here changes what those screens offer next time.

  async createContact({ orgType, orgId, name, title, email, phone, notes, isPrimary }) {
    const clean = (name || "").trim();
    if (!clean) throw new Error("Give the contact a name.");
    // The first contact for an organisation is its primary whether or not the
    // box was ticked — otherwise an org can end up with contacts on file and
    // nothing for the job screens to pre-fill.
    const existing = await this.listContactsForOrg(orgType, orgId);
    const primary = isPrimary || existing.length === 0;
    if (primary && existing.length) await this.clearPrimary(orgType, orgId);
    const { data, error } = await sbClient.from("contacts").insert({
      org_type: orgType, org_id: orgId, name: clean,
      title: (title || "").trim() || null,
      email: (email || "").trim() || null,
      phone: (phone || "").trim() || null,
      notes: (notes || "").trim() || null,
      is_primary: primary,
      last_used_at: new Date().toISOString()
    }).select().single();
    if (error) throw error;
    invalidate("contacts");
    return data;
  },

  async updateContact(id, { name, title, email, phone, notes }) {
    const clean = (name || "").trim();
    if (!clean) throw new Error("Give the contact a name.");
    const { error } = await sbClient.from("contacts").update({
      name: clean,
      title: (title || "").trim() || null,
      email: (email || "").trim() || null,
      phone: (phone || "").trim() || null,
      notes: (notes || "").trim() || null
    }).eq("id", id);
    if (error) throw error;
    invalidate("contacts");
  },

  async deleteContact(id) {
    const { error } = await sbClient.from("contacts").delete().eq("id", id);
    if (error) throw error;
    invalidate("contacts");
  },

  // Clearing before setting, in two statements: the unique partial index
  // allows one primary per organisation, so writing the new one first would
  // collide with the old.
  async clearPrimary(orgType, orgId) {
    const { error } = await sbClient.from("contacts").update({ is_primary: false })
      .eq("org_type", orgType).eq("org_id", orgId).eq("is_primary", true);
    if (error) throw error;
  },

  async setPrimaryContact({ id, orgType, orgId }) {
    await this.clearPrimary(orgType, orgId);
    const { error } = await sbClient.from("contacts").update({ is_primary: true }).eq("id", id);
    if (error) throw error;
    invalidate("contacts");
  },

  // Contractors are created as a side effect of a job elsewhere; the
  // directory can add one on its own so a contact can be filed before the
  // first job for them exists.
  async createContractor({ name }) {
    const clean = (name || "").trim();
    if (!clean) throw new Error("Give the contractor a name.");
    const escaped = clean.replace(/[%_\\]/g, m => "\\" + m);
    const { data: existing } = await sbClient.from("contractors").select("*").ilike("name", escaped).maybeSingle();
    if (existing) return existing;
    const { data, error } = await sbClient.from("contractors").insert({ name: clean }).select().single();
    if (error) throw error;
    invalidate("contractors");
    return data;
  },

  // Jobs joined with client name, shaped to match what the screens expect.
  async listJobs() {
    const { data, error } = await sbClient
      .from("jobs")
      .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name), contractors(name), profiles!jobs_created_by_fkey(name)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data.map(shapeJob);
  },

  // Deleting a job, and saying what happens to what is filed against it.
  //
  // One RPC rather than a delete plus three updates from here: moving a JHA,
  // a report and a ticket and then removing the job has to be all-or-nothing,
  // and a browser that loses signal half way through would otherwise leave
  // the contents split across two jobs.
  //
  // `transferToId` moves everything to that job. `discard` destroys it with
  // the job. Neither one set, and the database refuses if anything is
  // attached — see 20260815000000.
  async deleteJob({ jobId, transferToId = null, discard = false }) {
    const { data, error } = await sbClient.rpc("delete_job", {
      p_job_id: jobId,
      p_transfer_to: transferToId,
      p_discard: discard
    });
    if (error) throw error;
    // The board, the job itself and its history are all now wrong on this
    // device, and the deleted job must not come back from the cache.
    invalidate("jobs.recent");
    await OfflineCache.remove("job." + jobId);
    await OfflineCache.remove("jhas." + jobId);
    await OfflineCache.remove("reports." + jobId);
    await OfflineCache.remove("tickets." + jobId);
    return data;
  },

  // The open jobs for one client, newest first — what the "New ticket" button
  // on the board offers once a client is chosen.
  //
  // Filtered on client_id rather than by searching the client's name: the
  // picker already knows which client it handed over, and two clients whose
  // names share a word would otherwise bleed into each other's list. Complete
  // jobs are left out because a ticket can't be raised against one anyway —
  // offering them would be a list of things that refuse to be picked.
  async listActiveJobsForClient(clientId) {
    if (!clientId) return [];
    const { data, error } = await sbClient
      .from("jobs")
      .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name), contractors(name), profiles!jobs_created_by_fkey(name)")
      .eq("client_id", clientId)
      .eq("status", "Active")
      .order("created_at", { ascending: false })
      .limit(RESPONSE_ROW_CAP);
    if (error) throw error;
    return data.map(shapeJob);
  },

  // Same shape as listJobs, for exactly one row — used to seed the initial
  // active job on sign-in without pulling every job just to pick the newest.
  async getMostRecentJob() {
    const { data, error } = await sbClient
      .from("jobs")
      .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name), contractors(name), profiles!jobs_created_by_fkey(name)")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? shapeJob(data) : null;
  },

  // Is this number already on a job? One lookup straight down the unique
  // index behind job_number.
  //
  // Advisory only: two coordinators can both pass this in the same instant
  // and one still loses at the insert, which is what the 23505 translation in
  // createJob is for. This catches the ordinary case — a number issued on
  // paper last week — against the field rather than after the form is filled.
  //
  // Trimmed and guarded because it is called on every keystroke now: an empty
  // box is not a collision, and " J-1 " is the same number as "J-1".
  async jobNumberExists(jobNumber) {
    const n = (jobNumber || "").trim();
    if (!n) return false;
    const { data, error } = await sbClient.from("jobs").select("id").eq("job_number", n).maybeSingle();
    if (error) throw error;
    return !!data;
  },

  async getNextJobNumber() {
    const recent = await this.getMostRecentJob();
    if (!recent) return "J-1";
    const n = parseInt(String(recent.id || "").replace("J-", ""), 10);
    return "J-" + (isNaN(n) ? 1 : n + 1);
  },

  // The dispatch board. Only the plain first page — no filter, no search — is
  // kept for offline use: that is the "what am I on today" view, and caching
  // every filter/search permutation would be a lot of storage for questions
  // nobody asks with no signal. When the network is down, that one page is
  // served whatever was asked for, and `fromCache` tells Home to say so
  // rather than pretending the filter was applied.
  async searchJobs({ page = 0, pageSize = 10, status = "All", search = "", searchField = "any" } = {}) {
    const shape = data => {
      const rows = (data || []).map(j => ({
        dbId: j.id, id: j.job_number, project: j.project,
        client: j.client_name || "", clientId: j.client_id,
        contractor: j.contractor_name || "", contractorId: j.contractor_id,
        lsd: j.lsd, afe: j.afe, area: j.area, method: j.method, procedure: j.procedure,
        scope: "RT · scope TBD", status: j.status,
        createdBy: j.created_by_name || "", createdById: j.created_by,
        createdAt: stamp(j.created_at)
      }));
      return { rows, total: data && data.length ? Number(data[0].total_count) : 0 };
    };

    const isBoardDefault = page === 0 && status === "All" && !search;
    try {
      const { data, error } = await sbClient.rpc("search_jobs", {
        q: search, status_filter: status, search_field: searchField, page_num: page, page_size: pageSize
      });
      if (error) throw error;
      const result = shape(data);
      OfflineCache.markLive();
      if (isBoardDefault) {
        OfflineCache.put("jobs.recent", result);
        // Each job on its own key too, so opening one offline works even
        // though Job detail fetches it by id rather than off the list.
        result.rows.forEach(j => OfflineCache.put("job." + j.dbId, j));
        // And the contents of each — deliberately not awaited, so the board
        // paints on the first response rather than the fourth.
        this.prefetchJobDetails(result.rows.map(j => j.dbId));
      }
      return result;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      const hit = await OfflineCache.read("jobs.recent");
      if (!hit) throw e;
      OfflineCache.noteServingCached(hit.at);
      return { ...hit.value, fromCache: true, cachedAt: hit.at };
    }
  },

  // Everything Job detail draws, for every job on the board, fetched in three
  // queries rather than thirty. Without this, a job opens offline showing its
  // header and three empty cards — the JHAs, reports and tickets were only
  // ever cached for jobs somebody had already opened in range, which is not
  // knowable in advance from a truck.
  //
  // Best effort and non-blocking: it runs after the board has already
  // rendered, and a failure means the old behaviour, not a broken board.
  async prefetchJobDetails(jobIds) {
    const ids = (jobIds || []).filter(Boolean);
    if (!ids.length) return;
    if (Date.now() - _lastDetailPrefetch < DETAIL_PREFETCH_GAP_MS) return;
    _lastDetailPrefetch = Date.now();

    try {
      const [jhas, reports, tickets] = await Promise.all([
        sbClient.from("jhas").select(JHA_COLUMNS).in("job_id", ids).order("signed_at", { ascending: false }),
        sbClient.from("reports").select("*").in("job_id", ids).order("uploaded_at", { ascending: false }),
        sbClient.from("tickets").select(JOB_TICKET_COLUMNS).in("job_id", ids).order("created_at", { ascending: false })
      ]);
      if (jhas.error || reports.error || tickets.error) return;

      // Written per job, including the empty ones. An absent key and an empty
      // list mean different things offline: absent throws and logs "failed to
      // load", empty renders "None on file yet." — which is the truth.
      const spread = (prefix, rows, shape) => {
        const byJob = new Map(ids.map(id => [id, []]));
        (rows || []).forEach(row => {
          const bucket = byJob.get(row.job_id);
          if (bucket) bucket.push(shape(row));
        });
        byJob.forEach((value, id) => OfflineCache.put(prefix + id, value));
      };
      spread("jhas.", jhas.data, shapeJha);
      spread("reports.", reports.data, shapeReport);
      spread("tickets.", tickets.data, shapeJobTicket);
    } catch (e) {
      // Offline, or the request was refused — either way the board is already
      // on screen and nothing here is worth interrupting it for.
    }
  },

  async getJob(jobDbId) {
    return OfflineCache.readThrough("job." + jobDbId, async () => {
      const { data: j, error } = await sbClient
        .from("jobs")
        .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name), contractors(name), profiles!jobs_created_by_fkey(name)")
        .eq("id", jobDbId).single();
      if (error) throw error;
      return shapeJob(j);
    });
  },

  // Same, keyed by job number — the id the new-job dialog hands back, before
  // the caller knows the row's dbId.
  async getJobByNumber(jobNumber) {
    const { data: j, error } = await sbClient
      .from("jobs")
      .select("id, job_number, project, lsd, afe, area, method, procedure, status, created_at, client_id, contractor_id, created_by, clients(name), contractors(name), profiles!jobs_created_by_fkey(name)")
      .eq("job_number", jobNumber).single();
    if (error) throw error;
    return shapeJob(j);
  },

  // A completed job is closed to new work: no JHAs, reports, tickets or record
  // edits. Only an admin can close or reopen one (the button is admin-only, and
  // this is checked again here rather than trusted from the screen).
  async setJobComplete(jobDbId, complete) {
    const { data: auth } = await sbClient.auth.getUser();
    // A dead session used to surface as "cannot read property id of null",
    // which reads like an app bug rather than "you've been signed out".
    if (!auth || !auth.user) throw new Error("Your session has expired — sign in again.");
    const { data: me, error: pErr } = await sbClient.from("profiles")
      .select("role").eq("id", auth.user.id).single();
    if (pErr) throw pErr;
    if (me.role !== "Admin") throw new Error("Only an admin can complete or reopen a job.");
    const { error } = await sbClient.from("jobs")
      .update({ status: complete ? "Complete" : "Active" }).eq("id", jobDbId);
    if (error) throw error;
  },

  // Anything that adds to a job goes through here first. A job someone marked
  // complete has been reported on and invoiced — a ticket landing on it a week
  // later is the error this prevents.
  async assertJobOpen(jobDbId) {
    const { data, error } = await sbClient.from("jobs").select("status, job_number").eq("id", jobDbId).maybeSingle();
    if (error) throw error;
    // maybeSingle rather than single, so a job that hasn't synced yet says so.
    // It reads as PostgREST's "Cannot coerce the result to a single JSON
    // object" otherwise, which tells the person holding the phone nothing.
    if (!data) {
      throw new Error("This job hasn't reached the database yet — it's still waiting to sync. It'll go through once the job ahead of it does.");
    }
    if (data.status === "Complete") {
      throw new Error(`Job ${data.job_number} is marked complete — an admin has to reopen it before anything can be added.`);
    }
  },

  // Contractors are created inline when a job names a new one (see
  // createJob), but clients are deliberate: they carry an agreement and a
  // rate schedule, so adding one is its own act rather than a side effect.
  async createClient({ name, agreementRef, minimumCallout, effectiveFrom }) {
    const clean = (name || "").trim();
    if (!clean) throw new Error("Give the client a name.");

    // `%` and `_` are wildcards to ilike, so a client literally called
    // "Site_A" would match "SiteXA" and be wrongly rejected as a duplicate.
    const escaped = clean.replace(/[%_\\]/g, m => "\\" + m);
    const { data: existing } = await sbClient.from("clients").select("id").ilike("name", escaped).maybeSingle();
    if (existing) throw new Error(`“${clean}” is already on file.`);

    const { data, error } = await sbClient.from("clients").insert({
      name: clean,
      agreement_ref: (agreementRef || "").trim() || "No agreement on file",
      minimum_callout: (minimumCallout || "").trim() || null,
      effective_from: effectiveFrom || todayLocal()
    }).select().single();
    if (error) throw error;
    invalidate("clients");

    // Start them following the house card, literally: the schedule is born
    // with the follows_default flag on, so their tickets price at Default
    // rates until an admin flips the switch and gives them their own card.
    // Best effort: a missing schedule is not a reason to fail the client.
    try {
      await sbClient.from("rate_schedules").insert({ client_id: data.id, follows_default: true });
    } catch (e) {
      console.warn("Client created, but their rate schedule was not:", e.message);
    }
    return data;
  },

  // `id` is optional and normally left to Postgres. A job created offline
  // supplies its own (see queueNewJob) so that the id it was given in the
  // field is the id it keeps once it syncs.
  async createJob({ id, jobNumber, project, clientName, lsd, createdBy, clientRep, contractorName, contractorRep }) {
    // Replaying a queued job has to be safe to do twice. The insert can
    // succeed and a later step fail — filing the reps into the directory, say
    // — which leaves the item queued; without this, every retry from then on
    // dies on the job number's unique constraint and the job can never finish
    // syncing. Because the id was minted on the device, "did this already
    // land?" is a question we can actually answer.
    if (id) {
      const { data: already } = await sbClient.from("jobs").select("id").eq("id", id).maybeSingle();
      if (already) return already;
    }

    const { data: client, error: cErr } = await sbClient.from("clients").select("id").eq("name", clientName).single();
    if (cErr) throw cErr;

    let contractorId = null;
    if (contractorName) {
      const { data: existing } = await sbClient.from("contractors").select("id").eq("name", contractorName).maybeSingle();
      if (existing) contractorId = existing.id;
      else {
        const { data: created, error: crErr } = await sbClient.from("contractors").insert({ name: contractorName }).select("id").single();
        if (crErr) throw crErr;
        contractorId = created.id;
      }
    }

    const row = {
      job_number: jobNumber, project, client_id: client.id, contractor_id: contractorId,
      lsd, status: "Active", created_by: createdBy
    };
    if (id) row.id = id;
    const { data: job, error } = await sbClient.from("jobs").insert(row).select().single();
    // job_number is UNIQUE, so this is the guard that actually holds — the
    // check on the form is a courtesy that can lose a race with another
    // coordinator. Left raw it reads "duplicate key value violates unique
    // constraint jobs_job_number_key", which is not something to hand
    // somebody in a truck.
    if (error) {
      if (isDuplicateJobNumber(error)) throw new Error(jobNumberTakenMessage(jobNumber));
      throw error;
    }

    // Write contacts back to the directory — persisted server-side now,
    // not localStorage, so the next job for this client/contractor is
    // pre-filled for every coordinator, not just this browser.
    if (clientRep && clientRep.name) {
      await this.rememberContact("client", client.id, clientRep);
    }
    if (contractorId && contractorRep && contractorRep.name) {
      await this.rememberContact("contractor", contractorId, contractorRep);
    }
    return job;
  },

  // Starting a job on site, with no signal.
  //
  // The id is minted here rather than by Postgres, which is the whole trick:
  // a job created at 07:00 in a truck needs a real `job_id` immediately,
  // because the JHA filed against it ten minutes later and the ticket raised
  // at the end of the day both have to point at something. Letting the
  // database assign it at sync time would mean rewriting every queued item
  // that referenced the temporary one. A uuid minted on the device is already
  // unique and survives the trip unchanged.
  //
  // The job number is the one thing that can't be settled out here: it is
  // UNIQUE and nothing on this device knows what the office has issued. So it
  // is typed, not suggested, and a collision surfaces in the queue panel as a
  // refusal to sync rather than being silently resolved.
  async queueNewJob({ jobNumber, project, clientId, clientName, lsd, createdBy, createdByName, clientRep, contractorName, contractorRep }) {
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();

    const contractors = await this.listContractors().catch(() => []);
    const known = contractorName ? contractors.find(c => c.name === contractorName) : null;

    const job = {
      dbId: id, id: jobNumber, project,
      client: clientName || "", clientId: clientId || null,
      contractor: contractorName || "", contractorId: known ? known.id : null,
      lsd, afe: null, area: null, method: null, procedure: null,
      scope: "RT · scope TBD", status: "Active",
      createdBy: createdByName || "", createdAt: stamp(new Date().toISOString())
    };

    await OfflineQueue.enqueue("job", {
      id, jobNumber, project, clientName, lsd, createdBy,
      clientRep, contractorName, contractorRep
    });

    // Make it a real job as far as this device is concerned: on the board,
    // openable, and with empty history rather than absent history — an
    // absent key reads as "couldn't load", an empty one as "none on file yet".
    OfflineCache.put("job." + id, job);
    OfflineCache.put("jhas." + id, []);
    OfflineCache.put("reports." + id, []);
    OfflineCache.put("tickets." + id, []);
    const board = await OfflineCache.read("jobs.recent").catch(() => null);
    const rows = board && board.value && board.value.rows ? board.value.rows : [];
    OfflineCache.put("jobs.recent", {
      rows: [job, ...rows.filter(r => r.dbId !== id)],
      total: (board && board.value ? board.value.total : 0) + 1
    });

    return job;
  },

  // Files the rep a job was created with into the directory. This was a single
  // upsert onto a unique (org_type, org_id) — which meant every new job
  // overwrote the organisation's one contact. Now it matches on the person
  // (name, case-insensitive) and adds them alongside the others.
  async rememberContact(orgType, orgId, rep) {
    const name = (rep.name || "").trim();
    if (!name) return;
    const existing = await this.listContactsForOrg(orgType, orgId);
    const match = existing.find(c => (c.name || "").trim().toLowerCase() === name.toLowerCase());
    const stampNow = new Date().toISOString();
    if (match) {
      // Only fill blanks — a rep typed in a hurry on the job form shouldn't
      // wipe a phone number someone curated in the directory.
      const patch = { last_used_at: stampNow };
      if (!match.email && rep.email) patch.email = rep.email.trim();
      if (!match.phone && rep.phone) patch.phone = rep.phone.trim();
      await sbClient.from("contacts").update(patch).eq("id", match.id);
      return;
    }
    await sbClient.from("contacts").insert({
      org_type: orgType, org_id: orgId, name,
      email: (rep.email || "").trim() || null,
      phone: (rep.phone || "").trim() || null,
      is_primary: !existing.some(c => c.is_primary),
      last_used_at: stampNow
    });
  },

  // ── JHAs ─────────────────────────────────────────────────────────────
  async listJhasForJob(jobDbId) {
    return OfflineCache.readThrough("jhas." + jobDbId, async () => {
    // `hazards` comes back too: Job detail shows what the last filed JHA
    // actually covered, rather than a fixed sample list.
    const { data, error } = await sbClient
      .from("jhas").select(JHA_COLUMNS)
      .eq("job_id", jobDbId).order("signed_at", { ascending: false });
    if (error) throw error;
    return data.map(shapeJha);
    });
  },

  // How this person last rated each hazard, so the JHA builder can start from
  // their own judgement instead of blank.
  //
  // No new table for this: every filed assessment already stores its ratings
  // inside `jhas.hazards`, so "what did I put last time" is a question the
  // existing records can answer. A separate preferences table would be a
  // second copy of the same fact, free to drift from what was actually filed.
  //
  // Merged field by field, newest first. Severity, probability and frequency
  // are set independently and often partially — someone who only changed the
  // severity last time should still get their usual probability back, not a
  // blank next to it.
  async lastHazardRatings(profileId) {
    if (!profileId) return {};
    return OfflineCache.readThrough("hazardratings." + profileId, async () => {
      const { data, error } = await sbClient
        .from("jhas").select("hazards, signed_at")
        .eq("signed_by", profileId)
        .order("signed_at", { ascending: false })
        .limit(25);
      if (error) throw error;

      const remembered = {};
      for (const row of data || []) {
        const list = Array.isArray(row.hazards) ? row.hazards : [];
        for (const h of list) {
          if (!h || !h.name || !h.rating) continue;
          const seen = remembered[h.name] || (remembered[h.name] = {});
          for (const key of ["s", "p", "f"]) {
            if (seen[key] === undefined && h.rating[key]) seen[key] = h.rating[key];
          }
        }
      }
      // Drop any hazard that ended up with nothing on it.
      Object.keys(remembered).forEach(name => {
        if (!Object.keys(remembered[name]).length) delete remembered[name];
      });
      return remembered;
    });
  },

  // Is there an assessment still waiting on its end readings? The ticket
  // screens ask this to remind rather than to block — a JHA left open is a
  // paperwork problem, not a reason to stop someone billing the day.
  async openJhaForJob(jobDbId) {
    const { data, error } = await sbClient
      .from("jhas").select("id, signed_at").eq("job_id", jobDbId).eq("status", "Open")
      .order("signed_at", { ascending: false }).limit(1);
    if (error) return null;   // pre-migration databases have no status column
    return data && data.length ? data[0] : null;
  },

  // Has a JHA been filed for this job today? Asked when a ticket is raised.
  async jhaFiledToday(jobDbId) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const { data, error } = await sbClient
      .from("jhas").select("id").eq("job_id", jobDbId).gte("signed_at", start.toISOString()).limit(1);
    if (error) return true;    // never nag on the strength of a failed query
    return !!(data && data.length);
  },

  // Closing out: the end readings, and with them the dose. Start is always 0,
  // so the end reading IS the dose for the assessment — computed here rather
  // than trusted from the screen, so both places can't disagree.
  async closeOutJha({ jhaId, dosimetry, closedBy }) {
    const rows = (dosimetry || []).map(d => {
      const raw = d.endReading === "" || d.endReading == null ? null : Number(String(d.endReading).replace(",", "."));
      // Dose is carried to one decimal place — that's the precision the DRDs
      // are read to, so 2.11 files as 2.1 rather than implying more.
      const dose = raw == null || isNaN(raw) ? null : Math.round(raw * 10) / 10;
      return { ...d, startReading: 0, endReading: dose, doseMr: dose };
    });
    const { data: updated, error } = await sbClient.from("jhas").update({
      dosimetry: rows, status: "Closed", closed_at: new Date().toISOString(), closed_by: closedBy
    }).eq("id", jhaId).select("id");
    if (error) throw error;
    // An update that no row-level security policy allows is not an error: it
    // reports success having changed nothing. Without this check the dialog
    // closed cleanly and the assessment stayed Open, with nothing to explain
    // why — so ask for the row back and treat silence as the failure it is.
    if (!updated || !updated.length) {
      throw new Error("That assessment wasn't updated — your account doesn't have permission to close out a JHA. Run the JHA close-out policy in Supabase (migration 20260812040000).");
    }
    // The stored PDF now has end readings on it — redraw it. Awaited here,
    // unlike on filing: close-out is the version anyone files or sends on.
    try { await this.renderJhaPdf(jhaId); }
    catch (e) { console.warn("Closed out, but the PDF didn't re-render:", e.message); }
    return rows;
  },

  // No real PDF is rendered client-side yet (see README) — this stores the
  // hazard selection, signatures and a placeholder filename, which is
  // enough for "Signed JHAs on file" to be real data instead of a mock array.
  async createJha({ jobDbId, template, hazards, signedBy, siteRep, pdfKey, dosimetry, unitNumber, details, workDate }) {
    await this.assertJobOpen(jobDbId);
    const { data, error } = await sbClient.from("jhas").insert({
      job_id: jobDbId, template, hazards, signed_by: signedBy, site_rep: siteRep,
      // signed_at is when this was written down and is never editable;
      // work_date is the day it covers and is.
      signed_at: new Date().toISOString(), work_date: workDate || null, pdf_key: pdfKey,
      dosimetry: dosimetry || [], unit_number: unitNumber || null,
      details: details || {}, status: "Open"
    }).select().single();
    if (error) throw error;
    // Render the PDF, best effort: a failed render must not lose an assessment
    // that has already been filed. A re-render happens at close-out anyway.
    this.renderJhaPdf(data.id).catch(e => console.warn("JHA filed, but the PDF didn't render:", e.message));
    return data;
  },

  // Draws the FLHA as a PDF in the render-jha Edge Function and files it in
  // the private `jhas` bucket. Called on filing and again on close-out, so the
  // stored document always matches the row.
  async renderJhaPdf(jhaId) {
    const { data, error } = await sbClient.functions.invoke("render-jha", { body: { jhaId } });
    if (error) throw new Error(await readFnError(error));
    return data;
  },

  // Emails the assessment's PDF. Unlike a report — which is stored first and
  // emailed second, so it can sit as Pending and be resent — a JHA already
  // exists by the time anyone sends it, so this is only the send. The
  // function stamps sent_at/sent_to on success.
  async sendJhaEmail({ jhaId, to, cc, message }) {
    const { data, error } = await sbClient.functions.invoke("send-jha", {
      body: { jhaId, to, cc, message }
    });
    if (error) throw new Error(await readFnError(error));
    if (data && data.error) throw new Error(data.error);
    return data;
  },

  // Removes an assessment and its stored PDF. Admin or Technician — the RLS
  // policy is the enforcement; this reports the refusal rather than letting
  // a delete that touched nothing pass as success.
  async deleteJha(jhaId) {
    const { data: rows, error: readErr } = await sbClient
      .from("jhas").select("pdf_key").eq("id", jhaId);
    if (readErr) throw readErr;
    // Already gone — deleted from another device, or a double-tap. The goal
    // state is reached; without this, the zero-row delete below would blame
    // the person's permissions for a row that simply no longer exists.
    if (!rows || !rows.length) return;
    const pdfKey = rows[0].pdf_key;

    const { data: gone, error } = await sbClient
      .from("jhas").delete().eq("id", jhaId).select("id");
    if (error) throw error;
    // A delete no policy allows is not an error: it reports success having
    // removed nothing. Ask for the rows back and treat silence as a refusal.
    if (!gone || !gone.length) {
      throw new Error("That assessment wasn't deleted — deleting a hazard assessment takes an Admin or Technician account.");
    }
    // The PDF goes with the row, best effort: an orphaned object in a private
    // bucket is untidy, not wrong, and must not resurrect the delete's error
    // state after the record is already gone.
    if (pdfKey) {
      try { await sbClient.storage.from("jhas").remove([pdfKey]); }
      catch (e) { console.warn("JHA deleted, but its PDF wasn't removed:", e.message); }
    }
  },

  // ── Equipment ────────────────────────────────────────────────────────
  // Equipment tracking — exposure devices, survey meters, dosimeters, tools.
  // Read is open to anyone with the tab; write is re-checked at the database
  // (see the equipment write policy) since Admin/Coordinator-only is a real
  // permission boundary, not just a hidden button.
  async listEquipment() {
    return OfflineCache.readThrough("equipment.all", async () => {
    const { data, error } = await sbClient
      .from("equipment").select("*, profiles(name)").order("type").order("serial_number");
    if (error) throw error;
    return data.map(e => ({
      id: e.id, type: e.type, serial: e.serial_number,
      calibrationDue: e.calibration_due, assignedTo: e.assigned_to,
      assignedName: e.profiles ? e.profiles.name : "", status: e.status
    }));
    });
  },

  async getEquipmentStats() {
    const { data, error } = await sbClient.rpc("equipment_stats");
    if (error) throw error;
    const r = (data && data[0]) || {};
    return { overdue: Number(r.overdue_count || 0), dueSoon: Number(r.due_soon_count || 0) };
  },

  async searchEquipment({ page = 0, pageSize = 10, filter = "All" } = {}) {
    const { data, error } = await sbClient.rpc("search_equipment", { filter_key: filter, page_num: page, page_size: pageSize });
    if (error) throw error;
    const rows = (data || []).map(e => ({
      id: e.id, type: e.type, serial: e.serial_number,
      calibrationDue: e.calibration_due, assignedTo: e.assigned_to,
      assignedName: e.assigned_name || "", status: e.status
    }));
    const total = data && data.length ? Number(data[0].total_count) : 0;
    return { rows, total };
  },

  async createEquipment({ type, serial, calibrationDue, assignedTo, status }) {
    const { error } = await sbClient.from("equipment").insert({
      type, serial_number: (serial || "").trim() || null,
      calibration_due: calibrationDue || null, assigned_to: assignedTo || null,
      status: status || "In service"
    });
    if (error) throw error;
  },

  async updateEquipment(id, { type, serial, calibrationDue, assignedTo, status }) {
    const { error } = await sbClient.from("equipment").update({
      type, serial_number: (serial || "").trim() || null,
      calibration_due: calibrationDue || null, assigned_to: assignedTo || null, status
    }).eq("id", id);
    if (error) throw error;
  },

  async deleteEquipment(id) {
    const { error } = await sbClient.from("equipment").delete().eq("id", id);
    if (error) throw error;
  },

  // ── Reports ──────────────────────────────────────────────────────────
  async listReportsForJob(jobDbId) {
    return OfflineCache.readThrough("reports." + jobDbId, async () => {
    const { data, error } = await sbClient
      .from("reports").select("*").eq("job_id", jobDbId).order("uploaded_at", { ascending: false });
    if (error) throw error;
    return data.map(shapeReport);
    });
  },

  // Uploads the actual PDF to the private `reports` bucket, then records
  // the row. Falls back to storing metadata only if the browser gave us no
  // File (the mobile screen's demo rows, or a same-name collision).
  async uploadReport({ jobDbId, jobNumber, file, welds, result, interpretedBy, send, sendTo }) {
    await this.assertJobOpen(jobDbId);
    let pdfKey = null;
    if (file) {
      // The key is sanitised, the display name is not: storage refuses
      // non-ASCII keys and mangles # ? % — a phone-named "Réport 📷.pdf"
      // failed outright in beta testing. The reports row below keeps the
      // original name for every screen that shows it.
      const path = `${storageKeySafe(jobNumber, "job")}/${Date.now()}-${storageKeySafe(file.name, "report.pdf")}`;
      const { error: upErr } = await sbClient.storage.from("reports").upload(path, file);
      if (upErr) {
        if (/row-level security/i.test(upErr.message || "")) {
          throw new Error("Your account doesn't have the Report upload or Job detail tab, so the file can't be stored — an admin can grant access in Users & access.");
        }
        throw upErr;
      }
      pdfKey = path;
    }
    const { data, error } = await sbClient.from("reports").insert({
      job_id: jobDbId, filename: file ? file.name : "report.pdf", pdf_key: pdfKey,
      welds, result, interpreted_by: interpretedBy,
      sent_at: send ? new Date().toISOString() : null, sent_to: send ? sendTo : null
    }).select().single();
    if (error) throw error;
    return data;
  },

  // Both buckets are private: a stored object has no public URL, so viewing a
  // PDF means minting a signed one at click time. 10 minutes is plenty to open
  // it and short enough that a copied link dies quickly.
  async signedUrl(bucket, pdfKey) {
    if (!pdfKey) return null;
    const { data, error } = await sbClient.storage.from(bucket).createSignedUrl(pdfKey, 60 * 10);
    if (error) throw error;
    return data.signedUrl;
  },

  // ── Email (Postmark, via Supabase Edge Functions) ────────────────────
  // The Postmark token lives as a Supabase secret and is only ever read
  // server-side — hence going through a function rather than calling the
  // Postmark API from the browser.

  // Removes a report and its stored PDF. The same shape as deleteJha, for the
  // same reasons: RLS is the enforcement (Admin or Technician), a delete that
  // touched no rows is reported as the refusal it is, and the storage object
  // goes second, best effort, so a failed cleanup can't resurrect an error
  // after the record is already gone.
  async deleteReport(reportId) {
    const { data: rows, error: readErr } = await sbClient
      .from("reports").select("pdf_key").eq("id", reportId);
    if (readErr) throw readErr;
    // Already gone — same idempotence as deleteJha, for the same reason.
    if (!rows || !rows.length) return;
    const pdfKey = rows[0].pdf_key;

    const { data: gone, error } = await sbClient
      .from("reports").delete().eq("id", reportId).select("id");
    if (error) throw error;
    if (!gone || !gone.length) {
      throw new Error("That report wasn't deleted — deleting a report takes an Admin or Technician account.");
    }
    if (pdfKey) {
      try { await sbClient.storage.from("reports").remove([pdfKey]); }
      catch (e) { console.warn("Report deleted, but its PDF wasn't removed:", e.message); }
    }
  },

  async sendReportEmail({ reportId, to, cc, message }) {
    const { data, error } = await sbClient.functions.invoke("send-report", {
      body: { reportId, to, cc, message }
    });
    if (error) throw new Error(await readFnError(error));
    if (data && data.error) throw new Error(data.error);
    return data;
  },

  // The field invoice for a ticket, as HTML, rendered by the same code that
  // renders the client's copy. The office view and the client's copy are then
  // one document rather than two descriptions of one.
  //
  // Comes back as a string in JSON rather than as an HTML response on purpose:
  // Supabase rewrites HTML served from the functions domain to text/plain, and
  // the app drops this into an iframe anyway.
  async renderTicketInvoice(ticketId) {
    const { data, error } = await sbClient.functions.invoke("render-invoice", { body: { ticketId } });
    if (error) throw new Error(await readFnError(error));
    if (data && data.error) throw new Error(data.error);
    return data.html;
  },

  async sendTicketApproval({ ticketId, to, cc }) {
    const { data, error } = await sbClient.functions.invoke("send-ticket-approval", {
      body: { ticketId, to, cc }
    });
    if (error) throw new Error(await readFnError(error));
    if (data && data.error) throw new Error(data.error);
    return data;
  },

  // Pulls a sent ticket back before the client signs it. Not a delete: the
  // day's lines and crew hours stay put, the ticket goes back to Draft to be
  // fixed and resent, and the client's signing link dies with the token —
  // approve-ticket looks the row up by that token, so a cleared token is a
  // dead link, not a link to a draft.
  //
  // The status filter on the update is the race with the client: if they
  // signed a moment ago, zero rows change here (RLS refuses too, on
  // approved_at) and the refusal says what probably happened. Approved and
  // invoiced tickets are the client's document — same line deleteTicket
  // draws.
  async withdrawTicketApproval(ticketId) {
    const { data: updated, error } = await sbClient.from("tickets").update({
      status: "Draft", approval_token: null, approval_sent_at: null, approval_expires_at: null
    }).eq("id", ticketId).eq("status", "Awaiting approval").select("id");
    if (error) throw error;
    if (!updated || !updated.length) {
      throw new Error("That approval wasn't cancelled — the client may have just approved it, or the ticket isn't yours. Reload the job to see where it stands.");
    }
  },

  // The Job record panel. Assembled from the job row plus the two directory
  // contacts, rather than kept as its own table — otherwise "Contractor" here
  // and the contractor column on the dispatch board are two different facts
  // that quietly disagree.
  async getJobRecord(job) {
    const contacts = await this.listContacts();

    // Which people this particular job names. `jobs.client_contact_id` and
    // `contractor_contact_id` have been in the schema since the beginning and
    // were never used — the record just showed whoever happened to be the
    // organisation's primary, so every job for a client showed the same rep
    // and editing it did nothing. A job that hasn't named anyone still falls
    // back to the primary, which is what it always did.
    let named = {};
    try {
      const { data } = await sbClient.from("jobs")
        .select("client_contact_id, contractor_contact_id").eq("id", job.dbId).maybeSingle();
      if (data) named = data;
    } catch (e) { /* offline — the primaries below are a fine stand-in */ }

    const byId = id => (id && contacts.find(c => c.id === id)) || null;
    const clientContact = byId(named.client_contact_id) || primaryContact(contacts, "client", job.clientId);
    const contractorContact = byId(named.contractor_contact_id) || primaryContact(contacts, "contractor", job.contractorId);

    const fmt = c => c ? [c.name, c.phone, c.email].filter(Boolean).join(" · ") : "";
    // The joined string is what the ticket email and the JHA read; the parts
    // are what the edit form needs so nobody has to type a "·".
    const parts = c => ({
      id: c ? c.id : "", name: c ? c.name : "",
      email: c ? (c.email || "") : "", phone: c ? (c.phone || "") : ""
    });

    return {
      job: job.id,
      client: job.client,
      clientRep: fmt(clientContact),
      clientRepDetail: parts(clientContact),
      contractor: job.contractor || "",
      contractorRep: fmt(contractorContact),
      contractorRepDetail: parts(contractorContact),
      afe: job.afe || "",
      area: job.area || "",
      lsd: job.lsd || "",
      method: job.method || "",
      procedure: job.procedure || "",
      started: job.createdAt || ""
    };
  },

  // Turns whatever the job record's rep boxes contain into a contact row, and
  // returns its id. Picking someone from the dropdown and editing their phone
  // number updates the directory entry; typing a name nobody has on file adds
  // them. Returns null for an empty name, which unlinks the rep.
  async resolveJobContact(orgType, orgId, rep) {
    if (!orgId || !rep) return null;
    const name = (rep.name || "").trim();
    if (!name) return null;
    const email = (rep.email || "").trim() || null;
    const phone = (rep.phone || "").trim() || null;

    const existing = await this.listContactsForOrg(orgType, orgId);
    const match = (rep.id && existing.find(c => c.id === rep.id))
      || existing.find(c => (c.name || "").trim().toLowerCase() === name.toLowerCase());

    if (match) {
      // Only write if something actually changed — an unedited pick shouldn't
      // touch the directory at all.
      if (match.name !== name || (match.email || null) !== email || (match.phone || null) !== phone) {
        const { error } = await sbClient.from("contacts")
          .update({ name, email, phone, last_used_at: new Date().toISOString() }).eq("id", match.id);
        if (error) throw error;
        invalidate("contacts");
      }
      return match.id;
    }

    const { data, error } = await sbClient.from("contacts").insert({
      org_type: orgType, org_id: orgId, name, email, phone,
      is_primary: !existing.some(c => c.is_primary),
      last_used_at: new Date().toISOString()
    }).select("id").single();
    if (error) throw error;
    invalidate("contacts");
    return data.id;
  },

  // Writes the editable fields back to the job. Contractor is matched by name
  // and created if it's new — same behaviour as the New job dialog, so typing
  // a contractor here doesn't silently do nothing.
  async updateJobRecord(job, record) {
    await this.assertJobOpen(job.dbId);
    let contractorId = job.contractorId ?? null;
    const name = (record.contractor || "").trim();
    if (name && name !== (job.contractor || "")) {
      const { data: existing } = await sbClient.from("contractors").select("id").eq("name", name).maybeSingle();
      if (existing) contractorId = existing.id;
      else {
        const { data: created, error } = await sbClient.from("contractors").insert({ name }).select("id").single();
        if (error) throw error;
        contractorId = created.id;
      }
    } else if (!name) {
      contractorId = null;
    }

    // The reps, which this used to drop on the floor: the boxes were editable
    // and nothing was ever written, so a corrected phone number vanished on
    // the next load.
    const clientContactId = await this.resolveJobContact("client", job.clientId, record.clientRepDetail);
    const contractorContactId = contractorId
      ? await this.resolveJobContact("contractor", contractorId, record.contractorRepDetail)
      : null;

    const { error } = await sbClient.from("jobs").update({
      contractor_id: contractorId,
      client_contact_id: clientContactId,
      contractor_contact_id: contractorContactId,
      afe: record.afe || null,
      area: record.area || null,
      lsd: record.lsd || null,
      method: record.method || null,
      procedure: record.procedure || null
    }).eq("id", job.dbId);
    if (error) throw error;
    return contractorId;
  },

  // ── Shared files ─────────────────────────────────────────────────────
  // Backed by a `shared` storage bucket. There is no folders table: Supabase
  // Storage keys are paths, so "Procedures/MND-RT-04.pdf" IS a folder — which
  // means no directory tree to keep in sync with the objects in it.
  //
  // One wrinkle: an empty prefix doesn't exist to the API. Creating a folder
  // writes a zero-byte `.keep` marker inside it, and listings hide that file.

  // Storage caps a listing at 1000 rows and defaults to 100, so a folder that
  // outgrows the page size would silently show only part of itself. Page until
  // a short batch comes back.
  async listAllEntries(prefix) {
    const PAGE = 500;
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await sbClient.storage
        .from("shared")
        .list(prefix, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE) return out;
    }
  },

  async listFiles(prefix = "") {
    const data = await this.listAllEntries(prefix);

    const folders = [];
    const files = [];
    for (const entry of data) {
      if (entry.name === FOLDER_MARKER) continue;
      // Storage reports a prefix as a row with no id/metadata.
      if (!entry.id) folders.push({ name: entry.name, path: prefix ? `${prefix}/${entry.name}` : entry.name });
      else files.push({
        name: entry.name,
        path: prefix ? `${prefix}/${entry.name}` : entry.name,
        size: entry.metadata ? entry.metadata.size : 0,
        type: entry.metadata ? entry.metadata.mimetype : "",
        at: entry.updated_at || entry.created_at
      });
    }
    return { folders, files };
  },

  async createFolder(prefix, name) {
    // Folder names live inside storage keys, which refuse what filenames
    // allow — same sanitiser as report uploads, same reason.
    const clean = storageKeySafe(name.trim(), "");
    if (!clean) throw new Error("Give the folder a name — letters and numbers, mostly.");
    const path = (prefix ? `${prefix}/` : "") + clean + "/" + FOLDER_MARKER;
    const { error } = await sbClient.storage
      .from("shared").upload(path, new Blob([""]), { upsert: true });
    if (error) throw error;
    return clean;
  },

  async uploadSharedFile(prefix, file) {
    const path = (prefix ? `${prefix}/` : "") + storageKeySafe(file.name, "file");
    const { error } = await sbClient.storage
      .from("shared").upload(path, file, { upsert: false });
    if (error) {
      if (/exists/i.test(error.message)) throw new Error(`“${file.name}” is already in this folder.`);
      throw error;
    }
    return path;
  },

  async deleteSharedFile(path) {
    const { error } = await sbClient.storage.from("shared").remove([path]);
    if (error) throw error;
  },

  // Removing a folder means removing everything under it — Storage has no
  // recursive delete, so walk the tree and remove the objects.
  async deleteFolder(path) {
    const keys = [];
    // Sibling subfolders are independent — walking them one at a time made a
    // deeply-nested shared drive a slow serial crawl. Each folder's own
    // entries still resolve before recursing into its children.
    const walk = async prefix => {
      const entries = await this.listAllEntries(prefix);
      const subfolders = [];
      for (const entry of entries) {
        const child = `${prefix}/${entry.name}`;
        if (!entry.id) subfolders.push(child);
        else keys.push(child);
      }
      await Promise.all(subfolders.map(walk));
    };
    await walk(path);
    // `remove` takes a bounded list, so delete in batches rather than handing
    // it a folder's worth of keys in one call.
    for (let i = 0; i < keys.length; i += 100) {
      const { error } = await sbClient.storage.from("shared").remove(keys.slice(i, i + 100));
      if (error) throw error;
    }
  },

  sharedFileUrl(path) { return this.signedUrl("shared", path); },

  // ── Crew & timesheets ────────────────────────────────────────────────
  // A ticket bills the client one hours figure; the crew rows say how those
  // hours land on each person's timesheet. The two can legitimately differ
  // (a 2-person crew billed as crew-hours), so the ticket screen shows both
  // and never silently forces them to agree.

  async listCrewForTicket(ticketId) {
    const { data, error } = await sbClient
      .from("ticket_crew")
      .select("id, profile_id, crew_role, straight_hours, ot_hours, solo_hours, solo_ot_hours, dose_mr, mileage_km, profiles(name, first_name, last_name, is_subcontractor, level, id_code)")
      .eq("ticket_id", ticketId);
    if (error) throw error;
    return data.map(c => ({
      id: c.id, profileId: c.profile_id, role: c.crew_role,
      straight: Number(c.straight_hours), ot: Number(c.ot_hours),
      solo: Number(c.solo_hours), soloOt: Number(c.solo_ot_hours),
      dose: Number(c.dose_mr), mileage: Number(c.mileage_km),
      name: c.profiles ? fullName(c.profiles) : "",
      // The client's field invoice names each person's level and number
      // beside their hours. Both are set in Users & access: "Level" is the
      // cert grade printed in the LEVEL column, "CGSB# / NRCAN#" the number.
      level: c.profiles ? (c.profiles.level || "") : "",
      certNo: c.profiles ? (c.profiles.id_code || "") : "",
      isSub: c.profiles ? c.profiles.is_subcontractor : false
    }));
  },

  async saveCrewForTicket(ticketId, crew) {
    // Replace rather than diff: a ticket's crew is small and edited as a
    // whole, and this keeps removals from needing their own bookkeeping.
    const { error: dErr } = await sbClient.from("ticket_crew").delete().eq("ticket_id", ticketId);
    if (dErr) throw dErr;
    if (!crew.length) return;
    const { error } = await sbClient.from("ticket_crew").insert(
      crew.map(c => ({
        ticket_id: ticketId, profile_id: c.profileId, crew_role: c.role || "Technician",
        // Hours and mileage bill exactly like a quantity does, and dose is a
        // physical reading — none of them go below zero.
        straight_hours: nonNegative(c.straight), ot_hours: nonNegative(c.ot),
        solo_hours: nonNegative(c.solo), solo_ot_hours: nonNegative(c.soloOt),
        dose_mr: nonNegative(c.dose), mileage_km: nonNegative(c.mileage)
      }))
    );
    if (error) throw error;
  },

  // Every crew entry in a pay period, with the ticket and job behind it —
  // this is the whole timesheet screen in one query.
  async listTimesheetEntries({ start, end }) {
    // Paged to exhaustion rather than fetched in one go: this is what people
    // get paid from, and the 1000-row response cap would silently take hours
    // off the end of a busy period. Ordered by id so the ranges can't overlap
    // or skip a row between requests.
    //
    // Asking for the count is what lets the rest of the pages be fetched
    // concurrently — the first response says how many there are, so the others
    // go out together instead of one round trip per thousand rows.
    //
    // Only page 0 asks for it. An exact count has to be counted through the
    // join, and every later page would be paying for a number already known.
    const SELECT = "id, profile_id, crew_role, straight_hours, ot_hours, solo_hours, solo_ot_hours, dose_mr, mileage_km, profiles(name, first_name, last_name, is_subcontractor), tickets!inner(id, work_date, status, jobs(job_number, project, clients(name)))";
    const data = await fetchAllPages(async page => {
      const from = page * RESPONSE_ROW_CAP;
      const { data: batch, count, error } = await sbClient
        .from("ticket_crew")
        .select(SELECT, page === 0 ? { count: "exact" } : undefined)
        .gte("tickets.work_date", start)
        .lte("tickets.work_date", end)
        .order("id")
        .range(from, from + RESPONSE_ROW_CAP - 1);
      if (error) throw error;
      return { rows: batch || [], total: count == null ? (batch || []).length : count };
    });

    return data.map(c => {
      const t = c.tickets || {};
      const j = t.jobs || {};
      return {
        id: c.id,
        profileId: c.profile_id,
        name: c.profiles ? fullName(c.profiles) : "",
        isSub: c.profiles ? c.profiles.is_subcontractor : false,
        role: c.crew_role,
        date: t.work_date,
        ticketId: t.id,
        ticketStatus: t.status,
        job: j.job_number || "",
        project: j.project || "",
        client: j.clients ? j.clients.name : "",
        straight: Number(c.straight_hours),
        ot: Number(c.ot_hours),
        solo: Number(c.solo_hours),
        soloOt: Number(c.solo_ot_hours),
        dose: Number(c.dose_mr),
        mileage: Number(c.mileage_km)
      };
    }).sort((a, b) =>
      String(a.date || "").localeCompare(String(b.date || "")) ||
      String(a.ticketId || "").localeCompare(String(b.ticketId || "")));
  },

  async listApprovals({ start }) {
    const { data, error } = await sbClient
      .from("timesheet_approvals")
      .select("profile_id, approved_at, approved_by, pdf_key, profiles!timesheet_approvals_approved_by_fkey(name)")
      .eq("period_start", start);
    if (error) throw error;
    return data;
  },

  // The PDF is what approval means: the figures the admin saw, frozen.
  // The file goes up before the row is written, so an approval can never
  // point at a document that is not there — if the upload fails, the
  // period simply stays unapproved and the admin tries again. One file
  // per person per period at a deterministic path; re-approving a
  // reopened period overwrites it rather than minting a sibling.
  async approveTimesheet({ profileId, start, end, approvedBy, pdfBytes }) {
    let pdfKey = null;
    if (pdfBytes) {
      pdfKey = `${profileId}/${start}.pdf`;
      const { error: upErr } = await sbClient.storage.from("timesheets")
        .upload(pdfKey, new Blob([pdfBytes], { type: "application/pdf" }),
          { upsert: true, contentType: "application/pdf" });
      if (upErr) throw upErr;
    }
    const { error } = await sbClient.from("timesheet_approvals").upsert({
      profile_id: profileId, period_start: start, period_end: end,
      approved_at: new Date().toISOString(), approved_by: approvedBy, pdf_key: pdfKey
    }, { onConflict: "profile_id,period_start" });
    if (error) throw error;
  },

  async unapproveTimesheet({ profileId, start }) {
    const { error } = await sbClient.from("timesheet_approvals")
      .delete().eq("profile_id", profileId).eq("period_start", start);
    if (error) throw error;
    // Best effort: the approval is gone either way, and the path is
    // deterministic, so any orphan is overwritten by the next approve.
    await sbClient.storage.from("timesheets").remove([`${profileId}/${start}.pdf`]).catch(() => {});
  },

  // The "Approved timesheets" tab: every period of yours that has been
  // signed off, newest first. RLS on the storage bucket means the View
  // button only works on your own folder (or all of them for an admin),
  // but the listing itself comes from the approvals table.
  async listMyApprovedTimesheets(profileId) {
    const { data, error } = await sbClient
      .from("timesheet_approvals")
      .select("period_start, period_end, approved_at, pdf_key, profiles!timesheet_approvals_approved_by_fkey(name)")
      .eq("profile_id", profileId)
      .order("period_start", { ascending: false });
    if (error) throw error;
    return (data || []).map(r => ({
      start: r.period_start, end: r.period_end, at: r.approved_at,
      pdfKey: r.pdf_key, by: r.profiles ? r.profiles.name : "—"
    }));
  },

  // ── Tickets ──────────────────────────────────────────────────────────
  async listTicketsForJob(jobDbId) {
    return OfflineCache.readThrough("tickets." + jobDbId, async () => {
    const { data, error } = await sbClient
      .from("tickets").select(JOB_TICKET_COLUMNS)
      .eq("job_id", jobDbId).order("created_at", { ascending: false });
    if (error) throw error;
    return data.map(shapeJobTicket);
    });
  },

  async getTicketTrackerStats() {
    const { data, error } = await sbClient.rpc("ticket_tracker_stats");
    if (error) throw error;
    const r = (data && data[0]) || {};
    return {
      unsigned: { count: Number(r.unsigned_count || 0), total: Number(r.unsigned_total || 0) },
      over7: { count: Number(r.over7_count || 0), total: Number(r.over7_total || 0) },
      approved: { count: Number(r.approved_count || 0), total: Number(r.approved_total || 0) },
      invoiced: { count: Number(r.invoiced_count || 0), total: Number(r.invoiced_total || 0) }
    };
  },

  async searchTickets({ page = 0, pageSize = 10, status = "All" } = {}) {
    const { data, error } = await sbClient.rpc("search_tickets", { status_filter: status, page_num: page, page_size: pageSize });
    if (error) throw error;
    const rows = (data || []).map(t => ({
      id: t.id, date: dayMonth(localDate(t.work_date)),
      age: ageInDays(t.created_at),
      amount: Number(t.total), status: t.status, tech: t.technician_name || "",
      job: t.job_number || "", project: t.project || "", client: t.client_name || ""
    }));
    const total = data && data.length ? Number(data[0].total_count) : 0;
    return { rows, total };
  },

  // Every ticket matching a filter, for the accounting export — paged, because
  // "give me all of them" is exactly the request the 1000-row cap silently
  // truncates, and a short CSV of financial records is worse than none.
  async listTicketsForExport(status = "All") {
    return fetchAllPages(page => this.searchTickets({ page, pageSize: RESPONSE_ROW_CAP, status }));
  },

  // Every unsigned ticket's client contact, for the tracker's bulk chase —
  // a small, purpose-built fetch rather than paging through search_tickets
  // to reassemble the same thing.
  async listUnsignedTicketContacts() {
    const { data, error } = await sbClient
      .from("tickets").select("id, client_contact")
      .eq("status", "Awaiting approval");
    if (error) throw error;
    return data.map(t => ({ id: t.id, contactLabel: t.client_contact ? t.client_contact.name : "" }));
  },

  async listMyTickets(technicianId) {
    const { data, error } = await sbClient
      .from("tickets")
      .select("id, work_date, status, total, created_at, jobs(job_number, project, clients(name))")
      .eq("technician_id", technicianId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data.map(t => ({
      id: t.id, date: dayMonth(localDate(t.work_date)),
      age: ageInDays(t.created_at),
      amount: Number(t.total), status: t.status,
      job: t.jobs ? t.jobs.job_number : "", project: t.jobs ? t.jobs.project : "",
      client: t.jobs && t.jobs.clients ? t.jobs.clients.name : ""
    }));
  },

  // The next ticket number for these initials on this date, counted in the
  // database (see the next_ticket_number migration). Used both to show the
  // number on screen before anything is saved and to mint the real one at
  // save time — same function either way, so the preview can't disagree with
  // what actually gets written.
  async nextTicketNumber(initials, workDate) {
    const prefix = initials + "-" + ticketDateStamp(localDate(workDate)) + "-";
    try {
      const { data, error } = await sbClient.rpc("next_ticket_number", {
        _initials: initials, _work_date: workDate
      });
      if (error) throw error;
      // Remember where the sequence had got to, so the offline path below can
      // carry on from the same place instead of guessing.
      OfflineCache.put("ticketno." + prefix, data);
      return data;
    } catch (e) {
      if (!isNetworkError(e)) throw e;

      // No signal, so run the server's rule against what this device knows:
      // the last number the database handed out for this prefix, plus every
      // ticket queued under it since. On one device, for one technician,
      // that is the same answer the server would give.
      //
      // It can still be overtaken — a second device, or another technician
      // sharing initials, raises one while this is out of range — and no
      // client-side count can know that. So the number is provisional, the
      // screen says so, and the database mints the real one on replay.
      const hit = await OfflineCache.read("ticketno." + prefix).catch(() => null);
      const lastKnown = hit ? parseInt(String(hit.value).slice(prefix.length), 10) : NaN;
      const base = isNaN(lastKnown) ? 1 : lastKnown;

      const queued = await OfflineQueue.list().catch(() => []);
      const alreadyQueuedUnderThisPrefix = queued.filter(item =>
        item.type === "ticket" &&
        item.payload && !item.payload.alreadyCreated &&
        item.payload.initials === initials &&
        item.payload.workDate === workDate
      ).length;

      if (hit) OfflineCache.noteServingCached(hit.at);
      return prefix + String(base + alreadyQueuedUnderThisPrefix).padStart(2, "0");
    }
  },

  // A ticket number is the primary key, and it is minted here — at save time,
  // never earlier. The number shown while the ticket is being built is a
  // preview: by the time a ticket queued offline at 07:00 replays at 18:00,
  // its preview is often taken, and the id that matters is the one minted now.
  //
  // Minting and inserting can't be one atomic act without either a reservation
  // table or a gapless-sequence lock held across the round trip, so the
  // primary key is the arbiter: on a collision, mint again and retry. Two
  // technicians would have to submit inside the same few milliseconds to see
  // one retry, and nothing about it is visible to them.
  async createTicket({ initials, jobDbId, technicianId, workDate, clientContact, contractorContact, lines, status, delays }) {
    await this.assertJobOpen(jobDbId);
    lines = lines.map(cleanLine);
    const total = totalOf(lines);
    assertBillable(total);

    let id = null;
    for (let attempt = 0; ; attempt++) {
      id = await this.nextTicketNumber(initials, workDate);
      // Inserted at zero, not at the total these lines are about to add up
      // to. The row and its lines are two separate requests and therefore two
      // separate transactions, so for the length of the first one the ticket
      // exists with no lines under it — and a ticket claiming money it has no
      // lines for is exactly the state that left KK-0814-26-01 showing $17.00
      // of nothing when an RLS policy refused the second request. The trigger
      // on ticket_lines sets the real figure the moment they land, and the
      // deferred constraint refuses any row where the two disagree.
      const { error } = await sbClient.from("tickets").insert({
        id, job_id: jobDbId, technician_id: technicianId, work_date: workDate,
        status, client_contact: clientContact, contractor_contact: contractorContact,
        total: 0,
        delays: delays || null
      });
      if (!error) break;
      // 23505 = unique violation: somebody took this number between the mint
      // and the insert. Anything else is a real failure.
      if (error.code !== "23505" || attempt >= 4) throw error;
    }

    if (lines.length) {
      const { error: lErr } = await sbClient.from("ticket_lines").insert(
        lines.map(l => ({ ticket_id: id, ...l }))
      );
      if (lErr) {
        // The ticket row is already in — a failure here would strand an
        // empty draft nobody asked for. It has no lines and was never sent,
        // so deleting it is safe; if even the delete fails, the empty draft
        // is the honest leftover state and the error still surfaces.
        await sbClient.from("tickets").delete().eq("id", id).then(() => {}, () => {});
        throw friendlyLineError(lErr);
      }
    }
    return { id, total };
  },

  // Cancelling a ticket raised in error. A real delete, not a status: a ticket
  // number that was never worked should not sit in the tracker forever
  // explaining itself. Lines and crew rows go with it (both cascade on the
  // ticket), so nobody's timesheet keeps hours from a ticket that no longer
  // exists.
  //
  // Approved and invoiced tickets are never cancellable — by then it is the
  // client's document, and a correction is a new ticket.
  async deleteTicket(ticketId) {
    const { data: row, error: rErr } = await sbClient.from("tickets").select("status").eq("id", ticketId).single();
    if (rErr) throw rErr;
    if (row.status === "Approved" || row.status === "Invoiced") {
      throw new Error(`Ticket ${ticketId} is ${row.status.toLowerCase()} — it can't be cancelled. Raise a credit or a corrected ticket instead.`);
    }
    // The row itself goes first, and it is the guarded step. The old order —
    // crew, then lines, then the row — had a real failure mode: a client
    // approving in the seconds between the status read above and the delete
    // meant RLS refused the row (approved_at set) but the crew and lines were
    // already destroyed, leaving an approved ticket gutted and a "cancelled"
    // toast on screen. Row-first can't do that: the children cascade with it,
    // and in a schema that ever lost the cascade the parent delete would
    // refuse on the foreign keys before touching anything.
    //
    // A delete no policy allows reports success having removed nothing, so
    // ask for the row back and treat silence as the refusal it is.
    const { data: gone, error } = await sbClient.from("tickets").delete().eq("id", ticketId).select("id");
    if (error) throw error;
    if (!gone || !gone.length) {
      throw new Error(`Ticket ${ticketId} wasn't cancelled — the client may have just approved it. Reload to see where it stands.`);
    }
    // Cascade has taken the crew and lines with the row; these are the
    // belt-and-braces sweep and expect to find nothing.
    await sbClient.from("ticket_crew").delete().eq("ticket_id", ticketId).then(() => {}, () => {});
    await sbClient.from("ticket_lines").delete().eq("ticket_id", ticketId).then(() => {}, () => {});
  },

  // The last ticket raised on this job, with its lines and crew — what "start
  // from the last one" copies forward.
  //
  // Multi-day jobs are the norm and they repeat: the same weld sizes shot day
  // after day, the same two people in the truck. Re-picking all of it from
  // dropdowns every evening is the most repeated typing in the app.
  //
  // Ordered by work date and then by when it was raised, so two tickets on the
  // same day resolve to the later one rather than to whichever the planner
  // happened to return first.
  async lastTicketForJob(jobDbId, excludeTicketId) {
    let q = sbClient.from("tickets")
      .select("id, work_date, ticket_lines(kind, label, unit, quantity)")
      .eq("job_id", jobDbId);
    // Reopening a draft shouldn't offer to copy that same draft over itself.
    if (excludeTicketId) q = q.neq("id", excludeTicketId);
    const { data, error } = await q
      .order("work_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const row = data && data[0];
    if (!row) return null;
    const crew = await this.listCrewForTicket(row.id).catch(() => []);
    return { id: row.id, workDate: row.work_date, lines: row.ticket_lines || [], crew };
  },

  // One ticket with its lines, for reopening a draft in the billing screen.
  async getTicket(ticketId) {
    const { data, error } = await sbClient.from("tickets")
      .select("id, job_id, technician_id, work_date, status, total, delays, client_contact, contractor_contact, ticket_lines(kind, label, unit, quantity, unit_rate)")
      .eq("id", ticketId).single();
    if (error) throw error;
    return data;
  },

  // Saving a reopened draft. Lines are replaced wholesale for the same reason
  // crew rows are — a ticket's lines are edited as one document.
  //
  // The status guard is here rather than only in the screen: a ticket the
  // client has approved is what they agreed to pay, and nothing in the app may
  // quietly rewrite it afterwards.
  async updateTicket({ ticketId, clientContact, contractorContact, lines, status, delays }) {
    const { data: row, error: rErr } = await sbClient.from("tickets").select("status, job_id").eq("id", ticketId).single();
    if (rErr) throw rErr;
    await this.assertJobOpen(row.job_id);
    if (row.status === "Approved" || row.status === "Invoiced") {
      throw new Error(`Ticket ${ticketId} is ${row.status.toLowerCase()} — it can't be changed. Raise a new ticket for any correction.`);
    }
    lines = lines.map(cleanLine);
    const total = totalOf(lines);
    assertBillable(total);
    // No total in the patch. The old lines are still in place at this point,
    // so writing the new sum here would leave the row disagreeing with them
    // until the replacement below lands — which is the window the constraint
    // exists to close. Replacing the lines moves the total on its own.
    const patch = { status };
    // undefined means the caller isn't touching delays; "" means cleared.
    if (delays !== undefined) patch.delays = delays || null;
    if (clientContact) patch.client_contact = clientContact;
    if (contractorContact) patch.contractor_contact = contractorContact;
    const { error: uErr } = await sbClient.from("tickets").update(patch).eq("id", ticketId);
    if (uErr) throw uErr;

    // Replacing the lines is delete-then-insert, and the gap between the two
    // is where a dropped connection or a refused insert used to destroy a
    // ticket's existing billing — found in beta testing, when an overflow on
    // the insert left the ticket empty at $0. The old lines are held here
    // and put back if the replacement fails; the edit fails, the money
    // doesn't vanish.
    const { data: oldLines, error: oErr } = await sbClient
      .from("ticket_lines").select("kind, label, unit, quantity, unit_rate")
      .eq("ticket_id", ticketId);
    if (oErr) throw oErr;

    const { error: dErr } = await sbClient.from("ticket_lines").delete().eq("ticket_id", ticketId);
    if (dErr) throw dErr;
    if (lines.length) {
      const { error: lErr } = await sbClient.from("ticket_lines").insert(
        lines.map(l => ({ ticket_id: ticketId, ...l }))
      );
      if (lErr) {
        if (oldLines && oldLines.length) {
          await sbClient.from("ticket_lines")
            .insert(oldLines.map(l => ({ ticket_id: ticketId, ...l })))
            .then(() => {}, () => {});
        }
        throw friendlyLineError(lErr);
      }
    }
    return { id: ticketId, total };
  },

  // ── Rates (read-only lookup for the ticket screen) ──────────────────
  // Every rate change ever made to a schedule, newest first — what "Rate
  // history" shows, backed by the trigger in the migrations.
  async getRateLineHistory(scheduleId) {
    const { data, error } = await sbClient
      .from("rate_line_history")
      .select("id, label, kind, unit, old_rate, new_rate, changed_at, profiles(name)")
      .eq("schedule_id", scheduleId).order("changed_at", { ascending: false });
    if (error) throw error;
    return data.map(h => ({
      id: h.id, label: h.label, kind: h.kind, unit: h.unit,
      oldRate: Number(h.old_rate), newRate: Number(h.new_rate),
      changedBy: h.profiles ? h.profiles.name : "—", changedAt: h.changed_at
    }));
  },

  // Pulls the most recently published schedule for a client and shapes it
  // into the billing catalog the ticket screen offers: every line on the
  // card, in the card's dragged order, priced as the card says. Contents,
  // not just prices — a custom line on the card is offered, a line removed
  // from the card is gone from the menu rather than offered at $0.
  // Wrapped for offline: without the client's catalog the billing screen has
  // nothing to price against and refuses to open, which is what made building
  // a ticket in the field impossible even though saving one was handled.
  async getPublishedRatesForClient(clientId) {
    return OfflineCache.readThrough("catalog." + clientId, () => this._fetchPublishedRates(clientId));
  },

  async _fetchPublishedRates(clientId) {
    // The client's newest schedule decides where the catalog comes from: a
    // schedule that follows the house card prices from the default schedule,
    // live; one that doesn't prices from its own published lines, exactly
    // as before.
    const { data: latest, error: sErr } = await sbClient
      .from("rate_schedules").select("id, follows_default, published_at")
      .eq("client_id", clientId)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (sErr) throw sErr;

    let schedule = null;
    if (latest && latest.follows_default) {
      const { data: def, error: dErr } = await sbClient
        .from("rate_schedules").select("id").is("client_id", null)
        .not("published_at", "is", null)
        .order("effective_from", { ascending: false }).limit(1).maybeSingle();
      if (dErr) throw dErr;
      schedule = def;
    } else if (latest && latest.published_at) {
      schedule = latest;
    } else {
      // The newest schedule may be an unpublished draft sitting in front of
      // an older published one — the published one still prices tickets.
      const { data: pub, error: pErr } = await sbClient
        .from("rate_schedules").select("id").eq("client_id", clientId)
        .not("published_at", "is", null)
        .order("effective_from", { ascending: false }).limit(1).maybeSingle();
      if (pErr) throw pErr;
      schedule = pub;
    }
    if (!schedule) return null;

    const { data: lines, error: lErr } = await sbClient
      .from("rate_lines").select("*").eq("schedule_id", schedule.id)
      .order("position", { ascending: true, nullsFirst: false }).order("label");
    if (lErr) throw lErr;

    // The card's rows, expanded the way a ticket bills them: a size row is
    // three per-weld items (film, CR, DR), a method is one, and the expense
    // group is the other-charges list. Item labels are built exactly the way
    // tickets have always stored them, so old drafts reopen unchanged. Keys
    // are kind:label — unique per the schedule's line index.
    const RT = { rt_film: "RT film", rt_cr: "RT CR", rt_dr: "RT DR" };
    const welds = [];
    const seenSizes = new Set();
    for (const l of lines) {
      if (RT[l.kind]) {
        if (seenSizes.has(l.label)) continue;
        seenSizes.add(l.label);
        for (const kind of Object.keys(RT)) {
          const row = lines.find(x => x.kind === kind && x.label === l.label);
          if (row) welds.push({ key: kind + ":" + row.label, label: row.label + " · " + RT[kind], rate: Number(row.rate), isWeld: true });
        }
      } else if (l.kind === "custom_weld") {
        // One-cell lines from before custom sizes grew all three kinds.
        welds.push({ key: "custom_weld:" + l.label, label: l.label, rate: Number(l.rate), isWeld: true });
      }
    }
    for (const l of lines) {
      if (l.kind === "method" || l.kind === "custom_method") {
        // Not isWeld: the weld count on the ticket header counts RT welds
        // shot, the way it always has.
        welds.push({ key: l.kind + ":" + l.label, label: l.label + " — per weld", rate: Number(l.rate), isWeld: false });
      }
    }
    const others = lines
      .filter(l => l.kind === "expense" || l.kind === "custom_expense")
      .map(l => ({
        key: l.kind + ":" + l.label, label: l.label, rate: Number(l.rate),
        unit: l.unit || "ea", step: l.unit === "h" ? 0.5 : 1
      }));
    return { welds, others };
  },

  // ── Rate admin (full editable schedule, not just the read-only lookup
  //    above) ───────────────────────────────────────────────────────────
  // The house default schedule is a rate_schedules row with no client_id.
  // Modelling it as a real schedule rather than a separate table means the
  // same editor, the same publish flow and the same line types apply to it.
  async getEditableSchedule(clientId) {
    const isDefault = clientId === DEFAULT_SCHEDULE;
    const q = sbClient.from("rate_schedules").select("*");
    let { data: schedule, error: sErr } = await (isDefault ? q.is("client_id", null) : q.eq("client_id", clientId))
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (sErr) throw sErr;
    if (!schedule) {
      const { data: created, error: cErr } = await sbClient
        .from("rate_schedules").insert({ client_id: isDefault ? null : clientId }).select().single();
      if (cErr) throw cErr;
      schedule = created;
    }
    let { data: lines, error: lErr } = await sbClient.from("rate_lines").select("*")
      .eq("schedule_id", schedule.id)
      // The dragged order first; label keeps rows stable for anything from
      // before the position column, which sorts to the end as null.
      .order("position", { ascending: true, nullsFirst: false }).order("label");
    if (lErr) throw lErr;

    // The standard card is laid out once, when a schedule is empty — which
    // in practice means it was just created. This used to top up whatever
    // was MISSING on every open, which made removing a standard line
    // cosmetic: it came back at zero the next time anyone looked,
    // contradicting both the remove button's promise and the Restore
    // standard lines button, whose whole job is bringing removed lines back
    // on purpose. The editor draws its rows from the lines themselves now,
    // so an absent line is simply not there.
    if (!(lines || []).length) {
      const seed = STANDARD_RATE_LINES.map(l => ({ schedule_id: schedule.id, ...l, rate: 0 }));
      const { data: seeded, error: seedErr } = await sbClient.from("rate_lines").insert(seed).select();
      if (seedErr) throw seedErr;
      lines = seeded;
    }
    return { schedule, lines };
  },

  // A rate is what the client gets billed, so it can't be negative. The
  // database rejects one outright; clamping here means the field just refuses
  // to go below zero instead of surfacing a constraint violation.
  async setRateLine(id, rate) {
    const { error } = await sbClient.from("rate_lines").update({ rate: nonNegative(rate) }).eq("id", id);
    if (error) throw error;
  },

  async addRateLine({ scheduleId, kind, label, unit, rate, position = null }) {
    const { data, error } = await sbClient.from("rate_lines")
      .insert({ schedule_id: scheduleId, kind, label, unit, rate: nonNegative(rate), position }).select().single();
    if (error) throw error;
    return data;
  },

  // The dragged order, written back one position per line. Parallel
  // single-row updates rather than an upsert: an upsert would need every
  // column of every row, and a miss here should refuse loudly — an update
  // no policy allows reports success having moved nothing.
  async reorderRateLines(updates) {
    const results = await Promise.all(updates.map(u =>
      sbClient.from("rate_lines").update({ position: u.position }).eq("id", u.id).select("id")
    ));
    for (const { error } of results) if (error) throw error;
    if (results.some(r => !r.data || !r.data.length)) {
      throw new Error("The new order didn't fully save — reload the schedule and try again.");
    }
  },

  async deleteRateLine(id) {
    const { error } = await sbClient.from("rate_lines").delete().eq("id", id);
    if (error) throw error;
  },

  async publishSchedule(scheduleId) {
    const { error } = await sbClient.from("rate_schedules").update({ published_at: new Date().toISOString() }).eq("id", scheduleId);
    if (error) throw error;
  },

  // The switch on a client's card. On: their tickets price from the house
  // card, live, and their own lines lie dormant. Off: their own card prices
  // again, exactly as it was left.
  async setFollowsDefault(scheduleId, follows) {
    const { data, error } = await sbClient.from("rate_schedules")
      .update({ follows_default: !!follows }).eq("id", scheduleId).select("id");
    if (error) throw error;
    if (!data || !data.length) {
      throw new Error("That schedule wasn't updated — rate cards are an admin's to change.");
    }
  },

  // Copies the house default into a schedule — the card itself, not just
  // its figures:
  //
  //   - a line the schedule does not carry  -> inserted, priced or not
  //   - a line it carries at zero           -> filled in from the default
  //
  // A line with a rate already on it is never touched: a negotiated 6in rate
  // must not silently revert to the house figure. Zero is not a negotiated
  // rate, it is an unset one. Nothing is ever removed, either — lines this
  // schedule has that the default lacks are its own business.
  async copyDefaultInto(scheduleId) {
    const { data: def } = await sbClient
      .from("rate_schedules").select("id").is("client_id", null)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle();
    if (!def) throw new Error("There is no default schedule yet — set one up first.");
    if (def.id === scheduleId) throw new Error("This is the default schedule — there is nothing to copy into it.");

    const [{ data: source }, { data: existing }] = await Promise.all([
      sbClient.from("rate_lines").select("*").eq("schedule_id", def.id),
      sbClient.from("rate_lines").select("id, kind, label, rate").eq("schedule_id", scheduleId)
    ]);
    if (!source || !source.length) throw new Error("The default schedule has nothing on it yet — set it up first.");

    const key = l => l.kind + "\u0000" + l.label;
    const mine = new Map((existing || []).map(l => [key(l), l]));

    const toAdd = [];
    const toFill = [];
    for (const l of source) {
      const match = mine.get(key(l));
      // Structure copies whether or not the line is priced yet: the house
      // card's rows — its size bands, its methods — are themselves the
      // template, and they used to be skipped at $0, which made "Fill from
      // default" a no-op on a card whose rates hadn't been typed in yet.
      // The default's dragged order comes along with each line.
      if (!match) {
        toAdd.push({ schedule_id: scheduleId, kind: l.kind, label: l.label, unit: l.unit, rate: l.rate, position: l.position });
      } else if (Number(l.rate) && !Number(match.rate)) {
        toFill.push({ id: match.id, rate: l.rate });
      }
    }

    if (toAdd.length) {
      const { error } = await sbClient.from("rate_lines").insert(toAdd);
      if (error) throw error;
    }
    if (toFill.length) {
      // One round trip covering every row via bulk_set_rate_lines() (see
      // migrations) — a plain UPDATE...FROM unnest(), not an upsert, so it
      // can't trip over rate_lines' other required columns the way a
      // partial-row upsert could.
      const { error } = await sbClient.rpc("bulk_set_rate_lines", {
        ids: toFill.map(f => f.id), rates: toFill.map(f => f.rate)
      });
      if (error) throw error;
    }
    return toAdd.length + toFill.length;
  },

  async listOverrides() {
    const { data, error } = await sbClient
      .from("rate_overrides").select("*, jobs(job_number, client_id)").order("id");
    if (error) throw error;
    return data;
  },

  async createOverride({ jobId, description, basis, bidRef }) {
    const { data, error } = await sbClient.from("rate_overrides")
      .insert({ job_id: jobId, description, basis, bid_ref: bidRef || null, active: true, locked: false })
      .select("*, jobs(job_number, client_id)").single();
    if (error) throw error;
    return data;
  },

  // Locked overrides are priced into an approved ticket, so removing one
  // would change what a client already signed for. The guard is here rather
  // than only in the screen: any future caller gets it too.
  async deleteOverride(id) {
    const { data: row, error: rErr } = await sbClient
      .from("rate_overrides").select("locked").eq("id", id).maybeSingle();
    if (rErr) throw rErr;
    if (row && row.locked) throw new Error("That override is locked — a ticket on the job has already been approved against it.");
    const { error } = await sbClient.from("rate_overrides").delete().eq("id", id);
    if (error) throw error;
  },

  async toggleOverrideActive(id, active) {
    const { error } = await sbClient.from("rate_overrides").update({ active }).eq("id", id);
    if (error) throw error;
  },

  // ── Users & access ───────────────────────────────────────────────────
  async listFunctionErrors(limit = 20) {
    const { data, error } = await sbClient
      .from("function_errors").select("*").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return data;
  },

  async listProfiles() {
    return cached("profiles", () => OfflineCache.readThrough("profiles", async () => {
      // Ordered client-side rather than in the query: the name columns arrive
      // with the crew/timesheets migration, and sorting on one before it runs
      // makes this throw — taking Users & access and the ticket crew list with
      // it. Sorting here means the app works either side of the migration.
      const { data, error } = await sbClient.from("profiles").select("*");
      if (error) throw error;
      // `displayName` is what the app shows; `name` stays untouched so an
      // account whose parts were never filled in still reads sensibly.
      return data
        .map(p => ({ ...p, displayName: fullName(p) }))
        .sort((a, b) =>
          (a.last_name || a.displayName).localeCompare(b.last_name || b.displayName) ||
          a.displayName.localeCompare(b.displayName)
        );
    }));
  },

  async updateProfileDetails(id, { firstName, lastName, isSubcontractor, cert, level, unitNumber, idCode }) {
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const patch = { first_name: firstName || null, last_name: lastName || null, is_subcontractor: !!isSubcontractor };
    if (name) patch.name = name;
    if (cert !== undefined) patch.cert = cert;
    // Level and the CGSB/NRCAN number both print on the client's field
    // invoice. Empty means "not set", which the invoice shows as a dash
    // rather than inventing a grade for somebody.
    if (level !== undefined) patch.level = level || null;
    // Equipment fields: sent only when the caller passed them, so an older
    // screen that doesn't know about them can't blank them out.
    if (unitNumber !== undefined) patch.unit_number = unitNumber.trim() || null;
    if (idCode !== undefined) patch.id_code = idCode.trim() || null;
    const { error } = await sbClient.from("profiles").update(patch).eq("id", id);
    if (error) throw error;
    invalidate("profiles");
  },

  async updateProfileTabs(id, tabs) {
    const { error } = await sbClient.from("profiles").update({ tab_access: tabs }).eq("id", id);
    if (error) throw error;
    invalidate("profiles");
  },

  async updateProfileRole(id, role, tabs) {
    const { error } = await sbClient.from("profiles").update({ role, tab_access: tabs }).eq("id", id);
    if (error) throw error;
    invalidate("profiles");
  },

  // Deletes the account for real — the profile row and the auth.users record
  // behind it — via the delete-user Edge Function, which holds the
  // service-role key this can never touch client-side.
  async deleteUserAccount(userId) {
    const { data, error } = await sbClient.functions.invoke("delete-user", { body: { userId } });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    invalidate("profiles");
  },

  // Creates a real Supabase Auth user (not just a profile) via signUp on a
  // throwaway client instance — `persistSession: false` keeps this from
  // touching the admin's own logged-in session. The on_auth_user_created
  // trigger provisions the matching profile row from the metadata here.
  // Note: if "Confirm email" is on for this project (the default), the new
  // person has to click the confirmation email before they can sign in.
  async createUserAccount({ firstName, lastName, email, password, role, cert, level, isSubcontractor }) {
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const tempClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await tempClient.auth.signUp({
      email, password, options: { data: { name, role, cert } }
    });
    if (error) throw error;
    invalidate("profiles");
    // The trigger provisions the profile from auth metadata, which has no
    // slot for the name parts or the subcontractor flag — so set them after.
    if (data.user) {
      try {
        // Muted for the same reason as above: filling in the name parts is
        // part of creating the account, so it should not also say "saved".
        Toasts.mute();
        try { await this.updateProfileDetails(data.user.id, { firstName, lastName, isSubcontractor, cert, level }); }
        finally { Toasts.unmute(); }
      } catch (e) {
        console.warn("Account created, but couldn't save name parts:", e.message);
      }
    }
    return data;
  },

  // ── The arcade ───────────────────────────────────────────────────────
  // Every easter egg's leaderboard, one table keyed by game. Both calls are
  // deliberately outside the offline queue: a score is not work, and it has
  // no business sitting in the same queue as a ticket, competing for a sync
  // slot or surviving a failed replay.
  async listArcadeScores(game) {
    const { data, error } = await sbClient
      .from("arcade_scores")
      .select("profile_id, best, updated_at, profiles(name)")
      .eq("game", game)
      .order("best", { ascending: false })
      .order("updated_at", { ascending: true })   // a tie goes to whoever got there first
      .limit(10);
    if (error) throw error;
    return (data || []).map(r => ({
      id: r.profile_id,
      name: r.profiles ? r.profiles.name : "",
      best: Number(r.best),
      at: r.updated_at
    }));
  },

  // Muted, because "Saved" popping up over a game you just lost is not a
  // message anybody needs. The database keeps whichever score is higher, so
  // this is safe to call with a stale number. No timestamp goes up with it:
  // updated_at breaks ties on the board, and the server stamps it itself —
  // a phone with its clock set wrong should not out-rank an honest one.
  async saveArcadeScore({ game, profileId, best }) {
    Toasts.mute();
    try {
      const { error } = await sbClient.from("arcade_scores").upsert(
        { game, profile_id: profileId, best },
        { onConflict: "game,profile_id" }
      );
      if (error) throw error;
    } finally { Toasts.unmute(); }
  }
};

// ── "That saved" ─────────────────────────────────────────────────────────
//
// Every write a person actually performs, and what to call it afterwards.
// Announcing it here rather than at each screen means a new screen gets the
// confirmation for free, and no screen can forget one.
//
// Wording is the action in the past tense, from the user's side: they pressed
// Approve, so it says "Timesheet approved", not "timesheet_approvals row
// inserted". Deletes say so plainly — a disappearing row is exactly when you
// want to be told it was on purpose.
const SAVE_MESSAGES = {
  // Contacts and organisations
  createContact: "Contact added",
  updateContact: "Contact saved",
  deleteContact: "Contact removed",
  setPrimaryContact: "Primary contact changed",
  createClient: "Client added",
  createContractor: "Contractor added",

  // Jobs
  createJob: "Job created",
  updateJobRecord: "Job record saved",
  setJobComplete: "Job status changed",
  deleteJob: "Job deleted",

  // Hazard assessments
  createJha: "JHA filed",
  closeOutJha: "JHA closed out",
  sendJhaEmail: "Assessment sent",
  deleteJha: "Assessment deleted",

  // Reports and files
  uploadReport: "Report uploaded",
  sendReportEmail: "Report sent",
  deleteReport: "Report deleted",
  deleteSharedFile: "File deleted",
  deleteFolder: "Folder deleted",

  // Billing
  createTicket: "Ticket created",
  updateTicket: "Ticket saved",
  deleteTicket: "Ticket cancelled",
  sendTicketApproval: "Approval sent",
  withdrawTicketApproval: "Approval cancelled — the ticket is a draft again",

  // Rates
  setRateLine: "Rate saved",
  addRateLine: "Rate line added",
  deleteRateLine: "Rate line removed",
  reorderRateLines: "Line order saved",
  publishSchedule: "Schedule published",
  copyDefaultInto: "Default rates copied in",
  setFollowsDefault: "Rate card updated",
  createOverride: "Override added",
  deleteOverride: "Override removed",
  toggleOverrideActive: "Override updated",

  // Equipment
  createEquipment: "Equipment added",
  updateEquipment: "Equipment saved",
  deleteEquipment: "Equipment removed",

  // Timesheets
  approveTimesheet: "Timesheet approved",
  unapproveTimesheet: "Timesheet reopened",

  // Accounts
  createUserAccount: "Account created",
  deleteUserAccount: "Account removed",
  updateProfileDetails: "Account saved",
  updateProfileTabs: "Access updated",
  updateProfileRole: "Role changed"
};

// Left deliberately silent, because nobody did them on purpose:
//
//   clearPrimary        a step inside setPrimaryContact
//   rememberContact     files the rep a new job was created with
//   resolveJobContact   the same, for the job record
//   saveCrewForTicket   part of saving a ticket, not its own action
//   getEditableSchedule creates a draft schedule the first time a client's
//                       rates are opened — a read, as far as anyone can tell
//   renderJhaPdf        best-effort background render
//
// Each of those fires inside something already in the table above, and would
// otherwise produce two confirmations for one press.
for (const [method, message] of Object.entries(SAVE_MESSAGES)) {
  const original = Db[method];
  if (typeof original !== "function") {
    // A rename would otherwise silently stop announcing that write.
    console.warn(`No Db.${method} to announce — SAVE_MESSAGES is out of date.`);
    continue;
  }
  Db[method] = async function (...args) {
    const result = await original.apply(this, args);
    // Only on the way out, so a write that throws says nothing — the screen
    // shows the real error instead of a confirmation that isn't true.
    Toasts.show(message);
    return result;
  };
}

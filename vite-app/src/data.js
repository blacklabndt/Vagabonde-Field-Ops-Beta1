// ─────────────────────────────────────────────────────────────────────────
// Shared constants and pure helpers: money and date formatting, ticket
// numbering, pay periods, the tab and role tables, and the standing hazard
// and rate-card lists every screen builds from.
//
// Nothing here touches the network. The tables themselves live in Supabase
// and are read through db.js; what stays here is the arithmetic and the
// vocabulary, in one place so that the job screen and the billing screen
// can never disagree about a ticket number or what a standard rate line is.
// ─────────────────────────────────────────────────────────────────────────

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export const money = n => "$" + (Number(n) || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Today as YYYY-MM-DD in the *browser's* timezone.
//
// `new Date().toISOString().slice(0, 10)` looks like it does this and doesn't:
// it returns the UTC date, which in Alberta rolls over at 17:00 local. Every
// evening ticket was being dated tomorrow, and any raised on the 15th after
// 17:00 was filed into the following pay period.
export const todayLocal = () => {
  const d = new Date();
  return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

// Parses a plain YYYY-MM-DD as *local* midday. Midday, not midnight, so that a
// DST transition can't push the value onto the neighbouring day.
export const localDate = s => {
  const [y, m, d] = String(s || "").split("-").map(Number);
  return (y && m && d) ? new Date(y, m - 1, d, 12) : new Date(NaN);
};

export const dayMonth = d => String(d.getDate()).padStart(2, "0") + " " +
  d.toLocaleDateString("en-CA", { month: "short" }).replace(".", "");

export const initialsOf = name => (name || "")
  .replace(/[^A-Za-z\s.]/g, "").split(/[\s.]+/).filter(Boolean)
  .map(w => w[0].toUpperCase()).slice(0, 3).join("");

// The date part of a ticket number: MMDD-YY.
//
// Ticket numbers read {initials}-{MMDD}-{YY}-{NN} (KK-0812-26-01). Kept as a
// helper rather than inlined so the number minted on the job screen and the one
// minted on the billing screen can never drift apart.
export const ticketDateStamp = d =>
  String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") +
  "-" + String(d.getFullYear()).slice(2);

// Access lists arrive from the `profiles` table and can be null on a row that
// predates the column, or on one an admin emptied. Every read of them went
// through `.includes` / `[0]` / `.length` unguarded, so a single null column
// took the whole app to a blank screen at sign-in. One coercion, used
// everywhere a tab list is read.
//
// Contacts is a universal lookup — a phone number for the rep on the lease is
// not privileged information the way rates and timesheets are. So it is added
// to every account that has any access at all. An account with no tabs stays
// locked out: that emptiness is what App treats as "profile with no access".
//
// Lives here rather than in common.jsx so the sign-in logic that depends on it
// can be tested without pulling in React.
export const UNIVERSAL_TABS = ["contacts"];
export const tabList = v => {
  const tabs = Array.isArray(v) ? v : [];
  if (!tabs.length) return tabs;
  return tabs.concat(UNIVERSAL_TABS.filter(t => !tabs.includes(t)));
};

export const TABS = [
  { key: "board", label: "Home" },
  { key: "job", label: "Job detail" },
  { key: "jha", label: "JHA builder" },
  { key: "upload", label: "Report upload" },
  { key: "ticket", label: "Billing ticket" },
  { key: "mytickets", label: "Open tickets" },
  { key: "chat", label: "Team chat" },
  { key: "files", label: "Files" },
  { key: "contacts", label: "Contacts" },
  { key: "equipment", label: "Equipment" },
  { key: "timesheets", label: "Timesheets" },
  { key: "rates", label: "Rate admin" },
  { key: "tracker", label: "Billing tracker" },
  { key: "users", label: "Users & access" }
];

// Screens that only make sense with a job under them. They never appear in
// the drawer — for anyone — because a JHA builder opened from the menu
// operates on whichever job happens to be active, which is how the wrong
// job gets edited. The route to them is the one Kyle described: Home or
// Open tickets, pick the job, work from its own buttons.
//
// The tabs themselves still exist and still matter: they are PERMISSION.
// Row-level security and the storage buckets gate on them, which is how
// hiding them by deleting them from tab_access broke report uploads for
// two admins without a visible symptom. Visibility is decided here, in
// code, for everybody; access is decided per person, in Users & access.
export const CONTEXT_TABS = ["job", "jha", "upload", "ticket"];

// Kept in step with public.tabs_for_role() in the migrations, which is what
// the signup trigger seeds a new account from — the two had drifted, leaving
// accounts created in the app without the tabs this table promises them.
export const ROLE_PRESETS = {
  Admin: ["board", "job", "jha", "upload", "ticket", "mytickets", "files", "contacts", "equipment", "timesheets", "rates", "tracker", "users", "chat"],
  Coordinator: ["board", "job", "jha", "upload", "ticket", "mytickets", "files", "contacts", "equipment", "timesheets", "tracker", "chat"],
  // Technicians get the directory read-write too: the person who finds out
  // the site rep's number is usually the one standing on the lease.
  Technician: ["board", "job", "jha", "upload", "ticket", "mytickets", "files", "contacts", "chat"],
  // A helper assists a technician on site: they sign onto the JHA and appear
  // on the ticket crew for their hours and dose, but they do not raise
  // tickets or upload reports themselves, so those tabs stay off.
  Helper: ["board", "job", "jha", "files", "contacts", "chat"]
};

// The contact every screen pre-fills from: an organisation's primary, or its
// only one if nobody has been promoted yet (rows predating the directory).
export function primaryContact(contacts, orgType, orgId) {
  if (!orgId) return null;
  const mine = (contacts || []).filter(c => c.org_type === orgType && c.org_id === orgId);
  return mine.find(c => c.is_primary) || mine[0] || null;
}

// Roles that can be added to a ticket crew, and the crew_role each carries.
// Kept apart from ROLE_PRESETS so the crew grouping does not change every
// time an office role is added.
const CREW_ROLE_OF = { Helper: "Helper" };
export const crewRoleFor = profile => CREW_ROLE_OF[profile && profile.role] || "Technician";

// ── Pay periods ────────────────────────────────────────────────────────
// Semi-monthly: the 1st–15th, then the 16th to the end of the month. Dates
// are handled as plain YYYY-MM-DD strings, never Date objects, because a
// Date parsed from "2026-08-01" is midnight UTC — which in Alberta is the
// previous evening, and would file the 1st under the wrong period.
const lastDayOf = (y, m) => new Date(y, m, 0).getDate();

export function payPeriodLabel(p) {
  const fmt = s => {
    const [y, m, d] = s.split("-").map(Number);
    return `${String(d).padStart(2, "0")} ${new Date(y, m - 1, 1).toLocaleDateString("en-CA", { month: "short" }).replace(".", "")}`;
  };
  return `${fmt(p.start)} – ${fmt(p.end)} ${p.start.slice(0, 4)}`;
}

// The last `count` periods, newest first — the period picker's options.
export function recentPayPeriods(count = 12, from = new Date()) {
  const out = [];
  let y = from.getFullYear();
  let m = from.getMonth() + 1;
  let firstHalf = from.getDate() <= 15;
  for (let i = 0; i < count; i++) {
    out.push({
      start: iso(y, m, firstHalf ? 1 : 16),
      end: iso(y, m, firstHalf ? 15 : lastDayOf(y, m))
    });
    if (firstHalf) { m -= 1; if (m === 0) { m = 12; y -= 1; } firstHalf = false; }
    else firstHalf = true;
  }
  return out;
}

export const hours = n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

// Whole days between a timestamp and now. Counted from local midnight on each
// side, so "2 days old" doesn't tick over at whatever time of day the row
// happened to be written — which is what drove the "over 7 days" flag before.
export function ageInDays(ts) {
  if (!ts) return 0;
  const then = new Date(ts);
  if (isNaN(then)) return 0;
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const now = new Date();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((b - a) / 86400000));
}

// Only STANDARD_RATE_LINES below reads these two now — the ticket screen's
// menus come from the client's card itself, and the rate admin's rows come
// from the lines. They seed fresh schedules and order legacy position-less
// lines, nothing more.
const SIZE_LABELS = ['2" NPS', '4" NPS', '6" NPS', '8" NPS', '12" NPS'];

// An empty job record. `App` holds one of these until a job is actually
// opened. It used to hold a hard-coded sample record for a real job — which
// meant the mobile ticket and upload screens displayed, and addressed email
// to, one client's rep before any job had been chosen.
export const EMPTY_JOB_RECORD = {
  job: "", client: "", clientRep: "", contractor: "", contractorRep: "",
  afe: "", lsd: "", method: "", procedure: "", started: ""
};

// The job record, in the order the panel shows it: identifiers first, then the
// two organisations with their reps, then the start date.
export const JOB_FIELDS = [
  { key: "job", label: "Job" }, { key: "lsd", label: "LSD" }, { key: "afe", label: "AFE" },
  { key: "area", label: "Area" },
  { key: "client", label: "Client" }, { key: "clientRep", label: "Client rep" },
  { key: "contractor", label: "Contractor" }, { key: "contractorRep", label: "Contractor rep" },
  { key: "started", label: "Started" }
];

// GST on the client's field invoice. Alberta, so the 5% federal rate with no
// provincial component. One named constant because a tax rate copied into
// three templates is a tax rate that will one day disagree with itself — if
// it changes, or the company ever bills into a province with HST, this is the
// only line to edit.
// The certification levels printed beside a technician's name on the client
// field invoice, and the legend printed under them. One list so the codes on
// the ticket and the legend explaining them can never drift apart.
export const TECH_LEVELS = [
  { code: "S",  label: "Specialist" },
  { code: "T2", label: "Level 2 Certified Technician" },
  { code: "T1", label: "Level 1 Certified Technician" },
  { code: "C",  label: "CEDO" },
  { code: "T",  label: "Trainee" },
  { code: "A",  label: "Administrative" }
];

// Floors a figure at zero, for anything that feeds a bill. A negative rate,
// quantity or hour count prices a line below zero and quietly credits the
// client — the ticket totals up short with nothing anywhere reporting an
// error, which is the worst way for a number to be wrong. Zero stays a real
// value ("not priced yet", "no hours today"), so this floors, not rejects.
//
// One copy, here, because it used to live twice — in db.js and in the
// NumField — and only one of the two knew that a comma decimal is a decimal:
// "1,5" is how half the world's keyboards type one and a half, and a bare
// parseFloat silently reads it as 1.
export const nonNegative = value => {
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// A line's billable amount: quantity × rate, rounded to the cent. The one
// formula the database's total sync, the ticket screen and the printed
// invoice all share — migration 20260818140051 put the same round() into
// the triggers, after the audit found half an hour at a $9.25 rate could
// not be saved: the stored total rounded to 4.63 while the balance check
// summed the exact 4.625, and the database refused its own arithmetic.
export const lineTotal = (quantity, unitRate) =>
  Math.round(Number(quantity || 0) * Number(unitRate || 0) * 100) / 100;

export const GST_RATE = 0.05;

// Rounded on integer cents, not on dollars.
//
// `Math.round(subtotal * 0.05 * 100) / 100` looks equivalent and is not: in
// binary floating point a half-cent lands just below the boundary often
// enough to matter. Checked every whole-cent subtotal from $0.01 to $5,000
// and 408 of them come out a cent low that way — $0.70, $2.90, $20.70,
// $42.30 among them — always under-charging, so the company covers the
// difference. Rounding the subtotal to cents first removes the class.
//
// Mirrored in supabase/functions/_shared/invoice.ts. The two must agree to
// the cent or the app and the client's copy quote different totals.
export const gstOn = subtotal => Math.round(Math.round(subtotal * 100) * GST_RATE) / 100;

// Storage object keys are stricter than filenames: the API refuses
// non-ASCII outright ("Invalid key"), % breaks the request before it
// leaves, and # or ? silently truncate the key at what a URL considers
// the end of a path. Found in beta testing with a phone-style filename.
// Accents fold to their plain letters so "Réport.pdf" stays readable as
// "Report.pdf"; everything else the key can't carry becomes a dash. The
// original name is still shown everywhere — only the key is boring.
export const storageKeySafe = (name, fallback = "file") => {
  const cleaned = String(name || "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return cleaned || fallback;
};

// Reads the film and MPI numbering off an interpreted report's text and
// answers the Upload dialog's "Last numbers" field in its own format:
// "XF-16 to XF-44, MT-66, MT-70 to MT-71".
//
// Contiguous runs, not one span from lowest to highest. A report holding
// MT-66 and MT-70..71 does not hold MT-67..69 — those welds are on some
// other day's report — and "MT-66 to MT-71" would claim them. The
// contractor reconciles these numbers against the film in the envelope,
// so the field has to say exactly what is in the PDF and nothing more.
//
// The prefixes: XF, XS and XT number radiographic film, MT the MPI
// indications, UT the ultrasonic ones. Radiographic first in the answer,
// then surface, then volumetric — the order the paperwork reads in.
//
// The enemy is the procedure designation, which is paperwork wearing the
// same prefix as the welds — MT and UT are the methods' abbreviations, so
// their procedures are named after them too. Across real reports it has
// appeared three ways: "MT1 T1 Rev. 11", "MT 1", and "MT-01 REV 2 ASME V"
// on the same page as genuine MT-6..MT-9 rows. Three rules keep it out,
// each measured against a page where the collision actually happens, and
// every prefix gets all three because the UT procedure will pull exactly
// the same trick:
//   - the hyphen is required        ("MT1", "MT 1" are out)
//   - a zero-padded number is out   (rows write MT-6, never MT-06; the
//                                    template writes the procedure MT-01)
//   - a number followed by REV is out, whatever the padding
// A tech who zero-pads a real weld by hand loses that one from the range
// and edits the field, which stays a head start rather than an authority.
const NUMBER_PREFIXES = ["XF", "XS", "XT", "MT", "UT"];
export function lastNumbers(text) {
  const seen = {};
  for (const m of String(text || "").matchAll(/\b(XF|XS|XT|MT|UT)-(\d+)\b(?!\s*rev\b)/gi)) {
    if (/^0/.test(m[2])) continue;             // MT-01 is a procedure, not a weld
    const k = m[1].toUpperCase();
    if (!seen[k]) seen[k] = new Set();
    seen[k].add(Number(m[2]));
  }
  return NUMBER_PREFIXES
    .filter(k => seen[k])
    .map(k => {
      const nums = [...seen[k]].sort((a, b) => a - b);
      const runs = [];
      let start = nums[0];
      let prev = nums[0];
      for (const n of nums.slice(1)) {
        if (n === prev + 1) { prev = n; continue; }
        runs.push([start, prev]);
        start = prev = n;
      }
      runs.push([start, prev]);
      return runs
        .map(([a, b]) => (a === b ? `${k}-${a}` : `${k}-${a} to ${k}-${b}`))
        .join(", ");
    })
    .join(", ");
}

export const JHA_TEMPLATES = [
  "RT — Pipeline tie-in v4", "RT — Facility / plant piping v2",
  "RT — Shop radiography v1", "RT — Sour service (H₂S) v3"
];

export const SEED_HAZARDS = [
  { name: "Driving", control: "Follow all road rules, wear safety equipment, drive to conditions", level: "High", on: true },
  { name: "Entanglement", control: "Store equipment correctly, housekeeping to prevent injuries", level: "Med", on: true },
  { name: "Environmental", control: "Dress to conditions, stay hydrated, watch for extreme weather", level: "Med", on: true },
  { name: "Hazardous materials (WHMIS)", control: "Refer to MSDS sheets, sign transportation documentation", level: "High", on: true },
  { name: "Heavy equipment", control: "Make eye contact with the operator, keep a safe distance", level: "High", on: true },
  { name: "Housekeeping", control: "Keep the work area clutter-free to prevent injuries", level: "Med", on: true },
  { name: "Manual lifting", control: "Lift with your legs, do not twist or jerk", level: "Med", on: true },
  { name: "Pinch points", control: "Be aware of pinch points and avoid them whenever possible", level: "Med", on: true },
  { name: "Radiation (inc. NORM)", control: "ALARA, monitors, survey meters and signage to control area and monitor dose rates", level: "Critical", on: true },
  { name: "Slips / trips / falls", control: "Watch footing, wear proper footwear", level: "Med", on: true },
  { name: "Tools", control: "Examine tools for defects before use; do not use a defective tool", level: "Med", on: true },
  { name: "Weather related", control: "Dress to conditions; watch for extreme heat/cold, slippery or wet ground", level: "Med", on: true }
];

// The methods every schedule starts with. What a ticket can bill comes from
// the client's card itself now (Db catalog), not from this list — it exists
// to seed new schedules and order old, position-less lines.
const METHODS = [
  { key: "mt", label: "MT / MPI" }, { key: "pt", label: "PT" },
  { key: "vt", label: "VT" }, { key: "ht", label: "Hardness test" },
  { key: "ut", label: "UT" }
];

// The lines every rate schedule starts with, at zero. One list, used both
// when a schedule is first opened and by Restore standard lines, so the two
// can never disagree about what "standard" means.
// `position` is where a line starts on a fresh schedule — the same numbers
// migration 20260818030718 stamped on the live rows. The Rate admin screen
// orders by it and rewrites it when rows are dragged; the three RT kinds of
// one size share a position because the editor shows them as one row.
export const STANDARD_RATE_LINES = [
  ...SIZE_LABELS.flatMap((sz, i) => [
    { kind: "rt_film", label: sz, unit: "weld", position: i },
    { kind: "rt_cr", label: sz, unit: "weld", position: i },
    { kind: "rt_dr", label: sz, unit: "weld", position: i }
  ]),
  ...METHODS.map((m, i) => ({ kind: "method", label: m.label, unit: "weld", position: 10 + i })),
  // The crew rate is per truck, not per person: a second technician in the
  // same truck does not double it, and a second truck is a second ticket —
  // which is why these no longer say "Technician". Renamed live in migration
  // 20260818025620; the DB labels and these must stay identical, since old
  // tickets and legacy aliases are matched by label text.
  { kind: "expense", label: "Straight time", unit: "h", position: 20 },
  { kind: "expense", label: "Overtime", unit: "h", position: 21 },
  // Travel is billed apart from hours worked, at its own rate — that is how
  // the paper field ticket has always split it.
  { kind: "expense", label: "Travel — straight", unit: "h", position: 22 },
  { kind: "expense", label: "Travel — overtime", unit: "h", position: 23 },
  { kind: "expense", label: "Mileage", unit: "km", position: 24 },
  { kind: "expense", label: "Film & consumables", unit: "ea", position: 25 },
  { kind: "expense", label: "Subsistence / LOA", unit: "days", position: 26 },
  // The eight that used to be priced by constants in the ticket screen's
  // SERVICES list, moved onto the card by migration 20260818035752 so every
  // dollar a ticket bills comes from one editable place.
  { kind: "expense", label: "Standby time", unit: "h", position: 27 },
  { kind: "expense", label: "Callout premium", unit: "ea", position: 28 },
  { kind: "expense", label: "Source / isotope charge", unit: "days", position: 29 },
  { kind: "expense", label: "Truck / unit day rate", unit: "days", position: 30 },
  { kind: "expense", label: "Darkroom / processing", unit: "h", position: 31 },
  { kind: "expense", label: "Crawler unit", unit: "days", position: 32 },
  { kind: "expense", label: "Mobilization / demob", unit: "ea", position: 33 },
  { kind: "expense", label: "Safety watch / attendant", unit: "h", position: 34 }
];

// ─── tiny persistence layer ────────────────────────────────────────────
// localStorage, for the few preferences that belong to this device rather
// than to the account — the light/dark choice is the only one so far, and
// it should stay here rather than becoming a column. Anything that is a
// fact about the business goes to Supabase through db.js instead.
export const Store = {
  load(key, fallback) {
    try {
      const raw = localStorage.getItem("nde." + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  },
  save(key, value) {
    try { localStorage.setItem("nde." + key, JSON.stringify(value)); } catch (e) {}
  }
};

// The rest of data.js — the helpers that decide what an amount looks like,
// what day it is, which screens a person gets, whose phone number a form
// pre-fills, and who is allowed to see a price.
//
// Run with: node --test src/data.test.mjs
//
// The date and money *arithmetic* is covered next door in dates.test.mjs,
// numbers.test.mjs and periods.test.mjs. What is here is the other half:
// small functions with no arithmetic in them at all, each of which answers a
// question several screens ask, and each of which has a failure mode that
// looks like a blank screen or a wrong permission rather than a wrong number.
//
// The last test in the file is the drift check CLAUDE.md asks for: the
// role → tabs defaults exist in two places, and they have drifted before.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  money, todayLocal, tabList, UNIVERSAL_TABS,
  primaryContact, crewRoleFor, seesPrices, ROLE_PRESETS, ticketStatusWriteRefusal
} from "./data.js";

// ── money ────────────────────────────────────────────────────────────────
// The one formatter. Every amount on a screen, in an export and on a printed
// invoice goes through it, so "two decimals, always" is not cosmetic — a
// total that renders as $1,240.5 reads as a different number.

test("money always shows two decimals and groups thousands", () => {
  assert.equal(money(0), "$0.00");
  assert.equal(money(7), "$7.00");
  assert.equal(money(1234.5), "$1,234.50");
  assert.equal(money(1234567.891), "$1,234,567.89");
});

test("money treats nonsense as zero rather than printing NaN at a client", () => {
  assert.equal(money(null), "$0.00");
  assert.equal(money(undefined), "$0.00");
  assert.equal(money(""), "$0.00");
  assert.equal(money("not a number"), "$0.00");
  // A numeric string is a number: totals arrive from PostgREST as strings.
  assert.equal(money("1234.5"), "$1,234.50");
});

// ── todayLocal ───────────────────────────────────────────────────────────
// The date a ticket, a JHA and a timesheet row are filed under. It must be
// the day it is *here*, not in UTC: in Alberta the UTC date rolls over at
// 17:00, so toISOString() dated every evening ticket tomorrow and pushed the
// 15th's evening work into the next pay period.

// Runs `fn` with the clock stopped at a local wall-clock moment. Built from
// local components, so the assertion holds whatever timezone the test
// machine is in — which is the point: the answer is the local day, always.
function atLocalTime(y, m, d, hh, mm, fn) {
  const Real = Date;
  const fixed = new Real(y, m - 1, d, hh, mm);
  class Fake extends Real {
    constructor(...args) { super(...(args.length ? args : [fixed.getTime()])); }
    static now() { return fixed.getTime(); }
  }
  globalThis.Date = Fake;
  try { return fn(fixed); } finally { globalThis.Date = Real; }
}

test("todayLocal is the local day, morning and evening alike", () => {
  atLocalTime(2026, 8, 15, 9, 0, () => assert.equal(todayLocal(), "2026-08-15"));
  atLocalTime(2026, 8, 15, 23, 45, () => assert.equal(todayLocal(), "2026-08-15"));
});

test("todayLocal does not follow UTC over the day boundary", () => {
  atLocalTime(2026, 8, 15, 23, 45, fixed => {
    // Wherever this runs, the moment above is late enough that some zones are
    // already on the 16th in UTC. Where the runner is one of them, this is
    // the assertion that catches toISOString() creeping back in.
    if (fixed.toISOString().slice(0, 10) !== "2026-08-15") {
      assert.notEqual(todayLocal(), fixed.toISOString().slice(0, 10),
        "todayLocal must answer the local day, not the UTC one");
    }
    assert.equal(todayLocal(), "2026-08-15");
  });
});

test("todayLocal pads a single-digit month and day", () => {
  atLocalTime(2026, 1, 5, 12, 0, () => assert.equal(todayLocal(), "2026-01-05"));
});

// ── tabList ──────────────────────────────────────────────────────────────
// Read on every sign-in. A null tab_access column once took the whole app to
// a blank screen, and an account with no tabs at all must stay locked out —
// that emptiness is what App reads as "profile with no access".

test("contacts is added to any account that has access at all", () => {
  assert.deepEqual(tabList(["board"]), ["board", "contacts"]);
  assert.deepEqual(UNIVERSAL_TABS, ["contacts"]);
});

test("an account already holding contacts does not get it twice", () => {
  assert.deepEqual(tabList(["board", "contacts"]), ["board", "contacts"]);
});

test("no tabs stays no tabs — the universal one never unlocks an empty account", () => {
  assert.deepEqual(tabList([]), []);
  assert.deepEqual(tabList(null), []);
  assert.deepEqual(tabList(undefined), []);
  // A column that is not an array at all — anything but a list is no access.
  assert.deepEqual(tabList("board"), []);
  assert.deepEqual(tabList({ board: true }), []);
});

test("tabList hands back a new list rather than editing the profile's", () => {
  const stored = ["board"];
  const got = tabList(stored);
  assert.notEqual(got, stored);
  assert.deepEqual(stored, ["board"], "the row the caller passed in is untouched");
});

// ── primaryContact ───────────────────────────────────────────────────────
// What every form pre-fills its rep from. Getting the wrong one addresses a
// client's approval email to somebody at another company.

const CONTACTS = [
  { id: "a", org_type: "client", org_id: "C1", is_primary: false, name: "Second at C1" },
  { id: "b", org_type: "client", org_id: "C1", is_primary: true, name: "Primary at C1" },
  { id: "c", org_type: "client", org_id: "C2", is_primary: true, name: "Primary at C2" },
  { id: "d", org_type: "contractor", org_id: "C1", is_primary: true, name: "Primary at contractor C1" },
  { id: "e", org_type: "client", org_id: "C3", is_primary: false, name: "Only one at C3" },
  { id: "f", org_type: "client", org_id: "C3", is_primary: false, name: "Also at C3" }
];

test("the primary is the one that comes back", () => {
  assert.equal(primaryContact(CONTACTS, "client", "C1").name, "Primary at C1");
});

test("an org id is not enough — the type has to match too", () => {
  // Client C1 and contractor C1 are different organisations that happen to
  // share an id shape; matching on the id alone crosses them.
  assert.equal(primaryContact(CONTACTS, "contractor", "C1").name, "Primary at contractor C1");
});

test("with nobody promoted, the first on file stands in", () => {
  assert.equal(primaryContact(CONTACTS, "client", "C3").name, "Only one at C3");
});

test("nothing to answer with is null, never a stranger", () => {
  assert.equal(primaryContact(CONTACTS, "client", null), null);
  assert.equal(primaryContact(CONTACTS, "client", ""), null);
  assert.equal(primaryContact(CONTACTS, "client", "C9"), null, "an org with no contacts");
  assert.equal(primaryContact(null, "client", "C1"), null, "before the directory has loaded");
  assert.equal(primaryContact([], "client", "C1"), null);
});

// ── crewRoleFor ──────────────────────────────────────────────────────────
// The crew_role a person carries onto a ticket. Only Helper is a helper;
// every office rank on a crew is there doing a technician's work.

test("a helper is a Helper and everyone else is a Technician", () => {
  assert.equal(crewRoleFor({ role: "Helper" }), "Helper");
  assert.equal(crewRoleFor({ role: "Technician" }), "Technician");
  assert.equal(crewRoleFor({ role: "Admin" }), "Technician");
  assert.equal(crewRoleFor({ role: "Coordinator" }), "Technician");
});

test("an unknown or missing rank falls to Technician, not to nothing", () => {
  assert.equal(crewRoleFor({ role: "Apprentice" }), "Technician");
  assert.equal(crewRoleFor({}), "Technician");
  assert.equal(crewRoleFor(null), "Technician");
  assert.equal(crewRoleFor(undefined), "Technician");
});

// ── seesPrices ───────────────────────────────────────────────────────────
// The one client-side answer to "does this person see money". The database
// enforces the same rule and hands other roles null totals; this is what
// keeps Job detail, Open tickets and the tracker from disagreeing about it.

test("prices are an Admin's and a Technician's", () => {
  assert.equal(seesPrices({ role: "Admin" }), true);
  assert.equal(seesPrices({ role: "Technician" }), true);
});

test("nobody else sees a price, including nobody at all", () => {
  assert.equal(seesPrices({ role: "Coordinator" }), false);
  assert.equal(seesPrices({ role: "Helper" }), false);
  assert.equal(seesPrices({}), false);
  assert.equal(seesPrices(null), false);
  assert.equal(seesPrices(undefined), false);
  // Always a boolean: it is spread through JSX as `{priced && …}`, and a
  // falsy non-boolean (0, "") renders itself onto the screen.
  assert.equal(typeof seesPrices(null), "boolean");
});

// ── which saves a ticket's status lets through ───────────────────────────
// updateTicket asks this before it prices a line or touches a crew row. Every
// clause of it is about a bill the client has already been shown.

test("an approved or invoiced ticket refuses a save outright", () => {
  assert.equal(
    ticketStatusWriteRefusal("Approved", "Draft", "KK-0818-26-01"),
    "Ticket KK-0818-26-01 is approved — it can't be changed. Raise a new ticket for any correction.");
  assert.match(ticketStatusWriteRefusal("Invoiced", "Draft", "KK-1"), /is invoiced — it can't be changed/);
  // The status the save carries makes no difference: what the client agreed
  // to pay is not editable by any route the app offers.
  assert.ok(ticketStatusWriteRefusal("Approved", "Awaiting approval", "KK-1"));
  assert.ok(ticketStatusWriteRefusal("Approved", "Approved", "KK-1"));
});

test("a Draft save over a ticket sent for signature is refused", () => {
  // "Draft" is what every save sends — the editor hardcodes it, and a queued
  // replay carries the string it was enqueued with hours ago. Letting it land
  // moves the money under a live approval link.
  assert.match(
    ticketStatusWriteRefusal("Awaiting approval", "Draft", "KK-0818-26-01"),
    /^Ticket KK-0818-26-01 has been sent for the client's signature — cancel the approval/);
  // Sending it for signature, though, is exactly the save that has to land.
  assert.equal(ticketStatusWriteRefusal("Awaiting approval", "Awaiting approval", "KK-1"), null);
});

test("an ordinary draft save is not refused", () => {
  assert.equal(ticketStatusWriteRefusal("Draft", "Draft", "KK-1"), null);
  assert.equal(ticketStatusWriteRefusal("Draft", "Awaiting approval", "KK-1"), null);
  // A status nobody has heard of is not a reason to refuse a save — the
  // database's own policies are the backstop, and inventing a refusal here
  // would strand a ticket with nothing on screen to explain it.
  assert.equal(ticketStatusWriteRefusal("Queried", "Draft", "KK-1"), null);
  assert.equal(ticketStatusWriteRefusal(null, "Draft", "KK-1"), null);
});

// ── ROLE_PRESETS against the database ────────────────────────────────────
// The drift check CLAUDE.md asks for. The role → tabs defaults live in two
// places that must move together: ROLE_PRESETS here, and public.tabs_for_role()
// in the migrations, which is what create-user and the provisioning trigger
// seed a new account from. They drifted once and a new Admin came out unable
// to write equipment, with nothing anywhere to say why.
//
// The SQL is read rather than executed — no database, and none needed: the
// function is a plain CASE of array literals. The last migration that
// redefines it wins, because migrations apply in filename order.

const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);
const HANDOVER = new URL("../../supabase/handover/", import.meta.url);
const DEFINES_TABS_FOR_ROLE = /(create|replace)\s+function\s+public\.tabs_for_role/i;

function tabsForRoleFromSql() {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  const defining = files.filter(f =>
    DEFINES_TABS_FOR_ROLE.test(readFileSync(new URL(f, MIGRATIONS), "utf8")));
  assert.ok(defining.length, "no migration defines public.tabs_for_role");

  const latest = defining[defining.length - 1];
  const sql = readFileSync(new URL(latest, MIGRATIONS), "utf8");
  // From the last definition in that file to the end of its body.
  const from = sql.toLowerCase().lastIndexOf("function public.tabs_for_role");
  const body = sql.slice(from, sql.indexOf("$$;", from));

  const roles = {};
  for (const m of body.matchAll(/when\s+'(\w+)'\s*then\s+array\[([^\]]*)\]/gi)) {
    roles[m[1]] = m[2].split(",").map(s => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  }
  return { file: latest, roles };
}

test("ROLE_PRESETS matches tabs_for_role() in the migrations", () => {
  const { file, roles } = tabsForRoleFromSql();
  assert.ok(Object.keys(roles).length, `could not read any role out of ${file}`);

  assert.deepEqual(
    Object.keys(roles).sort(), Object.keys(ROLE_PRESETS).sort(),
    `${file} and ROLE_PRESETS do not name the same roles`);

  for (const role of Object.keys(ROLE_PRESETS)) {
    // Sorted: tab_access is a set, and the order it is written in is not
    // meant to carry any meaning.
    assert.deepEqual(
      [...roles[role]].sort(), [...ROLE_PRESETS[role]].sort(),
      `${role}'s tabs differ between data.js and ${file} — move both together`);
  }
});

test("no unapplied handover SQL quietly redefines tabs_for_role", () => {
  // supabase/handover holds SQL that is not part of the migration history —
  // the wipes, the probe files a migration was checked with, and any draft
  // fix still waiting on Kyle's word. The check above reads the migrations,
  // so a redefinition parked in here would be invisible to it: the test
  // would go on comparing ROLE_PRESETS against the old migration and pass,
  // right up to the day the draft was applied and every new account came out
  // with the wrong tabs.
  //
  // Asserting there is none, rather than folding these into "last definition
  // wins": an unapplied file is not what the database is running, so treating
  // it as the winner would be its own kind of wrong. If one ever does define
  // the function, this fails and the person adding it decides — most likely
  // by applying it and writing the migration, which puts it back where the
  // check above can see it.
  const stray = readdirSync(HANDOVER)
    .filter(f => f.endsWith(".sql"))
    .filter(f => DEFINES_TABS_FOR_ROLE.test(readFileSync(new URL(f, HANDOVER), "utf8")));
  assert.deepEqual(stray, [],
    "handover SQL defines public.tabs_for_role — apply it and write the migration, or the drift check above is reading the wrong definition");
});

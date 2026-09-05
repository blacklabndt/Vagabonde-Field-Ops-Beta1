// The parts of a backup that are just data and arithmetic: which tables go
// in and in what order, what the manifest says, which old folders retention
// throws away, and a drive that answers without a network.
//
// These three modules are imported straight out of supabase/functions/ —
// node strips their types (Node 22.18+ / 24) — which is why they are
// written in erasable TypeScript with no imports of their own beyond the
// shared schedule. If this file ever fails with "Unknown file extension" or
// a syntax error inside a .ts, something non-erasable (an enum, a parameter
// property) has been added to one of them and must come back out.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  LOAD_ORDER, BACKUP_TABLES, WIPE_ORDER, NEVER_WIPED, BUCKETS,
  APP_SETTINGS_SECRETS, APP_SETTINGS_NEVER_RESTORED,
  CURSOR_COLUMN, TABLE_KEYS, JOB_CHILD_TABLES,
  PAGE_ROWS, MAX_PART_ROWS, stripSecrets, partFileName, chunkRows
} from "../../supabase/functions/_shared/backupTables.ts";

import {
  MANIFEST_NAME, BACKUP_ROOT_NAME, TABLES_FOLDER, FILES_FOLDER,
  newManifest, recordTable, recordFiles, finishManifest, jobsIndex,
  folderStamp, beforeRestoreName, isBeforeRestore, foldersToDelete,
  schemaTooNew, fileEntryName, parseFileEntryName
} from "../../supabase/functions/_shared/backupManifest.ts";

import {
  FakeDrive, GoogleDrive, OneDrive, Dropbox, authorizeUrl, SCOPES, PROVIDERS
} from "../../supabase/functions/_shared/drive.ts";

import {
  NONCE_MS, PROVIDERS as OAUTH_PROVIDERS, providerInPath, callbackUri,
  credentialsFrom, nonceRefusal, providerRefusal
} from "../../supabase/functions/_shared/backupOauth.ts";

import { BACKUP_PROVIDERS } from "./backupPanelLogic.js";

const ROOT = new URL("../../", import.meta.url);
const read = rel => readFileSync(new URL(rel, ROOT), "utf8");

// ── The table lists ──────────────────────────────────────────────────────

test("every backed-up table is also a loaded table, and the other way round", () => {
  assert.deepEqual(BACKUP_TABLES, LOAD_ORDER);
  assert.equal(new Set(LOAD_ORDER).size, LOAD_ORDER.length, "no table twice");
});

test("the spec's table list is what is actually backed up", () => {
  // The spec names issued_ticket_numbers; the table is burned_ticket_numbers.
  const expected = [
    "clients", "contractors", "contacts", "profiles", "jobs", "tickets",
    "ticket_lines", "ticket_crew", "jhas", "reports", "rate_schedules",
    "rate_lines", "rate_overrides", "rate_line_history", "equipment",
    "timesheet_approvals", "chat_messages", "chat_reactions", "chat_reads",
    "push_subscriptions", "arcade_scores", "burned_ticket_numbers", "app_settings"
  ];
  assert.deepEqual([...BACKUP_TABLES].sort(), expected.sort());
});

test("parents come before their children in the load order", () => {
  const at = t => LOAD_ORDER.indexOf(t);
  // Every foreign key the schema actually declares, written out as
  // [parent, child] pairs and read off supabase/migrations/ by hand:
  // the baseline's FOREIGN KEY block plus the chat migrations' inline
  // `references`. contacts is a parent of jobs (client_contact_id and
  // contractor_contact_id) and has no foreign key of its own — org_id is
  // a discriminated reference, not a constraint.
  const pairs = [
    ["clients", "jobs"], ["contractors", "jobs"], ["contacts", "jobs"],
    ["profiles", "jobs"], ["jobs", "tickets"], ["profiles", "tickets"],
    ["tickets", "ticket_lines"], ["tickets", "ticket_crew"], ["profiles", "ticket_crew"],
    ["jobs", "jhas"], ["profiles", "jhas"], ["jobs", "reports"],
    ["clients", "rate_schedules"], ["rate_schedules", "rate_lines"],
    ["rate_lines", "rate_line_history"], ["rate_schedules", "rate_line_history"],
    ["profiles", "rate_line_history"],
    ["jobs", "rate_overrides"], ["profiles", "equipment"],
    ["profiles", "timesheet_approvals"], ["profiles", "chat_messages"],
    ["chat_messages", "chat_reactions"], ["profiles", "chat_reactions"],
    ["profiles", "chat_reads"],
    ["profiles", "push_subscriptions"], ["profiles", "arcade_scores"]
  ];
  for (const [parent, child] of pairs) {
    assert.ok(at(parent) >= 0 && at(child) >= 0, `${parent}/${child} must both be in the load order`);
    assert.ok(at(parent) < at(child), `${parent} must load before ${child}`);
  }
});

test("the wipe order is the handover script's own order", () => {
  // The restore empties the database before it loads it, and the one place
  // this project has ever worked out a safe delete order is the handover
  // wipe. Read it back rather than re-deriving it.
  const sql = read("supabase/handover/wipe-seed-data.sql");
  const inScript = [...sql.matchAll(/delete from public\.(\w+)/g)].map(m => m[1]);
  const shared = WIPE_ORDER.filter(t => inScript.includes(t));
  const sameInScript = inScript.filter(t => shared.includes(t));
  assert.deepEqual(shared, [...new Set(sameInScript)], "the wipe order must follow the handover script");
});

test("rate_lines is emptied before its history, because deleting one writes the other", () => {
  // rate_lines_history_trigger is AFTER INSERT OR DELETE OR UPDATE on
  // rate_lines and inserts a history row for each. Clearing
  // rate_line_history first therefore leaves a phantom row per line deleted
  // after it, and the load that follows collides with it. The restore's
  // ruling comes from the trigger's INSERT arm: rate_lines is loaded first,
  // then every rate_line_history row is deleted, and only then is the
  // backup's history file loaded — so the rows the inserts wrote are gone
  // before the real history goes in.
  const at = t => WIPE_ORDER.indexOf(t);
  assert.ok(at("rate_lines") >= 0 && at("rate_line_history") >= 0);
  assert.ok(at("rate_lines") < at("rate_line_history"),
    "rate_lines must be deleted before rate_line_history");
  const sql = read("supabase/handover/wipe-seed-data.sql");
  assert.ok(sql.indexOf("delete from public.rate_lines") < sql.indexOf("delete from public.rate_line_history"),
    "the handover script must delete them in that order too");
});

test("everything loaded is wiped first, except the settings row", () => {
  assert.deepEqual(NEVER_WIPED, ["app_settings"]);
  for (const t of LOAD_ORDER) {
    if (NEVER_WIPED.includes(t)) {
      assert.ok(!WIPE_ORDER.includes(t), `${t} must never be wiped`);
    } else {
      assert.ok(WIPE_ORDER.includes(t), `${t} is loaded but never wiped — the load would collide`);
    }
  }
});

test("profiles is wiped last, because everything else names it", () => {
  assert.equal(WIPE_ORDER[WIPE_ORDER.length - 1], "profiles");
});

test("the wipe clears the two log tables the backup does not carry", () => {
  // audit_log.actor_id and function_errors have foreign keys to profiles, so
  // they must go before profiles can. They are not backed up (they are
  // operational noise), so a restored database starts with both empty.
  assert.ok(WIPE_ORDER.includes("audit_log"));
  assert.ok(WIPE_ORDER.includes("function_errors"));
  assert.ok(!BACKUP_TABLES.includes("audit_log"));
  assert.ok(!BACKUP_TABLES.includes("function_errors"));
});

test("every table has a primary key and a paging answer", () => {
  for (const t of BACKUP_TABLES) {
    assert.ok(Array.isArray(TABLE_KEYS[t]) && TABLE_KEYS[t].length, `${t} needs a primary key`);
    assert.ok(t in CURSOR_COLUMN, `${t} needs a cursor column or an explicit null`);
    const cursor = CURSOR_COLUMN[t];
    if (cursor !== null) {
      assert.deepEqual(TABLE_KEYS[t], [cursor], `${t}'s cursor must be its whole primary key`);
    } else {
      assert.ok(TABLE_KEYS[t].length > 1, `${t} only pages by offset if its key is composite`);
    }
  }
});

test("only the composite-key tables page by offset", () => {
  const offset = BACKUP_TABLES.filter(t => CURSOR_COLUMN[t] === null);
  assert.deepEqual(offset.sort(), ["arcade_scores", "chat_reactions"].sort());
});

test("the buckets are the five the app actually stores in", () => {
  const sql = read("supabase/handover/wipe-seed-data.sql");
  for (const b of BUCKETS) assert.ok(sql.includes(`'${b}'`), `${b} should appear in the wipe script`);
  assert.deepEqual(BUCKETS, ["reports", "jhas", "shared", "timesheets", "chat-media"]);
});

// ── Secrets ──────────────────────────────────────────────────────────────

// Every column app_settings has ever been given, read off the migrations.
// Only that table: a scan of every column in every migration would sweep up
// pdf_key, client_key and approval_token, which are records, not
// credentials, and would make this test impossible to pass.
function appSettingsColumns() {
  const dir = new URL("supabase/migrations/", ROOT);
  const columns = new Set();
  // The table was born as mail_settings and renamed in 20260902050835.
  const NAMES = "(?:app_settings|mail_settings)";
  for (const f of readdirSync(dir).sort()) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    // create table public.mail_settings ( … );
    for (const m of sql.matchAll(new RegExp(`create table (?:if not exists )?public\\.${NAMES}\\s*\\(([\\s\\S]*?)\\n\\);`, "g"))) {
      for (const line of m[1].split("\n")) {
        const col = /^\s{2}(\w+)\s+\w/.exec(line);
        if (col && !/^(constraint|primary|unique|check|foreign)$/i.test(col[1])) columns.add(col[1]);
      }
    }
    // alter table public.app_settings … add column [if not exists] name …;
    for (const m of sql.matchAll(new RegExp(`alter table public\\.${NAMES}([\\s\\S]*?);`, "g"))) {
      for (const c of m[1].matchAll(/add column(?: if not exists)? (\w+)/g)) columns.add(c[1]);
    }
  }
  return [...columns];
}

test("the app_settings column scan finds the columns the migrations added", () => {
  // The scan itself has to be worth trusting, or the test below it is a
  // test of an empty list.
  const columns = appSettingsColumns();
  for (const known of ["resend_api_key", "from_reports", "klipy_api_key",
    "approval_base_url", "backup_provider", "backup_refresh_token",
    "backup_client_secret_dropbox", "backup_keep"]) {
    assert.ok(columns.includes(known), `the scan should have found ${known}`);
  }
  assert.ok(!columns.includes("constraint"), "a constraint line is not a column");
});

test("every credential column of app_settings is stripped from a backup", () => {
  // The list is checked against the migrations rather than against itself:
  // a column added later whose name says key, secret or token must be
  // added here too, and this is what says so.
  const credentials = appSettingsColumns().filter(c => /(secret|token|key)/i.test(c));
  assert.ok(credentials.length >= 6, "the scan found suspiciously few credential columns");
  for (const c of credentials) {
    assert.ok(APP_SETTINGS_SECRETS.includes(c), `${c} looks like a credential and must be stripped`);
  }
  assert.ok(APP_SETTINGS_SECRETS.includes("backup_oauth_state"), "the OAuth nonce is not a backup's business either");
});

test("stripSecrets empties the settings row's credentials and leaves the rest", () => {
  const row = {
    id: true, resend_api_key: "re_live", klipy_api_key: "kl_live",
    from_reports: "reports@vagabonde.ca", approval_base_url: "https://app.example.ca",
    backup_refresh_token: "1//refresh", backup_client_secret_google: "gsec",
    backup_provider: "google", backup_hour: 2
  };
  const [out] = stripSecrets("app_settings", [row]);
  assert.equal(out.resend_api_key, null);
  assert.equal(out.klipy_api_key, null);
  assert.equal(out.backup_refresh_token, null);
  assert.equal(out.backup_client_secret_google, null);
  assert.equal(out.from_reports, "reports@vagabonde.ca");
  assert.equal(out.backup_provider, "google");
  assert.equal(out.backup_hour, 2);
  assert.equal(row.resend_api_key, "re_live", "the caller's row must not be mutated");
});

test("stripSecrets leaves every other table exactly as it found it", () => {
  const rows = [
    { id: "a", straight_hours: 8, dose_mr: 1.25, resend_api_key: "not a credential here" },
    { id: "b", straight_hours: 0, dose_mr: null }
  ];
  // Compared against a copy taken before the call, so the assertion cannot
  // be satisfied by the function handing its own argument back mutated.
  const before = structuredClone(rows);
  assert.deepEqual(stripSecrets("ticket_crew", rows), before);
  assert.deepEqual(rows, before, "the caller's rows must not be touched");
});

test("a restore never writes back the drive connection it is running through", () => {
  for (const c of ["backup_provider", "backup_refresh_token", "backup_root_folder_id", "backup_next_run_at", "backup_hour"]) {
    assert.ok(APP_SETTINGS_NEVER_RESTORED.includes(c), `${c} must not be restored`);
  }
  assert.ok(!APP_SETTINGS_NEVER_RESTORED.includes("resend_api_key"));
  // Every backup_* column the migrations added, without exception: a new
  // one that slipped through would be restored out of a backup and point
  // the running restore at somebody else's drive.
  for (const c of appSettingsColumns().filter(c => c.startsWith("backup_"))) {
    assert.ok(APP_SETTINGS_NEVER_RESTORED.includes(c), `${c} is part of the connection and must not be restored`);
  }
});

// ── Paging and parts ─────────────────────────────────────────────────────

test("the page size is PostgREST's own silent cap", () => {
  assert.equal(PAGE_ROWS, 1000);
  assert.ok(MAX_PART_ROWS >= PAGE_ROWS && MAX_PART_ROWS % PAGE_ROWS === 0);
});

test("chunkRows splits at the cap and never drops or duplicates a row", () => {
  const rows = Array.from({ length: 2501 }, (_, i) => i);
  const parts = chunkRows(rows, 1000);
  assert.deepEqual(parts.map(p => p.length), [1000, 1000, 501]);
  assert.deepEqual(parts.flat(), rows);
  assert.deepEqual(chunkRows([], 1000), []);
  assert.deepEqual(chunkRows([1, 2], 1000), [[1, 2]]);
});

test("part files are flat names, numbered from one, that sort in order", () => {
  assert.equal(partFileName("tickets", 0), "tickets.01.json.gz");
  assert.equal(partFileName("tickets", 9), "tickets.10.json.gz");
  assert.ok(!partFileName("tickets", 0).includes("/"), "a drive name is one path segment");
  const names = [0, 1, 10, 2].map(i => partFileName("t", i));
  assert.deepEqual([...names].sort(), ["t.01.json.gz", "t.02.json.gz", "t.03.json.gz", "t.11.json.gz"]);
});

test("a stored object's name survives the round trip through the drive", () => {
  assert.equal(TABLES_FOLDER, "tables");
  assert.equal(FILES_FOLDER, "files");
  const cases = [
    ["reports", "8f1c/report-2026-08.pdf"],
    ["chat-media", "2026/08/voice note (1).webm"],
    ["shared", "Safety & procedures/RT+SOP.pdf"]
  ];
  for (const [bucket, key] of cases) {
    const name = fileEntryName(bucket, key);
    assert.ok(!name.includes("/"), `${name} must be one path segment`);
    assert.deepEqual(parseFileEntryName(name), { bucket, key });
  }
  assert.equal(parseFileEntryName("not-a-backup-file"), null);
});

test("restoring chosen jobs reaches for exactly the tables a job owns", () => {
  assert.deepEqual(JOB_CHILD_TABLES,
    ["tickets", "ticket_lines", "ticket_crew", "jhas", "reports", "rate_overrides"]);
});

// ── The manifest ─────────────────────────────────────────────────────────

test("a folder is stamped on Grande Prairie's clock", () => {
  assert.equal(folderStamp(Date.parse("2026-09-04T08:05:00Z")), "2026-09-04 02-05");
  assert.equal(folderStamp(Date.parse("2026-01-04T09:05:00Z")), "2026-01-04 02-05");
  assert.equal(BACKUP_ROOT_NAME, "VagaboNDE backups");
  assert.equal(MANIFEST_NAME, "manifest.json");
});

test("a manifest records what went in and says what it holds", () => {
  let m = newManifest("0.9.0-Beta", "20260904135107", "2026-09-04T08:00:00.000Z");
  m = recordTable(m, "tickets", 2501, ["tickets.01.json.gz", "tickets.02.json.gz"]);
  m = recordTable(m, "clients", 12, ["clients.01.json.gz"]);
  m = recordFiles(m, 340, 1234567);
  m = finishManifest(m, "2026-09-04T08:41:00.000Z");
  assert.equal(m.app_version, "0.9.0-Beta");
  assert.equal(m.schema_version, "20260904135107");
  assert.equal(m.tables.tickets.rows, 2501);
  assert.deepEqual(m.tables.tickets.parts, ["tickets.01.json.gz", "tickets.02.json.gz"]);
  assert.equal(m.files.count, 340);
  assert.equal(m.files.bytes, 1234567);
  assert.equal(m.finished_at, "2026-09-04T08:41:00.000Z");
  assert.match(m.note, /hours and dose/i, "the manifest must say what a backup contains");
  // It has to survive a round trip through the drive as bytes.
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
});

test("recordFiles adds up across the slices a run is made of", () => {
  let m = newManifest("0.9.0-Beta", null, "2026-09-04T08:00:00.000Z");
  m = recordFiles(m, 100, 1000);
  m = recordFiles(m, 40, 500);
  assert.deepEqual(m.files, { count: 140, bytes: 1500 });
});

test("the jobs index is what the per-job restore picks from", () => {
  const index = jobsIndex({
    jobs: [
      { id: "j1", job_number: "25-0001", project: "Wapiti tie-in", status: "Active", created_at: "2026-08-01T12:00:00Z", client_id: "c1" },
      { id: "j2", job_number: "25-0002", project: "Kakwa", status: "Closed", created_at: "2026-08-02T12:00:00Z", client_id: null }
    ],
    clients: [{ id: "c1", name: "Northgate Energy" }],
    tickets: [{ job_id: "j1" }, { job_id: "j1" }],
    jhas: [{ job_id: "j2" }],
    reports: [{ job_id: "j1" }]
  });
  assert.deepEqual(index, [
    { id: "j1", job_number: "25-0001", client: "Northgate Energy", project: "Wapiti tie-in", created_at: "2026-08-01T12:00:00Z", status: "Active", tickets: 2, jhas: 0, reports: 1 },
    { id: "j2", job_number: "25-0002", client: "", project: "Kakwa", created_at: "2026-08-02T12:00:00Z", status: "Closed", tickets: 0, jhas: 1, reports: 0 }
  ]);
});

// ── Retention ────────────────────────────────────────────────────────────

test("retention keeps the newest N and throws the rest away", () => {
  const names = ["2026-09-01 02-00", "2026-09-02 02-00", "2026-09-03 02-00", "2026-09-04 02-00"];
  assert.deepEqual(foldersToDelete(names, 2), ["2026-09-01 02-00", "2026-09-02 02-00"]);
  assert.deepEqual(foldersToDelete(names, 4), []);
  assert.deepEqual(foldersToDelete(names, 10), []);
  assert.deepEqual(foldersToDelete([], 3), []);
});

test("retention reads the folders in date order however they arrive", () => {
  const shuffled = ["2026-09-04 02-00", "2026-09-01 02-00", "2026-09-03 02-00", "2026-09-02 02-00"];
  assert.deepEqual(foldersToDelete(shuffled, 1),
    ["2026-09-01 02-00", "2026-09-02 02-00", "2026-09-03 02-00"]);
});

test("retention never touches a before-restore folder", () => {
  const names = [
    "2026-09-01 02-00", "before-restore 2026-09-02 11-30",
    "2026-09-03 02-00", "2026-09-04 02-00", "notes"
  ];
  assert.equal(beforeRestoreName("2026-09-02 11-30"), "before-restore 2026-09-02 11-30");
  assert.equal(isBeforeRestore("before-restore 2026-09-02 11-30"), true);
  assert.equal(isBeforeRestore("2026-09-02 11-30"), false);
  // "notes" is not a backup folder either — a person's own folder in the
  // same drive must survive.
  assert.deepEqual(foldersToDelete(names, 2), ["2026-09-01 02-00"]);
});

test("a backup from a newer schema than the live one is refused", () => {
  assert.equal(schemaTooNew("20260910000000", "20260904135107"), true);
  assert.equal(schemaTooNew("20260904135107", "20260904135107"), false);
  assert.equal(schemaTooNew("20260901000000", "20260904135107"), false);
  // Unknown either side is not proof of anything, so it is not a refusal.
  assert.equal(schemaTooNew(null, "20260904135107"), false);
  assert.equal(schemaTooNew("20260910000000", null), false);
});

// ── The drive, against the fake ──────────────────────────────────────────

const bytes = s => new TextEncoder().encode(s);
const text = b => new TextDecoder().decode(b);

test("the fake drive answers the whole interface", async () => {
  const drive = new FakeDrive();
  const root = drive.rootId();
  const folder = await drive.createFolder(root, "VagaboNDE backups");
  const run = await drive.createFolder(folder, "2026-09-04 02-00");

  assert.deepEqual((await drive.listFolders(root)).map(f => f.name), ["VagaboNDE backups"]);
  assert.deepEqual((await drive.listFolders(folder)).map(f => f.name), ["2026-09-04 02-00"]);

  const id = await drive.upload(run, "manifest.json", bytes('{"ok":true}'), "application/json");
  assert.deepEqual((await drive.listFiles(run)).map(f => f.name), ["manifest.json"]);
  assert.equal(text(await drive.download(id)), '{"ok":true}');

  await drive.delete(id);
  assert.deepEqual(await drive.listFiles(run), []);
});

test("the fake drive overwrites a name rather than doubling it, as the real three do", async () => {
  const drive = new FakeDrive();
  const folder = await drive.createFolder(drive.rootId(), "run");
  await drive.upload(folder, "clients.01.json.gz", bytes("first"), "application/gzip");
  const second = await drive.upload(folder, "clients.01.json.gz", bytes("second"), "application/gzip");
  assert.equal((await drive.listFiles(folder)).length, 1);
  assert.equal(text(await drive.download(second)), "second");
});

test("deleting a folder takes what is inside it", async () => {
  const drive = new FakeDrive();
  const folder = await drive.createFolder(drive.rootId(), "old");
  const file = await drive.upload(folder, "a.json", bytes("a"), "application/json");
  await drive.delete(folder);
  assert.deepEqual(await drive.listFolders(drive.rootId()), []);
  await assert.rejects(() => drive.download(file), /not found/i);
});

test("the fake can be told to fail, so retries can be tested", async () => {
  const drive = new FakeDrive();
  const folder = await drive.createFolder(drive.rootId(), "run");
  drive.failNextUploads = 2;
  await assert.rejects(() => drive.upload(folder, "a", bytes("a"), "text/plain"), /drive is unavailable/i);
  await assert.rejects(() => drive.upload(folder, "a", bytes("a"), "text/plain"), /drive is unavailable/i);
  const id = await drive.upload(folder, "a", bytes("a"), "text/plain");
  assert.equal(text(await drive.download(id)), "a");
});

// ── The three real drives, against a stubbed fetch ───────────────────────
// Nothing here touches a network. withFetch swaps globalThis.fetch for a
// stub that records every request and answers it, and puts the real one
// back afterwards however the test ends — so the parts of each provider
// class that are pure protocol can be read back off the requests
// themselves: which name it asks about, where it resumes an upload, and
// what it does about a folder that is already there.

async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return await stub(String(url), init, calls.length - 1);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });

const GOOGLE_LIST = "https://www.googleapis.com/drive/v3/files?";

test("Google resumes where the 308 says it got to, not where the sender hoped", async () => {
  // A resumable PUT can be accepted in part. Google says how much it kept
  // in the Range header of its 308, and carrying on past that would leave a
  // hole in the middle of the file: the upload "succeeds", the manifest
  // counts the rows, and the gzip is corrupt.
  const size = 6 * 1024 * 1024;          // one 8 MiB chunk covers the body…
  const kept = 1024 * 1024;              // …of which Google keeps 1 MiB.
  const ranges = [];
  const drive = new GoogleDrive("tok");

  const id = await withFetch(async (url, init) => {
    if (url.startsWith(GOOGLE_LIST)) return json({ files: [] });
    if (url.includes("uploadType=resumable")) {
      return json({}, 200, { Location: "https://upload.example/session-1" });
    }
    ranges.push(init.headers["Content-Range"]);
    if (ranges.length === 1) {
      return new Response(null, { status: 308, headers: { Range: `bytes=0-${kept - 1}` } });
    }
    return json({ id: "file-1" });
  }, () => drive.upload("folder-1", "tickets.01.json.gz", new Uint8Array(size), "application/gzip"));

  assert.equal(id, "file-1");
  assert.deepEqual(ranges, [
    `bytes 0-${size - 1}/${size}`,
    `bytes ${kept}-${size - 1}/${size}`
  ]);
});

test("a 308 with no Range at all is Google saying it took the whole chunk", async () => {
  const size = 10 * 1024 * 1024;         // two chunks: 8 MiB then 2 MiB.
  const chunk = 8 * 1024 * 1024;
  const ranges = [];
  const drive = new GoogleDrive("tok");

  const id = await withFetch(async (url, init) => {
    if (url.startsWith(GOOGLE_LIST)) return json({ files: [] });
    if (url.includes("uploadType=resumable")) {
      return json({}, 200, { Location: "https://upload.example/session-2" });
    }
    ranges.push(init.headers["Content-Range"]);
    if (ranges.length === 1) return new Response(null, { status: 308 });
    return json({ id: "file-2" });
  }, () => drive.upload("folder-1", "ticket_lines.01.json.gz", new Uint8Array(size), "application/gzip"));

  assert.equal(id, "file-2");
  assert.deepEqual(ranges, [
    `bytes 0-${chunk - 1}/${size}`,
    `bytes ${chunk}-${size - 1}/${size}`
  ]);
});

test("Google asks about the one name it is about to write, not the whole folder", async () => {
  const drive = new GoogleDrive("tok");
  const lookups = [];

  const id = await withFetch(async (url, init) => {
    if (url.startsWith(GOOGLE_LIST)) {
      lookups.push(new URL(url));
      return json({ files: [{ id: "old-1", name: "clients.01.json.gz" }] });
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return json({ id: "new-1" });
  }, async calls => {
    const out = await drive.upload("folder-1", "clients.01.json.gz", bytes("rows"), "application/gzip");
    assert.equal(calls.length, 3, "one lookup, one delete, one upload — a folder read is not one of them");
    return out;
  });

  assert.equal(id, "new-1");
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].searchParams.get("q"),
    "name = 'clients.01.json.gz' and 'folder-1' in parents and trashed = false" +
    " and mimeType != 'application/vnd.google-apps.folder'");
});

test("an apostrophe in a name does not become a Drive query syntax error", async () => {
  const drive = new GoogleDrive("tok");
  let q = "";
  await withFetch(async url => {
    if (url.startsWith(GOOGLE_LIST)) {
      q = new URL(url).searchParams.get("q");
      return json({ files: [] });
    }
    return json({ id: "new-1" });
  }, () => drive.upload("folder-1", "O'Brien \\ Sons.pdf", bytes("x"), "application/pdf"));

  // Unescaped, Google answers a 400 rather than an empty list, and the
  // upload fails on a client whose name has an apostrophe in it.
  assert.ok(q.startsWith("name = 'O\\'Brien \\\\ Sons.pdf' and "), q);
});

test("Google looks for the folder rather than making a second one of the same name", async () => {
  const drive = new GoogleDrive("tok");
  const found = await withFetch(async (url, init) => {
    assert.notEqual(init.method, "POST", "nothing may be created when the folder is already there");
    return json({ files: [{ id: "folder-9", name: "tables" }] });
  }, async calls => {
    const id = await drive.createFolder("run-1", "tables");
    assert.equal(calls.length, 1);
    return id;
  });
  assert.equal(found, "folder-9");
});

test("Google creates the folder when the lookup finds none", async () => {
  const drive = new GoogleDrive("tok");
  const made = await withFetch(async (url, init) => {
    if (!init.method || init.method === "GET") return json({ files: [] });
    assert.equal(JSON.parse(init.body).mimeType, "application/vnd.google-apps.folder");
    return json({ id: "folder-new" });
  }, () => drive.createFolder("run-1", "tables"));
  assert.equal(made, "folder-new");
});

test("OneDrive creates a folder fail-on-conflict, and looks it up rather than replacing it", async () => {
  const drive = new OneDrive("tok");
  const lookups = [];
  const bodies = [];

  const id = await withFetch(async (url, init) => {
    if (url.includes(":/tables")) {
      lookups.push(url);
      // Free the first time; taken by the time the 409 sends us back.
      return lookups.length === 1
        ? new Response(null, { status: 404 })
        : json({ id: "folder-9", folder: {} });
    }
    bodies.push(JSON.parse(init.body));
    return json({ error: { code: "nameAlreadyExists" } }, 409);
  }, () => drive.createFolder("run-1", "tables"));

  assert.equal(id, "folder-9");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]["@microsoft.graph.conflictBehavior"], "fail",
    "replace would throw away the backup already in that folder");
  assert.equal(lookups.length, 2, "the 409 is answered by looking again, not by giving up");
});

test("Dropbox returns the folder it finds rather than asking to create it", async () => {
  const drive = new Dropbox("tok");
  const endpoints = [];
  const path = await withFetch(async (url, init) => {
    endpoints.push(url.replace("https://api.dropboxapi.com/2/", ""));
    assert.equal(JSON.parse(init.body).path, "/VagaboNDE backups");
    return json({ ".tag": "folder", path_display: "/VagaboNDE backups" });
  }, () => drive.createFolder("", "VagaboNDE backups"));

  assert.equal(path, "/VagaboNDE backups");
  assert.deepEqual(endpoints, ["files/get_metadata"]);
});

test("Dropbox creates the folder when the path is free", async () => {
  const drive = new Dropbox("tok");
  const endpoints = [];
  const path = await withFetch(async url => {
    endpoints.push(url.replace("https://api.dropboxapi.com/2/", ""));
    // "path/not_found" is Dropbox saying the name is going spare.
    if (url.endsWith("files/get_metadata")) return json({ error_summary: "path/not_found/." }, 409);
    return json({ metadata: { path_display: "/VagaboNDE backups/2026-09-04 02-00" } });
  }, () => drive.createFolder("/VagaboNDE backups", "2026-09-04 02-00"));

  assert.equal(path, "/VagaboNDE backups/2026-09-04 02-00");
  assert.deepEqual(endpoints, ["files/get_metadata", "files/create_folder_v2"]);
});

// ── The consent URLs ─────────────────────────────────────────────────────

test("the three providers are asked for exactly the scopes the spec names", () => {
  assert.deepEqual(PROVIDERS, ["google", "microsoft", "dropbox"]);
  assert.equal(SCOPES.google, "https://www.googleapis.com/auth/drive.file");
  assert.equal(SCOPES.microsoft, "Files.ReadWrite offline_access");
  assert.equal(SCOPES.dropbox, "files.content.write files.content.read files.metadata.read");
});

test("each authorize URL carries the state, the redirect and offline access", () => {
  const redirect = "https://app.example.ca/backup/oauth/google";
  const google = new URL(authorizeUrl("google", "gid", redirect, "nonce123"));
  assert.equal(google.origin + google.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(google.searchParams.get("client_id"), "gid");
  assert.equal(google.searchParams.get("redirect_uri"), redirect);
  assert.equal(google.searchParams.get("response_type"), "code");
  assert.equal(google.searchParams.get("access_type"), "offline");
  assert.equal(google.searchParams.get("prompt"), "consent");
  assert.equal(google.searchParams.get("state"), "nonce123");
  assert.equal(google.searchParams.get("scope"), SCOPES.google);

  const ms = new URL(authorizeUrl("microsoft", "mid", "https://app.example.ca/backup/oauth/microsoft", "n2"));
  assert.equal(ms.origin + ms.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  assert.equal(ms.searchParams.get("response_mode"), "query");
  assert.equal(ms.searchParams.get("scope"), SCOPES.microsoft);
  assert.equal(ms.searchParams.get("state"), "n2");

  const db = new URL(authorizeUrl("dropbox", "did", "https://app.example.ca/backup/oauth/dropbox", "n3"));
  assert.equal(db.origin + db.pathname, "https://www.dropbox.com/oauth2/authorize");
  assert.equal(db.searchParams.get("token_access_type"), "offline");
  assert.equal(db.searchParams.get("scope"), SCOPES.dropbox);
  assert.equal(db.searchParams.get("state"), "n3");
});

test("an unknown provider is refused rather than guessed at", () => {
  assert.throws(() => authorizeUrl("box", "id", "https://x/y", "n"), /provider/i);
});

// ── The connection's own doors ───────────────────────────────────────────
// backup-oauth answers a browser that carries no token, so what stands in
// for one is a nonce this app minted minutes earlier. These are the checks
// that door is made of, with the network and the database taken out.

test("the provider is the last segment of the callback's path, and only if we know it", () => {
  assert.equal(providerInPath("/backup-oauth/google"), "google");
  assert.equal(providerInPath("/functions/v1/backup-oauth/microsoft"), "microsoft");
  assert.equal(providerInPath("/backup-oauth/dropbox/"), "dropbox");
  // The function's own name is not a provider, so a bare POST is not a
  // callback.
  assert.equal(providerInPath("/backup-oauth"), "");
  assert.equal(providerInPath("/functions/v1/backup-oauth"), "");
  assert.equal(providerInPath("/backup-oauth/box"), "");
  assert.equal(providerInPath("/backup-oauth/GOOGLE"), "");
  assert.equal(providerInPath(""), "");
});

test("the callback URI is built from the stored app address, origin only", () => {
  assert.deepEqual(callbackUri("https://ops.example.ca", "google"),
    { uri: "https://ops.example.ca/backup/oauth/google", base: "https://ops.example.ca" });
  assert.deepEqual(callbackUri("https://ops.example.ca/", "dropbox"),
    { uri: "https://ops.example.ca/backup/oauth/dropbox", base: "https://ops.example.ca" });
  assert.deepEqual(callbackUri("https://ops.example.ca/somewhere?x=1", "microsoft"),
    { uri: "https://ops.example.ca/backup/oauth/microsoft", base: "https://ops.example.ca" });
});

test("the panel and the function build the same string from the same stored address", () => {
  // The provider's registration holds one of these two and compares it with
  // the other. They are computed in different languages on different
  // machines; if they ever drift, every connection fails at the exchange.
  const stored = "https://ops.example.ca/";
  for (const p of PROVIDERS) {
    assert.equal(callbackUri(stored, p).uri, `https://ops.example.ca/backup/oauth/${p}`);
  }
});

test("with no app address stored the server refuses rather than guessing", () => {
  assert.throws(() => callbackUri("", "google"), /App address/i);
  assert.throws(() => callbackUri("   ", "google"), /App address/i);
  assert.throws(() => callbackUri("ops.example.ca", "google"), /App address/i);
});

test("credentials come out of the row by provider, and an incomplete pair is refused", () => {
  const row = {
    backup_client_id_google: " gid ", backup_client_secret_google: " gsecret ",
    backup_client_id_microsoft: "mid", backup_client_secret_microsoft: null,
    backup_client_id_dropbox: null, backup_client_secret_dropbox: "dsecret"
  };
  assert.deepEqual(credentialsFrom(row, "google"), { id: "gid", secret: "gsecret" });
  assert.throws(() => credentialsFrom(row, "microsoft"), /client secret|registration/i);
  assert.throws(() => credentialsFrom(row, "dropbox"), /client ID|registration/i);
  assert.throws(() => credentialsFrom({}, "google"), /registration/i);
});

test("the three provider lists are one list written three times", () => {
  // drive.ts knows how to talk to them, backupOauth.ts decides whether a
  // callback path names one, and the panel draws a Connect button per name.
  // None of the three may import the others (two are erasable TypeScript
  // read by Deno, one is browser JavaScript), so the copies are held level
  // here instead: a provider added to drive.ts alone is a drive the callback
  // answers 404 for, and one added to the panel alone is a button that
  // cannot start.
  assert.deepEqual(OAUTH_PROVIDERS, PROVIDERS);
  assert.deepEqual(BACKUP_PROVIDERS, PROVIDERS);
});

test("the callback spends the nonce it was handed and no other", () => {
  // Nulling the nonce on the settings row's id alone meant that any GET of
  // the callback address — a crawler, a stranger, a stale link — cleared the
  // nonce the Admin's Connect had just minted, and Connect could never
  // finish. The function is read back here because the fix is a filter on an
  // update, which no pure function can hold.
  const src = read("supabase/functions/backup-oauth/index.ts");
  const updates = [...src.matchAll(/\.update\(\{([^{}]*backup_oauth_state: null[^{}]*)\}\)([^;]*);/g)];
  assert.equal(updates.length, 2, "the nonce is nulled in exactly two places: disconnect, and spending it");
  for (const [, body, filters] of updates) {
    // Disconnect is an Admin's own POST and lets go of the whole connection,
    // so it clears the row's nonce unconditionally and rightly.
    if (/backup_refresh_token: null/.test(body)) continue;
    assert.match(filters, /\.eq\("backup_oauth_state",/,
      "the callback may spend only the nonce actually presented to it");
  }
  // And both callback paths — the consent screen's Cancel and the real
  // return — go through that one door.
  assert.equal((src.match(/await spendNonce\(/g) ?? []).length, 2);
});

test("a drive's own refusal is retold rather than repeated into the address bar", () => {
  // ok() in drive.ts throws "<what> failed (<status>): <up to 400 characters
  // of the provider's response body>". That body rides the redirect's why=
  // into an address bar and a browser history if it is passed through, so
  // the shape is recognised and answered in this app's own words.
  const raw = 'google token exchange failed (400): {"error":"invalid_grant","error_description":"Bad Request"}';
  const said = providerRefusal(raw);
  assert.ok(!said.includes("invalid_grant"), "the provider's body must not survive");
  assert.match(said, /google token exchange/);
  assert.match(said, /400/);

  // 401/403 is the registration, and says so.
  assert.match(providerRefusal("OneDrive account failed (401): {}"), /client ID and client secret/i);
  assert.match(providerRefusal("Dropbox folder failed (403): nope"), /client ID and client secret/i);
  // Busy is worth trying again; a 400 is not.
  assert.match(providerRefusal("Google Drive folder failed (503): <html>busy</html>"), /again in a minute/i);
  assert.match(providerRefusal("microsoft token exchange failed (429): slow down"), /again in a minute/i);
  assert.ok(!providerRefusal("Google Drive folder failed (503): <html>busy</html>").includes("<html>"));

  // Everything the app wrote itself is already a sentence and is left alone.
  for (const own of [
    "That connection link wasn't the one this app started. Press Connect again.",
    "The drive sent us back without an authorisation code.",
    "google sent an access token but no refresh token, so the connection would stop working within the hour."
  ]) {
    assert.equal(providerRefusal(own), own);
  }
  assert.equal(providerRefusal(""), "");
});

test("the nonce has to be the one we minted", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  const minted = now - 60_000;
  assert.equal(nonceRefusal("abc", "abc", minted, now), "");
  assert.match(nonceRefusal("abc", "xyz", minted, now), /wasn't the one this app started/);
  // Nothing minted at all: a callback arriving out of nowhere, or a second
  // one after the first spent it.
  assert.match(nonceRefusal("", "abc", minted, now), /wasn't the one this app started/);
  assert.match(nonceRefusal(null, "abc", minted, now), /wasn't the one this app started/);
  // An empty presented value must never match an empty stored one.
  assert.match(nonceRefusal("", "", minted, now), /wasn't the one this app started/);
});

test("the nonce goes stale at ten minutes", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  assert.equal(NONCE_MS, 10 * 60 * 1000);
  assert.equal(nonceRefusal("abc", "abc", now - NONCE_MS + 1000, now), "");
  assert.match(nonceRefusal("abc", "abc", now - NONCE_MS - 1000, now), /more than ten minutes/);
  // No mint time on the row is not "infinitely fresh".
  assert.match(nonceRefusal("abc", "abc", 0, now), /more than ten minutes/);
  assert.match(nonceRefusal("abc", "abc", NaN, now), /more than ten minutes/);
});

test("the shared modules read nothing from the world around them", () => {
  // They are imported by the node suite AND by Deno Edge Functions. An
  // import of supabase-js or a read of Deno.env in any of the three breaks
  // this file outright; the assertion is here so the reason is named.
  for (const f of ["backupTables.ts", "backupManifest.ts", "drive.ts", "backupOauth.ts"]) {
    const src = read(`supabase/functions/_shared/${f}`);
    const imports = [...src.matchAll(/^import .*?from ["'](.+?)["']/gm)].map(m => m[1]);
    const allowed = f === "backupManifest.ts" ? ["./backupSchedule.ts"] : [];
    assert.deepEqual(imports, allowed, `${f} must import only ${allowed.join(", ") || "nothing"}`);
    assert.ok(!/Deno\.env|process\.env/.test(src), `${f} must not read the environment`);
    // Erasable TypeScript only: an enum or a namespace does not strip.
    assert.ok(!/^\s*(?:export\s+)?(?:const\s+)?enum\s/m.test(src), `${f} must not declare an enum`);
    // No literal control character may reach a source file (git would call
    // it binary); dropboxArg's high range is written as escapes.
    assert.ok(!/[\x00-\x08\x0e-\x1f\x7f]/.test(src), `${f} must hold no control characters`);
  }
});

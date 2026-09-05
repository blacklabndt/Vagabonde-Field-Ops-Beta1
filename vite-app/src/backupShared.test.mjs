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

import { FakeDrive, authorizeUrl, SCOPES, PROVIDERS } from "../../supabase/functions/_shared/drive.ts";

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
  // rate_lines_history_trigger fires AFTER DELETE and inserts a history
  // row. Clearing rate_line_history first therefore leaves a phantom row
  // per deleted line, and the load that follows collides with it.
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

test("the shared modules read nothing from the world around them", () => {
  // They are imported by the node suite AND by Deno Edge Functions. An
  // import of supabase-js or a read of Deno.env in any of the three breaks
  // this file outright; the assertion is here so the reason is named.
  for (const f of ["backupTables.ts", "backupManifest.ts", "drive.ts"]) {
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

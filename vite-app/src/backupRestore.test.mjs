// Putting a backup back, as far as it can be checked without a drive: the
// phase arithmetic, chat history's two passes, the settings row's
// column-by-column rules, and the small decisions the restore makes on its
// own.
//
// backupRestore.ts is imported straight out of supabase/functions/ and node
// strips its types, so it is written in erasable TypeScript with no imports.
// If this file ever fails with "Unknown file extension" or a syntax error
// inside a .ts, something non-erasable has been added to it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  RESTORE_PHASES, WRITE_BATCH, CHAT_INSERT_PASS, CHAT_REPLY_PASS,
  newRestoreCursor, reviveRestoreCursor, restoreCounts,
  afterWipeStep, wipeKeepsCaller, afterPartLoaded, afterTableLoaded,
  partsForTable, withoutAuthEmail, chatInsertRows, chatReplyPatches,
  settingsRestorePatch, activityPatches, contentTypeFor, typedNameMatches,
  tooNewRefusal, accountFailureNote
} from "../../supabase/functions/_shared/backupRestore.ts";

import {
  LOAD_ORDER, WIPE_ORDER, APP_SETTINGS_SECRETS, APP_SETTINGS_NEVER_RESTORED
} from "../../supabase/functions/_shared/backupTables.ts";

const ROOT = new URL("../../", import.meta.url);
const read = rel => readFileSync(new URL(rel, ROOT), "utf8");

// ── The order the spec argued about ──────────────────────────────────────

test("the phases run safety, wipe, accounts, tables, files, activity", () => {
  assert.deepEqual(RESTORE_PHASES,
    ["safety", "wipe", "accounts", "tables", "files", "activity", "done"]);
  // Accounts before tables, not after: profiles.id is a foreign key to
  // auth.users, so a profile row whose Auth user is gone cannot be inserted
  // at all.
  assert.ok(RESTORE_PHASES.indexOf("accounts") < RESTORE_PHASES.indexOf("tables"));
  // The safety copy is taken before anything is emptied. That is the whole
  // reason it is a phase rather than a step inside one.
  assert.equal(RESTORE_PHASES[0], "safety");
  assert.ok(RESTORE_PHASES.indexOf("safety") < RESTORE_PHASES.indexOf("wipe"));
  // The activity times are put back after the files, because the triggers
  // that overwrite them fire on everything the load touches.
  assert.ok(RESTORE_PHASES.indexOf("activity") > RESTORE_PHASES.indexOf("files"));
});

// ── The cursor ───────────────────────────────────────────────────────────

test("a fresh cursor starts at safety and remembers who is driving", () => {
  const c = newRestoreCursor({ folderId: "f1", folderName: "2026-09-05 02-00", keepProfileId: "kyle" });
  assert.equal(c.phase, "safety");
  assert.equal(c.folderId, "f1");
  assert.equal(c.folderName, "2026-09-05 02-00");
  assert.equal(c.keepProfileId, "kyle");
  assert.equal(c.safetyRunId, null);
  assert.equal(c.chatPass, CHAT_INSERT_PASS);
  assert.equal(c.historyCleared, false);
  assert.deepEqual(c.loaded, {});
});

test("a cursor read back out of jsonb is filled in rather than trusted", () => {
  const c = reviveRestoreCursor({
    phase: "tables", folderId: "f1", folderName: "2026-09-05 02-00",
    keepProfileId: "kyle", tableIndex: 4, partIndex: 2, batchDone: 1000,
    loaded: { jobs: 120 }, safetyRunId: "s1", historyCleared: true
  });
  assert.equal(c.phase, "tables");
  assert.equal(c.tableIndex, 4);
  assert.equal(c.batchDone, 1000);
  assert.equal(c.loaded.jobs, 120);
  assert.equal(c.safetyRunId, "s1");
  assert.equal(c.historyCleared, true);
  // Everything the writing slice did not have is present and harmless.
  assert.deepEqual(c.accountsMade, []);
  assert.deepEqual(c.accountsFailed, []);
  assert.equal(c.fileOffset, 0);
  assert.equal(c.activityPart, 0);
  assert.equal(c.skipped, 0);
  assert.equal(c.collisions, 0);

  // A cursor that says nothing at all is a fresh one at safety.
  const fresh = reviveRestoreCursor(null);
  assert.equal(fresh.phase, "safety");
  assert.deepEqual(reviveRestoreCursor({}), fresh);
  // historyCleared is only ever true when it was written true — a truthy
  // string read out of jsonb must not be mistaken for the flag.
  assert.equal(reviveRestoreCursor({ historyCleared: "no" }).historyCleared, false);
});

test("the counts always carry skipped and collisions, at zero if nothing else", () => {
  const c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  const counts = restoreCounts(c);
  assert.deepEqual(counts.rows, {});
  assert.equal(counts.files, 0);
  assert.equal(counts.accounts, 0);
  assert.deepEqual(counts.accountsFailed, []);
  // A count that only exists once it is non-zero is a count nobody can read
  // as "none".
  assert.ok("skipped" in counts, "skipped is in every counts object");
  assert.ok("collisions" in counts, "collisions is in every counts object");
  assert.equal(counts.skipped, 0);
  assert.equal(counts.collisions, 0);

  c.loaded = { jobs: 12, tickets: 40 };
  c.filesDone = 9;
  c.filesBytes = 4096;
  c.accountsMade = ["a@b.ca", "c@d.ca"];
  c.accountsFailed = ["e@f.ca: bounced"];
  c.skipped = 3;
  c.collisions = 1;
  const after = restoreCounts(c);
  assert.deepEqual(after.rows, { jobs: 12, tickets: 40 });
  assert.equal(after.accounts, 2);
  assert.deepEqual(after.accountsFailed, ["e@f.ca: bounced"]);
  assert.equal(after.skipped, 3);
  assert.equal(after.collisions, 1);
});

// ── Wipe ─────────────────────────────────────────────────────────────────

test("the wipe walks its list once and then hands over to accounts", () => {
  let c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  c.phase = "wipe";
  for (let i = 0; i < WIPE_ORDER.length; i++) {
    assert.equal(c.phase, "wipe", `still wiping at ${WIPE_ORDER[i]}`);
    c = afterWipeStep(c, WIPE_ORDER.length);
  }
  assert.equal(c.wipeIndex, WIPE_ORDER.length);
  assert.equal(c.phase, "accounts");
});

test("only profiles keeps a row back, and it is the caller's", () => {
  assert.equal(wipeKeepsCaller("profiles"), true);
  for (const table of WIPE_ORDER.filter(t => t !== "profiles")) {
    assert.equal(wipeKeepsCaller(table), false, `${table} is emptied outright`);
  }
});

test("rate_lines is emptied before its history, and the restore says why", () => {
  // The trigger writes a history row per delete, so clearing the history
  // first leaves exactly as many phantoms as there were lines.
  assert.ok(WIPE_ORDER.indexOf("rate_lines") < WIPE_ORDER.indexOf("rate_line_history"));
  // And on the way back in, the same trigger's insert arm is why the
  // history is cleared again between the two loads.
  assert.ok(LOAD_ORDER.indexOf("rate_lines") < LOAD_ORDER.indexOf("rate_line_history"));
  const source = read("supabase/functions/backup-restore/index.ts");
  assert.match(source, /rate_line_history/,
    "the load clears the history rate_lines' own inserts wrote");
});

// ── Tables ───────────────────────────────────────────────────────────────

test("a part loaded adds to the count; the last one moves to the next table", () => {
  let c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  c.phase = "tables";
  c = afterPartLoaded(c, { table: "tickets", rows: 500, lastPart: false, tableCount: 3 });
  assert.equal(c.loaded.tickets, 500);
  assert.equal(c.partIndex, 1);
  assert.equal(c.tableIndex, 0);
  c = afterPartLoaded(c, { table: "tickets", rows: 120, lastPart: true, tableCount: 3 });
  assert.equal(c.loaded.tickets, 620);
  assert.equal(c.partIndex, 0);
  assert.equal(c.tableIndex, 1);
  assert.equal(c.phase, "tables");
});

test("the last table hands over to the files", () => {
  let c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  c.phase = "tables";
  c.tableIndex = LOAD_ORDER.length - 1;
  c = afterTableLoaded(c, LOAD_ORDER.length);
  assert.equal(c.phase, "files");
});

test("chat history rewinds for its second pass and only then moves on", () => {
  let c = newRestoreCursor({ folderId: "f", folderName: "n", keepProfileId: "k" });
  c.phase = "tables";
  c.tableIndex = 7;
  c.partIndex = 3;
  c = afterTableLoaded(c, 20, "chat_messages");
  // The same parts again, from the start, with the quotes this time.
  assert.equal(c.chatPass, CHAT_REPLY_PASS);
  assert.equal(c.partIndex, 0);
  assert.equal(c.tableIndex, 7, "still chat_messages");
  c = afterTableLoaded(c, 20, "chat_messages");
  assert.equal(c.tableIndex, 8);
  assert.equal(c.chatPass, CHAT_INSERT_PASS, "the next table starts on pass one");
});

test("a table's parts are its own, and rate_lines never takes the history's", () => {
  const entries = [
    { name: "rate_line_history.02.json.gz", id: "d" },
    { name: "rate_lines.02.json.gz", id: "b" },
    { name: "rate_lines.01.json.gz", id: "a" },
    { name: "rate_line_history.01.json.gz", id: "c" },
    { name: "manifest.json", id: "m" }
  ];
  assert.deepEqual(partsForTable(entries, "rate_lines").map(f => f.id), ["a", "b"]);
  assert.deepEqual(partsForTable(entries, "rate_line_history").map(f => f.id), ["c", "d"]);
  assert.deepEqual(partsForTable(entries, "jobs"), []);
  assert.deepEqual(partsForTable(null, "jobs"), []);
});

test("auth_email comes off before a profile row is written", () => {
  const rows = [
    { id: "1", name: "Kyle", auth_email: "kyle@example.ca" },
    { id: "2", name: "Sam" }
  ];
  const clean = withoutAuthEmail(rows);
  assert.deepEqual(clean, [{ id: "1", name: "Kyle" }, { id: "2", name: "Sam" }]);
  // The caller's own rows are not touched — the accounts phase still needs
  // the addresses.
  assert.equal(rows[0].auth_email, "kyle@example.ca");
});

// ── Chat history's two passes ────────────────────────────────────────────

test("pass one empties every quote and drops the ids already on the table", () => {
  const rows = [
    { id: "m1", body: "morning", reply_to: null },
    { id: "m2", body: "re: morning", reply_to: "m1" },
    { id: "m3", body: "already here", reply_to: null }
  ];
  const { rows: out, collisions } = chatInsertRows(rows, ["m3"]);
  assert.equal(out.length, 2);
  // The RPC has no ON CONFLICT clause: a row that is already there is a
  // failed batch, not a no-op.
  assert.equal(collisions, 1);
  assert.deepEqual(out.map(r => r.id), ["m1", "m2"]);
  // A reply can sit in an earlier part than the message it quotes, so no
  // quote goes in on this pass at all.
  assert.equal(out[1].reply_to, null);
  assert.equal(rows[1].reply_to, "m1", "the caller's rows are untouched");

  const none = chatInsertRows(rows, []);
  assert.equal(none.collisions, 0);
  assert.equal(none.rows.length, 3);
});

test("pass two writes only the quotes, and only where there is one", () => {
  const rows = [
    { id: "m1", body: "morning", reply_to: null },
    { id: "m2", body: "re: morning", reply_to: "m1" },
    { id: "m3", body: "no quote" }
  ];
  assert.deepEqual(chatReplyPatches(rows), [{ id: "m2", reply_to: "m1" }]);
  assert.deepEqual(chatReplyPatches([]), []);
  assert.deepEqual(chatReplyPatches(null), []);
});

// ── The settings row ─────────────────────────────────────────────────────

test("the live Resend and KLIPY keys survive a restore", () => {
  // What a backup actually holds: stripSecrets blanked them on the way out.
  const patch = settingsRestorePatch({
    id: true,
    resend_api_key: null,
    klipy_api_key: null,
    mail_from_reports: "reports@vagabonde.ca",
    approval_base_url: "https://app.example.ca",
    backup_refresh_token: null,
    backup_provider: "google"
  }, APP_SETTINGS_NEVER_RESTORED, APP_SETTINGS_SECRETS);

  assert.ok(!("resend_api_key" in patch), "a blanked key is never written back");
  assert.ok(!("klipy_api_key" in patch), "nor is the GIF key");
  assert.ok(!("id" in patch), "the enforced row's own key is not the restore's");
  // The drive connection this restore is running through stays exactly as
  // it is, whatever the backup remembers.
  assert.ok(!("backup_provider" in patch));
  assert.ok(!("backup_refresh_token" in patch));
  assert.equal(patch.mail_from_reports, "reports@vagabonde.ca");
  assert.equal(patch.approval_base_url, "https://app.example.ca");
});

test("a backup taken before the keys were stripped restores them like any column", () => {
  const patch = settingsRestorePatch(
    { resend_api_key: "re_old", klipy_api_key: "kl_old" },
    APP_SETTINGS_NEVER_RESTORED, APP_SETTINGS_SECRETS
  );
  assert.equal(patch.resend_api_key, "re_old");
  assert.equal(patch.klipy_api_key, "kl_old");
});

test("every column the backup blanks is one the restore skips or never writes", () => {
  // Whatever a backup holds, a null in one of these columns must not reach
  // app_settings. The two lists move together; this is the check that they
  // do.
  const blank = {};
  for (const column of APP_SETTINGS_SECRETS) blank[column] = null;
  const patch = settingsRestorePatch(blank, APP_SETTINGS_NEVER_RESTORED, APP_SETTINGS_SECRETS);
  assert.deepEqual(patch, {});
});

// ── The activity times ───────────────────────────────────────────────────

test("only the jobs that had an activity time get one back", () => {
  assert.deepEqual(activityPatches([
    { id: "j1", job_number: "S-1", last_activity_at: "2026-08-01T00:00:00Z" },
    { id: "j2", job_number: "S-2", last_activity_at: null },
    { id: "j3", job_number: "S-3" }
  ]), [{ id: "j1", last_activity_at: "2026-08-01T00:00:00Z" }]);
  assert.deepEqual(activityPatches(null), []);
});

// ── The small decisions ──────────────────────────────────────────────────

test("a report put back is still a PDF", () => {
  assert.equal(contentTypeFor("j-1/RT-0001.pdf"), "application/pdf");
  assert.equal(contentTypeFor("chat/2026/photo.JPG"), "image/jpeg");
  assert.equal(contentTypeFor("chat/note.webm"), "audio/webm");
  assert.equal(contentTypeFor("odd/thing.qqq"), "application/octet-stream");
  assert.equal(contentTypeFor("no-extension"), "application/octet-stream");
  assert.equal(contentTypeFor("trailing."), "application/octet-stream");
  assert.equal(contentTypeFor(""), "application/octet-stream");
});

test("the typed name is the backup's own, character for character", () => {
  assert.equal(typedNameMatches("2026-09-05 02-00", "2026-09-05 02-00"), true);
  // A name copied off the screen brings a space with it.
  assert.equal(typedNameMatches("  2026-09-05 02-00 ", "2026-09-05 02-00"), true);
  // The wrong night is the whole thing this gate is for.
  assert.equal(typedNameMatches("2026-09-04 02-00", "2026-09-05 02-00"), false);
  assert.equal(typedNameMatches("2026-09-05 0200", "2026-09-05 02-00"), false);
  assert.equal(typedNameMatches("", ""), false, "empty is never a confirmation");
  assert.equal(typedNameMatches("", "2026-09-05 02-00"), false);
  assert.equal(typedNameMatches(null, null), false);
});

test("the refusals say what to do about them", () => {
  const why = tooNewRefusal("20260906000000", "20260905080604");
  assert.match(why, /20260906000000/);
  assert.match(why, /20260905080604/);
  assert.match(why, /Update the app first/);
  assert.equal(accountFailureNote("sam@example.ca", "bounced"), "sam@example.ca: bounced");
});

// ── What the batches are ─────────────────────────────────────────────────

test("rows go back in batches small enough for PostgREST to take", () => {
  assert.equal(WRITE_BATCH, 500);
  assert.ok(WRITE_BATCH > 0 && WRITE_BATCH <= 1000);
});

// ── The function itself, read back ───────────────────────────────────────

test("the restore keeps the gates it is supposed to keep", () => {
  const source = read("supabase/functions/backup-restore/index.ts");
  // The door, before a byte of the body is parsed.
  assert.match(source, /backupDoor/);
  // Chat history goes in through the RPC that turns the push trigger off.
  assert.match(source, /restore_chat_messages/);
  // The safety backup's own run id is on the row before the slice returns,
  // or every tick raises another one.
  assert.match(source, /safetyRunId/);
  // Every mid-run write is conditional on the run this slice still holds.
  assert.match(source, /stillHoldsRun/);
  // Files are replaced, not added beside.
  assert.match(source, /upsert:\s*true/);
  // A restore never mints a new id for an account: the whole backup names
  // the old one.
  assert.match(source, /sendSetPasswordLink/);
});

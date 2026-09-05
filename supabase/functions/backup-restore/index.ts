// backup-restore — putting it all back.
//
// The dangerous one. It is the only thing in the app that empties tables it
// did not fill, so it is gated four times over: an Admin's own profile is
// read before anything else happens; a backup from a newer schema than this
// database is refused outright; the Admin types the backup's folder name;
// and the first phase of the restore itself is a complete backup of what is
// about to be replaced, into a "before-restore" folder retention will never
// tidy away. If that copy fails, nothing is deleted at all.
//
// It runs in slices for the same reason backup-run does, on the same
// cursor-in-the-row pattern, and it is driven by the same five-minute tick:
// backup-run handles its own two kinds and forwards a restore here.
//
//   {action:"preflight"}    an Admin, before the dialog offers anything
//   {action:"restore_all"}  an Admin, with the typed folder name
//   {action:"restore_jobs"} an Admin, with chosen job ids  (Task 7)
//   {action:"advance"}      the internal secret, one slice

// deno-lint-ignore-file no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  LOAD_ORDER, WIPE_ORDER, TABLE_KEYS, PROFILE_REFS,
  APP_SETTINGS_SECRETS, APP_SETTINGS_NEVER_RESTORED
} from "../_shared/backupTables.ts";
import {
  TABLES_FOLDER, FILES_FOLDER, folderStamp, beforeRestoreName,
  parseFileEntryName, schemaTooNew
} from "../_shared/backupManifest.ts";
import type { DriveClient } from "../_shared/drive.ts";
import {
  adminClient, backupDoor, connectDrive, corsHeaders,
  internalSecret, json, kick, logError, readManifest
} from "../_shared/backupCommon.ts";
import { BUDGET_MS, outOfBudget, sliceDeadline, sliceLooksAlive, stillHoldsRun } from "../_shared/backupRun.ts";
import {
  WRITE_BATCH, CHAT_INSERT_PASS,
  newRestoreCursor, reviveRestoreCursor, restoreCounts,
  afterWipeStep, wipeKeepsCaller, afterPartLoaded, afterTableLoaded,
  partsForTable, withoutAuthEmail, chatInsertRows, chatReplyPatches,
  settingsRestorePatch, ticketsForLoad, approvedTotalPatches, activityPatches,
  contentTypeFor, typedNameMatches, tooNewRefusal, accountFailureNote,
  withoutMissingProfiles, wantsSetPasswordMail, droppedAccountsNote, quotesThatLanded
} from "../_shared/backupRestore.ts";
import type { RestoreCursor } from "../_shared/backupRestore.ts";
import { gunzip } from "../_shared/gzip.ts";
import { sendSetPasswordLink } from "../_shared/setPassword.ts";

type Part = { id: string; name: string };

// ── The door ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  const db = adminClient();

  // Who is asking, before anything is parsed and before anything is written
  // down: the slice kick and the cron's forward come with the internal
  // secret and no JWT at all, and everything else is an Admin's own profile
  // read through RLS. A stranger's POST leaves no line in function_errors.
  const caller = await backupDoor(db, req, "Only an Admin can restore a backup");
  if (caller instanceof Response) return caller;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty body is not an action */ }
  const action = String(body.action ?? "");

  try {
    if (action === "advance") {
      // One slice of a restore already under way. Not an Admin's to call:
      // an Admin starts a restore, and the machinery drives it.
      if (!caller.internal) return json({ error: "Not authorized" }, 401);
      return json(await advance(db, String(body.runId ?? ""), caller.secret, body.chain === true));
    }
    if (caller.internal) return json({ error: "Not authorized" }, 401);

    if (action === "preflight") return json(await preflight(db, String(body.folderId ?? "")));
    if (action === "restore_all") {
      return json(await startRestoreAll(db, body, caller.userId, await internalSecret(db)));
    }
    return json({ error: `Unknown action "${action}"` }, 400);
  } catch (e) {
    await logError("backup-restore", (e as Error).message, { action });
    return json({ error: (e as Error).message }, 400);
  }
});

// ── Before anything is offered ───────────────────────────────────────────

async function preflight(db: SupabaseClient, folderId: string): Promise<Record<string, unknown>> {
  if (!folderId) throw new Error("folderId is required");
  const conn = await connectDrive(db);
  const m = await readManifest(conn.drive, folderId);
  const { data: live } = await db.rpc("backup_schema_version");
  const liveVersion = live ? String(live) : null;
  const backupVersion = m.schema_version ? String(m.schema_version) : null;
  const tables = (m.tables ?? {}) as Record<string, { rows?: number }>;
  const files = (m.files ?? {}) as { count?: number; bytes?: number };
  return {
    // The folder's own name is what the caller already has; what it does not
    // have is whether this backup may be loaded at all.
    app_version: m.app_version ?? null,
    finished_at: m.finished_at ?? null,
    schema_version: backupVersion,
    live_schema_version: liveVersion,
    // Refused: it holds columns this database has not got.
    tooNew: schemaTooNew(backupVersion, liveVersion),
    // Allowed, but worth saying out loud: anything added since is not in it.
    older: !!(backupVersion && liveVersion && backupVersion < liveVersion),
    rows: Object.values(tables).reduce((n, t) => n + Number(t?.rows ?? 0), 0),
    files: files.count ?? 0,
    bytes: files.bytes ?? 0,
    jobs: ((m.jobs ?? []) as unknown[]).length
  };
}

// ── Starting a restore ───────────────────────────────────────────────────

async function startRestoreAll(
  db: SupabaseClient, body: Record<string, unknown>, adminId: string, secret: string
): Promise<Record<string, unknown>> {
  const folderId = String(body.folderId ?? "");
  const folderName = String(body.folderName ?? "");
  if (!folderId || !folderName) throw new Error("folderId and folderName are required");

  // The typed name, character for character. The browser checks it too, but
  // the browser's copy of a gate is a courtesy and this one is the gate.
  if (!typedNameMatches(body.confirm, folderName)) {
    throw new Error(`To restore, type the backup's name exactly: ${folderName}`);
  }

  const check = await preflight(db, folderId);
  if (check.tooNew) {
    throw new Error(tooNewRefusal(
      check.schema_version as string | null, check.live_schema_version as string | null
    ));
  }

  const { data: open, error: openErr } = await db.from("backup_runs")
    .select("id, kind").in("status", ["queued", "running"]).limit(1).maybeSingle();
  if (openErr) throw openErr;
  if (open) throw new Error("Something is already running — wait for it to finish before starting a restore.");

  const now = new Date().toISOString();
  const cursor = newRestoreCursor({ folderId, folderName, keepProfileId: adminId });
  const { data: run, error } = await db.from("backup_runs").insert({
    kind: "restore_all", status: "running", phase: "safety",
    folder_id: folderId, folder_name: folderName, requested_by: adminId,
    started_at: now, heartbeat_at: now,
    cursor, counts: restoreCounts(cursor)
  }).select("id").single();
  if (error) throw error;

  // The row is in and the answer goes back now. The first slice is a
  // hundred seconds of work and the browser is not going to wait for it;
  // the kick starts it and is abandoned, and the five-minute tick is the
  // backstop if it never arrives.
  kick("backup-restore", { action: "advance", runId: run.id, chain: true }, secret);
  return { ok: true, runId: run.id };
}

// ── One slice of a restore ───────────────────────────────────────────────

const RUN_COLUMNS = "id, kind, status, phase, cursor, counts, folder_id, folder_name, heartbeat_at";

async function advance(
  db: SupabaseClient, runId: string, secret: string, chained: boolean
): Promise<Record<string, unknown>> {
  if (!runId) throw new Error("runId is required");
  const { data: run, error } = await db.from("backup_runs")
    .select(RUN_COLUMNS).eq("id", runId).maybeSingle();
  if (error) throw error;
  if (!run || run.status !== "running") return { ok: true, runId, idle: true };

  // A slice this one did not follow on from — the cron's forward, or an
  // Admin's panel poking the machinery — must not run beside a chain that is
  // already going: two slices of one restore would fight over the cursor and
  // repeat a phase. The chain's own kick is exempt, because the heartbeat it
  // is following is by definition seconds old.
  if (!chained && sliceLooksAlive(run.heartbeat_at, Date.now())) {
    return { ok: true, runId, busy: true };
  }

  const deadline = sliceDeadline(Date.now(), BUDGET_MS);
  let c: RestoreCursor = reviveRestoreCursor(run.cursor);
  // The status this slice holds the run at. Every write below is conditional
  // on it, so a slice that has been superseded writes nothing at all —
  // including its own failure. Same discipline as backup-run's, same reason:
  // a stale slice waking an hour later must not overwrite a finished run's
  // cursor or flip a complete run to failed on its way out.
  const guard = "running";

  try {
    // Nothing but the safety phase needs the drive, and the safety phase is
    // where a restore waits — so the connection is opened once the wait is
    // over rather than on every poll of it.
    let drive: DriveClient | null = null;
    const opened = async (): Promise<DriveClient> => {
      if (drive) return drive;
      const opening = (await connectDrive(db)).drive;
      drive = opening;
      return opening;
    };
    // The manifest names the parts; the drive holds them. Listed once per
    // slice rather than once per part, and deliberately not kept on the
    // cursor: it is a few hundred names that would be written back to the
    // row after every unit.
    let parts: Part[] | null = null;
    const partList = async (): Promise<Part[]> => {
      if (parts) return parts;
      const d = await opened();
      const tables = await subFolder(d, c.folderId, TABLES_FOLDER);
      if (!tables) throw new Error("That backup has no tables folder — there is nothing in it to restore.");
      const listed = (await d.listFiles(tables)).map(f => ({ id: f.id, name: f.name }));
      parts = listed;
      return listed;
    };

    let units = 0;
    while (!outOfBudget(deadline, Date.now()) && c.phase !== "done") {
      if (c.phase === "safety") {
        const ready = await stepSafety(db, c, runId, guard);
        // The cursor was written inside stepSafety, before this returned:
        // the safety run's id has to be on the row before the slice ends or
        // the next tick raises a second one.
        if (!ready) {
          // A restore waiting on its safety copy is doing exactly what it
          // was told to, and it can wait an hour while a big backup runs.
          // Without a heartbeat here the row would look like a slice that
          // died the moment the second poll returned, so the wait writes one
          // and changes nothing else. It does not wedge the machinery: the
          // heartbeat is stale again inside SLICE_ALIVE_MS, which is shorter
          // than the gap between cron ticks, so the very tick that has to
          // poll this restore still finds it quiet and forwards to it.
          if (!await beat(db, runId, guard)) return { ok: true, runId, superseded: true };
          return { ok: true, runId, phase: "safety", waiting: true };
        }
      }
      else if (c.phase === "wipe") await stepWipe(db, c);
      else if (c.phase === "accounts") c = await stepAccounts(db, await opened(), await partList(), c, deadline);
      else if (c.phase === "tables") c = await stepLoad(db, await opened(), await partList(), c, deadline);
      else if (c.phase === "files") c = await stepFilesBack(db, await opened(), c, deadline);
      else if (c.phase === "activity") c = await stepActivity(db, await opened(), await partList(), c, deadline);
      else c.phase = "done";
      units += 1;

      if (!await persist(db, runId, c, guard)) return { ok: true, runId, superseded: true };
    }

    if (c.phase === "done") {
      const finished = new Date().toISOString();
      // A restore that had to leave people out finished — and there is still
      // something an Admin has to be told, so it is written on the run. The
      // panel shows `error` only on a run that failed, which is right: this
      // one did not, and the note is for whoever goes looking.
      const left = droppedAccountsNote(c.droppedProfileIds, c.accountsFailed);
      const { data: held, error: doneErr } = await db.from("backup_runs").update({
        status: "complete", phase: "done", finished_at: finished,
        heartbeat_at: finished, cursor: c, counts: restoreCounts(c),
        error: left || null
      }).eq("id", runId).eq("status", guard).select("id");
      if (doneErr) throw doneErr;
      if (!stillHoldsRun(held)) return { ok: true, runId, superseded: true };
      // An address that bounced is not a reason to fail a restore, but it is
      // a reason somebody has to be told about: it is one person with no way
      // into an account that exists.
      for (const failure of c.accountsFailed) {
        await logError("backup-restore", `Account not restored: ${failure}`, { runId });
      }
      return { ok: true, runId, complete: true, counts: restoreCounts(c) };
    }

    if (units > 0) kick("backup-restore", { action: "advance", runId, chain: true }, secret);
    return { ok: true, runId, phase: c.phase, continuing: true };
  } catch (e) {
    return await fail(db, runId, (e as Error).message, guard, c.phase);
  }
}

// The cursor after every unit, not at the end of the slice: a slice that
// dies here has to be resumable from what is on the row, and the heartbeat
// is how the next tick knows it died. Zero rows matched is this slice
// finding out it no longer holds the run.
async function persist(
  db: SupabaseClient, runId: string, c: RestoreCursor, guard: string
): Promise<boolean> {
  const { data: held, error } = await db.from("backup_runs").update({
    phase: c.phase, cursor: c, heartbeat_at: new Date().toISOString(), counts: restoreCounts(c)
  }).eq("id", runId).eq("status", guard).select("id");
  if (error) throw error;
  return stillHoldsRun(held);
}

// The heartbeat on its own, for the one place a slice ends without having
// moved anything: waiting for the safety backup. Same condition as every
// other write, so a superseded slice does not keep a run it no longer holds
// looking alive.
async function beat(db: SupabaseClient, runId: string, guard: string): Promise<boolean> {
  const { data: held, error } = await db.from("backup_runs")
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("id", runId).eq("status", guard).select("id");
  if (error) throw error;
  return stillHoldsRun(held);
}

async function fail(
  db: SupabaseClient, runId: string, message: string, guard: string, phase: string
): Promise<Record<string, unknown>> {
  const { data: held } = await db.from("backup_runs").update({
    status: "failed", error: message, finished_at: new Date().toISOString()
  }).eq("id", runId).eq("status", guard).select("id");
  const superseded = !stillHoldsRun(held);
  await logError("backup-restore", message, superseded ? { runId, phase, superseded } : { runId, phase });
  return superseded
    ? { ok: false, runId, error: message, superseded: true }
    : { ok: false, runId, error: message };
}

// ── Phase: safety ────────────────────────────────────────────────────────
// A complete backup of what is about to be replaced, taken by exactly the
// code that takes every other backup — a queued run of kind before_restore,
// which backup-run's tick starts and drives. This phase does nothing but
// raise it and wait for it, and it refuses to go on if it fails: the whole
// point of the copy is that it exists before anything is deleted.

async function stepSafety(
  db: SupabaseClient, c: RestoreCursor, runId: string, guard: string
): Promise<boolean> {
  if (!c.safetyRunId) {
    const name = beforeRestoreName(folderStamp(Date.now()));
    const { data, error } = await db.from("backup_runs")
      .insert({ kind: "before_restore", status: "queued", folder_name: name })
      .select("id").single();
    if (error) throw error;
    c.safetyRunId = String(data.id);
    // Written to the row here rather than when the slice returns. A tick
    // that read a cursor with no safetyRunId on it would raise a second
    // safety backup, and the one after that a third — the restore would sit
    // in this phase queueing backups for ever.
    if (!await persist(db, runId, c, guard)) {
      throw new Error("This restore was taken over by another slice while its safety backup was being raised.");
    }
    return false;
  }

  const { data: safety, error } = await db.from("backup_runs")
    .select("status, error, folder_name").eq("id", c.safetyRunId).maybeSingle();
  if (error) throw error;
  if (!safety) {
    throw new Error("The safety backup disappeared before the restore could start. Nothing has been changed.");
  }
  if (safety.status === "failed") {
    throw new Error(
      `The safety backup failed (${safety.error ?? "no reason recorded"}), so nothing has been ` +
      `restored and nothing has been deleted.`
    );
  }
  if (safety.status !== "complete") return false;
  c.safetyFolderName = safety.folder_name ? String(safety.folder_name) : null;
  c.phase = "wipe";
  return true;
}

// ── Phase: wipe ──────────────────────────────────────────────────────────
// One table per step, in the order the handover script established —
// children first, profiles last, and the error log and audit trail in there
// too because their foreign keys to profiles would otherwise refuse the
// delete. The service role is doing this, so RLS and the guard policies are
// not in the way, which is the point and also why nothing but this function
// may.

async function stepWipe(db: SupabaseClient, c: RestoreCursor): Promise<void> {
  if (c.wipeIndex >= WIPE_ORDER.length) { c.phase = "accounts"; return; }
  const table = WIPE_ORDER[c.wipeIndex];
  const key = (TABLE_KEYS[table] ?? ["id"])[0];

  let q = db.from(table).delete();
  if (wipeKeepsCaller(table)) {
    // Everything except the Admin running this. Their row would take their
    // own way into the API with it, and the session driving the restore
    // would lose its permissions in the middle of the job. The load puts the
    // backup's version of the row back over the top.
    q = q.neq("id", c.keepProfileId || "00000000-0000-0000-0000-000000000000");
  } else {
    // PostgREST refuses an unfiltered delete; "every row" is said as a
    // filter that is true of all of them.
    q = q.not(key, "is", null);
  }
  const { error } = await q;
  if (error) throw new Error(`Emptying ${table} failed: ${error.message}`);

  afterWipeStep(c, WIPE_ORDER.length);
}

// ── Phase: accounts ──────────────────────────────────────────────────────
// Auth users are not in a backup — passwords never leave Supabase — so this
// re-creates the ones that are missing, from the profiles rows the backup
// does hold, using the auth_email each of them carries, and mails each
// person a set-password link through the app's own transport. The id is kept
// because every ticket, JHA and crew row in the backup names it: a new id
// would restore the work and lose whose it was.
//
// A failure here is listed, not fatal: one address that bounces must not
// leave the whole company's records unrestored. The list is on the run and
// in function_errors when it finishes.

async function stepAccounts(
  db: SupabaseClient, drive: DriveClient, parts: Part[], c: RestoreCursor, deadline: number
): Promise<RestoreCursor> {
  const profiles = await readTable(drive, parts, "profiles");

  const existing = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const users = data?.users ?? [];
    for (const u of users) existing.add(String(u.id));
    if (users.length < 1000) break;
  }

  for (let i = c.accountIndex; i < profiles.length; i++) {
    if (outOfBudget(deadline, Date.now())) { c.accountIndex = i; return c; }
    const p = profiles[i] as Record<string, unknown>;
    const id = String(p.id ?? "");
    // The Admin driving this keeps their own Auth user throughout; it is
    // already in `existing` and is never touched here either way.
    if (!id || existing.has(id)) continue;

    const email = String(p.auth_email ?? "").trim();
    const name = String(p.name ?? "");
    if (!email) {
      c.accountsFailed.push(accountFailureNote(name || id,
        "the backup has no email address for this account, so it could not be re-created."));
      c.droppedProfileIds.push(id);
      continue;
    }
    try {
      const { error } = await db.auth.admin.createUser({
        id, email, email_confirm: true,
        password: crypto.randomUUID() + crypto.randomUUID(),
        user_metadata: { name }
      });
      if (error) throw error;
      c.accountsMade.push(email);
      // A deactivated account is put back deactivated — the profiles load
      // writes deactivated_at over the stub in a moment and RLS locks it
      // again — so it gets no invitation to come and set a password.
      if (!wantsSetPasswordMail(p)) continue;
      try { await sendSetPasswordLink(db, email, name, "invite"); }
      catch (e) {
        c.accountsFailed.push(accountFailureNote(email,
          `the account was re-created but the set-password email did not go out (${(e as Error).message}).`));
      }
    } catch (e) {
      // The Auth user could not be made, so profiles.id has nothing to point
      // at: the profile row is refused however often it is retried, and so is
      // every row in every later table that cannot stand without this person.
      // Say who, drop them, and carry on — the rest of the company's records
      // are not this one account's to hold up.
      c.accountsFailed.push(accountFailureNote(email, (e as Error).message));
      c.droppedProfileIds.push(id);
    }
  }
  c.accountIndex = 0;
  c.phase = "tables";
  return c;
}

// ── Phase: tables ────────────────────────────────────────────────────────

async function stepLoad(
  db: SupabaseClient, drive: DriveClient, allParts: Part[], c: RestoreCursor, deadline: number
): Promise<RestoreCursor> {
  if (c.tableIndex >= LOAD_ORDER.length) { c.phase = "files"; return c; }
  const table = LOAD_ORDER[c.tableIndex];

  // The settings row is not replaced wholesale: it holds the drive
  // connection this restore is running through, and it holds live vendor
  // keys the backup deliberately blanked. Only the columns that are
  // genuinely the client's own settings come back, and only where the backup
  // actually has a value.
  if (table === "app_settings") {
    const rows = await readTable(drive, allParts, "app_settings");
    const patch = settingsRestorePatch(
      (rows[0] ?? {}) as Record<string, unknown>,
      APP_SETTINGS_NEVER_RESTORED, APP_SETTINGS_SECRETS
    );
    if (Object.keys(patch).length) {
      const { error } = await db.from("app_settings").update(patch).eq("id", true);
      if (error) throw new Error(`Restoring the settings failed: ${error.message}`);
    }
    c.loaded.app_settings = rows.length;
    return afterTableLoaded(c, LOAD_ORDER.length, table);
  }

  // rate_lines' own insert trigger writes a history row for every line it
  // has just put back, so the history the load itself created has to go
  // before the backup's history file is read. One unit, once per run.
  if (table === "rate_line_history" && !c.historyCleared) {
    const { error } = await db.from("rate_line_history").delete().not("id", "is", null);
    if (error) throw new Error(`Clearing the price history the load wrote failed: ${error.message}`);
    c.historyCleared = true;
    return c;
  }

  const parts = partsForTable(allParts, table);
  if (c.partIndex >= parts.length) return afterTableLoaded(c, LOAD_ORDER.length, table);

  const raw = await readPart(drive, parts[c.partIndex]);
  const lastPart = c.partIndex >= parts.length - 1;

  if (table === "chat_messages") {
    return await loadChatPart(db, c, raw, lastPart, deadline);
  }

  // Two tables go in altered, and both are put right later:
  //   · profiles — auth_email rides in the JSON, not in the table, and an
  //     insert that names it is one PostgREST refuses;
  //   · tickets — the deferred balance trigger re-adds a ticket's lines at
  //     the commit of its own insert, and ticket_lines cannot load first.
  const shaped = table === "profiles" ? withoutAuthEmail(raw)
    : table === "tickets" ? ticketsForLoad(raw)
    : raw;
  // And anyone the accounts phase could not put back is taken out here: a
  // row naming a profile that is not going in is a foreign key nothing will
  // ever satisfy, and one of them would fail the whole table's load.
  const missing = withoutMissingProfiles(shaped, table, c.droppedProfileIds, PROFILE_REFS);
  // Counted once per part. A slice cut short comes back to the same part and
  // filters it to the same rows, and a count added twice is a count that
  // tells whoever reads it the wrong thing.
  if (c.batchDone === 0) c.skipped += missing.skipped;
  const rows = missing.rows;
  const conflict = (TABLE_KEYS[table] ?? ["id"]).join(",");

  for (let at = c.batchDone; at < rows.length; at += WRITE_BATCH) {
    if (outOfBudget(deadline, Date.now())) { c.batchDone = at; return c; }
    const batch = rows.slice(at, at + WRITE_BATCH);
    // Upsert rather than insert: the Admin's own profile row survived the
    // wipe and has to be replaced by the backup's version of it, and a
    // retried slice must not collide with itself.
    //
    // Triggers stay on all the way through. The guard triggers exempt the
    // service role, the ticket total trigger recomputes exactly the cents
    // the backup already holds, and the two values a trigger does overwrite
    // — jobs.last_activity_at and the price history — are put right in their
    // own steps.
    const { error } = await db.from(table).upsert(batch, { onConflict: conflict });
    if (error) throw new Error(`Restoring ${table} failed at row ${at + 1} of ${rows.length}: ${error.message}`);
  }

  return afterPartLoaded(c, { table, rows: rows.length, lastPart, tableCount: LOAD_ORDER.length });
}

// Chat history, in two passes over the same parts.
//
// Pass one inserts through restore_chat_messages, the definer RPC that turns
// the push trigger off around the insert — without it the crew's phones
// would buzz once per historical message. That RPC has no ON CONFLICT
// clause, so a row already on the table is a failed batch rather than a
// no-op, and the live ids are read first. Every quote goes in empty, because
// reply_to points back at chat_messages and a reply can sit in an earlier
// part than the message it quotes.
//
// Pass two walks the same parts again and puts the quotes back, through
// restore_patch_rows — an UPDATE and nothing else. It cannot be an upsert:
// a two-column row {id, reply_to} is checked against chat_messages' NOT NULL
// columns before Postgres ever looks for the conflict, so profile_id and
// body being absent refuses the write outright. An UPDATE also means the
// push trigger (AFTER INSERT) is never reached.
async function loadChatPart(
  db: SupabaseClient, c: RestoreCursor, raw: Record<string, unknown>[],
  lastPart: boolean, deadline: number
): Promise<RestoreCursor> {
  if (c.chatPass === CHAT_INSERT_PASS) {
    // A message written by somebody the accounts phase could not put back
    // has nowhere to go: chat_messages.profile_id is NOT NULL. A pin by one
    // of them is only a pin forgotten.
    const missing = withoutMissingProfiles(raw, "chat_messages", c.droppedProfileIds, PROFILE_REFS);
    if (c.batchDone === 0) c.skipped += missing.skipped;
    const kept = missing.rows;
    for (let at = c.batchDone; at < kept.length; at += WRITE_BATCH) {
      if (outOfBudget(deadline, Date.now())) { c.batchDone = at; return c; }
      const batch = kept.slice(at, at + WRITE_BATCH);
      const ids = batch.map(r => String(r.id ?? "")).filter(Boolean);
      const { data: live, error: liveErr } = await db.from("chat_messages").select("id").in("id", ids);
      if (liveErr) throw new Error(`Reading the chat back failed: ${liveErr.message}`);
      const { rows, collisions } = chatInsertRows(batch, (live ?? []).map(r => String(r.id)));
      c.collisions += collisions;
      if (rows.length) {
        const { error } = await db.rpc("restore_chat_messages", { p_rows: rows });
        if (error) throw new Error(`Restoring the chat failed at row ${at + 1} of ${kept.length}: ${error.message}`);
      }
    }
    return afterPartLoaded(c, {
      table: "chat_messages", rows: kept.length, lastPart, tableCount: LOAD_ORDER.length
    });
  }

  const patches = chatReplyPatches(raw);
  for (let at = c.batchDone; at < patches.length; at += WRITE_BATCH) {
    if (outOfBudget(deadline, Date.now())) { c.batchDone = at; return c; }
    let batch = patches.slice(at, at + WRITE_BATCH);
    // Only when somebody was left out. With nobody dropped every message in
    // the backup is on the table and the quotes cannot name a row that is
    // not; with somebody dropped, theirs are gone and a reply quoting one of
    // them would be refused by the foreign key and take the batch with it.
    if (c.droppedProfileIds.length) {
      const targets = batch.map(p => String(p.reply_to ?? "")).filter(Boolean);
      const { data: there, error: thereErr } = await db.from("chat_messages").select("id").in("id", targets);
      if (thereErr) throw new Error(`Reading the quoted messages back failed: ${thereErr.message}`);
      const landed = quotesThatLanded(batch, (there ?? []).map(r => String(r.id)));
      batch = landed.rows;
      c.skipped += landed.dropped;
    }
    if (!batch.length) continue;
    const { error } = await db.rpc("restore_patch_rows", { p_table: "chat_messages", p_rows: batch });
    if (error) throw new Error(`Restoring the chat's replies failed: ${error.message}`);
  }
  c.batchDone = 0;
  if (!lastPart) { c.partIndex += 1; return c; }
  return afterTableLoaded(c, LOAD_ORDER.length, "chat_messages");
}

// ── Phase: files ─────────────────────────────────────────────────────────
// Every PDF and picture back into the bucket it came out of, under the key
// it had. Overwriting, not adding beside: a restore run twice must land on
// the same objects.

async function stepFilesBack(
  db: SupabaseClient, drive: DriveClient, c: RestoreCursor, deadline: number
): Promise<RestoreCursor> {
  const folder = await subFolder(drive, c.folderId, FILES_FOLDER);
  if (!folder) { c.phase = "activity"; return c; }
  const entries = (await drive.listFiles(folder)).slice().sort((a, b) => a.name.localeCompare(b.name));

  for (let i = c.fileOffset; i < entries.length; i++) {
    if (outOfBudget(deadline, Date.now())) { c.fileOffset = i; return c; }
    const parsed = parseFileEntryName(entries[i].name);
    if (!parsed) { c.skipped += 1; continue; }
    const bytes = await drive.download(entries[i].id);
    const { error } = await db.storage.from(parsed.bucket).upload(parsed.key, bytes, {
      upsert: true,
      // A backup holds the bytes and not the type the bucket served them as,
      // so the type is read back off the key: a report put back as
      // application/octet-stream is one the in-app viewer offers as a
      // download rather than drawing on the screen.
      contentType: contentTypeFor(parsed.key)
    });
    if (error) throw new Error(`Putting ${parsed.bucket}/${parsed.key} back failed: ${error.message}`);
    c.filesDone += 1;
    c.filesBytes += bytes.byteLength;
  }
  c.fileOffset = 0;
  c.phase = "activity";
  return c;
}

// ── Phase: activity ──────────────────────────────────────────────────────
// The two figures a trigger wrote over on the way in, put back now that
// nothing else is going to touch them.
//
//   · a signed ticket's total, which ticket_lines' sync trigger recomputed
//     from the lines. For consistent data that is the same number; for a
//     ticket whose lines and total once drifted it is not, and re-pricing a
//     ticket somebody has signed is not the restore's to do;
//   · jobs.last_activity_at, which orders the board and which the definer
//     triggers on tickets, JHAs and reports have just stamped with today for
//     every job the load touched.
//
// Both are UPDATEs through restore_patch_rows, not upserts. A row of two
// columns is checked against the table's NOT NULL columns before Postgres
// looks for a conflict — tickets.job_id, jobs.job_number — so an upsert of
// {id, total} or {id, last_activity_at} is refused outright, on every row,
// however certainly the id is already there.

async function stepActivity(
  db: SupabaseClient, drive: DriveClient, allParts: Part[], c: RestoreCursor, deadline: number
): Promise<RestoreCursor> {
  if (!c.totalsDone) {
    const parts = partsForTable(allParts, "tickets");
    for (let p = c.totalsPart; p < parts.length; p++) {
      if (outOfBudget(deadline, Date.now())) { c.totalsPart = p; return c; }
      const patches = approvedTotalPatches(await readPart(drive, parts[p]));
      for (let at = 0; at < patches.length; at += WRITE_BATCH) {
        const { error } = await db.rpc("restore_patch_rows", {
          p_table: "tickets", p_rows: patches.slice(at, at + WRITE_BATCH)
        });
        if (error) throw new Error(`Restoring the signed tickets' totals failed: ${error.message}`);
      }
    }
    c.totalsPart = 0;
    c.totalsDone = true;
    return c;
  }

  const parts = partsForTable(allParts, "jobs");
  for (let p = c.activityPart; p < parts.length; p++) {
    if (outOfBudget(deadline, Date.now())) { c.activityPart = p; return c; }
    const patches = activityPatches(await readPart(drive, parts[p]));
    for (let at = 0; at < patches.length; at += WRITE_BATCH) {
      const { error } = await db.rpc("restore_patch_rows", {
        p_table: "jobs", p_rows: patches.slice(at, at + WRITE_BATCH)
      });
      if (error) throw new Error(`Restoring the jobs' activity times failed: ${error.message}`);
    }
  }
  c.activityPart = 0;
  c.phase = "done";
  return c;
}

// ── Reading a backup's parts ─────────────────────────────────────────────

async function subFolder(drive: DriveClient, folderId: string, name: string): Promise<string | null> {
  const found = (await drive.listFolders(folderId)).find(f => f.name === name);
  return found ? found.id : null;
}

async function readPart(drive: DriveClient, part: Part): Promise<Record<string, unknown>[]> {
  const packed = await drive.download(part.id);
  const rows = JSON.parse(new TextDecoder().decode(await gunzip(packed)));
  if (!Array.isArray(rows)) throw new Error(`${part.name} is not a table part.`);
  return rows as Record<string, unknown>[];
}

// A whole table at once, for the two places that need all of it rather than
// a part at a time: the accounts phase, which has to know every profile in
// the backup, and the settings row, which is one row.
async function readTable(
  drive: DriveClient, allParts: Part[], table: string
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const part of partsForTable(allParts, table)) out.push(...await readPart(drive, part));
  return out;
}

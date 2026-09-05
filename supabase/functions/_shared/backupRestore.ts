// Putting a backup back: the bookkeeping only.
//
// The restore is done in slices for the same reason the backup is, and it
// carries the same kind of cursor — which phase, which table, which part,
// how far into it. Nothing here talks to a drive, a database or a storage
// bucket, so all of it can be exercised by the node suite: the phase
// arithmetic, the two passes chat history needs, the settings row's
// column-by-column rules, and the small decisions (a content type, a typed
// name) that are easy to get quietly wrong.
//
// Erasable TypeScript only, and no imports: vite-app/src/backupShared.test.mjs
// imports this file straight out of supabase/functions/ and node strips the
// types. An enum or a parameter property here breaks the test suite. The
// counts that belong to a table (WIPE_ORDER, LOAD_ORDER) are passed in
// rather than imported for the same reason.
//
// The functions mutate the cursor they are handed and give it back, exactly
// as backupRun.ts's do; call them as `c = afterWipeStep(c, n)` so that stays
// visible at the call site.

export const RESTORE_PHASES: string[] = [
  "safety", "wipe", "accounts", "tables", "files", "activity", "done"
];

// Rows go back in batches: one 25,000-row part in a single POST is a body
// PostgREST will refuse, and a batch that fails is a batch to name.
export const WRITE_BATCH = 500;

// Two passes over chat history, and the cursor has to say which one it is
// in. Pass one inserts every message with its quote left empty, because a
// reply can be older in the file than the message it quotes and the foreign
// key does not care what order a backup happened to be written in. Pass two
// walks the same parts again and puts the quotes back, by which time every
// message they point at is on the table.
export const CHAT_INSERT_PASS = 0;
export const CHAT_REPLY_PASS = 1;

export interface RestoreCursor {
  phase: string;
  folderId: string;
  folderName: string;
  keepProfileId: string;
  // The before-restore backup this restore raised, and waits for.
  safetyRunId: string | null;
  safetyFolderName: string | null;
  wipeIndex: number;
  accountIndex: number;
  accountsMade: string[];
  accountsFailed: string[];
  // The people the accounts phase could not put back. Their profile rows
  // cannot be inserted — profiles.id is a foreign key to auth.users — so
  // the load has to leave them, and every row in every later table that
  // names them, out. Kept as ids because that is what the rest of the
  // backup calls them.
  droppedProfileIds: string[];
  tableIndex: number;
  partIndex: number;
  batchDone: number;
  // Whether this part's rows-left-out have already been added to `skipped`,
  // and how many of its rows this restore has decided not to write. Both
  // belong to the part rather than the slice: a slice that runs out of
  // budget before its first batch persists batchDone at 0, so counting off
  // batchDone === 0 would add the same part's figures again on the resume.
  partSkipCounted: boolean;
  partDropped: number;
  chatPass: number;
  // rate_lines' own insert trigger writes a history row per line, so the
  // history it wrote has to go before the backup's history file is loaded.
  // Once per run, and the cursor is what remembers it happened.
  historyCleared: boolean;
  loaded: Record<string, number>;
  filesDone: number;
  filesBytes: number;
  fileOffset: number;
  totalsPart: number;
  totalsDone: boolean;
  activityPart: number;
  // A row the restore chose not to write, and a row it found already there.
  // Both are zero for a restore-all — it writes into tables it has just
  // emptied — and both are the per-job restore's to fill.
  skipped: number;
  collisions: number;
}

export function newRestoreCursor(o: {
  folderId: string; folderName: string; keepProfileId: string;
}): RestoreCursor {
  return {
    phase: "safety",
    folderId: String(o.folderId ?? ""),
    folderName: String(o.folderName ?? ""),
    keepProfileId: String(o.keepProfileId ?? ""),
    safetyRunId: null,
    safetyFolderName: null,
    wipeIndex: 0,
    accountIndex: 0,
    accountsMade: [],
    accountsFailed: [],
    droppedProfileIds: [],
    tableIndex: 0,
    partIndex: 0,
    batchDone: 0,
    partSkipCounted: false,
    partDropped: 0,
    chatPass: CHAT_INSERT_PASS,
    historyCleared: false,
    loaded: {},
    filesDone: 0,
    filesBytes: 0,
    fileOffset: 0,
    totalsPart: 0,
    totalsDone: false,
    activityPart: 0,
    skipped: 0,
    collisions: 0
  };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(x => String(x)) : [];

// A cursor read back out of jsonb has whatever shape the slice that wrote it
// left behind, and a run raised before a field existed has none at all. Fill
// the gaps rather than trusting them: a missing `loaded` read as undefined
// would throw the first time a table finished.
export function reviveRestoreCursor(raw: unknown): RestoreCursor {
  const c = (raw ?? {}) as Record<string, unknown>;
  const base = newRestoreCursor({
    folderId: String(c.folderId ?? ""),
    folderName: String(c.folderName ?? ""),
    keepProfileId: String(c.keepProfileId ?? "")
  });
  return {
    ...base,
    phase: typeof c.phase === "string" && c.phase ? c.phase : base.phase,
    safetyRunId: c.safetyRunId ? String(c.safetyRunId) : null,
    safetyFolderName: c.safetyFolderName ? String(c.safetyFolderName) : null,
    wipeIndex: num(c.wipeIndex),
    accountIndex: num(c.accountIndex),
    accountsMade: strs(c.accountsMade),
    accountsFailed: strs(c.accountsFailed),
    droppedProfileIds: strs(c.droppedProfileIds),
    tableIndex: num(c.tableIndex),
    partIndex: num(c.partIndex),
    batchDone: num(c.batchDone),
    partSkipCounted: c.partSkipCounted === true,
    partDropped: num(c.partDropped),
    chatPass: num(c.chatPass),
    historyCleared: c.historyCleared === true,
    loaded: (c.loaded ?? {}) as Record<string, number>,
    filesDone: num(c.filesDone),
    filesBytes: num(c.filesBytes),
    fileOffset: num(c.fileOffset),
    totalsPart: num(c.totalsPart),
    totalsDone: c.totalsDone === true,
    activityPart: num(c.activityPart),
    skipped: num(c.skipped),
    collisions: num(c.collisions)
  };
}

// What the panel shows, and what every mid-run write to backup_runs carries.
// `skipped` and `collisions` are in it from the first slice of the first
// restore, at zero, rather than appearing halfway through a per-job run: a
// count that only exists once it is non-zero is a count nobody can read as
// "none".
// `safety` is the cursor's safetyFolderName said out loud, because the panel
// reads `counts` and does not read the cursor. It is the name of the copy
// taken automatically just before the wipe, and it is null until that copy
// has completed — so it is also the answer to the only question a failed
// restore-all raises: was the app emptied? A name means yes and names the
// way back; a null means the run stopped before anything was deleted.
export function restoreCounts(c: RestoreCursor): Record<string, unknown> {
  return {
    rows: c.loaded ?? {},
    files: num(c.filesDone),
    bytes: num(c.filesBytes),
    accounts: (c.accountsMade ?? []).length,
    accountsFailed: c.accountsFailed ?? [],
    accountsDropped: (c.droppedProfileIds ?? []).length,
    skipped: num(c.skipped),
    collisions: num(c.collisions),
    safety: c.safetyFolderName ?? null
  };
}

// ── Phase: wipe ──────────────────────────────────────────────────────────

// One table emptied. The order is WIPE_ORDER's, children before parents, and
// the phase ends when the list does.
export function afterWipeStep(c: RestoreCursor, wipeCount: number): RestoreCursor {
  c.wipeIndex = num(c.wipeIndex) + 1;
  if (c.wipeIndex >= wipeCount) c.phase = "accounts";
  return c;
}

// Every row of that table except the Admin driving the restore. Their
// profile row would take their own Auth user's only way into the API with
// it, and the session running the restore would lose its permissions
// halfway through the job. The load puts the backup's version of the row
// back over the top.
export function wipeKeepsCaller(table: string): boolean {
  return table === "profiles";
}

// ── Phase: tables ────────────────────────────────────────────────────────

// One part of one table written. `lastPart` means the table is finished and
// the next slice starts the one after it. The part's own bookkeeping — has
// its skipped rows been counted, how many did it drop — goes back to nothing
// here, because the next part is a different part.
export function afterPartLoaded(c: RestoreCursor, done: {
  table: string; rows: number; lastPart: boolean; tableCount: number;
}): RestoreCursor {
  c.loaded[done.table] = num(c.loaded[done.table]) + num(done.rows);
  c.batchDone = 0;
  c.partSkipCounted = false;
  c.partDropped = 0;
  if (done.lastPart) {
    c.partIndex = 0;
    return afterTableLoaded(c, done.tableCount, done.table);
  }
  c.partIndex = num(c.partIndex) + 1;
  return c;
}

// A table is done with. Chat history is the exception: its first pass over
// the parts leaves every quote empty, so the second pass rewinds to the
// first part rather than moving on.
export function afterTableLoaded(c: RestoreCursor, tableCount: number, table = ""): RestoreCursor {
  if (table === "chat_messages" && num(c.chatPass) === CHAT_INSERT_PASS) {
    c.chatPass = CHAT_REPLY_PASS;
    c.partIndex = 0;
    c.batchDone = 0;
    c.partSkipCounted = false;
    c.partDropped = 0;
    return c;
  }
  c.tableIndex = num(c.tableIndex) + 1;
  c.partIndex = 0;
  c.batchDone = 0;
  c.partSkipCounted = false;
  c.partDropped = 0;
  c.chatPass = CHAT_INSERT_PASS;
  if (c.tableIndex >= tableCount) c.phase = "files";
  return c;
}

// The parts of one table, in the order they were written. A name is a part
// of this table only when the whole table name is followed by the numbering
// dot — "rate_lines.01.json.gz" belongs to rate_lines and never to
// rate_line_history, and the reverse must be just as true.
export function partsForTable<T extends { name: string }>(entries: T[], table: string): T[] {
  const prefix = `${table}.`;
  return (entries || [])
    .filter(f => String(f.name).startsWith(prefix) && String(f.name).endsWith(".json.gz"))
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// auth_email rides in the backup's JSON so a restore into an empty project
// knows where to send each person their set-password link. It is not a
// column of profiles, and an insert that names it is an insert PostgREST
// refuses.
export function withoutAuthEmail(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return (rows || []).map(row => {
    if (!(row && "auth_email" in row)) return row;
    const out: Record<string, unknown> = { ...row };
    delete out.auth_email;
    return out;
  });
}

// ── The people who could not be put back ─────────────────────────────────

// An Auth account the restore could not re-create is a profile row it
// cannot insert: profiles.id is a foreign key to auth.users, and the row
// would be refused however many times the load retried it. So the row is
// left out — and so is every later row that cannot stand without it.
//
// Which is which comes off the live catalogs (PROFILE_REFS). A NOT NULL
// foreign key is a row that has nowhere to go: a ticket_crew line, a chat
// message, somebody's high score. Those are dropped and counted as skipped,
// because a skipped row is a thing to say out loud. A nullable one is a
// name on a row that stands perfectly well without it: a job whose creator
// could not be re-created is still the job, so the column is blanked and
// the row goes in. Dropping the job instead would lose the work of everyone
// who was never missing in the first place.
export function withoutMissingProfiles(
  rows: Record<string, unknown>[],
  table: string,
  droppedIds: string[],
  refs: Record<string, { required: string[]; optional: string[] }>
): { rows: Record<string, unknown>[]; skipped: number } {
  const all = rows || [];
  const gone = new Set<string>();
  for (const id of droppedIds || []) { const s = String(id ?? ""); if (s) gone.add(s); }
  const ref = (refs || {})[table];
  if (!gone.size || !ref) return { rows: all, skipped: 0 };

  const required = ref.required || [];
  const optional = ref.optional || [];
  const out: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const row of all) {
    const r = (row ?? {}) as Record<string, unknown>;
    let orphaned = false;
    for (const column of required) {
      const v = r[column];
      if (v !== null && v !== undefined && gone.has(String(v))) { orphaned = true; break; }
    }
    if (orphaned) { skipped += 1; continue; }
    let blanked: Record<string, unknown> | null = null;
    for (const column of optional) {
      const v = r[column];
      if (v === null || v === undefined || !gone.has(String(v))) continue;
      blanked = blanked ?? { ...r };
      blanked[column] = null;
    }
    out.push(blanked ?? r);
  }
  return { rows: out, skipped };
}

// A re-created account gets a set-password link, because a password is the
// one thing a backup never holds. A deactivated one does not: the row says
// this person was locked out on purpose, RLS locks them out again the
// moment the profiles load puts deactivated_at back, and mailing them an
// invitation to set a password would be the app asking somebody who was
// let go to come back in.
export function wantsSetPasswordMail(profile: Record<string, unknown>): boolean {
  const off = (profile ?? {}).deactivated_at;
  return off === null || off === undefined || off === "";
}

// What a restore that had to leave people out writes on the run itself. It
// is put in `error` on a run that completed on purpose: the restore worked,
// and there is still something an Admin has to be told — these ids are the
// rows that are not in the restored database and never will be without a
// hand. Empty when nobody was left out, so the column stays null.
export function droppedAccountsNote(droppedIds: string[], failures: string[]): string {
  const ids = (droppedIds || []).map(String).filter(Boolean);
  if (!ids.length) return "";
  const many = ids.length !== 1;
  return `The restore finished, but ${ids.length} account${many ? "s" : ""} could not be re-created, ` +
    `so ${many ? "their profile rows" : "that profile row"} and the rows that cannot stand without ` +
    `${many ? "them" : "it"} were left out: ${(failures || []).join(" · ")} ` +
    `(profile ${many ? "ids" : "id"}: ${ids.join(", ")}).`;
}

// ── Chat history, in two passes ──────────────────────────────────────────

// Pass one. Two things happen here, and both are the shape of the RPC that
// does the inserting: it has no ON CONFLICT clause, so a row whose id is
// already on the table is not a no-op but a failed batch — hence the live
// ids are read first and the rows that match them are dropped. And every
// quote is emptied, because reply_to points back at chat_messages and a
// reply can sit in an earlier part than the message it quotes.
export function chatInsertRows(
  rows: Record<string, unknown>[], liveIds: Iterable<string>
): { rows: Record<string, unknown>[]; collisions: number } {
  const live = new Set<string>();
  for (const id of liveIds || []) live.add(String(id));
  const out: Record<string, unknown>[] = [];
  let collisions = 0;
  for (const row of rows || []) {
    const id = String((row as Record<string, unknown>).id ?? "");
    if (id && live.has(id)) { collisions += 1; continue; }
    out.push({ ...row, reply_to: null });
  }
  return { rows: out, collisions };
}

// Pass two. Only the messages that actually quote something, and only the
// two columns: by now every message in the backup is on the table, so this
// can only ever take the update arm of the upsert.
export function chatReplyPatches(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows || []) {
    const id = (row as Record<string, unknown>).id;
    const reply = (row as Record<string, unknown>).reply_to;
    if (!id || reply === null || reply === undefined) continue;
    out.push({ id, reply_to: reply });
  }
  return out;
}

// ── Rows whose parent did not land ───────────────────────────────────────

// The rows of one batch that still have something to point at. A restore
// that could not re-create an account leaves that person's rows out, and a
// row in a later table whose foreign key names one of them is a row nothing
// will ever satisfy: one of those in a batch is the whole batch refused.
//
// `presentIds` is what the database says is actually there, read back for
// this batch — not what the backup said should be there. That is the whole
// point: the two differ by exactly the rows this restore left out.
export function rowsWithLiveParent(
  rows: Record<string, unknown>[], column: string, presentIds: Iterable<string>
): { rows: Record<string, unknown>[]; dropped: number } {
  const present = new Set<string>();
  for (const id of presentIds || []) present.add(String(id));
  const out: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const row of rows || []) {
    // A row that names nobody is nobody's orphan: chat's quote column is
    // nullable, and a message that quotes nothing is not missing anything.
    const target = String((row as Record<string, unknown>)[column] ?? "");
    if (target && !present.has(target)) { dropped += 1; continue; }
    out.push(row);
  }
  return { rows: out, dropped };
}

// Pass two, when somebody was left out. A message written by an account
// that could not be re-created is not on the table, and a reply that quotes
// it would name a row that is not there — the foreign key would refuse the
// whole batch. The reply keeps its own words and loses the quote, which is
// exactly what chat already does when a quoted message is deleted.
export function quotesThatLanded(
  patches: Record<string, unknown>[], presentIds: Iterable<string>
): { rows: Record<string, unknown>[]; dropped: number } {
  return rowsWithLiveParent(patches, "reply_to", presentIds);
}

// ── The settings row ─────────────────────────────────────────────────────

// app_settings is not replaced wholesale. It holds the drive connection this
// very restore is running through, and it holds live vendor keys the backup
// deliberately blanked on its way out. So: a column the restore is never
// allowed to write is skipped; a credential column that is null in the
// backup is skipped, because every backup carries a null where the key was
// and writing that back would take the mail out of the building on a
// database whose own key was perfectly good; and a column with nothing in it
// is nothing to write.
export function settingsRestorePatch(
  source: Record<string, unknown>,
  neverRestored: string[],
  secrets: string[]
): Record<string, unknown> {
  const never = new Set((neverRestored || []).map(String));
  const secret = new Set((secrets || []).map(String));
  const patch: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(source || {})) {
    if (never.has(column)) continue;
    const missing = value === null || value === undefined;
    // Said on its own on purpose: the credential case is a rule with a
    // reason of its own, not a happy accident of the empty-value one. Every
    // backup carries a null where the key was.
    if (missing && secret.has(column)) continue;
    if (missing) continue;
    patch[column] = value;
  }
  return patch;
}

// ── Tickets and their money ──────────────────────────────────────────────

// A ticket goes back in at zero, and the lines put its total on it.
//
// tickets_total_balances is a DEFERRED CONSTRAINT trigger: at the commit of
// any insert or total-update it re-adds that ticket's lines and refuses the
// write if they do not come to the total on the row. ticket_lines load after
// tickets — they have to, the foreign key runs that way — so a ticket
// carrying its real total would be a ticket whose lines add up to nothing,
// and every priced ticket in the backup would be refused. Loading at zero
// balances against no lines, and ticket_lines' own sync trigger writes the
// real figure the moment the first line lands.
export function ticketsForLoad(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return (rows || []).map(row => ({ ...row, total: 0 }));
}

// Except for the ones nobody may re-price. An approved or invoiced ticket's
// total is a figure a client has signed or been billed for, and the sync
// trigger recomputes it from the lines like any other — which is the same
// answer for consistent data and is not the same answer for a ticket whose
// lines and total ever drifted apart. So the backup's own figure is written
// back over it afterwards, and only for those: the balance trigger lets an
// approved ticket alone, and a draft's total is its lines by definition.
export function approvedTotalPatches(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows || []) {
    const r = row as Record<string, unknown>;
    if (!r.id) continue;
    const signed = r.approved_at !== null && r.approved_at !== undefined;
    const billed = r.status === "Approved" || r.status === "Invoiced";
    if (!signed && !billed) continue;
    out.push({ id: r.id, total: r.total ?? 0 });
  }
  return out;
}

// ── Phase: activity ──────────────────────────────────────────────────────

// The board is ordered by jobs.last_activity_at and definer triggers on
// tickets, JHAs and reports keep it, so the load has just stamped every
// restored job with today. These are the backup's own values, put back once
// nothing else is going to touch them.
export function activityPatches(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows || []) {
    const id = (row as Record<string, unknown>).id;
    const at = (row as Record<string, unknown>).last_activity_at;
    if (!id || !at) continue;
    out.push({ id, last_activity_at: at });
  }
  return out;
}

// ── Small decisions ──────────────────────────────────────────────────────

// A backup holds the bytes of a stored file and not the type the bucket
// served it as, so the type is read back off the key. It matters: a report
// put back as application/octet-stream is a report the in-app viewer offers
// as a download instead of drawing on the screen.
const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain"
};

export function contentTypeFor(key: string): string {
  const name = String(key || "");
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "application/octet-stream";
  return CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

// The typed confirmation. Trimmed at both ends because a name copied off the
// screen brings a space with it, and compared character for character
// otherwise: the whole point of typing the folder's own name is that it
// cannot be typed for the wrong night by accident.
export function typedNameMatches(typed: unknown, folderName: unknown): boolean {
  const a = String(typed ?? "").trim();
  const b = String(folderName ?? "").trim();
  return !!b && a === b;
}

// Why a backup from a newer schema is not offered, said to somebody who has
// not read the code. It is the one refusal in the whole feature that cannot
// be worked around from this screen.
export function tooNewRefusal(backupVersion: string | null, liveVersion: string | null): string {
  return `That backup was taken from a newer version of the app (database ${backupVersion ?? "unknown"}) ` +
    `than this one (${liveVersion ?? "unknown"}), so it holds things this database has not got. ` +
    `Restoring it would fail halfway. Update the app first.`;
}

// The set-password mail is a courtesy that must never cost the restore: one
// address that bounces cannot be a reason to leave the company's records
// unrestored. This is how a failure is written down instead.
export function accountFailureNote(who: string, why: string): string {
  return `${who}: ${why}`;
}

// ═════════════════════════════════════════════════════════════════════════
// Restoring a few jobs — the everyday mistake
// ═════════════════════════════════════════════════════════════════════════
//
// The disaster story replaces everything; the everyday one is a job somebody
// deleted on Tuesday. So this kind writes into tables that are NOT empty,
// and every rule below follows from that one difference:
//
//   · nothing live is deleted and nothing live is overwritten — a row whose
//     id is already here is left alone, which makes restoring the same job
//     twice a no-op rather than a duplicate;
//   · a ticket number already in use by a DIFFERENT ticket is a collision,
//     and that ticket goes back unrestored with its charges and crew,
//     because a ticket number is somebody's invoice reference;
//   · everything a job points at that may no longer exist is resolved rather
//     than assumed.
//
// And because a row this restore chose not to write is a parent some other
// row still names, the children of a skipped row are never even read for:
// the filter below follows the jobs and the tickets that ACTUALLY landed,
// not the ones that were asked for.

export const JOB_RESTORE_KIND = "restore_jobs";

// No safety phase and no wipe: it deletes nothing, so there is nothing to
// take a copy of first. The activity phase is here for the same reason
// restore-all has one — a trigger writes over two figures on the way in.
export const JOB_RESTORE_PHASES: string[] = ["tables", "files", "activity", "done"];

// This kind reports by name rather than by tally, and the report lives on
// the run's cursor, which is one jsonb column. Past this many the notes stop
// and say so: a report nobody can read is not a report, and a cursor that
// grows without bound is a row that stops fitting.
export const MAX_RESTORE_NOTES = 200;

export interface JobRestoreCursor {
  kind: string;
  phase: string;
  folderId: string;
  folderName: string;
  // What the Admin picked, off the backup's own jobs index.
  jobIds: string[];
  tableIndex: number;
  partIndex: number;
  // The jobs and the tickets this run actually wrote. Everything under them
  // is filtered by these and never by what was asked for: a job that
  // collided on its number has no row for its tickets to point at.
  jobsDone: string[];
  ticketIds: string[];
  // And the chosen jobs that were already in the app. They are not on
  // jobsDone — this run did not write them, so their place on the board and
  // their tickets' signed totals are their own — but they are a row that
  // exists, so their missing tickets, assessments and reports go under them.
  // A restore that died between a job and its children left exactly that,
  // and pressing the button again is how an office fixes it.
  jobsHere: string[];
  // bucket/key for each PDF the restored rows point at, fetched in the
  // files phase.
  pdfKeys: string[];
  loaded: Record<string, number>;
  // Which drive file is which, worked out once and kept: the files folder of
  // a year's backup is thousands of entries and listing it per slice is a
  // round trip, but matching it per slice is not free either.
  fileIndex: { key: string; id: string | null }[] | null;
  fileOffset: number;
  filesDone: number;
  filesBytes: number;
  totalsPart: number;
  totalsDone: boolean;
  activityPart: number;
  // Sentences, not numbers. "Two records were skipped" tells an office
  // nothing; "ticket 24-118 is already in use here" tells them what to do.
  skipped: string[];
  collisions: string[];
}

export function newJobRestoreCursor(o: {
  folderId: string; folderName: string; jobIds: string[];
}): JobRestoreCursor {
  return {
    kind: JOB_RESTORE_KIND,
    phase: "tables",
    folderId: String(o.folderId ?? ""),
    folderName: String(o.folderName ?? ""),
    jobIds: strs(o.jobIds),
    tableIndex: 0,
    partIndex: 0,
    jobsDone: [],
    ticketIds: [],
    jobsHere: [],
    pdfKeys: [],
    loaded: {},
    fileIndex: null,
    fileOffset: 0,
    filesDone: 0,
    filesBytes: 0,
    totalsPart: 0,
    totalsDone: false,
    activityPart: 0,
    skipped: [],
    collisions: []
  };
}

export function reviveJobRestoreCursor(raw: unknown): JobRestoreCursor {
  const c = (raw ?? {}) as Record<string, unknown>;
  const base = newJobRestoreCursor({
    folderId: String(c.folderId ?? ""),
    folderName: String(c.folderName ?? ""),
    jobIds: strs(c.jobIds)
  });
  const index = Array.isArray(c.fileIndex)
    ? (c.fileIndex as Record<string, unknown>[]).map(e => ({
        key: String((e ?? {}).key ?? ""),
        id: (e ?? {}).id ? String((e as Record<string, unknown>).id) : null
      }))
    : null;
  return {
    ...base,
    phase: typeof c.phase === "string" && c.phase ? c.phase : base.phase,
    tableIndex: num(c.tableIndex),
    partIndex: num(c.partIndex),
    jobsDone: strs(c.jobsDone),
    ticketIds: strs(c.ticketIds),
    jobsHere: strs(c.jobsHere),
    pdfKeys: strs(c.pdfKeys),
    loaded: (c.loaded ?? {}) as Record<string, number>,
    fileIndex: index,
    fileOffset: num(c.fileOffset),
    filesDone: num(c.filesDone),
    filesBytes: num(c.filesBytes),
    totalsPart: num(c.totalsPart),
    totalsDone: c.totalsDone === true,
    activityPart: num(c.activityPart),
    skipped: strs(c.skipped),
    collisions: strs(c.collisions)
  };
}

// Which cursor a slice is holding. The two kinds share one function, one
// row and one set of guards, and they differ in shape — so the shape says
// which it is, off a field the cursor carries rather than a guess at its
// contents.
export function isJobRestoreCursor(c: unknown): boolean {
  return !!c && (c as Record<string, unknown>).kind === JOB_RESTORE_KIND;
}

// What the panel shows for this kind. `skipped` and `collisions` are the
// notes themselves — a count of collisions is a count nobody can act on.
export function jobRestoreCounts(c: JobRestoreCursor): Record<string, unknown> {
  return {
    rows: c.loaded ?? {},
    files: num(c.filesDone),
    bytes: num(c.filesBytes),
    skipped: c.skipped ?? [],
    collisions: c.collisions ?? []
  };
}

// One more note, up to the cap and then one line saying there were more.
export function addRestoreNote(notes: string[], text: string): string[] {
  if (notes.length < MAX_RESTORE_NOTES) notes.push(text);
  else if (notes.length === MAX_RESTORE_NOTES) {
    notes.push("…and more were left out or already here; they are not listed.");
  }
  return notes;
}

const setOf = (ids: Iterable<string> | undefined): Set<string> => {
  const out = new Set<string>();
  for (const id of ids || []) { const s = String(id ?? ""); if (s) out.add(s); }
  return out;
};

// ── Which rows of a part belong to this restore ──────────────────────────

// The backup is read the same way it was written — part by part — and each
// part is filtered here, so a per-job restore never holds more than one part
// in memory however big the backup is.
//
// Three different sets, and the difference between them is the whole point:
// `chosen` is what the Admin picked, `restored` is the jobs that actually
// went back, `tickets` is the tickets that actually went back. Children
// follow the last two, so a job that collided on its number takes its
// tickets, assessments and reports out of the restore with it rather than
// leaving them to be refused by a foreign key.
export function rowsForChosenJobs(
  table: string,
  rows: Record<string, unknown>[],
  sets: { chosen: Iterable<string>; restored: Iterable<string>; tickets: Iterable<string> }
): Record<string, unknown>[] {
  const chosen = setOf(sets.chosen);
  const restored = setOf(sets.restored);
  const tickets = setOf(sets.tickets);
  return (rows || []).filter(row => {
    const r = (row ?? {}) as Record<string, unknown>;
    if (table === "jobs") return chosen.has(String(r.id ?? ""));
    if (table === "ticket_lines" || table === "ticket_crew") {
      return tickets.has(String(r.ticket_id ?? ""));
    }
    return restored.has(String(r.job_id ?? ""));
  });
}

// ── Nothing live is overwritten ──────────────────────────────────────────

// A job already here by id is left alone — that is what makes restoring the
// same job twice a no-op. A job whose NUMBER is here under a different id is
// something else entirely: jobs.job_number is unique, so the insert would be
// refused anyway, and silently is the wrong way to be refused.
//
// Left alone is not the same as finished with, and `alreadyHere` is the
// difference. A restore that failed between the jobs insert and the tickets
// left the job live with nothing under it; pressing the button again skips
// that job by id, and if the skip took its children out of the run with it
// the retry would report itself green over a job that is still missing its
// work. So its id comes back on this list, the children follow it, and every
// row of theirs that is already there is skipped one at a time, by id, the
// way every other row is.
export function jobsToRestore(
  rows: Record<string, unknown>[],
  live: { ids: Iterable<string>; numbers: Iterable<string> }
): {
  rows: Record<string, unknown>[]; alreadyHere: string[];
  skipped: string[]; collisions: string[];
} {
  const ids = setOf(live.ids);
  const numbers = setOf(live.numbers);
  const out: Record<string, unknown>[] = [];
  const alreadyHere: string[] = [];
  const skipped: string[] = [];
  const collisions: string[] = [];
  for (const row of rows || []) {
    const r = (row ?? {}) as Record<string, unknown>;
    const number = String(r.job_number ?? "");
    if (ids.has(String(r.id ?? ""))) {
      alreadyHere.push(String(r.id ?? ""));
      addRestoreNote(skipped,
        `Job ${number} is already in the app, so the job itself was left alone — any of its tickets, ` +
        `assessments and reports that were missing were restored beside it.`);
      continue;
    }
    if (numbers.has(number)) {
      addRestoreNote(collisions,
        `Job number ${number} is already used by a different job here, so that job was not restored.`);
      continue;
    }
    out.push(r);
  }
  return { rows: out, alreadyHere, skipped, collisions };
}

// A ticket's id IS its number, so an id already in use is the collision the
// office cares about — and a number deliberately retired is not free either.
// Its charges and crew go with it: half a ticket is worse than none.
//
// With one exception, and `jobOf` is what tells it apart: a ticket already
// here ON THE JOB IT CAME BACK UNDER is that same ticket, not a second
// invoice bearing one number. That is the second press of Restore jobs, and
// twenty lines calling it a collision would read as twenty invoices in
// danger. It is left alone and said once, and its charges and crew hours
// stay exactly as they are — this restore does not reprice a live ticket.
// Without a `jobOf` there is nothing to tell apart, and every live id is a
// collision as before.
export function ticketsToRestore(
  rows: Record<string, unknown>[],
  live: { ids: Iterable<string>; burned: Iterable<string>; jobOf?: Map<string, string> }
): { rows: Record<string, unknown>[]; skipped: string[]; collisions: string[] } {
  const ids = setOf(live.ids);
  const burned = setOf(live.burned);
  const jobOf = live.jobOf ?? new Map<string, string>();
  const out: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  const collisions: string[] = [];
  let already = 0;
  for (const row of rows || []) {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = String(r.id ?? "");
    if (ids.has(id)) {
      const on = String(jobOf.get(id) ?? "");
      if (on && on === String(r.job_id ?? "")) { already += 1; continue; }
      addRestoreNote(collisions,
        `Ticket ${id} already exists here${on ? " on a different job" : ""}, so it and its charges ` +
        `and crew hours were not restored.`);
      continue;
    }
    if (burned.has(id)) {
      addRestoreNote(collisions,
        `Ticket number ${id} has been retired in this app, so that ticket was not restored.`);
      continue;
    }
    out.push(r);
  }
  if (already) {
    addRestoreNote(skipped,
      `${already} ticket${already === 1 ? " was" : "s were"} already in the app and ${already === 1 ? "was" : "were"} ` +
      `left alone, along with ${already === 1 ? "its" : "their"} charges and crew hours.`);
  }
  return { rows: out, skipped, collisions };
}

// What to call a row when a note is all an office has to go on. A ticket is
// its number; a report is the file somebody uploaded; an assessment is the
// day it was raised for. "A row was skipped" is not a report.
export function rowIdentity(table: string, row: Record<string, unknown>): string {
  const r = (row ?? {}) as Record<string, unknown>;
  if (table === "tickets") return `Ticket ${String(r.id ?? "")}`;
  if (table === "reports") {
    const name = String(r.filename ?? "").trim();
    return name ? `The report ${name}` : "A report";
  }
  if (table === "jhas") {
    const day = String(r.work_date ?? "").trim();
    return day ? `The assessment of ${day}` : "An assessment";
  }
  const what = table.replace(/_/g, " ").replace(/s$/, "");
  return `A ${what} row`;
}

// tickets, reports and jhas each carry a client_key — the idempotency key the
// app mints for a record it has not saved yet, unique across the table
// wherever it is not null. A restored row keeps its own, so a key that is
// live here under a DIFFERENT id is an insert Postgres refuses outright, and
// one refused row fails the whole batch with a message naming an index.
//
// So it is asked about first, and answered the way a ticket number in use is
// answered: that row is not restored, it is named, and anything that depends
// on it goes with it — a ticket left out here never reaches c.ticketIds, so
// its charges and crew hours are never attempted.
export function withoutTakenClientKeys(
  table: string, rows: Record<string, unknown>[], liveKeys: Iterable<string>
): { rows: Record<string, unknown>[]; collisions: string[] } {
  const taken = setOf(liveKeys);
  const all = rows || [];
  if (!taken.size) return { rows: all, collisions: [] };
  const out: Record<string, unknown>[] = [];
  const collisions: string[] = [];
  for (const row of all) {
    const r = (row ?? {}) as Record<string, unknown>;
    const key = String(r.client_key ?? "").trim();
    if (key && taken.has(key)) {
      addRestoreNote(collisions,
        `${rowIdentity(table, r)} was not restored: another record in the app already carries the same ` +
        `save key, and two of them is a row the database refuses.`);
      continue;
    }
    out.push(r);
  }
  return { rows: out, collisions };
}

// The plain children — charges, crew, assessments, reports, price overrides.
// Already here means left alone, and it is said once for the table rather
// than once for the row: a hundred lines saying a charge was already there
// is not a report anybody reads.
export function childRowsToRestore(
  table: string, rows: Record<string, unknown>[], liveIds: Iterable<string>
): { rows: Record<string, unknown>[]; skipped: string[] } {
  const live = setOf(liveIds);
  const out: Record<string, unknown>[] = [];
  let already = 0;
  for (const row of rows || []) {
    const r = (row ?? {}) as Record<string, unknown>;
    if (live.has(String(r.id ?? ""))) { already += 1; continue; }
    out.push(r);
  }
  const skipped: string[] = [];
  if (already) {
    const what = table.replace(/_/g, " ").replace(/s$/, "");
    addRestoreNote(skipped,
      `${already} ${what}${already === 1 ? "" : "s"} were already in the app and were left alone.`);
  }
  return { rows: out, skipped };
}

// ticket_crew.profile_id is NOT NULL, so a crew row for somebody with no
// profile cannot be written at all. There is nothing else it could be — and
// it is hours somebody worked, so it is counted out loud rather than
// quietly dropped.
export function crewWithLiveProfiles(
  rows: Record<string, unknown>[], liveProfileIds: Iterable<string>
): { rows: Record<string, unknown>[]; skipped: string[] } {
  const live = setOf(liveProfileIds);
  const out: Record<string, unknown>[] = [];
  let gone = 0;
  for (const row of rows || []) {
    const r = (row ?? {}) as Record<string, unknown>;
    if (!live.has(String(r.profile_id ?? ""))) { gone += 1; continue; }
    out.push(r);
  }
  const skipped: string[] = [];
  if (gone) {
    addRestoreNote(skipped,
      `${gone} crew ${gone === 1 ? "row" : "rows"} could not be restored: ${gone === 1 ? "that account is" : "those accounts are"} ` +
      `no longer in the app, so ${gone === 1 ? "its" : "their"} hours are missing from the restored tickets.`);
  }
  return { rows: out, skipped };
}

// A name on a row that stands perfectly well without it — a job's creator, a
// ticket's technician, an assessment's signer. The column is blanked and the
// row goes in; dropping the row instead would lose the work.
export function blankUnknown(
  rows: Record<string, unknown>[], column: string, liveIds: Iterable<string>
): Record<string, unknown>[] {
  const live = setOf(liveIds);
  return (rows || []).map(row => {
    const r = (row ?? {}) as Record<string, unknown>;
    const v = r[column];
    if (v === null || v === undefined || live.has(String(v))) return r;
    return { ...r, [column]: null };
  });
}

// ── The organisations and people a job points at ─────────────────────────

// A job's client or contractor: kept by id when that organisation still
// exists, matched by name when it does not — a client re-entered by hand
// after a mistake has a new id and the same name — and otherwise left empty
// and named in the report rather than blocking the job.
export function matchOrganisation(
  wantedId: unknown,
  backupNames: Map<string, string>,
  live: { ids: Set<string>; byName: Map<string, string> }
): { id: string | null; how: string; name: string } {
  const wanted = String(wantedId ?? "").trim();
  if (!wanted) return { id: null, how: "none", name: "" };
  const name = String(backupNames.get(wanted) ?? "").trim();
  if (live.ids.has(wanted)) return { id: wanted, how: "id", name };
  const matched = name ? live.byName.get(name.toLowerCase()) : undefined;
  if (matched) return { id: matched, how: "name", name };
  return { id: null, how: "lost", name };
}

// A job's client or contractor contact, the same way — except that a contact
// name is unique only inside its organisation (contacts carry org_id, and
// two firms may each have a Dave), so the match is made inside whichever
// organisation the job has just ended up pointing at. With no organisation
// there is nowhere to look, and the column is left empty.
export function matchContact(
  wantedId: unknown,
  backupContacts: Map<string, { name: string; org_id: string }>,
  live: { ids: Set<string>; byOrgAndName: Map<string, string> },
  orgId: string | null
): { id: string | null; how: string; name: string } {
  const wanted = String(wantedId ?? "").trim();
  if (!wanted) return { id: null, how: "none", name: "" };
  const from = backupContacts.get(wanted);
  const name = String((from ?? {}).name ?? "").trim();
  if (live.ids.has(wanted)) return { id: wanted, how: "id", name };
  const matched = orgId && name
    ? live.byOrgAndName.get(`${orgId}|${name.toLowerCase()}`)
    : undefined;
  if (matched) return { id: matched, how: "name", name };
  return { id: null, how: "lost", name };
}

export function contactKey(orgId: unknown, name: unknown): string {
  return `${String(orgId ?? "")}|${String(name ?? "").trim().toLowerCase()}`;
}

// ── The PDFs, and the two figures a trigger writes over ──────────────────

// bucket/key for each PDF the rows that actually went back point at, which
// is the same shape restore-all's file entries are named in. A row with no
// PDF is not a missing PDF.
export function pdfKeysFor(bucket: string, rows: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const row of rows || []) {
    const key = String(((row ?? {}) as Record<string, unknown>).pdf_key ?? "").trim();
    if (key) out.push(`${bucket}/${key}`);
  }
  return out;
}

// The patches for the rows THIS run wrote and no others. A ticket that was
// already here keeps its own total and a job that was already here keeps its
// own place on the board: this restore did not write them, and re-pricing a
// ticket somebody has signed is not a per-job restore's to do.
export function onlyForIds(
  patches: Record<string, unknown>[], ids: Iterable<string>
): Record<string, unknown>[] {
  const mine = setOf(ids);
  return (patches || []).filter(p => mine.has(String(((p ?? {}) as Record<string, unknown>).id ?? "")));
}

// ── The cursor's arithmetic ──────────────────────────────────────────────

// Nothing to hang a record on. Once the jobs table has been walked, a run
// with no job written and no chosen job already here has no row for a
// ticket, a charge, an assessment, a PDF or a patch to belong to — every
// chosen job collided on its number, or was not in that backup at all. The
// five remaining tables, the drive's file listing and the two patch passes
// are all work with a known answer, so the run stops and reports what it
// found rather than reading a year's parts to filter them all away.
export function noRestorableJobs(c: JobRestoreCursor): boolean {
  return !(c.jobsDone ?? []).length && !(c.jobsHere ?? []).length;
}

export function afterJobPart(c: JobRestoreCursor, done: {
  table: string; rows: number; lastPart: boolean; tableCount: number;
}): JobRestoreCursor {
  c.loaded[done.table] = num(c.loaded[done.table]) + num(done.rows);
  if (done.lastPart) return afterJobTable(c, done.tableCount);
  c.partIndex = num(c.partIndex) + 1;
  return c;
}

export function afterJobTable(c: JobRestoreCursor, tableCount: number): JobRestoreCursor {
  c.tableIndex = num(c.tableIndex) + 1;
  c.partIndex = 0;
  if (c.tableIndex >= tableCount) c.phase = "files";
  return c;
}

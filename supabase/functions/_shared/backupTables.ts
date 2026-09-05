// What a backup is made of: which tables, in what order, and which columns
// never leave the building.
//
// Erasable TypeScript only, and no imports: vite-app/src/backupShared.test.mjs
// imports this file straight out of supabase/functions/ and node strips the
// types. An enum or a parameter property here breaks the test suite.
//
// Two orders, and they are not each other's reverse. LOAD_ORDER is
// parents-first, so an insert never names a row that is not there yet.
// WIPE_ORDER is the delete order supabase/handover/wipe-seed-data.sql
// worked out the hard way — children first, profiles last because every
// other table names it, and audit_log and function_errors in there too
// because their foreign keys to profiles would otherwise abort the whole
// transaction. The test reads the handover script back and compares.

export const LOAD_ORDER: string[] = [
  // profiles first of all: every other table's created_by, technician_id
  // and profile_id points at it. Its own id is a foreign key to
  // auth.users, which is why a restore creates the missing Auth accounts
  // BEFORE it loads this table, not after.
  "profiles",
  "clients",
  "contractors",
  // No foreign key of its own — org_id is a discriminated reference — but
  // jobs.client_contact_id and jobs.contractor_contact_id both name it, so
  // it loads before jobs.
  "contacts",
  "rate_schedules",
  "rate_lines",
  "rate_line_history",
  "jobs",
  "rate_overrides",
  "tickets",
  "ticket_lines",
  "ticket_crew",
  "jhas",
  "reports",
  "equipment",
  "timesheet_approvals",
  // chat_messages.reply_to points at chat_messages, so its rows are loaded
  // oldest first — a reply is always newer than the message it quotes.
  "chat_messages",
  "chat_reactions",
  "chat_reads",
  "push_subscriptions",
  "arcade_scores",
  "burned_ticket_numbers",
  // Last, and restored by a narrow UPDATE rather than an insert: this row
  // holds the drive connection the restore is running through.
  "app_settings"
];

export const BACKUP_TABLES: string[] = LOAD_ORDER;

export const WIPE_ORDER: string[] = [
  "ticket_crew",
  "ticket_lines",
  "tickets",
  "burned_ticket_numbers",
  "timesheet_approvals",
  "jhas",
  "reports",
  "rate_overrides",
  "jobs",
  // rate_lines before its history, not after: rate_lines_history_trigger
  // fires AFTER DELETE and writes a history row per line removed, so
  // clearing the history first leaves exactly as many phantom rows behind
  // as there were lines, and the load that follows collides with them.
  "rate_lines",
  "rate_line_history",
  "rate_schedules",
  "contacts",
  "clients",
  "contractors",
  "chat_reactions",
  "chat_reads",
  "chat_messages",
  "push_subscriptions",
  "arcade_scores",
  // Not backed up — operational noise — but they carry foreign keys to
  // profiles, so they have to go before profiles can. A restored database
  // therefore starts with an empty error log and an empty audit trail, and
  // the panel says so.
  "function_errors",
  "audit_log",
  "equipment",
  "profiles"
];

export const NEVER_WIPED: string[] = ["app_settings"];

export const BUCKETS: string[] = ["reports", "jhas", "shared", "timesheets", "chat-media"];

// Stripped from the app_settings row on its way into a backup. A backup
// lives in somebody's consumer drive; a Resend key in it is a key posted to
// a consumer drive. The list is checked against the migrations by the test:
// a later app_settings column whose name says key, secret or token must be
// added here.
export const APP_SETTINGS_SECRETS: string[] = [
  "resend_api_key",
  "klipy_api_key",
  "backup_refresh_token",
  "backup_oauth_state",
  "backup_client_secret_google",
  "backup_client_secret_microsoft",
  "backup_client_secret_dropbox"
];

// Never written back by a restore. Restoring the drive connection out of a
// backup would point the running restore at whatever drive was connected
// when that backup was taken — possibly none at all, mid-restore.
export const APP_SETTINGS_NEVER_RESTORED: string[] = [
  "id",
  "backup_provider",
  "backup_refresh_token",
  "backup_account",
  "backup_root_folder_id",
  "backup_connection_error",
  "backup_oauth_state",
  "backup_oauth_state_at",
  "backup_client_id_google",
  "backup_client_secret_google",
  "backup_client_id_microsoft",
  "backup_client_secret_microsoft",
  "backup_client_id_dropbox",
  "backup_client_secret_dropbox",
  "backup_frequency",
  "backup_weekday",
  "backup_hour",
  "backup_keep",
  "backup_next_run_at"
];

export const TABLE_KEYS: Record<string, string[]> = {
  profiles: ["id"],
  clients: ["id"],
  contractors: ["id"],
  contacts: ["id"],
  rate_schedules: ["id"],
  rate_lines: ["id"],
  rate_line_history: ["id"],
  jobs: ["id"],
  rate_overrides: ["id"],
  tickets: ["id"],
  ticket_lines: ["id"],
  ticket_crew: ["id"],
  jhas: ["id"],
  reports: ["id"],
  equipment: ["id"],
  timesheet_approvals: ["id"],
  chat_messages: ["id"],
  chat_reactions: ["message_id", "profile_id", "emoji"],
  chat_reads: ["profile_id"],
  push_subscriptions: ["id"],
  arcade_scores: ["game", "profile_id"],
  burned_ticket_numbers: ["id"],
  app_settings: ["id"]
};

// How a table is walked past PostgREST's silent 1,000-row cap. A single
// unique column means keyset — "the next thousand after this id" — which
// cannot skip a row when one is inserted mid-walk, and every table holding
// money, hours or dose has one. The two with a composite primary key are
// walked by OFFSET instead: chat_reactions is thumbs-ups and arcade_scores
// is a high-score table, and a reappearing or missing row in either is not
// something anybody is paid from.
export const CURSOR_COLUMN: Record<string, string | null> = {
  profiles: "id",
  clients: "id",
  contractors: "id",
  contacts: "id",
  rate_schedules: "id",
  rate_lines: "id",
  rate_line_history: "id",
  jobs: "id",
  rate_overrides: "id",
  tickets: "id",
  ticket_lines: "id",
  ticket_crew: "id",
  jhas: "id",
  reports: "id",
  equipment: "id",
  timesheet_approvals: "id",
  chat_messages: "id",
  chat_reactions: null,
  chat_reads: "profile_id",
  push_subscriptions: "id",
  arcade_scores: null,
  burned_ticket_numbers: "id",
  app_settings: "id"
};

// What "restore these jobs" reaches for, in the order it inserts them.
export const JOB_CHILD_TABLES: string[] = [
  "tickets", "ticket_lines", "ticket_crew", "jhas", "reports", "rate_overrides"
];

// PostgREST answers at most 1,000 rows per request, silently.
export const PAGE_ROWS = 1000;

// A part is uploaded and forgotten, so this is the ceiling on how much of
// one table is held in a function's memory at once. Twenty-five pages of
// ticket_lines is a few megabytes of JSON before gzip.
export const MAX_PART_ROWS = 25000;

// A copy of the rows with the credential columns emptied. The caller's rows
// are never touched: they are also what gets counted and what the manifest
// records.
export function stripSecrets(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (table !== "app_settings") return rows;
  return rows.map(row => {
    const out: Record<string, unknown> = { ...row };
    for (const column of APP_SETTINGS_SECRETS) {
      if (column in out) out[column] = null;
    }
    return out;
  });
}

// One flat path segment — every provider reads a "/" in a name as a folder
// boundary — numbered from 01 so the parts sort into their own order.
export function partFileName(table: string, index: number): string {
  return `${table}.${String(index + 1).padStart(2, "0")}.json.gz`;
}

export function chunkRows<T>(rows: T[], max: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += max) out.push(rows.slice(i, i + max));
  return out;
}

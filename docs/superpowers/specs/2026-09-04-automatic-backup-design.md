# Automatic backup to a drive, with restore

Date: 2026-09-04. Approved in conversation by Kyle Keith.

## What this is

An Admin connects one drive account (Google Drive, OneDrive or Dropbox) from
the Archive block of the Admin screen, picks a schedule, and from then on the
project backs itself up to a dated folder in that drive: every table as
gzipped JSON, every stored PDF, and a manifest. From the same panel the Admin
can run a backup now, see the last run, and restore — either everything (the
disaster story) or a chosen set of jobs (the everyday mistake).

The work runs server-side, in Edge Functions driven by pg_cron, the pattern
chat-retention already uses. The browser never sees a drive token and never
holds a backup in memory.

## Out of scope

- Point-in-time database recovery (Supabase's own PITR covers that).
- Backing up Auth passwords. Restore re-creates missing accounts and mails a
  set-password link.
- More than one connected drive at a time.
- Encrypting backups beyond what the drive provider does.

## Components

### Drive connection (`backup-oauth` Edge Function)

- The Admin enters the provider's client id and client secret in the panel
  (each provider needs an app registration under Kyle's account). The panel
  shows the three redirect URIs to paste into those registrations:
  `<approval base URL origin>/backup/oauth/google`, `/microsoft`, `/dropbox`.
- Connect opens the provider's consent page (scopes: Google
  `drive.file`; Microsoft `Files.ReadWrite offline_access`; Dropbox
  `files.content.write files.content.read files.metadata.read` with token
  access type offline). State is a random nonce stored in app_settings for
  ten minutes.
- The Worker proxies `/backup/oauth/*` to the function the way `/approve`
  is proxied. The function exchanges the code, stores `backup_provider`,
  `backup_refresh_token`, `backup_root_folder_id` (created as
  `VagaboNDE backups` at the drive root) in app_settings, and redirects back
  to the app with `?backup=connected`.
- Disconnect clears those columns. Connecting a different provider
  disconnects the old one first.
- Tokens are refreshed inside the functions on demand; a refresh failure
  marks the connection as needing reconnection (`backup_connection_error`)
  and the panel says so.

### Drive client interface (`_shared/drive.ts`)

One interface, three implementations, one fake for tests:

```
listFolders(parentId) → [{ id, name }]
createFolder(parentId, name) → id
upload(folderId, name, bytes, contentType) → id   (resumable above 5 MB)
download(fileId) → bytes
delete(id)
```

Provider quirks stay inside their implementation (Google resumable
sessions, Graph upload sessions, Dropbox upload sessions; Dropbox paths
instead of ids are mapped internally).

### What a backup contains

Folder `VagaboNDE backups/<YYYY-MM-DD HH-MM>/` (Grande Prairie time):

- `manifest.json`: app version, schema version (latest row of
  `supabase_migrations.schema_migrations`), started/finished, row count per
  table, file count and bytes, and a jobs index (job number, client,
  project, created_at, status, ticket/JHA/report counts) for the per-job
  restore.
- `tables/<table>.json.gz`: one file per table, rows as they are, ids
  preserved. Tables: clients, contractors, contacts, profiles, jobs,
  tickets, ticket_lines, ticket_crew, jhas, reports, rate_schedules,
  rate_lines, rate_overrides, rate_line_history, equipment,
  timesheet_approvals, chat_messages, chat_reactions, chat_reads,
  push_subscriptions, arcade_scores, issued_ticket_numbers, app_settings.
  app_settings is written without secret columns (Resend key, KLIPY key,
  drive tokens and client secrets); profiles carries role and tabs, never
  passwords.
- `files/<bucket>/<object key>`: every object in jhas, reports, shared,
  timesheets, chat-media.

Retention: `backup_keep` runs (default 14). After a successful run the
function deletes the oldest folders beyond that count, never the
`before-restore` folders.

### Schedule and run state (`backup-run` Edge Function, `backup_runs` table)

Settings in app_settings: `backup_frequency` (daily | weekdays | weekly |
monthly), `backup_weekday` (for weekly), `backup_hour` (0–23, Edmonton),
`backup_keep`, `backup_next_run_at`.

`backup_runs`: id, kind (backup | restore_all | restore_jobs |
before_restore), status (queued | running | complete | failed), phase,
cursor (jsonb), counts (jsonb), error, folder_id, folder_name, started_at,
finished_at, requested_by. Admin-only read; writes are the service role's.

pg_cron job `backup-tick`, every five minutes, calls `backup-run` through
pg_net with the internal secret (chat-retention's shape). Each call:

1. If a run is `running`, advance it for up to ~100 seconds of work and
   return.
2. Else if `backup_next_run_at` is due (or a queued "Back up now" exists),
   create the run and start it.
3. Else return.

Backup phases, in order: `tables` (one table at a time, paged by primary
key, 1,000 rows a page, gzipped and uploaded when the table is done — a
table larger than memory allows is split into numbered parts), `files`
(bucket by bucket, listing paged, each object downloaded and uploaded,
cursor = bucket + last key), `manifest`, `retention`, then complete.
`backup_next_run_at` is advanced when a run starts, computed by a pure
`nextRunAt(settings, now)` in the shared module and mirrored in
vite-app/src for the panel's "next due" line and its tests.

An upload that fails is retried three times with backoff; after that the
run is `failed` with the reason and a row in function_errors. A failed run
does not block the next scheduled one. "Back up now" inserts a queued run
and the next tick picks it up.

### Restore, replace everything (`backup-restore`, kind `restore_all`)

Gates, in order: Admin role checked in the function; the chosen backup's
schema version must not be newer than the live one (refused), and an older
one is warned about; the Admin types the backup's folder name.

Phases: `safety` (a full backup into `before-restore <stamp>`, same code
path as a backup), `wipe` (tables emptied in the FK order the handover wipe
script uses, keeping Kyle's own profile row and Auth user), `tables`
(insert each table from the backup, ids preserved, in dependency order,
with triggers left on: the guard triggers exempt the service role, the
total trigger recomputes the same cents the backup holds, and
`jobs.last_activity_at`, which the activity trigger overwrites during the
load, is written back from the backup in a final update), `files` (objects re-uploaded into
the buckets, overwriting), `accounts` (for each profile whose Auth user no
longer exists, create it with a random password and send the set-password
mail through `_shared/setPassword.ts`; failures are listed, not fatal),
then complete. Progress and the final report show in the panel; anything
skipped goes to function_errors too.

### Restore selected jobs (kind `restore_jobs`)

The Admin picks jobs from the manifest's index. The function reads only
what it needs from the backup: the jobs rows, their tickets, ticket_lines,
ticket_crew, jhas, reports, rate_overrides, and the PDFs those reference.
Rows whose id already exists live are skipped. Client and contractor ids
are kept when they exist live, otherwise matched by name, otherwise the job
is restored with a null organisation and reported. Ticket numbers are kept
as they were; a number already in use live is reported as a collision and
that ticket is skipped. Nothing live is deleted. Plain confirmation.

### Admin screen

Inside the Archive Blueprint, under the dropdown, an "Automatic backup"
panel:

- Provider row: connected as (provider + account name from the token
  exchange), Connect / Disconnect, and a collapsed "App registration"
  section with client id and secret fields per provider and the redirect
  URIs.
- Schedule row: frequency, weekday, hour, keep N; Save.
- "Back up now" and the last-run line (when, outcome, counts, or the
  error), plus "next due".
- Backups list (read from the drive through a `backup-list` action of the
  function): date, app version, counts, size, with Restore and Restore jobs
  buttons per row. Restore opens the typed-name dialog; Restore jobs opens
  the searchable job picker.
- Progress of a running restore or backup, polled every few seconds from
  `backup_runs`.

Everything is gated by the Admin tab it sits on and by the functions' own
Admin check.

### Security

- Refresh tokens and client secrets live in app_settings under the existing
  Admin-only RLS and are never selected by the client; the panel only
  learns "connected" and the account name.
- All three functions verify a signed-in Admin (or the internal secret for
  the cron tick). `backup-oauth`'s callback is reachable without a JWT but
  acts only on a nonce it minted.
- Backups contain the crew's private hours and dose; they go only to the
  Admin's own drive, and the manifest names that.

### Testing

- Node suite: `nextRunAt` for every frequency across DST and month ends;
  manifest building; FK order shared by wipe and restore; per-job selection
  and collision reporting; the drive interface against the fake.
- Deno: the drive implementations exercised against recorded fixtures for
  each provider's upload-session handshake.
- Live: a probe that runs a backup of the seed data, restores it into a
  fresh Supabase branch, and diffs row and file counts; role simulation on
  `backup_runs` RLS and the new app_settings columns.

### Migration

One migration: app_settings columns above, `backup_runs` with RLS, the
`backup-tick` cron job, and a `backup_state()` RPC (Admin) returning the
settings minus secrets, connection status, the last run and the next due
time for the panel. Applied live first, then filed, per the project rule.

## Order of work

1. Migration and the drive interface with the fake.
2. `backup-oauth` and the Worker proxy; the panel's provider row.
3. `backup-run` backup phases; schedule settings; "Back up now"; last-run
   line; cron.
4. Backups list and restore-all.
5. Restore selected jobs.
6. Docs (CLAUDE.md rules, README, HANDOVER: registering the three provider
   apps).

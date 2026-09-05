-- The project backs itself up.
--
-- An Admin connects one drive account from the Archive block of the Admin
-- screen; from then on a pg_cron job pokes the backup-run Edge Function
-- every five minutes and that function does the work in slices — one table
-- part or one stored file at a time — so nothing has to finish inside a
-- single function invocation.
--
-- Five things land here. The connection and the schedule join the one
-- app_settings row, which is already Admin-only and already the place the
-- app's vendor keys live. Every run gets a row in backup_runs, which an
-- Admin may read and nobody may write — the writes are the service role's,
-- from inside the functions. backup_state() is the panel's single read: it
-- answers with the settings MINUS every secret, so the browser learns
-- "connected, as kyle@example.com" and never the refresh token. Then two
-- functions the restore side needs: backup_schema_version(), so a backup
-- can say which schema it was taken from, and restore_chat_messages(),
-- which puts chat history back without waking every phone in the crew.
--
-- The tick is chat-retention's shape exactly: pg_net carries the call and
-- the database signs it with x-internal-secret, read when the job fires
-- rather than baked into the job's text, so rotating the value in
-- private.internal_config rotates this too.

-- ── 1 · The connection and the schedule ────────────────────────────────
-- Client id and secret per provider because each of the three needs its own
-- app registration under the owner's account; only one provider is ever
-- connected at a time, and backup_provider says which.
alter table public.app_settings
  add column if not exists backup_provider text,
  add column if not exists backup_refresh_token text,
  add column if not exists backup_account text,
  add column if not exists backup_root_folder_id text,
  add column if not exists backup_connection_error text,
  add column if not exists backup_oauth_state text,
  add column if not exists backup_oauth_state_at timestamptz,
  add column if not exists backup_client_id_google text,
  add column if not exists backup_client_secret_google text,
  add column if not exists backup_client_id_microsoft text,
  add column if not exists backup_client_secret_microsoft text,
  add column if not exists backup_client_id_dropbox text,
  add column if not exists backup_client_secret_dropbox text,
  add column if not exists backup_frequency text not null default 'daily',
  add column if not exists backup_weekday smallint not null default 0,
  add column if not exists backup_hour smallint not null default 2,
  add column if not exists backup_keep smallint not null default 14,
  add column if not exists backup_next_run_at timestamptz;

alter table public.app_settings
  drop constraint if exists app_settings_backup_provider_check,
  add constraint app_settings_backup_provider_check
    check (backup_provider is null or backup_provider in ('google', 'microsoft', 'dropbox'));

alter table public.app_settings
  drop constraint if exists app_settings_backup_frequency_check,
  add constraint app_settings_backup_frequency_check
    check (backup_frequency in ('daily', 'weekdays', 'weekly', 'monthly'));

alter table public.app_settings
  drop constraint if exists app_settings_backup_weekday_check,
  add constraint app_settings_backup_weekday_check
    check (backup_weekday between 0 and 6);

alter table public.app_settings
  drop constraint if exists app_settings_backup_hour_check,
  add constraint app_settings_backup_hour_check
    check (backup_hour between 0 and 23);

-- One is the floor: keeping zero backups is not a schedule, it is a
-- delete. 365 is the ceiling so a typo cannot fill somebody's drive.
alter table public.app_settings
  drop constraint if exists app_settings_backup_keep_check,
  add constraint app_settings_backup_keep_check
    check (backup_keep between 1 and 365);

-- ── 2 · Every run, and how far it got ──────────────────────────────────
-- cursor is where the next slice picks up; counts is what to show the
-- Admin. A run is never deleted by the app: the log is how a failure at
-- three in the morning is explained at nine.
create table if not exists public.backup_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('backup', 'restore_all', 'restore_jobs', 'before_restore')),
  status text not null default 'queued' check (status in ('queued', 'running', 'complete', 'failed')),
  phase text,
  cursor jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  error text,
  folder_id text,
  folder_name text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- Stamped at the end of every slice. A run whose heartbeat has gone
  -- quiet for ten minutes is one whose function died mid-slice; the next
  -- tick reclaims it rather than leaving the schedule wedged for ever.
  heartbeat_at timestamptz,
  requested_by uuid references public.profiles (id) on delete set null
);

create index if not exists backup_runs_open_idx on public.backup_runs (status, created_at);
create index if not exists backup_runs_recent_idx on public.backup_runs (created_at desc);

alter table public.backup_runs enable row level security;

-- Read-only, and only for an Admin: a run row names the folder a backup
-- went to and how many rows of each table went with it.
drop policy if exists "backup_runs admin read" on public.backup_runs;
create policy "backup_runs admin read" on public.backup_runs
  for select to authenticated
  using ((select private.user_role()) = 'Admin');

-- No client writes at all. Progress is the service role's, written from
-- inside the functions — an account that could insert a run could point a
-- restore at a folder of its own choosing.
grant select on public.backup_runs to authenticated;
revoke insert, update, delete on public.backup_runs from authenticated, anon;
grant all on public.backup_runs to service_role;

-- ── 3 · What the panel is allowed to know ──────────────────────────────
-- Definer, because it reads app_settings columns the browser must never
-- select; the Admin check is the door, and every secret comes back as a
-- boolean rather than a value.
create or replace function public.backup_state()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s public.app_settings;
  last_run jsonb;
  active jsonb;
begin
  if (select private.user_role()) is distinct from 'Admin' then
    raise exception 'The backup settings are an Admin''s.';
  end if;

  select * into s from public.app_settings limit 1;

  select to_jsonb(r) into last_run from (
    select id, kind, status, phase, counts, error, folder_name, started_at, finished_at
      from public.backup_runs
     where status in ('complete', 'failed')
     order by coalesce(finished_at, created_at) desc
     limit 1
  ) r;

  select to_jsonb(r) into active from (
    select id, kind, status, phase, counts, folder_name, created_at, started_at, heartbeat_at
      from public.backup_runs
     where status in ('queued', 'running')
     order by created_at
     limit 1
  ) r;

  return jsonb_build_object(
    'provider', s.backup_provider,
    'account', s.backup_account,
    'connected', (s.backup_refresh_token is not null),
    'connection_error', s.backup_connection_error,
    'root_folder_id', s.backup_root_folder_id,
    'frequency', coalesce(s.backup_frequency, 'daily'),
    'weekday', coalesce(s.backup_weekday, 0),
    'hour', coalesce(s.backup_hour, 2),
    'keep', coalesce(s.backup_keep, 14),
    'next_run_at', s.backup_next_run_at,
    'client_id_google', s.backup_client_id_google,
    'client_id_microsoft', s.backup_client_id_microsoft,
    'client_id_dropbox', s.backup_client_id_dropbox,
    'has_secret_google', (s.backup_client_secret_google is not null),
    'has_secret_microsoft', (s.backup_client_secret_microsoft is not null),
    'has_secret_dropbox', (s.backup_client_secret_dropbox is not null),
    'approval_base_url', s.approval_base_url,
    'last_run', last_run,
    'active_run', active
  );
end;
$$;

revoke execute on function public.backup_state() from public, anon;
grant execute on function public.backup_state() to authenticated;

-- ── 4 · Which schema a backup was taken from ───────────────────────────
-- Definer because supabase_migrations is not the API's to read. It hands
-- back one string and nothing else, so there is nothing here to gate
-- beyond being signed in.
create or replace function public.backup_schema_version()
returns text
language sql
security definer
set search_path to 'public'
as $$
  select max(version) from supabase_migrations.schema_migrations;
$$;

comment on function public.backup_schema_version() is
  'The latest applied migration version. Read by the restore preflight, which compares the schema version recorded in a backup with the live one before it puts anything back.';

revoke execute on function public.backup_schema_version() from public, anon;
grant execute on function public.backup_schema_version() to authenticated;

-- ── 5 · Putting chat history back without waking the crew ──────────────
-- chat_messages carries an insert trigger that fires the chat-push Edge
-- Function, and a restore is thousands of inserts. Without this the crew's
-- phones would buzz once per historical message. The trigger comes back on
-- in the same call, including when the insert fails.
create or replace function public.restore_chat_messages(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n integer;
begin
  alter table public.chat_messages disable trigger chat_messages_push;

  insert into public.chat_messages (
    id, profile_id, body, created_at, pinned_at, pinned_by,
    image_key, gif_url, reply_to, audio_key, file_key, file_name
  )
  select id, profile_id, body, created_at, pinned_at, pinned_by,
         image_key, gif_url, reply_to, audio_key, file_key, file_name
    from jsonb_populate_recordset(null::public.chat_messages, coalesce(p_rows, '[]'::jsonb));

  get diagnostics n = row_count;

  alter table public.chat_messages enable trigger chat_messages_push;

  return n;
exception
  when others then
    alter table public.chat_messages enable trigger chat_messages_push;
    raise;
end;
$$;

comment on function public.restore_chat_messages(jsonb) is
  'Insert restored chat_messages rows with the chat_messages_push trigger off: a restore must not push-notify every device once per historical message. The service role''s alone.';

revoke execute on function public.restore_chat_messages(jsonb) from public, anon, authenticated;
grant execute on function public.restore_chat_messages(jsonb) to service_role;

-- ── 6 · The five-minute tick ───────────────────────────────────────────
-- Not a schedule of its own: it is a poke. backup-run decides whether
-- anything is due, advances a run in flight for about a hundred seconds,
-- and otherwise returns. Five minutes is fine granularity for an hourly
-- setting and is cheap enough to leave running for ever.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('backup-tick')
 where exists (select 1 from cron.job where jobname = 'backup-tick');

select cron.schedule(
  'backup-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://eielmvxzdwwprmmfamlq.supabase.co/functions/v1/backup-run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg',
      'x-internal-secret', (select value from private.internal_config where key = 'edge_shared_secret')
    ),
    body := '{"action":"tick"}'::jsonb
  );
  $$
);

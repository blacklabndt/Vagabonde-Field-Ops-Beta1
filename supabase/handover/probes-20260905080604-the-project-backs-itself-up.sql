-- Probes for the automatic-backup migration (20260905080604). READ ONLY:
-- every statement here is a SELECT, and the one block that would write is
-- commented out with its ROLLBACK attached.
--
-- HOW TO RUN
--   Run each numbered block WHOLE — the begin/rollback pair is what makes
--   `set local role` and `set local request.jwt.claims` local. Block 0
--   names the fixtures the rest pick up. Run 0-4 and 6-8 BEFORE applying
--   and keep the output (they fail: nothing exists yet, and that IS their
--   "before"), apply, then run them again and read them against the
--   assertions below.
--
-- WHAT ROLE SIMULATION SIMULATES
--   `set local role authenticated` puts us in the API's role, so RLS is
--   enforced and schema `private` is reached the way PostgREST reaches it
--   (migration 20260903055300). `set local request.jwt.claims` is the
--   token; profiles is what the helpers actually believe.

-- ═══ 0 · Fixtures ══════════════════════════════════════════════════════
select 'chosen fixtures' as probe,
       (select id from public.profiles
         where role = 'Admin' and deactivated_at is null
         order by created_at limit 1)                        as admin_id,
       (select id from public.profiles
         where role = 'Technician' and deactivated_at is null
         order by created_at limit 1)                        as tech_id;

-- ═══ 1 · The settings columns exist, with the intended defaults ════════
-- BEFORE: 42703 column "backup_provider" does not exist.
-- AFTER: one row, frequency 'daily', weekday 0, hour 2, keep 14,
-- next_run_at null, and no provider connected.
select 'settings defaults' as probe,
       backup_provider, backup_frequency, backup_weekday, backup_hour,
       backup_keep, backup_next_run_at,
       (backup_refresh_token is not null) as connected
  from public.app_settings;

-- ═══ 2 · An Admin may read backup_runs ═════════════════════════════════
-- BEFORE: 42P01 relation "public.backup_runs" does not exist.
-- AFTER: 0 rows and NO error. (Nothing has run yet; the point is that the
-- read is permitted.)
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select 'admin reads runs' as probe, count(*) as rows_visible from public.backup_runs;
rollback;

-- ═══ 3 · A Technician may not ══════════════════════════════════════════
-- BEFORE: 42P01, the same relation.
-- AFTER: 0 rows and no error — RLS is a filter, not a refusal. The
-- assertion is that it stays 0 even once runs exist; re-run this block
-- after the first backup and it must still say 0.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select 'technician reads runs' as probe, count(*) as rows_visible from public.backup_runs;
rollback;

-- ═══ 4 · backup_state() answers an Admin and refuses everyone else ═════
-- BEFORE (both halves): 42883 function public.backup_state() does not exist.
-- AFTER (4a): a jsonb object whose 'connected' is false and which contains
-- NO key holding a token or a client secret — only has_secret_* booleans.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select '4a admin state' as probe, public.backup_state() as state;
select '4a no secrets leaked' as probe,
       not exists (
         select 1 from jsonb_object_keys(public.backup_state()) k
          where k like '%refresh_token%' or k like '%client_secret%' or k = 'backup_oauth_state'
       ) as clean;
rollback;

-- AFTER (4b): raises 'The backup settings are an Admin''s.'
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select '4b technician state' as probe, public.backup_state() as state;
rollback;

-- ═══ 5 · A signed-in account cannot write a run ════════════════════════
-- The grant table says so without writing anything. AFTER: authenticated
-- and anon hold SELECT and no INSERT, UPDATE or DELETE; service_role holds
-- all four. (TRUNCATE, TRIGGER and REFERENCES ride in on Supabase's schema
-- default privileges and sit on every table in this project; PostgREST
-- issues none of them, so they are not a write path.)
select 'run grants' as probe, grantee,
       string_agg(privilege_type, ',' order by privilege_type) as privs
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'backup_runs'
   and grantee in ('anon', 'authenticated', 'service_role')
 group by grantee
 order by grantee;

-- The insert below is the one thing this file will not do for real, so it
-- is left commented with its rollback. Uncomment, run the whole block, and
-- expect 42501 "permission denied for table backup_runs".
--
-- begin;
-- select set_config('request.jwt.claims',
--   json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by created_at limit 1))::text,
--   true);
-- set local role authenticated;
-- insert into public.backup_runs (kind) values ('backup');
-- rollback;

-- ═══ 6 · The tick is scheduled, and signs its own call ═════════════════
-- BEFORE: 0 rows.
-- AFTER: one row, every five minutes, active, and its command names
-- x-internal-secret and internal_config rather than a literal secret.
select 'tick job' as probe, jobname, schedule, active,
       (command like '%x-internal-secret%') as signs_itself,
       (command like '%private.internal_config%') as reads_the_secret_live,
       (command like '%backup-run%') as calls_the_function
  from cron.job
 where jobname = 'backup-tick';

-- ═══ 7 · backup_schema_version() answers any signed-in account ═════════
-- BEFORE: 42883 function public.backup_schema_version() does not exist.
-- AFTER: the version of the newest applied migration — '20260905080604'
-- the day this landed, and whatever is newest after that. A Technician is
-- used on purpose: the restore preflight only needs the number, so this
-- one is not Admin-gated, and the probe is the assertion that it is not.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Technician' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select '7 schema version' as probe, public.backup_schema_version() as version;
rollback;

-- ═══ 8 · restore_chat_messages() is the service role's alone ═══════════
-- BEFORE: 42883 function public.restore_chat_messages(jsonb) does not exist.
-- AFTER: 42501 "permission denied for function restore_chat_messages",
-- for an ADMIN — the highest rank there is. It turns the chat push trigger
-- off around its insert, so no signed-in account may reach it; backup-run
-- calls it with the service role.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles where role = 'Admin' and deactivated_at is null order by created_at limit 1))::text,
  true);
set local role authenticated;
select '8 restore refused' as probe, public.restore_chat_messages('[]'::jsonb) as inserted;
rollback;

-- And the grant table says the same thing without calling anything.
-- AFTER: one row, service_role, EXECUTE.
select 'restore grants' as probe, grantee, privilege_type
  from information_schema.role_routine_grants
 where routine_schema = 'public' and routine_name = 'restore_chat_messages'
   and grantee in ('anon', 'authenticated', 'service_role')
 order by grantee;

-- ═══ 9 · The trigger it borrows is still on ════════════════════════════
-- Not a probe of the migration so much as of every restore after it:
-- restore_chat_messages re-enables chat_messages_push on its way out,
-- including through its exception block. AFTER a restore, this must still
-- read 'O' (enabled, origin). 'D' means a restore died in a way that got
-- past the handler and the crew has stopped being notified of new chat.
select 'chat push trigger' as probe, tgname,
       tgenabled as enabled_flag,
       (tgenabled = 'O') as still_firing
  from pg_trigger
 where tgrelid = 'public.chat_messages'::regclass
   and tgname = 'chat_messages_push';

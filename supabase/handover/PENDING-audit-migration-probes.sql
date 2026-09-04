-- Probes for the round-six draft. READ ONLY: every statement here is a
-- SELECT. Nothing inserts, updates or deletes, and the one block that
-- would has been left commented out with its ROLLBACK attached.
--
-- HOW TO RUN
--   Run each numbered block WHOLE — the begin/rollback pair is what makes
--   `set local role` and `set local request.jwt.claims` local. Run block 0
--   first (it names the fixtures the rest pick up), then run blocks 1-7
--   BEFORE applying the migration and keep the output; apply; run 1-7
--   again and diff. Each block says what the two runs should say.
--
-- WHAT ROLE SIMULATION ACTUALLY SIMULATES
--   `set local role authenticated` puts us in the API's role, so RLS is
--   enforced and schema `private` is reached the way PostgREST reaches it
--   (migration 20260903055300 — an invoker-rights function that names
--   private.user_role() is parsed at call time and needs that USAGE).
--   `set local request.jwt.claims` is the token. Setting app_metadata is
--   how a STALE token is reproduced: the claim says one thing, profiles
--   says another, and the whole question is which one the database
--   believes.


-- ═══ 0 · Fixtures ═══════════════════════════════════════════════════════
-- Read the ids the later blocks look up, so the output can be read back
-- against real accounts. Live today: 2 Admins, 21 Technicians, 21 Helpers,
-- 0 Coordinators, 0 deactivated, 0 with an empty tab_access.

select 'fixture census' as probe, role, count(*) as n,
       count(*) filter (where deactivated_at is not null) as deactivated,
       count(*) filter (where cardinality(tab_access) = 0)  as no_tabs
  from public.profiles
 group by role
 order by role;

select 'chosen fixtures' as probe,
       (select id from public.profiles
         where role = 'Admin' and deactivated_at is null
         order by created_at limit 1)                        as admin_id,
       (select id from public.profiles
         where role = 'Technician' and deactivated_at is null
         order by created_at limit 1)                        as tech_id,
       (select id from public.profiles
         where deactivated_at is not null limit 1)           as deactivated_id;


-- ═══ 1 · An honest Admin token ══════════════════════════════════════════
-- The control. Must read the same before and after: Admin, every tab,
-- staff, holds the users tab.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Admin' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Admin',
      'tab_access', public.tabs_for_role('Admin'))
  )::text, true);
set local role authenticated;

select '1 · honest Admin'            as probe,
       (select private.user_role())  as user_role,
       (select public.is_staff())    as is_staff,
       (select private.has_any_tab('users'))  as has_users_tab,
       (select cardinality(private.tab_access())) as tab_count;
rollback;


-- ═══ 2 · THE SELF-RESTORE — a demoted Admin holding a stale token ═══════
-- This is finding 1. The profiles row says Technician; the token in the
-- pocket still says Admin and still carries the users tab, and it stays
-- valid for the best part of an hour.
--
-- ONE PRECONDITION, found by running this probe: profiles_update's USING
-- reads p.tab_access — the ROW's column, not the claim — so the row must
-- still hold the users tab for the self-restore to be reachable. That is
-- precisely a demotion that changed the rank and left the tabs alone,
-- which the users screen will do. The probe therefore evaluates the
-- policy against a synthetic row: this account's real id and real stored
-- rank, with the users tab present. Nothing is written; the row is a
-- SELECT literal.
--
--   BEFORE: claim_role 'Admin' while table_role is Technician/Helper, and
--           update_check_role_admin TRUE — the account can PATCH itself
--           back to Admin, and that rank is then permanent because it is
--           in the table. Confirmed live on 2026-09-03.
--   AFTER:  claim_role equals table_role and update_check_role_admin is
--           FALSE. The token is ignored.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Admin',
      'tab_access', public.tabs_for_role('Admin'))
  )::text, true);
set local role authenticated;

select '2 · stale Admin token'         as probe,
       (select private.user_role())    as claim_role,
       (select private.stored_role((select auth.uid()))) as table_role,
       (select public.is_staff())      as is_staff,
       (select private.has_any_tab('users')) as has_users_tab,
       (select cardinality(private.tab_access())) as tab_count,
       -- profiles_update USING, against the demoted-but-still-tabbed row
       ((select private.has_any_tab('users'))
        and not (p.id = (select auth.uid())
                 and not ('users' = any (p.tab_access))))          as update_using,
       -- profiles_update WITH CHECK with role rewritten to 'Admin'
       ((select private.has_any_tab('users'))
        and not (p.id = (select auth.uid())
                 and not ('users' = any (p.tab_access)))
        and ('Admin' = (select private.stored_role(p.id))
             or (select private.user_role()) = 'Admin'))           as update_check_role_admin
  from (select (select auth.uid()) as id,
               public.tabs_for_role('Technician') || array['users'] as tab_access) p;
rollback;

-- 2b · The same account against its REAL row, which has no users tab.
--      update_using is false both before and after — the row's own tabs
--      are the first gate and the stale claim never reached past it here.
--      Kept so the two runs are not misread as the fix doing more than it
--      does.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Admin',
      'tab_access', public.tabs_for_role('Admin'))
  )::text, true);
set local role authenticated;

select '2b · stale claim, real row'    as probe,
       (select private.user_role())    as claim_role,
       ((select private.has_any_tab('users'))
        and not (p.id = (select auth.uid())
                 and not ('users' = any (p.tab_access))))          as update_using
  from public.profiles p
 where p.id = (select auth.uid());
rollback;

-- 2c · THE DOOR THAT NEEDS NO TAB. The users tab was the narrow part of
--      block 2; every OTHER Admin gate asks user_role() and nothing else,
--      and the stale claim answers 'Admin' to all of them — app_settings,
--      the rate card, ticket_lines, timesheet_approvals, jhas/reports/
--      tickets delete, and the definer RPCs archive_clear_jobs,
--      mark_tickets_invoiced and delete_job's admin branch. app_settings
--      is the one that can be proven without writing anything, because
--      its gate is on SELECT: a Technician with a stale Admin token reads
--      the Resend and KLIPY keys straight out of the table.
--
--      BEFORE: rows_visible 1, sees_a_resend_key true. Confirmed live on
--              2026-09-03.
--      AFTER:  rows_visible 0, sees_a_resend_key null.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Admin',
      'tab_access', public.tabs_for_role('Admin'))
  )::text, true);
set local role authenticated;

select '2c · stale claim reads app_settings' as probe,
       count(*)                              as rows_visible,
       bool_or(resend_api_key is not null)   as sees_a_resend_key
  from public.app_settings;
rollback;

-- 2d · The control for 2c: the same Technician on an honest token. Zero
--      rows before and after — nothing here is being taken from anyone.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Technician',
      'tab_access', public.tabs_for_role('Technician'))
  )::text, true);
set local role authenticated;

select '2d · honest Technician, app_settings' as probe, count(*) as rows_visible
  from public.app_settings;
rollback;

-- 2e · And the real Admin, who must still read it. One row before and
--      after, or the Admin screen has lost its settings.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Admin' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Admin',
      'tab_access', public.tabs_for_role('Admin'))
  )::text, true);
set local role authenticated;

select '2e · real Admin, app_settings' as probe, count(*) as rows_visible
  from public.app_settings;
rollback;


-- ═══ 3 · The same Technician, an honest token ═══════════════════════════
-- The shape block 2 should collapse to after the migration. Must read the
-- same before and after — proof the fix takes nothing away from an account
-- whose token was never lying.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Technician',
      'tab_access', public.tabs_for_role('Technician'))
  )::text, true);
set local role authenticated;

select '3 · honest Technician'         as probe,
       (select private.user_role())    as user_role,
       (select public.is_staff())      as is_staff,
       (select private.has_any_tab('users')) as has_users_tab,
       (select cardinality(private.tab_access())) as tab_count;
rollback;


-- ═══ 4 · A token with no app_metadata at all ════════════════════════════
-- The table branch, which is the ONLY branch after the migration. Running
-- this before shows what "after" will look like without applying anything:
-- blocks 2, 3 and 4 must all agree once the migration is in.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

select '4 · claimless token'           as probe,
       (select private.user_role())    as user_role,
       (select public.is_staff())      as is_staff,
       (select private.has_any_tab('users')) as has_users_tab,
       (select cardinality(private.tab_access())) as tab_count;
rollback;


-- ═══ 5 · The deactivated account ════════════════════════════════════════
-- 5a is read-only and needs no fixture: it projects, for every profile,
-- what the NEW tab_access()/user_role() will return. Rows with
-- deactivated_at set must project '{}' and null. With no deactivated row
-- live today this returns the active accounts only, which is itself the
-- assurance that nothing active changes shape.

select '5a · projection of the new bodies' as probe,
       p.id, p.role, p.deactivated_at,
       p.tab_access                                        as tab_access_today,
       case when p.deactivated_at is null
            then p.tab_access else '{}'::text[] end        as tab_access_after,
       case when p.deactivated_at is null
            then p.role else null end                      as user_role_after
  from public.profiles p
 order by (p.deactivated_at is null), p.role, p.created_at
 limit 20;

-- 5b · The live version, if there is a deactivated account to point at.
--      Skip the block if 'chosen fixtures' showed deactivated_id null.
--      BEFORE: the stale claim wins — user_role 'Technician', is_staff
--              true, the ban is invisible to the database for an hour.
--      AFTER:  user_role null, is_staff false, tab_count 0.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where deactivated_at is not null limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Technician',
      'tab_access', public.tabs_for_role('Technician'))
  )::text, true);
set local role authenticated;

select '5b · locked account, unexpired token' as probe,
       (select private.user_role())   as user_role,
       (select public.is_staff())     as is_staff,
       (select coalesce(cardinality(private.tab_access()), -1)) as tab_count,
       -- contacts/equipment/arcade_scores reads all hang off is_staff()
       (select public.is_staff())     as would_read_contacts;
rollback;

-- 5c · OPTIONAL, and a WRITE — left commented deliberately. It deactivates
--      a seed account inside a transaction that ends in ROLLBACK, so
--      nothing persists, and it is the only way to prove 5b end-to-end
--      while no account is locked. Run it only if Kyle wants it, and read
--      the ROLLBACK before you press anything.
--
-- begin;
--   update public.profiles set deactivated_at = now(), tab_access = '{}'
--    where id = (select id from public.profiles
--                 where role = 'Technician' order by created_at limit 1);
--   select set_config('request.jwt.claims', json_build_object(
--       'sub',  (select id::text from public.profiles
--                 where deactivated_at is not null limit 1),
--       'role', 'authenticated',
--       'app_metadata', json_build_object(
--         'app_role', 'Technician',
--         'tab_access', public.tabs_for_role('Technician'))
--     )::text, true);
--   set local role authenticated;
--   select 'locked, proven' as probe,
--          (select private.user_role()) as user_role,
--          (select public.is_staff())   as is_staff;
-- rollback;


-- ═══ 6 · profiles_insert / profiles_delete, as a matrix ═════════════════
-- Finding 2. Each row evaluates the OLD predicate and the NEW predicate
-- side by side for one (caller rank × payload rank) pair, under that
-- caller's own simulated token — so the "before" run and the "after" run
-- should both print the same two columns and the migration's job is to
-- make the live behaviour equal the new_* column.
--
--   ins_old is true for every users-tab holder whatever rank is written:
--     that is the hole. ins_new is true only for an Admin, or for a
--     non-Admin writing Technician/Helper.
--   del_old is true for any users-tab holder against anyone but itself;
--     del_new needs Admin.

-- 6a · caller is a users-tab Technician (the hole)
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Technician',
      -- a Technician who has been given the users tab, which is what the
      -- tab grant alone is supposed to mean
      'tab_access', public.tabs_for_role('Technician') || array['users'])
  )::text, true);
set local role authenticated;

select '6a · users-tab Technician' as probe, payload_role,
       (select private.user_role()) as caller_role,
       -- OLD profiles_insert
       (select private.has_any_tab('users'))                                   as ins_old,
       -- NEW profiles_insert
       ((select private.has_any_tab('users'))
        and ((select private.user_role()) = 'Admin'
             or payload_role = any (array['Technician','Helper'])))            as ins_new,
       -- OLD profiles_delete (against someone else's row)
       ((select private.has_any_tab('users')) and true)                        as del_old,
       -- NEW profiles_delete
       ((select private.user_role()) = 'Admin'
        and (select private.has_any_tab('users')) and true)                    as del_new
  from unnest(array['Admin','Coordinator','Technician','Helper']) as payload_role;
rollback;

-- 6b · caller is a real Admin. Nothing here may change: ins_new and
--      del_new must be true across the board, or the users screen has
--      lost a power it is meant to have.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Admin' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Admin',
      'tab_access', public.tabs_for_role('Admin'))
  )::text, true);
set local role authenticated;

select '6b · Admin' as probe, payload_role,
       (select private.user_role()) as caller_role,
       (select private.has_any_tab('users'))                                   as ins_old,
       ((select private.has_any_tab('users'))
        and ((select private.user_role()) = 'Admin'
             or payload_role = any (array['Technician','Helper'])))            as ins_new,
       ((select private.has_any_tab('users')) and true)                        as del_old,
       ((select private.user_role()) = 'Admin'
        and (select private.has_any_tab('users')) and true)                    as del_new
  from unnest(array['Admin','Coordinator','Technician','Helper']) as payload_role;
rollback;

-- 6c · caller is a Technician WITHOUT the users tab. Everything false in
--      both columns, before and after — the tab is still the first gate.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Technician',
      'tab_access', public.tabs_for_role('Technician'))
  )::text, true);
set local role authenticated;

select '6c · Technician, no users tab' as probe,
       (select private.user_role())          as caller_role,
       (select private.has_any_tab('users')) as ins_old_and_del_old,
       false                                  as ins_new_for_Admin_payload;
rollback;

-- 6d · The policies as the catalog holds them. Before: profiles_insert's
--      with_check is has_any_tab('users') alone and profiles_delete's qual
--      has no rank test. After: both name private.user_role().
select '6d · catalog' as probe, policyname, cmd, roles::text, qual, with_check
  from pg_policies
 where schemaname = 'public' and tablename = 'profiles'
 order by policyname;


-- ═══ 7 · delete_job's orphaned PDFs ═════════════════════════════════════
-- Finding 3. 7a is the signature check: before, the returned jsonb has no
-- jha_keys/report_keys member; after, it has both and every old member is
-- still there. Read it out of the source rather than by calling the
-- function, because calling it deletes a job.

select '7a · returned members, from the source' as probe,
       (pg_get_functiondef(p.oid) like '%''jha_keys''%')    as returns_jha_keys,
       (pg_get_functiondef(p.oid) like '%''report_keys''%') as returns_report_keys,
       (pg_get_functiondef(p.oid) like '%''transferred''%') as still_returns_transferred,
       (pg_get_functiondef(p.oid) like '%''overrides''%')   as still_returns_overrides
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'delete_job';

-- 7b · The keys the discard branch would strand, for a real job. This is
--      the same pair of array_aggs the new body runs, executed here as a
--      dry run: whatever this prints is what the client will be handed
--      after the migration, and what it was handed nothing of before.
with candidate as (
  select j.id, j.job_number
    from public.jobs j
   where exists (select 1 from public.jhas    x where x.job_id = j.id and x.pdf_key is not null)
      or exists (select 1 from public.reports x where x.job_id = j.id and x.pdf_key is not null)
   order by j.created_at desc
   limit 3
)
select '7b · keys a discard would strand' as probe,
       c.job_number,
       (select coalesce(array_agg(x.pdf_key), '{}')
          from public.jhas x where x.job_id = c.id and x.pdf_key is not null)    as jha_keys,
       (select coalesce(array_agg(x.pdf_key), '{}')
          from public.reports x where x.job_id = c.id and x.pdf_key is not null) as report_keys
  from candidate c;

-- 7c · The cascades that make 7b necessary: jhas and reports are ON DELETE
--      CASCADE off jobs, so their rows are gone before anything reads them.
select '7c · cascades off jobs' as probe,
       conrelid::regclass::text as child, pg_get_constraintdef(oid) as def
  from pg_constraint
 where contype = 'f' and confrelid = 'public.jobs'::regclass
 order by 2;


-- ═══ 8 · The invoker-rights functions still work as a non-owner ═════════
-- CLAUDE.md's three-minute outage: a SQL function that runs as the caller
-- and names private.user_role() is parsed at call time, and broke for
-- every account when private's USAGE was missing. Both functions below are
-- invoker-rights and both name it, so they get called as `authenticated`
-- before this is called done. Expect rows, not an error.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Admin' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Admin',
      'tab_access', public.tabs_for_role('Admin'))
  )::text, true);
set local role authenticated;

select '8a · ticket_tracker_stats as Admin' as probe, *
  from public.ticket_tracker_stats();

select '8b · search_tickets as Admin' as probe, count(*) as rows_returned
  from public.search_tickets(null, 1, 5, null, null, null);
rollback;

-- 8c · The same two, as a Technician: they must answer, and search_tickets
--      must still hand a Technician its money (Technicians see prices) —
--      what matters here is only that neither raises.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Technician',
      'tab_access', public.tabs_for_role('Technician'))
  )::text, true);
set local role authenticated;

select '8c · tracker + search as Technician' as probe,
       (select count(*) from public.ticket_tracker_stats())                as stats_rows,
       (select count(*) from public.search_tickets(null,1,5,null,null,null)) as search_rows;
rollback;


-- ═══ 9 · Nothing else reads the token ═══════════════════════════════════
-- Must return no rows both before and after the migration EXCEPT for
-- private.tab_access and private.user_role, which must appear before and
-- disappear after.

select '9a · functions naming auth.jwt()' as probe,
       n.nspname as schema, p.proname as name
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public','private') and p.prosrc ilike '%auth.jwt%'
 order by 1, 2;

-- 9b · No policy anywhere compares against the token directly. Empty
--      before and after.
select '9b · policies naming jwt' as probe, schemaname, tablename, policyname
  from pg_policies
 where coalesce(qual,'') ilike '%jwt%' or coalesce(with_check,'') ilike '%jwt%'
 order by 2, 3;

-- 9c · Every policy still wraps these helpers in (select …), so the
--      table-backed bodies cost one InitPlan per statement and not one
--      lookup per row. Empty before and after.
select '9c · unwrapped helper calls in policies' as probe,
       schemaname, tablename, policyname, cmd
  from pg_policies
 where (coalesce(qual,'')||' '||coalesce(with_check,'')) ~ '(user_role|has_any_tab|has_tab|tab_access|is_staff)\('
   and (coalesce(qual,'')||' '||coalesce(with_check,''))
       !~ 'SELECT (private\.)?(user_role|has_any_tab|has_tab|tab_access|is_staff)'
 order by 2, 3;

-- 9d · The token hook is untouched: it still stamps app_metadata, because
--      the app still draws its menu from the claim. Only the database has
--      stopped believing it.
select '9d · hook still writes the claim' as probe,
       (pg_get_functiondef(p.oid) like '%app_metadata%') as writes_app_metadata,
       (pg_get_functiondef(p.oid) like '%tab_access%')   as writes_tab_access
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'custom_access_token_hook';

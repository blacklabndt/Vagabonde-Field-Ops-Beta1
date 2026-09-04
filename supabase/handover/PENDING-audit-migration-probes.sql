-- Probes for the round-six draft. READ ONLY: every statement here is a
-- SELECT. Nothing inserts, updates or deletes, and the one block that
-- would has been left commented out with its ROLLBACK attached.
--
-- HOW TO RUN
--   Run each numbered block WHOLE — the begin/rollback pair is what makes
--   `set local role` and `set local request.jwt.claims` local. Run block 0
--   first (it names the fixtures the rest pick up), then run blocks 1-13
--   BEFORE applying the migration and keep the output; apply; run 1-13
--   again and diff. Each block says what the two runs should say.
--   Block 12 is the exception: it calls a function that does not exist yet,
--   so before the migration it raises 42883 and that IS its "before".
--   Block 5d is a second kind of exception: it runs in both, but only its
--   AFTER line is an assertion — its "before" refuses for a reason that has
--   nothing to do with the finding. Its own comment says why.
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
--
-- deactivated_id null is why block 5b raises rather than runs: with nobody
-- locked there is nothing for it to prove. That is the block telling you
-- so, not a failure of the migration.

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

-- 5b · The live version, against a real locked account.
--      WITH NO DEACTIVATED ACCOUNT THIS BLOCK MUST NOT QUIETLY PASS. With
--      0 locked accounts live, 'sub' would be null, auth.uid() would be
--      null, and every column below would read null/false — which is
--      exactly what "after" is supposed to look like, so the block would
--      agree with the fix before the fix existed and prove nothing. It
--      therefore raises instead: no fixture, no result. Run 5c (or lock a
--      seed account for real) and come back.
--
--      The guard is a cast that cannot succeed, built from a column so the
--      planner cannot fold it to a constant and raise it even when the
--      fixture DOES exist — coalesce only reaches its second argument at
--      run time, and only when the first is null. The error text is the
--      instruction.
--
--      BEFORE: the stale claim wins — user_role 'Technician', is_staff
--              true, the ban is invisible to the database for an hour.
--      AFTER:  user_role null, is_staff false, tab_count 0.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  coalesce(
              (select id::text from public.profiles
                where deactivated_at is not null limit 1),
              (select ('5b NEEDS A DEACTIVATED ACCOUNT: none is locked, so this block would '
                       || 'prove nothing. Run 5c, or lock a seed account, then rerun. '
                       || p.id::text)::uuid::text
                 from public.profiles p limit 1)),
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

-- 5c · A WRITE — left commented deliberately. It deactivates a seed
--      account inside a transaction that ends in ROLLBACK, so nothing
--      persists, and it is the only way to prove 5b end-to-end while no
--      account is locked. It is what 5b's error is asking for: uncomment
--      and run the whole block, or lock a seed account for real from the
--      Users screen and then run 5b as written. Read the ROLLBACK before
--      you press anything.
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

-- 5d · The other half of what section 1 sets loose: delete_job. Its admin
--      test is `is_admin := user_role() = 'Admin'`, and the three gates
--      under it all read `not is_admin` — which is null, not false, once
--      user_role() answers null for a locked account, and a null IF takes
--      the false branch. The creator test would stop refusing, the discard
--      test would stop refusing, and the ban section 1 exists to enforce
--      would hand that account the discard instead. This is the block that
--      calls the function for real rather than reading it, and it is
--      read-only twice over: the inner block is a subtransaction, so
--      anything raised inside it unwinds the deletes — including the
--      sentinel this probe raises ITSELF when delete_job returns instead
--      of refusing — and the outer transaction ends in ROLLBACK regardless.
--
--      READ THIS AS AN ASSERTION ABOUT THE "AFTER" RUN ONLY. The null-rank
--      hole above is reachable in exactly one state: section 1 applied and
--      section 3 not. Before the migration user_role() still reads the
--      claim, and the claim this block forges says 'Technician' — so
--      is_admin is FALSE, not null, the gates refuse the way they refuse
--      any non-creator, and 'WENT THROUGH' is unreachable. After the
--      migration section 3's is_staff() door has already turned the
--      account away before is_admin is computed at all. The one migration
--      carries both sections in the one transaction, so the state that
--      would print 'WENT THROUGH' never exists outside it. If this block
--      ever DOES print it, something has applied section 1 without
--      section 3 and delete_job is open to every locked account: stop and
--      finish the migration.
--
--      Like 5b it refuses to run without a locked account, because with
--      none the 'sub' is null, auth.uid() is null, and it would refuse for
--      the wrong reason. Uncomment 5c's update at the top of THIS
--      transaction, or lock a seed account, then rerun.
--
--      BEFORE: '5d · refused P0001 — You can only delete a job you raised
--              yourself …' — the creator test, on a claim the database
--              still believes.
--      AFTER:  '5d · refused 42501 …' — the is_staff() door turned it away
--              before the rank was ever asked for. This is the assertion.
begin;
do $$
declare
  v_dead uuid;
  v_job  uuid;
  v_out  jsonb;
begin
  select id into v_dead from public.profiles where deactivated_at is not null limit 1;
  if v_dead is null then
    raise exception
      '5d NEEDS A DEACTIVATED ACCOUNT: none is locked, so this block would refuse for the wrong reason. Run 5c''s update in this transaction, or lock a seed account, then rerun.';
  end if;
  -- Aim at a job the function would otherwise go all the way through for,
  -- or the "before" run refuses for a reason that has nothing to do with
  -- the finding: created_by present (a null one raises "no longer exists"
  -- off is_creator), and nothing approved or invoiced on it (that raise
  -- stands for everybody, admin included, and rightly).
  select j.id into v_job
    from public.jobs j
   where j.created_by is not null
     and not exists (
       select 1 from public.tickets t
        where t.job_id = j.id
          and (t.approved_at is not null or t.status in ('Approved', 'Invoiced')))
   order by j.created_at desc
   limit 1;
  if v_job is null then
    raise exception '5d NEEDS A JOB to aim at: none is both attributed and free of approved billing.';
  end if;

  perform set_config('request.jwt.claims', json_build_object(
      'sub',  v_dead::text,
      'role', 'authenticated',
      'app_metadata', json_build_object(
        'app_role',   'Technician',
        'tab_access', public.tabs_for_role('Technician'))
    )::text, true);
  -- set_config rather than SET, which plpgsql does not take; is_local so
  -- it dies with the transaction either way.
  perform set_config('role', 'authenticated', true);

  begin
    v_out := public.delete_job(v_job, null, true);
    raise exception 'sentinel' using errcode = 'PRB01';
  exception
    when sqlstate 'PRB01' then
      perform set_config('probe.r5d', format(
        '5d · WENT THROUGH — section 1 without section 3: a locked account discarded job %s and got back %s (rolled back)',
        v_job, v_out), true);
    when others then
      perform set_config('probe.r5d', format(
        '5d · refused %s — %s', sqlstate, sqlerrm), true);
  end;
end $$;

-- The DO block's answer, carried out on a custom GUC so it lands in a
-- result row and not only in the client's NOTICE stream, which not every
-- SQL client shows.
select '5d · delete_job as a locked account' as probe,
       current_setting('probe.r5d', true)    as outcome;
rollback;


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
--
--      THE TAB GATE IS HELD TRUE BY HAND HERE, and it has to be. The claim
--      below grants the users tab, which is what this block used to lean
--      on — but section 1 stops tab_access() believing the claim, and no
--      Technician holds that tab in profiles (0 live today). So on the
--      "after" run the real read is false, every column collapses to
--      false, and the block would look like a pass while proving the tab
--      gate twice and section 2's RANK gate not at all. Satisfying the tab
--      half as a literal leaves the rank half alone to answer, and it
--      answers identically before and after — which is the point: section
--      2 is not about the tab.
--
--      has_users_tab_real beside it is the honest read, and it is MEANT to
--      change: true before (the forged claim), false after. That is
--      section 1 showing through, and 2c is where it is argued.
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

select '6a · users-tab Technician (tab held true)' as probe, payload_role,
       (select private.user_role())          as caller_role,
       (select private.has_any_tab('users')) as has_users_tab_real,
       -- OLD profiles_insert, with the tab granted: true for every payload
       -- rank, and that flat row of trues IS the hole — the tab was the
       -- whole predicate.
       true                                                                    as ins_old,
       -- NEW profiles_insert, with the tab granted: the rank gate alone.
       ((select private.user_role()) = 'Admin'
        or payload_role = any (array['Technician','Helper']))                  as ins_new,
       -- OLD profiles_delete (against someone else's row)
       true                                                                    as del_old,
       -- NEW profiles_delete: Admin, and this caller is not one.
       ((select private.user_role()) = 'Admin')                                as del_new
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
--
-- The arguments are spelled out on purpose. status_filter must be 'All',
-- never null: the body tests `status_filter = 'All' or t.status =
-- status_filter`, and null makes both of those null, so a null filter
-- returns zero rows — the probe would pass having proved only that nothing
-- raised. page_num is 0 for the same reason: page 1 of a 5-row page can be
-- empty on its own. And a row count alone would not notice the money going
-- missing, so both blocks count the rows that carry a total. An Admin and
-- a Technician both see prices, so rows_with_money must equal
-- rows_returned in both, before and after.

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

select '8b · search_tickets as Admin' as probe,
       count(*)                                     as rows_returned,
       count(*) filter (where s.total is not null)  as rows_with_money,
       max(s.filtered_total)                        as filtered_total
  from public.search_tickets('All', 0, 5, '', null, null) s;
rollback;

-- 8c · The same two, as a Technician: they must answer, and search_tickets
--      must still hand a Technician its money (Technicians see prices) —
--      so rows_with_money must equal search_rows here too. If it comes
--      back 0 against a non-zero search_rows, the role lost its prices.
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
       (select count(*) from public.ticket_tracker_stats())                 as stats_rows,
       (select count(*) from public.search_tickets('All',0,5,'',null,null)) as search_rows,
       (select count(*) filter (where s.total is not null)
          from public.search_tickets('All',0,5,'',null,null) s)             as rows_with_money;
rollback;


-- ═══ 9 · Nothing else reads the token ═══════════════════════════════════
-- 9a searches for BOTH spellings. auth.jwt() is one way to read the claim;
-- current_setting('request.jwt.claims') is the other, and the first draft
-- of this probe looked only for the first — which would have reported a
-- clean sweep while private.guard_job_update sat there reading the claim
-- through current_setting.
--
--   BEFORE: private.guard_job_update, private.tab_access, private.user_role.
--   AFTER:  private.guard_job_update ALONE, and that one stays on purpose.
--           It reads the claim's `role` — 'authenticated' vs
--           'service_role' vs absent — to tell an API call from the SQL
--           editor or a migration. That is a fact about the CONNECTION,
--           which the token is still the honest source of; it never asks
--           the claim who you are or what rank you hold. Anything else in
--           this list after the migration is a function that still
--           believes the token, and belongs in the next round.

select '9a · functions reading the token' as probe,
       n.nspname as schema, p.proname as name,
       (p.prosrc ilike '%auth.jwt%')     as via_auth_jwt,
       (p.prosrc ilike '%request.jwt%')  as via_current_setting
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public','private')
   and (p.prosrc ilike '%auth.jwt%' or p.prosrc ilike '%request.jwt%')
 order by 2, 3;

-- 9b · No policy anywhere compares against the token directly. Empty
--      before and after.
select '9b · policies naming jwt' as probe, schemaname, tablename, policyname
  from pg_policies
 where coalesce(qual,'') ilike '%jwt%' or coalesce(with_check,'') ilike '%jwt%'
 order by 2, 3;

-- 9c · Every policy still wraps these helpers in (select …), so the
--      table-backed bodies cost one InitPlan per statement and not one
--      lookup per row. Empty before and after.
--
--      Counted, not matched. The first draft asked "does this policy
--      contain a wrapped call?" — which a policy with three calls passes
--      on the strength of one, and the jhas and reports storage policies
--      have three apiece. So: count every call site, count the wrapped
--      ones, and print any policy where the two numbers disagree. Every
--      schema, storage's sixteen included.
select '9c · unwrapped helper calls in policies' as probe,
       c.schemaname, c.tablename, c.policyname, c.cmd,
       c.calls, c.wrapped, c.calls - c.wrapped as unwrapped
  from (
    select p.schemaname, p.tablename, p.policyname, p.cmd,
           (select count(*) from regexp_matches(
              coalesce(p.qual,'')||' '||coalesce(p.with_check,''),
              '(private\.)?(user_role|has_any_tab|has_tab|tab_access|is_staff)\s*\(', 'g')) as calls,
           (select count(*) from regexp_matches(
              coalesce(p.qual,'')||' '||coalesce(p.with_check,''),
              'SELECT\s+(private\.)?(user_role|has_any_tab|has_tab|tab_access|is_staff)\s*\(', 'g')) as wrapped
      from pg_policies p
  ) c
 where c.calls <> c.wrapped
 order by 2, 3;

-- 9d · The token hook is untouched: it still stamps app_metadata. Not
--      because anything reads it — the app draws its menu from the
--      profiles row it fetches on sign-in (session.js), and a search of
--      vite-app, the Worker and the Edge Functions turns up no reader of
--      app_metadata anywhere — but because pulling an auth hook out is its
--      own change with its own blast radius, and this migration is already
--      six seams wide. After this, the claim has no reader on either
--      side; removing the hook is the follow-up, once this has been live
--      long enough to be sure. Both columns true before and after.
select '9d · hook still writes the claim' as probe,
       (pg_get_functiondef(p.oid) like '%app_metadata%') as writes_app_metadata,
       (pg_get_functiondef(p.oid) like '%tab_access%')   as writes_tab_access
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'custom_access_token_hook';


-- ═══ 10 · Storage answers to the same people it did ═════════════════════
-- Sixteen policies on storage.objects gate the five buckets, and every one
-- of them asks private.has_tab() or private.user_role() — the two bodies
-- section 1 replaces. Nothing above touches storage at all, so this counts
-- what each simulated account can actually see, bucket by bucket. An
-- account whose token was never lying must see the identical counts before
-- and after; a stale claim must lose what its borrowed rank was buying.
--
-- Read the numbers as a set: a bucket missing from a run is zero visible
-- objects there, which is a real answer and not a missing row.

-- 10a · An honest Technician. Identical before and after. chat-media (the
--       chat tab), jhas and reports (job/jha/upload tabs) show what the
--       tabs buy; timesheets shows only this account's own folder.
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

select '10a · honest Technician, storage' as probe,
       o.bucket_id, count(*) as visible
  from storage.objects o
 group by o.bucket_id
 order by 2;
rollback;

-- 10b · A real Admin. Identical before and after, and the only account that
--       sees every timesheet folder. If this run loses rows, the migration
--       has taken something from the person who needs it most.
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

select '10b · real Admin, storage' as probe,
       o.bucket_id, count(*) as visible
  from storage.objects o
 group by o.bucket_id
 order by 2;
rollback;

-- 10c · The stale Admin claim on a Technician's row — the storage half of
--       block 2c. The timesheets read policy is Admin OR your own folder,
--       so this is the bucket that moves.
--       BEFORE: timesheets shows everyone's folders, matching 10b.
--       AFTER:  timesheets shows this account's own folder only, matching
--               10a. Every other bucket reads the same in both runs.
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

select '10c · stale Admin claim, storage' as probe,
       o.bucket_id, count(*) as visible
  from storage.objects o
 group by o.bucket_id
 order by 2;
rollback;


-- ═══ 11 · The equipment screen's day ════════════════════════════════════
-- Finding 5. The functions counted against current_date, which is UTC; the
-- tag on the row is computed in the browser, in Grande Prairie time.
--
-- 11a is the mechanism, and it is honest at any hour: it prints both dates
-- and the hour it is locally. days_apart is 1 whenever this is run after
-- 18:00 in Grande Prairie (17:00 in the winter) and 0 the rest of the day
-- — so a 0 here does not mean there was no bug, it means you are running
-- the probe in the morning. Read it beside 11b.
select '11a · the two days' as probe,
       current_date                                        as utc_today,
       (now() at time zone 'America/Edmonton')::date        as edmonton_today,
       current_date - (now() at time zone 'America/Edmonton')::date as days_apart,
       to_char(now() at time zone 'America/Edmonton', 'HH24:MI') as local_time;

-- 11b · The equipment the two days disagree about: a row due exactly on
--       the Edmonton date, which the browser tags "due soon" (0 days left)
--       while UTC has already gone past it and calls it overdue, and the
--       same story at the far edge of the 30-day window.
--
--       READ THIS HONESTLY. A row only trips it if its calibration_due
--       lands on one of the two boundary days, so a zero here is not proof
--       of anything on its own — the fleet on file today is four items,
--       three of them due 2027-08-13, so this reads 0 at every hour of
--       every day until a due date comes round. The mechanism is 11a and
--       the diff of the two function bodies; 11b is the standing check
--       that goes non-zero the moment the fleet does have a date on the
--       boundary, and it must read 0 after the migration at ANY hour.
select '11b · rows the two days disagree about' as probe,
       count(*) filter (
         where e.calibration_due is not null
           and (e.calibration_due < current_date)
             is distinct from
               (e.calibration_due < (now() at time zone 'America/Edmonton')::date)
       ) as overdue_disagreements,
       count(*) filter (
         where e.calibration_due is not null
           and (e.calibration_due >= current_date and e.calibration_due <= current_date + 30)
             is distinct from
               (e.calibration_due >= (now() at time zone 'America/Edmonton')::date
                and e.calibration_due <= (now() at time zone 'America/Edmonton')::date + 30)
       ) as due_soon_disagreements
  from public.equipment e;

-- 11c · What the functions themselves say, called as a Technician — the
--       tile beside the filter that fills it. They are the pair that has
--       to agree; a tile saying 1 over a list saying none is the shape the
--       crew actually saw. stat_overdue must equal filter_overdue and
--       stat_due_soon must equal filter_due_soon, before and after.
--       All four are 0 on today's fleet (four items, calibration due
--       2027-08-13), so this is a shape check now and a real one later.
--       It doubles as the invoker-rights check for these two: both are
--       called as `authenticated` here, and both must answer.
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

select '11c · stats beside the filter' as probe,
       (select s.overdue_count  from public.equipment_stats() s) as stat_overdue,
       (select s.due_soon_count from public.equipment_stats() s) as stat_due_soon,
       (select count(*) from public.search_equipment('Overdue',  0, 1000, '')) as filter_overdue,
       (select count(*) from public.search_equipment('Due soon', 0, 1000, '')) as filter_due_soon;
rollback;


-- ═══ 12 · dose_totals, called by a non-owner ════════════════════════════
-- Finding 6, and CLAUDE.md's three-minute outage again: dose_totals runs
-- as the CALLER and names private.user_role(), so it is parsed at call
-- time and needs USAGE on schema private — which `authenticated` has since
-- 20260903055300, and which nothing proves until somebody who is not the
-- owner actually calls it. That somebody is this block.
--
-- BEFORE: 12a and 12b raise 42883, function public.dose_totals(date, date)
--         does not exist. That is the correct "before" — do not try to
--         make them return rows. 12c is the arithmetic they will replace
--         and answers in both runs.
-- AFTER:  rows, or zero rows, but never an error.

-- 12a · A Technician. Sees its own dose and nobody else's: the crew read
--       policy would also show it a crewmate's row on a ticket they
--       shared, so the function narrows to own-or-Admin the way the ledger
--       screen has always narrowed it. distinct_people must be 0 or 1.
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

select '12a · dose_totals as Technician' as probe,
       count(*)                                as distinct_people,
       coalesce(sum(d.days), 0)                as crew_rows_behind_it,
       coalesce(sum(d.total_mr), 0)            as mr,
       coalesce(sum(d.q1 + d.q2 + d.q3 + d.q4), 0) as quarters_sum
  from public.dose_totals(date_trunc('year', now() at time zone 'America/Edmonton')::date,
                          (now() at time zone 'America/Edmonton')::date) d;
rollback;

-- 12b · An Admin, over the same year. distinct_people is everyone who
--       carried a DRD; quarters_sum must equal mr exactly, because the four
--       quarters are the same rows partitioned four ways; and all three
--       numbers must equal 12c, which is the read the screen does today.
--       On this morning's data that is 44 people, 31,823 crew rows and
--       230,066.06 mR.
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

select '12b · dose_totals as Admin' as probe,
       count(*)                                    as distinct_people,
       coalesce(sum(d.days), 0)                    as crew_rows_behind_it,
       coalesce(sum(d.total_mr), 0)                as mr,
       coalesce(sum(d.q1 + d.q2 + d.q3 + d.q4), 0) as quarters_sum
  from public.dose_totals(date_trunc('year', now() at time zone 'America/Edmonton')::date,
                          (now() at time zone 'America/Edmonton')::date) d;
rollback;

-- 12c · The arithmetic the screen does today, as the owner, over the same
--       year — the number 12b has to match. Also the size of what the
--       browser was being sent to work it out.
select '12c · what the ledger reads today' as probe,
       count(distinct c.profile_id) as distinct_people,
       count(*)                     as crew_rows_behind_it,
       sum(c.dose_mr)               as mr
  from public.ticket_crew c
  join public.tickets t on t.id = c.ticket_id
 where t.work_date >= date_trunc('year', now() at time zone 'America/Edmonton')::date
   and t.work_date <= (now() at time zone 'America/Edmonton')::date
   and c.dose_mr > 0;


-- ═══ 13 · Filing a report needs the report tab ══════════════════════════
-- Finding 7. reports_insert and storage's "reports write" both accepted the
-- job tab as well as the upload tab, and the job tab is one every Helper
-- holds — so a Helper could put a PDF in the reports bucket and file the row
-- that goes with it, and the report screen would then mail that
-- interpretation to the contractor. Nothing here inserts anything: each
-- block evaluates the predicate the way the CATALOG currently spells it —
-- the two tab reads are live, and whether the job arm is still in the policy
-- is read out of pg_policies — so one and the same statement answers true
-- before the migration and false after it.
--
-- The READ policies keep their job arm on purpose, and these blocks watch
-- them for it: a Helper who worked the day must go on seeing the reports
-- filed against that job, in both runs.

-- 13a · A Helper. The block this finding is about.
--       BEFORE: may_insert_report_row and may_write_reports_bucket are both
--               true, on the job tab alone — that pair IS the hole.
--       AFTER:  both false. has_upload_tab is false in both runs (no Helper
--               has ever held that tab) and may_read_report_rows is true in
--               both, or the migration has taken a read it was told to keep.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Helper' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Helper',
      'tab_access', public.tabs_for_role('Helper'))
  )::text, true);
set local role authenticated;

select '13a · Helper' as probe,
       (select private.user_role())       as caller_role,
       (select private.has_tab('job'))    as has_job_tab,
       (select private.has_tab('upload')) as has_upload_tab,
       -- reports_insert as the catalog holds it at this moment.
       ((select private.has_tab('upload'))
        or ((select private.has_tab('job')) and job_arm.on_row))    as may_insert_report_row,
       -- storage "reports write" — the same question about the bucket.
       ((select private.has_tab('upload'))
        or ((select private.has_tab('job')) and job_arm.on_object)) as may_write_reports_bucket,
       -- Untouched by this migration, and meant to stay true.
       (select private.has_any_tab(variadic array['upload','job','users'])) as may_read_report_rows
  from (select
          exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'reports'
                     and policyname = 'reports_insert'
                     and with_check like '%''job''::text%') as on_row,
          exists (select 1 from pg_policies
                   where schemaname = 'storage' and tablename = 'objects'
                     and policyname = 'reports write'
                     and with_check like '%''job''::text%') as on_object
       ) job_arm;
rollback;

-- 13b · A Technician — the person who actually files reports, and the one
--       who must lose nothing. Every column true in both runs: the upload
--       tab is what is answering, so the job arm coming off changes none of
--       it. Admins hold the same tab and read the same way.
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

select '13b · Technician' as probe,
       (select private.user_role())       as caller_role,
       (select private.has_tab('job'))    as has_job_tab,
       (select private.has_tab('upload')) as has_upload_tab,
       ((select private.has_tab('upload'))
        or ((select private.has_tab('job')) and job_arm.on_row))    as may_insert_report_row,
       ((select private.has_tab('upload'))
        or ((select private.has_tab('job')) and job_arm.on_object)) as may_write_reports_bucket,
       (select private.has_any_tab(variadic array['upload','job','users'])) as may_read_report_rows
  from (select
          exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'reports'
                     and policyname = 'reports_insert'
                     and with_check like '%''job''::text%') as on_row,
          exists (select 1 from pg_policies
                   where schemaname = 'storage' and tablename = 'objects'
                     and policyname = 'reports write'
                     and with_check like '%''job''::text%') as on_object
       ) job_arm;
rollback;

-- 13c · The six policies as the catalog holds them.
--       BEFORE: reports_insert's with_check names 'upload' and 'job', and
--               so does "reports write".
--       AFTER:  each names 'upload' alone. reports_select, "reports read"
--               and the two deletes must read identically in both runs —
--               the roles column included, since reports_insert is
--               `to public` and is meant to stay that way.
select '13c · catalog' as probe, schemaname, policyname, cmd, roles::text, qual, with_check
  from pg_policies
 where (schemaname = 'public'  and tablename = 'reports')
    or (schemaname = 'storage' and tablename = 'objects' and policyname like 'reports %')
 order by schemaname, policyname;

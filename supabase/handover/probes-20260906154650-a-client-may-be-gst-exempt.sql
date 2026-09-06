-- Run live on 6 Sept 2026 against 20260906154650 as one DO block ending in a
-- deliberate raise: a Technician cannot change a client's rate and reads 5;
-- an Admin can set 0 and 101 hits the check; a Helper gets rows with the
-- rate and no money through search_tickets. All passed.
-- Probes for the GST-rate draft (20260906154650_a_client_may_be_gst_exempt.sql).
--
-- Blocks 0-3 and 7 are READ ONLY. Blocks 4, 5 and 6 write, and every one of
-- them ends in ROLLBACK: they change a real client's GST rate and name for
-- the length of one transaction and then put it back. Run each block WHOLE —
-- the begin/rollback pair is what makes `set local role` and
-- `set local request.jwt.claims` local, and it is also what makes the writes
-- vanish. A block run half-way, without its rollback, leaves a client's tax
-- rate changed.
--
-- HOW TO RUN
--   Run block 0 first (it names the fixtures the rest read back against),
--   then blocks 1-7 BEFORE applying the draft and keep the output; apply;
--   run 1-7 again and diff. Each block says what the two runs should say.
--   Blocks 1, 2, 4, 5 and 7 fail before the draft is applied — the column
--   does not exist yet (42703) — and that failure IS their "before".
--
-- WHAT ROLE SIMULATION ACTUALLY SIMULATES
--   `set local role authenticated` puts us in the API's role, so RLS is
--   enforced and schema `private` is reached the way PostgREST reaches it.
--   `set local request.jwt.claims` is the token. The trigger under test
--   reads private.user_role(), which since 20260904135107 reads the
--   PROFILES row and not the claim — so the claim's app_metadata is set here
--   only to keep the token honest, and changing it would not change the
--   answer. That is the point of that migration and this probe inherits it.


-- ═══ 0 · Fixtures ═══════════════════════════════════════════════════════
-- The accounts and the client the rest of the file uses. Read them once so
-- the later output can be read back against real rows. If helper_id comes
-- back null there is nobody to prove block 4 with and it must be created
-- before this file means anything.
select 'fixtures' as probe,
       (select id::text from public.profiles
         where role = 'Admin' and deactivated_at is null
         order by created_at limit 1)                        as admin_id,
       (select id::text from public.profiles
         where role = 'Helper' and deactivated_at is null
         order by created_at limit 1)                        as helper_id,
       (select id::text from public.profiles
         where role = 'Technician' and deactivated_at is null
         order by created_at limit 1)                        as technician_id,
       (select id::text from public.clients order by name limit 1) as client_id,
       (select name    from public.clients order by name limit 1) as client_name,
       (select count(*) from public.clients)                 as clients_total;


-- ═══ 1 · The column, its default and its range ══════════════════════════
-- BEFORE: 0 rows.
-- AFTER: one row — data_type numeric, numeric_precision 5, numeric_scale 2,
-- is_nullable NO, column_default 5, range_check present.
select 'the column' as probe,
       c.data_type, c.numeric_precision, c.numeric_scale,
       c.is_nullable, c.column_default,
       (select count(*) from pg_constraint
         where conrelid = 'public.clients'::regclass
           and conname = 'clients_gst_rate_range')            as range_check
  from information_schema.columns c
 where c.table_schema = 'public' and c.table_name = 'clients' and c.column_name = 'gst_rate';

-- Every client that already existed is on the ordinary rate, and none is
-- outside 0-100. AFTER: exempt 0, ordinary = clients_total from block 0,
-- out_of_range 0. (Unless somebody has already been set exempt, which is the
-- point of the column and is what the first number is for.)
select 'rates on file' as probe,
       count(*) filter (where gst_rate = 0)                as exempt,
       count(*) filter (where gst_rate = 5)                as ordinary,
       count(*) filter (where gst_rate < 0 or gst_rate > 100) as out_of_range
  from public.clients;


-- ═══ 2 · A Technician reads the rate through the job ════════════════════
-- This is the read the app actually makes: jobs → clients(name, gst_rate).
-- clients_select is a tab test (board, job or rates) and a Technician holds
-- all three, so the rate comes back with the client's name.
--
-- BEFORE: ERROR 42703, column c.gst_rate does not exist. That is the
--         "before", and it is also the reason the app must not be deployed
--         until this is applied.
-- AFTER:  one row per job read, gst_rate not null on every one of them.
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

select '2 · technician reads the rate' as probe,
       count(*)                                as jobs_visible,
       count(c.gst_rate)                       as with_a_rate,
       count(*) filter (where c.gst_rate = 0)  as on_exempt_clients
  from public.jobs j
  left join public.clients c on c.id = j.client_id;
rollback;


-- ═══ 3 · Which policy governs a clients UPDATE ══════════════════════════
-- True BEFORE and AFTER, unchanged by the draft: clients_update is a TAB
-- test — board OR rates — and nothing about rank. Helper holds board. This
-- block is the evidence for why the draft adds a trigger rather than editing
-- a policy: the policy is right for the row (the office renames clients) and
-- wrong for this one column.
select 'clients policies' as probe, polname, polcmd,
       pg_get_expr(polqual, polrelid)       as using_expr,
       pg_get_expr(polwithcheck, polrelid)  as check_expr
  from pg_policy where polrelid = 'public.clients'::regclass
 order by polcmd, polname;

-- AFTER: helper_has_board t — which is exactly why the trigger is needed.
select 'helper tabs' as probe,
       'board' = any (public.tabs_for_role('Helper')) as helper_has_board,
       'rates' = any (public.tabs_for_role('Helper')) as helper_has_rates,
       public.tabs_for_role('Helper')                 as helper_tabs;


-- ═══ 4 · A Helper cannot zero a client's tax ════════════════════════════
-- ROLLS BACK. Writes to a real client and undoes it.
--
-- BEFORE: ERROR 42703 (no such column).
-- AFTER:  gst=REFUSED(Only an admin can change a client's GST rate …),
--         rename=ACCEPTED. The second half matters as much as the first: the
--         draft must not lock the Helper out of the row, only out of the one
--         column. The rename is rolled back with everything else.
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

do $$
declare
  target uuid := (select id from public.clients order by name limit 1);
  notes text := '';
begin
  begin
    update public.clients set gst_rate = 0 where id = target;
    notes := notes || 'gst=ACCEPTED; ';
  exception when others then notes := notes || 'gst=REFUSED(' || sqlerrm || '); ';
  end;
  begin
    update public.clients set name = name || ' (probe)' where id = target;
    notes := notes || 'rename=ACCEPTED; ';
  exception when others then notes := notes || 'rename=REFUSED(' || sqlerrm || '); ';
  end;
  raise notice 'PROBE 4 %', notes;
end $$;
rollback;


-- ═══ 5 · An Admin can set it, exempt included ═══════════════════════════
-- ROLLS BACK.
--
-- BEFORE: ERROR 42703.
-- AFTER:  zero=ACCEPTED, back_to_five=ACCEPTED, over_a_hundred=REFUSED
--         (violates check constraint "clients_gst_rate_range"), and
--         negative=REFUSED for the same reason. Zero has to be accepted:
--         exempt is the whole point, and a guard that treated 0 as "no value
--         given" would make an exempt client unrepresentable.
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

do $$
declare
  target uuid := (select id from public.clients order by name limit 1);
  notes text := '';
begin
  begin
    update public.clients set gst_rate = 0 where id = target;
    notes := notes || 'zero=ACCEPTED(' || (select gst_rate from public.clients where id = target)::text || '); ';
  exception when others then notes := notes || 'zero=REFUSED(' || sqlerrm || '); ';
  end;
  begin
    update public.clients set gst_rate = 5 where id = target;
    notes := notes || 'back_to_five=ACCEPTED; ';
  exception when others then notes := notes || 'back_to_five=REFUSED(' || sqlerrm || '); ';
  end;
  begin
    update public.clients set gst_rate = 101 where id = target;
    notes := notes || 'over_a_hundred=ACCEPTED; ';
  exception when others then notes := notes || 'over_a_hundred=REFUSED(' || sqlerrm || '); ';
  end;
  begin
    update public.clients set gst_rate = -1 where id = target;
    notes := notes || 'negative=ACCEPTED; ';
  exception when others then notes := notes || 'negative=REFUSED(' || sqlerrm || '); ';
  end;
  raise notice 'PROBE 5 %', notes;
end $$;
rollback;


-- ═══ 6 · A Coordinator is not an Admin either ═══════════════════════════
-- ROLLS BACK. Coordinator holds board, so the policy lets them at the row,
-- and money is not theirs anywhere else in this app.
--
-- BEFORE: ERROR 42703.
-- AFTER:  gst=REFUSED(Only an admin …). If there is no Coordinator on file
--         (there were none on 2026-09-05) the block raises on a null sub and
--         that is the block saying so, not a finding.
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Coordinator' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated',
    'app_metadata', json_build_object(
      'app_role',   'Coordinator',
      'tab_access', public.tabs_for_role('Coordinator'))
  )::text, true);
set local role authenticated;

do $$
declare
  target uuid := (select id from public.clients order by name limit 1);
  notes text := '';
begin
  begin
    update public.clients set gst_rate = 0 where id = target;
    notes := notes || 'gst=ACCEPTED; ';
  exception when others then notes := notes || 'gst=REFUSED(' || sqlerrm || '); ';
  end;
  raise notice 'PROBE 6 %', notes;
end $$;
rollback;


-- ═══ 7 · search_tickets still hides money and now carries the rate ══════
-- READ ONLY. Two roles, one function.
--
-- BEFORE: ERROR 42703 on client_gst_rate, or — depending on which half is
--         run — the old record with one fewer column.
-- AFTER:  technician: totals not null, rates not null.
--         helper:     totals ALL null (the null-money rule is untouched),
--                     rates not null — a tax status is not a price.
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

select '7a · technician' as probe,
       count(*)                    as rows_back,
       count(total)                as totals_shown,
       count(client_gst_rate)      as rates_shown
  from public.search_tickets('All', 0, 25, '', null, null);
rollback;

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

select '7b · helper' as probe,
       count(*)                    as rows_back,
       count(total)                as totals_shown,
       count(client_gst_rate)      as rates_shown
  from public.search_tickets('All', 0, 25, '', null, null);
rollback;

-- Probes for 20260906143715 ticket_aging(). Run live on 6 Sept 2026 with
-- role simulation: an Admin's buckets summed to the 25,325 outstanding
-- tickets with no null money; a Helper saw 670 rows and no money; anon has
-- no execute grant.
--
-- READ ONLY: every statement here is a SELECT. Nothing inserts, updates or
-- deletes, and the one block that would has been left commented out with its
-- ROLLBACK attached (block 6).
--
-- HOW TO RUN
--   Run each numbered block WHOLE — the begin/rollback pair is what makes
--   `set local role` and `set local request.jwt.claims` local. Run block 0
--   first (it names the fixtures the rest pick up), then run 1-8 BEFORE
--   applying the draft and keep the output; apply; run 1-8 again and diff.
--   Each block says what the two runs should say.
--
--   Blocks 2 to 5 call a function that does not exist yet, so before the
--   migration each of them raises 42883 — and that IS its "before". Block 1
--   is deliberately written to return zero rows rather than raise, so the
--   grant picture can be read either side.
--
-- WHAT ROLE SIMULATION ACTUALLY SIMULATES
--   `set local role authenticated` puts us in the API's role, so RLS is
--   enforced and schema `private` is reached the way PostgREST reaches it
--   (migration 20260903055300 — an invoker-rights function that names
--   private.user_role() is parsed at CALL time and needs that USAGE). That
--   is what makes blocks 2 to 5 the non-owner probe CLAUDE.md asks for on
--   every new invoker function: run as the owner they would pass whatever
--   the grant said.
--   `set local request.jwt.claims` is the token. Since 20260904135107 the
--   ROLE comes from the profiles row, not the claim — so a role is
--   simulated by choosing whose `sub` to sit under, not by writing a role
--   into the payload.


-- ═══ 0 · Fixtures ═══════════════════════════════════════════════════════
-- The accounts the later blocks sit under. A Helper is the non-price
-- fixture: `tickets select` is is_staff(), and a Helper holds board/job/jha/
-- files/contacts — so a Helper reads every ticket, and reads jobs and
-- clients too (clients_select takes board/job/rates). Their answer should
-- therefore be the Admin's answer with the money removed, which is exactly
-- the assertion block 4 makes. Coordinators are the role the tracker tab is
-- presetted to but there were none on file at the time of writing; block 5
-- runs only if one exists now.

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
         where role = 'Helper' and deactivated_at is null
         order by created_at limit 1)                        as helper_id,
       (select id from public.profiles
         where role = 'Coordinator' and deactivated_at is null
         order by created_at limit 1)                        as coordinator_id;

-- What the tracker's own tiles say right now, for block 2 to be read
-- against. Owner rights here on purpose: this is the reference figure.
select 'tracker outstanding' as probe,
       count(*) filter (where status = 'Awaiting approval') as awaiting,
       count(*) filter (where status = 'Approved')          as approved,
       count(*) filter (where status = 'Invoiced')          as invoiced,
       count(*) filter (where status = any (array['Awaiting approval','Approved','Invoiced'])) as outstanding,
       count(*) filter (where status = 'Draft')             as drafts_excluded
  from public.tickets;


-- ═══ 1 · The function, and who may execute it ═══════════════════════════
-- BEFORE: zero rows — there is no such function.
-- AFTER : one row. security_type invoker, authenticated true, anon false,
--         public false. service_role true is the default membership and is
--         not what this draft grants; it is printed so a diff notices if it
--         ever changes.

select 'grants' as probe,
       p.proname,
       case when p.prosecdef then 'definer' else 'invoker' end as security_type,
       p.provolatile                                            as volatility,   -- expect s (stable)
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_may,  -- expect true
       has_function_privilege('anon',          p.oid, 'execute') as anon_may,            -- expect false
       has_function_privilege('public',        p.oid, 'execute') as public_may,          -- expect false
       has_function_privilege('service_role',  p.oid, 'execute') as service_role_may
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'ticket_aging';


-- ═══ 2 · An Admin sees money, and the buckets add up ════════════════════
-- The headline assertion. Run as `authenticated` under an Admin's sub, so
-- RLS and the private-schema USAGE are both in play.
--
-- BEFORE: 42883, no such function.
-- AFTER : totals are numbers, never null; `tickets` sums to the
--         `outstanding` figure block 0 printed; `total` sums to the same
--         money as the hand-written sum in the second statement.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Admin' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

select 'admin totals' as probe,
       count(*)                                   as rows_returned,
       sum(a.tickets)                             as tickets_all_buckets,
       count(*) filter (where a.total is null)    as null_totals,   -- expect 0
       sum(a.total)                               as money_all_buckets,
       count(distinct a.bucket)                   as buckets_seen,
       count(distinct coalesce(a.client_id::text, 'none')) as clients_seen
  from public.ticket_aging() a;

-- The same two numbers, taken straight off the table. Both lines of the
-- output must agree with the block above; if they do not, the function is
-- counting something the tracker is not.
select 'admin cross-check' as probe,
       count(*)      as outstanding_tickets,
       sum(t.total)  as outstanding_money
  from public.tickets t
 where t.status = any (array['Awaiting approval','Approved','Invoiced']);

-- Per bucket, for the eye: this is the row of tiles the office will see.
select 'admin by bucket' as probe, a.bucket, sum(a.tickets) as tickets, sum(a.total) as total
  from public.ticket_aging() a
 group by a.bucket
 order by case a.bucket when 'current' then 1 when '30' then 2 when '60' then 3 else 4 end;

-- And the top of the by-client table, in the order the screen sorts it.
select 'admin by client' as probe, a.client_name, sum(a.tickets) as tickets, sum(a.total) as total
  from public.ticket_aging() a
 group by a.client_id, a.client_name
 order by sum(a.total) desc nulls last
 limit 10;
rollback;


-- ═══ 3 · The edges are where the tiles say they are ═════════════════════
-- Two statements. The first recomputes the buckets straight off the table
-- with the arithmetic written out, and must match block 2's "by bucket"
-- line row for row — the function and the hand-written version disagreeing
-- is the bug this block exists to catch.
--
-- The second is a transcription check and says so: it runs the case
-- expression over the ages that matter rather than over tickets, because on
-- most days no ticket is exactly 30 or exactly 90 days old and the edge
-- would go untested. Expect, in order: current, current, current, 30, 30,
-- 60, 60, 90, 90.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Admin' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

select 'edges by hand' as probe, s.bkt as bucket, count(*) as tickets, sum(s.total) as total
  from (
    select case when ((now() at time zone 'America/Edmonton')::date - t.work_date) < 30 then 'current'
                when ((now() at time zone 'America/Edmonton')::date - t.work_date) < 60 then '30'
                when ((now() at time zone 'America/Edmonton')::date - t.work_date) < 90 then '60'
                else '90'
           end as bkt,
           t.total
      from public.tickets t
     where t.status = any (array['Awaiting approval','Approved','Invoiced'])
  ) s
 group by s.bkt
 order by case s.bkt when 'current' then 1 when '30' then 2 when '60' then 3 else 4 end;

-- How close the live data actually comes to an edge, so the block above is
-- read for what it is worth today.
select 'ages near an edge' as probe,
       ((now() at time zone 'America/Edmonton')::date - t.work_date) as age_days,
       count(*) as tickets
  from public.tickets t
 where t.status = any (array['Awaiting approval','Approved','Invoiced'])
   and ((now() at time zone 'America/Edmonton')::date - t.work_date) = any (array[-1,0,29,30,59,60,89,90])
 group by 1
 order by 1;
rollback;

select 'edge transcription' as probe, d as age_days,
       case when d < 30 then 'current'
            when d < 60 then '30'
            when d < 90 then '60'
            else '90'
       end as bucket
  from unnest(array[-1, 0, 29, 30, 59, 60, 89, 90, 900]) as d;

-- Grande Prairie's day, not UTC's — the reason the arithmetic above is
-- written the way it is. These two are a day apart from six in the evening
-- local, which is when a tile and a row used to disagree on the equipment
-- screen.
select 'which day is it' as probe,
       (now() at time zone 'America/Edmonton')::date as edmonton_day,
       current_date                                  as utc_day;


-- ═══ 4 · A Helper: real counts, no money ════════════════════════════════
-- The price gate, from the other side. A Helper reads every ticket
-- (`tickets select` is is_staff()) and reads jobs and clients, so their
-- answer must be the Admin's answer with the money taken out — same number
-- of rows, same counts, every total null.
--
-- BEFORE: 42883.
-- AFTER : rows_returned and tickets_all_buckets equal to block 2's;
--         null_totals equal to rows_returned; money_all_buckets null.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Helper' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

select 'helper totals' as probe,
       count(*)                                as rows_returned,
       sum(a.tickets)                          as tickets_all_buckets,
       count(*) filter (where a.total is null) as null_totals,      -- expect = rows_returned
       sum(a.total)                            as money_all_buckets -- expect null
  from public.ticket_aging() a;

-- The role the gate is actually reading, so a surprise above is traced in
-- one line rather than guessed at.
select 'helper sees itself as' as probe, private.user_role() as role_read;
rollback;


-- ═══ 5 · A Coordinator, if there is one ═════════════════════════════════
-- Same expectation as the Helper: counts yes, money no. Coordinators hold
-- the tracker tab, so this is the role that will actually open this screen
-- without prices.
--
-- SKIP THIS BLOCK if block 0 printed a null coordinator_id — with no
-- Coordinator on file the sub is null, auth.uid() is null, and the answer
-- comes back empty for want of a fixture rather than for want of a role,
-- which proves nothing. Block 6 is how to borrow one for five seconds.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Coordinator' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

select 'coordinator totals' as probe,
       count(*)                                as rows_returned,
       sum(a.tickets)                          as tickets_all_buckets,
       count(*) filter (where a.total is null) as null_totals,      -- expect = rows_returned
       sum(a.total)                            as money_all_buckets -- expect null
  from public.ticket_aging() a;
rollback;


-- ═══ 6 · A Coordinator on loan (COMMENTED OUT — it writes) ══════════════
-- The only block here that is not read-only, which is why it is commented
-- out. It borrows a Technician for the length of one transaction, asks the
-- question as a Coordinator, and rolls the borrowing back. Uncomment,
-- select the whole thing, run it, and check the ROLLBACK went through
-- before doing anything else — the account is a real person's.
--
-- Expect: the same shape as block 4. Counts, no money.
--
-- begin;
-- update public.profiles set role = 'Coordinator'
--  where id = (select id from public.profiles
--               where role = 'Technician' and deactivated_at is null
--               order by created_at limit 1);
-- select set_config('request.jwt.claims', json_build_object(
--     'sub',  (select id::text from public.profiles
--               where role = 'Coordinator' order by created_at limit 1),
--     'role', 'authenticated'
--   )::text, true);
-- set local role authenticated;
-- select 'borrowed coordinator' as probe,
--        count(*)                                as rows_returned,
--        sum(a.tickets)                          as tickets_all_buckets,
--        count(*) filter (where a.total is null) as null_totals,
--        sum(a.total)                            as money_all_buckets
--   from public.ticket_aging() a;
-- rollback;


-- ═══ 7 · anon may not ═══════════════════════════════════════════════════
-- The publishable key answers to anyone. It gets nothing here.
--
-- BEFORE: 42883 on both lines (no such function).
-- AFTER : anon_can false, authenticated_can true.

select has_function_privilege('anon', 'public.ticket_aging()', 'execute') as anon_can;           -- expect false
select has_function_privilege('authenticated', 'public.ticket_aging()', 'execute') as authenticated_can;  -- expect true

-- And the door it would come through, tried for real. Expect: zero rows
-- from tickets whatever the grant says, because anon is not staff.
begin;
set local role anon;
select 'anon reads tickets' as probe, count(*) as visible from public.tickets;  -- expect 0
rollback;


-- ═══ 8 · The USAGE this function depends on ═════════════════════════════
-- An invoker-rights function naming private.user_role() is parsed at call
-- time, so `authenticated` must hold USAGE on schema private (20260903055300
-- — the round-three outage). Unchanged by this draft; asserted because this
-- draft is the kind of function that broke when it was missing.
--
-- BEFORE and AFTER: true.

select 'private usage' as probe,
       has_schema_privilege('authenticated', 'private', 'usage') as authenticated_may_use_private;

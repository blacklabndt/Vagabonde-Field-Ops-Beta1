-- Run live on 6 Sept 2026 against 20260906154840 as one DO block ending in a
-- deliberate raise: two invoices numbered 1000 and 1001, un-invoice kept the
-- number and re-invoice returned it; a Technician's direct write and RPC
-- call both refused; authenticated has no USAGE on the sequence;
-- search_tickets carries invoice_number and client_id. The sequence was then
-- restarted at 1000, because nextval does not roll back. All passed.
-- Probes for the DRAFT migration 20260906154840_an_invoice_has_a_number.sql:
-- tickets.invoice_number, public.invoice_number_seq, mark_tickets_invoiced
-- stamping it, the insert policy pinning it, the three app_settings columns,
-- and search_tickets carrying it.
--
-- NOT YET RUN — this draft has not been applied. Fill in the date and the
-- headline numbers here when it has been.
--
-- HOW TO RUN
--   Run each numbered block WHOLE — the begin/rollback pair is what makes
--   `set local role` and `set local request.jwt.claims` local. Run block 0
--   first (it says what the fixtures are), then 1-6 BEFORE applying the
--   draft and keep the output; apply; run 1-6 again and diff. Each block
--   says what the two runs should say.
--
--   Before the migration, blocks that name invoice_number raise 42703
--   (no such column) and block 1's sequence line returns no row — that IS
--   their "before".
--
-- ONE THING HERE IS NOT UNDONE BY ITS ROLLBACK
--   Block 3 marks a real ticket invoiced inside a transaction it rolls
--   back. The ROWS come back; the sequence does not — nextval() is outside
--   transaction control by design, so the two or three numbers this probe
--   spends are spent for good. Run block 3 once. If it matters that the
--   first real invoice is 1000, run
--     alter sequence public.invoice_number_seq restart with 1000;
--   afterwards — and only before the first ticket is genuinely invoiced,
--   never after, or the next invoice reuses a number a client already has.
--
-- WHAT ROLE SIMULATION ACTUALLY SIMULATES
--   `set local role authenticated` puts us in the API's role, so RLS is
--   enforced and schema `private` is reached the way PostgREST reaches it
--   (migration 20260903055300 — an invoker-rights function that names
--   private.user_role() is parsed at CALL time and needs that USAGE).
--   `set local request.jwt.claims` is the token. Since 20260904135107 the
--   ROLE comes from the profiles row, not the claim — so a role is
--   simulated by choosing whose `sub` to sit under, not by writing a role
--   into the payload.


-- ═══ 0 · Fixtures ═══════════════════════════════════════════════════════
-- The accounts the later blocks sit under, and what the tickets look like
-- before anything is stamped. A Technician is the fixture that must NOT be
-- able to write the column (they can read prices, so a refusal here is
-- about the column and not about the role's blindness to money); a Helper
-- is the non-price fixture for block 6.

select 'chosen fixtures' as probe,
       (select id from public.profiles
         where role = 'Admin' and deactivated_at is null
         order by created_at limit 1)                        as admin_id,
       (select id from public.profiles
         where role = 'Technician' and deactivated_at is null
         order by created_at limit 1)                        as technician_id,
       (select id from public.profiles
         where role = 'Helper' and deactivated_at is null
         order by created_at limit 1)                        as helper_id;

-- What is invoiceable today, and what is already invoiced. Block 3 needs at
-- least one Approved ticket; if `approved_ready` is 0 there is nothing to
-- probe with and block 3 will return 0 rows affected rather than raise.
select 'ticket census' as probe,
       count(*) filter (where status = 'Approved' and approved_at is not null) as approved_ready,
       count(*) filter (where status = 'Invoiced')                             as already_invoiced,
       count(*)                                                                as tickets_all
  from public.tickets;

-- AFTER only (42703 before): nothing carries a number until this ships.
select 'numbers in use' as probe,
       count(*) filter (where invoice_number is not null) as numbered,
       min(invoice_number) as lowest, max(invoice_number) as highest
  from public.tickets;


-- ═══ 1 · The shape of it: column, sequence, grants, policy ══════════════
-- No writes. Read as the owner — this block is about what the catalog says,
-- not about what any role can do with it.
--
-- BEFORE: the column row and the sequence row are absent; the policy line
--         does not mention invoice_number.
-- AFTER : integer column, nullable; a partial unique index on it; the
--         sequence exists with last_value 999 and is_called false (nothing
--         drawn yet); anon, authenticated and public hold NO privilege on
--         the sequence; the tickets UPDATE grant still names five columns
--         and invoice_number is not among them; the insert policy names it.

select 'the column' as probe, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'tickets' and column_name = 'invoice_number';

select 'the unique index' as probe, indexname, indexdef
  from pg_indexes
 where schemaname = 'public' and tablename = 'tickets' and indexname = 'tickets_invoice_number_key';

select 'the sequence' as probe, last_value, is_called
  from public.invoice_number_seq;

select 'sequence grants' as probe, r.rolname,
       has_sequence_privilege(r.rolname, 'public.invoice_number_seq', 'usage')  as may_use,
       has_sequence_privilege(r.rolname, 'public.invoice_number_seq', 'select') as may_select,
       has_sequence_privilege(r.rolname, 'public.invoice_number_seq', 'update') as may_nextval
  from unnest(array['anon','authenticated','service_role']) as r(rolname);

-- The five columns a signed-in account may write. invoice_number must not
-- appear: mark_tickets_invoiced is the only writer there is.
select 'tickets update grant' as probe, grantee, string_agg(column_name, ', ' order by column_name) as columns
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'tickets' and privilege_type = 'UPDATE'
   and grantee in ('anon', 'authenticated')
 group by grantee;

-- The policy is stored resolved, so this is the actual gate, not the source
-- file's version of it.
select 'insert policy pins it' as probe,
       (with_check like '%invoice_number IS NULL%') as pins_invoice_number,
       (with_check like '%approval_token IS NULL%') as still_pins_the_token,
       (with_check like '%queried_at IS NULL%')     as still_pins_the_query
  from pg_policies
 where schemaname = 'public' and tablename = 'tickets' and policyname = 'tickets insert';

select 'the settings columns' as probe, column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'app_settings'
   and column_name in ('invoice_terms', 'invoice_remit_to', 'business_number')
 order by column_name;

select 'function grants' as probe, p.proname,
       case when p.prosecdef then 'definer' else 'invoker' end   as security_type,
       has_function_privilege('authenticated', p.oid, 'execute')  as authenticated_may, -- expect true
       has_function_privilege('anon',          p.oid, 'execute')  as anon_may,          -- expect false
       has_function_privilege('public',        p.oid, 'execute')  as public_may         -- expect false
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('mark_tickets_invoiced', 'search_tickets')
 order by p.proname;

-- Every column search_tickets hands back, in order. AFTER must be BEFORE's
-- list with invoice_number appended at the end and nothing dropped. (If the
-- gst-exempt draft is merged in first, client_gst_rate is there too — both
-- go at the end, and both must survive.)
select 'search_tickets columns' as probe,
       string_agg(t.name, ', ' order by t.n) as returns
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace,
  lateral unnest(p.proargnames) with ordinality as t(name, n)
 where ns.nspname = 'public' and p.proname = 'search_tickets';


-- ═══ 2 · An Admin's ordinary read still works ═══════════════════════════
-- The cheap regression: search_tickets is what the tracker lives on, and it
-- was re-created whole. Money present, the count sane, the new column there.
--
-- BEFORE: answers, with no invoice_number column (42703 on the last field).
-- AFTER : the same row count and the same filtered_total, plus the column.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Admin' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

select 'admin search' as probe,
       count(*)                                        as rows_returned,
       count(*) filter (where s.total is null)         as null_totals,      -- expect 0
       max(s.total_count)                              as total_count,
       max(s.filtered_total)                           as filtered_total,
       count(*) filter (where s.invoice_number is not null) as numbered_rows
  from public.search_tickets('All', 0, 25, '', null, null) s;

-- The invoiced page, which is where a number is expected to show.
select 'admin invoiced page' as probe, s.id, s.status, s.invoice_number, s.invoiced_at, s.total
  from public.search_tickets('Invoiced', 0, 10, '', null, null) s
 order by s.invoice_number nulls last
 limit 10;
rollback;


-- ═══ 3 · The number is stamped, increases, and survives a round trip ════
-- The headline assertion, on a real Approved ticket, rolled back. Read the
-- warning at the top of this file first: the sequence values it spends are
-- not rolled back with the rows.
--
-- BEFORE: 42703 — mark_tickets_invoiced does not know the column.
-- AFTER : `first_number` is 1000 on a series nothing has drawn from yet and
--         rises by one per newly invoiced ticket; `after_uninvoice` shows
--         status Approved, invoiced_at null and the SAME number; and
--         `after_reinvoice` shows that same number again, not a new one.
--         `rows` is 1 at each of the three calls.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Admin' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

-- Two Approved tickets if there are two: one is enough for the round trip,
-- the second is what shows the number rising. coalesce to '' rather than
-- null so a project with nothing Approved returns 0 rows affected instead
-- of raising — a "nothing to test with" answer, not a failure.
select set_config('probe.ticket_a', coalesce((
         select id from public.tickets
          where status = 'Approved' and approved_at is not null and invoice_number is null
          order by created_at limit 1), ''), true) as ticket_a,
       set_config('probe.ticket_b', coalesce((
         select id from public.tickets
          where status = 'Approved' and approved_at is not null and invoice_number is null
          order by created_at offset 1 limit 1), ''), true) as ticket_b;

select 'invoice A' as probe,
       public.mark_tickets_invoiced(array[current_setting('probe.ticket_a')], true) as rows;
select 'first_number' as probe, t.id, t.status, t.invoice_number, t.invoiced_at is not null as dated
  from public.tickets t where t.id = current_setting('probe.ticket_a');

select 'invoice B' as probe,
       public.mark_tickets_invoiced(array[current_setting('probe.ticket_b')], true) as rows;
select 'second_number is one higher' as probe,
       (select invoice_number from public.tickets where id = current_setting('probe.ticket_a')) as a,
       (select invoice_number from public.tickets where id = current_setting('probe.ticket_b')) as b,
       (select invoice_number from public.tickets where id = current_setting('probe.ticket_b'))
     - (select invoice_number from public.tickets where id = current_setting('probe.ticket_a')) as gap; -- expect 1

select 'un-invoice A' as probe,
       public.mark_tickets_invoiced(array[current_setting('probe.ticket_a')], false) as rows;
select 'after_uninvoice' as probe, t.id, t.status, t.invoice_number, t.invoiced_at
  from public.tickets t where t.id = current_setting('probe.ticket_a');

select 're-invoice A' as probe,
       public.mark_tickets_invoiced(array[current_setting('probe.ticket_a')], true) as rows;
select 'after_reinvoice' as probe, t.id, t.status, t.invoice_number, t.invoiced_at is not null as dated
  from public.tickets t where t.id = current_setting('probe.ticket_a');
rollback;

-- The rollback took the rows back. Confirm it, as the owner: nothing above
-- may survive this file.
select 'nothing survived block 3' as probe,
       count(*) filter (where invoice_number is not null) as numbered
  from public.tickets;


-- ═══ 4 · A Technician cannot write the number ═══════════════════════════
-- Two refusals, each in its own transaction because the first one aborts.
-- Run each begin/rollback pair on its own and record the error.
--
-- BEFORE: 42703 on both — the column does not exist yet.
-- AFTER : 4a raises 42501, "permission denied for table tickets" or
--         "column invoice_number of relation tickets" — the UPDATE grant
--         names five columns and this is not one of them, so the statement
--         never reaches RLS. 4b raises 42501 from the function's own Admin
--         check. Either way the ticket is unchanged, which the owner read
--         after the rollback proves.

-- 4a · the direct write
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

update public.tickets set invoice_number = 999999
 where id = (select id from public.tickets order by created_at limit 1);
rollback;

-- 4b · the front door, as a Technician
begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Technician' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

select public.mark_tickets_invoiced(array[(
         select id from public.tickets
          where status = 'Approved' and approved_at is not null
          order by created_at limit 1)], true);
rollback;

-- And nothing moved, whichever way it was refused.
select 'no ticket carries 999999' as probe, count(*) as rows
  from public.tickets where invoice_number = 999999;


-- ═══ 5 · A Technician cannot smuggle one in on an insert ════════════════
-- LEFT COMMENTED OUT ON PURPOSE. It inserts a ticket, and a ticket id is
-- the ticket number — a real one, taken out of the crew's own series — so
-- this is the one probe that is cheaper to reason about than to run. Its
-- rollback is attached; fill in a job the technician may raise against and
-- an id that is neither in use nor in burned_ticket_numbers if it is ever
-- worth running.
--
-- Expect: 42501, "new row violates row-level security policy" — the
-- with_check in block 1 is the same gate, read from the catalog.
--
-- begin;
-- select set_config('request.jwt.claims', json_build_object(
--     'sub',  (select id::text from public.profiles
--               where role = 'Technician' and deactivated_at is null
--               order by created_at limit 1),
--     'role', 'authenticated'
--   )::text, true);
-- set local role authenticated;
-- insert into public.tickets (id, job_id, technician_id, work_date, status, total, invoice_number)
-- values ('PROBE-1', '<a job id>', (select id from public.profiles where role = 'Technician'
--                                    and deactivated_at is null order by created_at limit 1),
--         current_date, 'Draft', 0, 1000);
-- rollback;


-- ═══ 6 · A non-price role still gets null money ═════════════════════════
-- The rule the re-created search_tickets must not have lost. A Helper reads
-- every ticket (tickets_select is is_staff()) and no price at all.
--
-- BEFORE and AFTER: rows_returned the same as an Admin's, every total null,
-- filtered_total null. AFTER additionally: invoice_number is NOT null on
-- the invoiced ones — it is a reference, not money, and the office quotes
-- it on the phone.

begin;
select set_config('request.jwt.claims', json_build_object(
    'sub',  (select id::text from public.profiles
              where role = 'Helper' and deactivated_at is null
              order by created_at limit 1),
    'role', 'authenticated'
  )::text, true);
set local role authenticated;

select 'helper search' as probe,
       count(*)                                             as rows_returned,
       count(*) filter (where s.total is not null)          as rows_with_money,   -- expect 0
       max(s.filtered_total)                                as filtered_total,    -- expect null
       max(s.total_count)                                   as total_count,
       count(*) filter (where s.invoice_number is not null) as numbered_rows
  from public.search_tickets('All', 0, 25, '', null, null) s;

select 'helper invoiced page' as probe, s.id, s.status, s.invoice_number, s.total
  from public.search_tickets('Invoiced', 0, 5, '', null, null) s;
rollback;

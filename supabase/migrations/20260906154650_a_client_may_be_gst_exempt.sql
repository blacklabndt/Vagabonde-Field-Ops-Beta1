-- A client may be GST exempt. Applied live 6 Sept 2026 as 20260906154650 and
-- probed with role simulation (probes beside it under supabase/handover/).
--
-- Alberta is the 5% federal rate with no provincial component, and the app
-- had that rate written into the code in three places. But not every client
-- pays it: a First Nations band, a Crown agency, a client billing through an
-- exempt entity is zero-rated, and the office was deleting the GST line off
-- those tickets by hand every time one went out. A rate that is corrected by
-- hand is a rate that will one day be forgotten, on the one ticket that
-- matters.
--
-- So the rate is the client's, as a percent, on the client's own row.
--
-- WHY A PERCENT AND NOT A FRACTION
--   It is typed by a person, into a box on the rate admin screen, beside the
--   words "GST %". 5 is what the office says out loud; 0.05 is what the code
--   used to say to itself. The one place that still wants a fraction (the
--   invoice) divides by 100 where it needs to.
--
-- WHY NOT NULL WITH A DEFAULT OF 5
--   Nothing may be silent about tax. A null rate would have to be read
--   somewhere as "the usual", and the reading would be forgotten in one of
--   the places that reads it — which is the failure that undercharges. Every
--   client that exists when this lands is on 5, which is what they were
--   being billed the minute before, and an exempt one is set to 0 on purpose
--   by an Admin. The app's own gstRateOf() reads a MISSING rate as 5 for the
--   same reason: a job cached on a tablet before this migration, or a row out
--   of an older backup, is an ordinary client, never an exempt one.
--
-- WHY A TRIGGER AND NOT A POLICY
--   clients_update is a tab test — board OR rates — and Helper holds board.
--   So as the policies stand, a Helper can already rename a client, and
--   would be able to zero their tax. A policy cannot pin a column it does not
--   name, and the row's other columns are deliberately open to the office, so
--   the guard is per-column and it is a trigger: exactly the shape
--   private.guard_job_update() already uses to keep a job's status an
--   Admin's. Money is Admin-and-Technician everywhere in this app; a tax rate
--   that decides what leaves the building is an Admin's alone.
--
-- WHAT ELSE MOVES WITH IT
--   search_tickets carries the rate out with each ticket, so the tracker and
--   the CSV export can price GST per client without a second read per row.
--   Every existing column and the null-money rule are untouched: the money
--   is still nulled for a role that may not see prices, and the rate is not
--   money — a client's tax status is not a price and every staff role that
--   can see the ticket can see it.
--
-- APPLY BEFORE DEPLOYING THE APP. The job reads join clients(name, gst_rate)
-- and the New client dialog inserts gst_rate; against a database without the
-- column both are a 42703 and the board does not load.

-- ── 1 · The column ───────────────────────────────────────────────────────
alter table public.clients
  add column if not exists gst_rate numeric(5,2) not null default 5;

-- Separate from the add so re-running the file over a half-applied state
-- still lands the constraint. 100 is the ceiling because a rate above it is
-- a typo (a "5" typed into the box after a "1" that was meant to be erased),
-- and numeric(5,2) would happily hold 999.99.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.clients'::regclass and conname = 'clients_gst_rate_range')
  then
    alter table public.clients
      add constraint clients_gst_rate_range check (gst_rate >= 0 and gst_rate <= 100);
  end if;
end $$;

comment on column public.clients.gst_rate is
  'GST charged on this client''s tickets, as a percent. 5 is Alberta''s federal rate; 0 is exempt. An Admin''s to change (private.guard_client_update).';

-- ── 2 · Only an Admin may change it ──────────────────────────────────────
-- The shape of private.guard_job_update, for the same reason: the claim_role
-- read at the top is not asking who you are, it is asking whether this is an
-- API call at all. A migration, the SQL editor and the service role (the
-- backup restore loads clients rows verbatim) are not this trigger's to
-- police — a restore that could not put a client's own tax rate back would
-- put every exempt client back on 5%.
create or replace function private.guard_client_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  claim_role text;
begin
  claim_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');
  if claim_role is null or claim_role = 'service_role' then return new; end if;
  -- coalesce, because `null is distinct from 'Admin'` is true but reads by
  -- accident: an account with no rank — deactivated, or with no profiles row
  -- behind its token — is not an Admin, and saying so out loud is what stops
  -- the next edit here from inverting it.
  if new.gst_rate is distinct from old.gst_rate
     and coalesce((select private.user_role()), '') <> 'Admin' then
    raise exception 'Only an admin can change a client''s GST rate — it decides the tax on every ticket they are sent.'
      using errcode = '42501';
  end if;
  return new;
end $$;

revoke execute on function private.guard_client_update() from public, anon, authenticated;
drop trigger if exists clients_guard_update on public.clients;
create trigger clients_guard_update before update on public.clients
  for each row execute function private.guard_client_update();

-- ── 3 · search_tickets carries the client's rate ─────────────────────────
-- The live body from 20260903095901, verbatim, with one column added at the
-- end of the record and one join column read for it. Added at the END on
-- purpose: a returns-table record is positional to anything that reads it by
-- index, and the app reads it by name.
drop function if exists public.search_tickets(text, integer, integer, text, date, date);
create function public.search_tickets(
  status_filter text default 'All', page_num integer default 0, page_size integer default 10,
  q text default '', date_from date default null, date_to date default null)
returns table(id text, work_date date, status text, total numeric, created_at timestamp with time zone,
              job_number text, project text, client_name text, technician_name text,
              chased_at timestamp with time zone, invoiced_at timestamp with time zone,
              queried_at timestamp with time zone, query_text text, query_by text,
              total_count bigint, filtered_total numeric, client_gst_rate numeric)
language sql stable set search_path to 'public' as $$
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
           coalesce(q, '') = '' as blank,
           (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]) as priced
  ),
  hit as (
    select t.id, t.work_date, t.status,
           case when esc.priced then t.total end as total,
           t.created_at, t.chased_at, t.invoiced_at,
           t.queried_at, t.query_text, t.query_by,
           j.job_number, j.project, c.name as client_name, p.name as technician_name,
           c.gst_rate as client_gst_rate
      from public.tickets t
      cross join esc
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
     where (status_filter = 'All'
            or (status_filter = 'Over 7 days' and t.status = 'Awaiting approval' and now() - t.created_at > interval '7 days')
            or t.status = status_filter)
       and (esc.blank
            or t.id ilike esc.pat or j.job_number ilike esc.pat
            or j.project ilike esc.pat or c.name ilike esc.pat or p.name ilike esc.pat)
       and (date_from is null or t.work_date >= date_from)
       and (date_to is null or t.work_date <= date_to)
  )
  select h.id, h.work_date, h.status, h.total, h.created_at, h.job_number, h.project, h.client_name,
         h.technician_name, h.chased_at, h.invoiced_at, h.queried_at, h.query_text, h.query_by,
         count(*) over () as total_count,
         -- null for roles that don't see prices: every h.total is null for them.
         sum(h.total) over () as filtered_total,
         -- Not money. A ticket whose job has no client (a job raised before
         -- the client existed) has no rate, and the app reads that absence
         -- as the ordinary 5%.
         h.client_gst_rate
    from hit h
   order by h.created_at desc, h.id desc
  offset page_num * page_size limit page_size;
$$;
revoke execute on function public.search_tickets(text, integer, integer, text, date, date) from public, anon;
grant execute on function public.search_tickets(text, integer, integer, text, date, date) to authenticated;

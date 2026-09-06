-- Applied live 6 Sept 2026 as 20260906143715 and probed as a non-owner
-- (probes-20260906143715-the-tracker-knows-how-old-the-money-is.sql).
--
-- ── What this is for ────────────────────────────────────────────────────
-- "Who owes me, and how long has it been" is the Monday-morning question,
-- and the Billing tracker could not answer it. It had one tile — "Over 7
-- days" — and a paged table you read client by client to find out that one
-- of them has four tickets from June sitting unsigned.
--
-- public.ticket_aging() answers it in one read: one row per client per age
-- bucket over every OUTSTANDING ticket, which here means a ticket that has
-- been sent to the client and has not been through — status 'Awaiting
-- approval', 'Approved' or 'Invoiced'. Drafts are not outstanding; they have
-- not been sent to anybody. There is no Paid status in this app — Invoiced is
-- as far as a ticket goes — so an invoice the client has settled stays in
-- this answer until the job is archived. That is a deliberate limit of the
-- data and not of this function: it counts what the schema knows.
--
-- The grouping is here, in the database, rather than in the browser, because
-- "every outstanding ticket" is a table of thousands and PostgREST caps a
-- response at 1,000 rows without saying so — the tracker would have been
-- adding up whatever fitted and calling it the year. The answer is one row
-- per client per bucket, which is dozens.
--
-- ── The buckets ────────────────────────────────────────────────────────
-- By the age of the ticket's WORK DATE, in Grande Prairie days:
--
--   current  0-29 days      30  30-59 days      60  60-89 days      90  90+
--
-- The work date and not created_at, because that is the day the client is
-- being billed for and the day their own accounts department will look for.
-- (The tracker's "Over 7 days" tile and its filter measure created_at, and
-- they are left exactly as they are — this is a second question, not a
-- correction of that one.)
--
-- (now() at time zone 'America/Edmonton')::date is the same day
-- equipment_stats() and search_equipment() count by, for the same reason:
-- current_date is UTC and has already rolled into tomorrow by six in the
-- evening here, so from suppertime a ticket exactly 30 days old would land
-- in a different bucket than the crew's calendar says. A work date in the
-- future — a ticket dated ahead — is a negative age and reads as current,
-- which is what the office means by it.
--
-- ── Who sees the money ─────────────────────────────────────────────────
-- The same test search_tickets and ticket_tracker_stats use, word for word:
-- Admin and Technician see prices, and everybody else gets null totals and
-- real counts. Prices are for Admins and Technicians per Kyle, and null is
-- not zero — a rollup that turned those into 0 would print "$0.00" against a
-- client owed thousands.
--
-- SECURITY INVOKER (the default, which is what ticket_tracker_stats and
-- search_tickets are): RLS on tickets is what decides which tickets a caller
-- may count, and it must stay what decides. That makes this an invoker-rights
-- function naming private.user_role(), which is parsed at call time — it
-- needs `authenticated` to hold USAGE on schema private (migration
-- 20260903055300, which granted it), and it must be probed as a non-owner
-- before it is called done. Block 4 of the probes is that probe.

create or replace function public.ticket_aging()
returns table(client_id uuid, client_name text, bucket text, tickets bigint, total numeric)
language sql
stable
security invoker
set search_path to 'public'
as $$
  -- Every column is aliased and the outer select list is positional, the way
  -- dose_totals is: the RETURNS TABLE names are parameters inside a sql
  -- body, and a bare `client_id`, `client_name` or `total` here would be
  -- ambiguous against the tables this reads.
  with priced as (
    select (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]) as ok
  ),
  today as (
    select (now() at time zone 'America/Edmonton')::date as d
  ),
  aged as (
    select j.client_id      as cid,
           c.name           as cname,
           (x.d - t.work_date) as age_days,
           t.total          as amount
      from public.tickets t
      cross join today x
      left join public.jobs j    on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
     -- Sent to the client and not yet through. Draft is not outstanding.
     where t.status = any (array['Awaiting approval'::text, 'Approved'::text, 'Invoiced'::text])
  ),
  bucketed as (
    select a.cid, a.cname, a.amount,
           -- Cast, so the bucket is text and not `unknown` waiting to be
           -- resolved by whatever reads it next.
           (case when a.age_days < 30 then 'current'
                 when a.age_days < 60 then '30'
                 when a.age_days < 90 then '60'
                 else '90'
            end)::text as bkt
      from aged a
  )
  select b.cid, b.cname, b.bkt,
         count(*),
         -- null, not 0, for a role that may not see prices — the whole
         -- column, so nothing downstream has to guess which zeros are real.
         case when (select ok from priced) then coalesce(sum(b.amount), 0) end
    from bucketed b
   group by b.cid, b.cname, b.bkt;
$$;

comment on function public.ticket_aging() is
  'Outstanding tickets — awaiting approval, approved or invoiced; there is '
  'no Paid status — grouped by client and by the age of the work date in '
  'Grande Prairie days: current, 30, 60, 90. Counts for everyone, money for '
  'Admins and Technicians. Invoker rights: RLS is what decides whose '
  'tickets are counted.';

-- The same shape every other reporting function in this schema has: the
-- default EXECUTE to public and anon comes off, authenticated keeps it.
revoke execute on function public.ticket_aging() from public, anon;
grant  execute on function public.ticket_aging() to authenticated;

-- No new index. The scan is over tickets with a status test and two left
-- joins on primary keys, and idx_tickets_status_created_id already leads
-- with status; the answer is dozens of rows however many tickets are behind
-- it. If it ever needs one, it is a partial index on the three outstanding
-- statuses — measure before adding it.

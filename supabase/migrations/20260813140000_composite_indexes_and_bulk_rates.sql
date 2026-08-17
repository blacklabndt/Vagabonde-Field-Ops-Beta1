-- Two small follow-ups.
--
-- 1. Composite indexes for the filter+sort pattern search_jobs() and
-- search_tickets() both run constantly: filter by status, order by
-- created_at desc. The single-column indexes from earlier migrations let
-- Postgres use one or the other, not both together — a composite index
-- lets it satisfy the whole query (filter + order) in one index scan.
create index if not exists idx_jobs_status_created on public.jobs (status, created_at desc);
create index if not exists idx_tickets_status_created on public.tickets (status, created_at desc);

-- 2. "Fill from default" on Rate admin used to update matching rate lines
-- one at a time (one round trip each, and — since the history trigger —
-- one history row insert each). A plain UPDATE...FROM unnest() does every
-- row in a single statement. Not an upsert: rate_lines has other required
-- columns an upsert would have to supply or risk failing; this only ever
-- updates rows that already exist.
create or replace function public.bulk_set_rate_lines(ids uuid[], rates numeric[])
returns void
language sql as $$
  update public.rate_lines rl
  set rate = v.rate
  from unnest(ids, rates) as v(id, rate)
  where rl.id = v.id;
$$;

grant execute on function public.bulk_set_rate_lines(uuid[], numeric[]) to authenticated;

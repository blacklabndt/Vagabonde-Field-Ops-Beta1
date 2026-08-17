-- Finishes what 20260815020914 started.
--
-- De-materialising the CTE made the page fetch an index-only scan — 0.1 ms for
-- ten rows. But the function still took 13 ms, and the two halves measured
-- standalone only account for 3.2 ms of that.
--
-- The gap is the predicate. Inside the function `status_filter` is a
-- parameter, not a constant, so
--
--     where status_filter = 'All' or ... or t.status = status_filter
--
-- cannot be folded away at plan time. Postgres has to evaluate the whole OR
-- chain for every row it touches, which is exactly what an index exists to
-- avoid. Measured standalone with the predicate written as a literal, the same
-- work is an order of magnitude cheaper — that difference is the parameter.
--
-- Branching in plpgsql gives each case its own plan against a sargable
-- predicate: 'All' walks the index and stops at page_size, a named status
-- seeks on (status, created_at desc, id desc), and 'Over 7 days' gets the one
-- query that genuinely has to think about it.
--
-- Ordering and results are identical — created_at desc with id as tiebreaker,
-- the same total_count on every row. Only the plan changes.

create or replace function public.search_tickets(
  status_filter text default 'All',
  page_num integer default 0,
  page_size integer default 10
)
returns table (
  id text, work_date date, status text, total numeric, created_at timestamptz,
  job_number text, project text, client_name text, technician_name text,
  total_count bigint
)
language plpgsql
stable
set search_path = public
as $$
declare
  off integer := page_num * page_size;
begin
  if status_filter = 'All' then
    return query
      select t.id, t.work_date, t.status, t.total, t.created_at,
             j.job_number, j.project, c.name, p.name,
             (select count(*) from public.tickets)
      from (select t2.id from public.tickets t2
            order by t2.created_at desc, t2.id desc
            offset off limit page_size) pg
      join public.tickets t on t.id = pg.id
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
      order by t.created_at desc, t.id desc;

  elsif status_filter = 'Over 7 days' then
    return query
      select t.id, t.work_date, t.status, t.total, t.created_at,
             j.job_number, j.project, c.name, p.name,
             (select count(*) from public.tickets tc
               where tc.status = 'Awaiting approval'
                 and now() - tc.created_at > interval '7 days')
      from (select t2.id from public.tickets t2
            where t2.status = 'Awaiting approval'
              and now() - t2.created_at > interval '7 days'
            order by t2.created_at desc, t2.id desc
            offset off limit page_size) pg
      join public.tickets t on t.id = pg.id
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
      order by t.created_at desc, t.id desc;

  else
    return query
      select t.id, t.work_date, t.status, t.total, t.created_at,
             j.job_number, j.project, c.name, p.name,
             (select count(*) from public.tickets tc where tc.status = status_filter)
      from (select t2.id from public.tickets t2
            where t2.status = status_filter
            order by t2.created_at desc, t2.id desc
            offset off limit page_size) pg
      join public.tickets t on t.id = pg.id
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
      order by t.created_at desc, t.id desc;
  end if;
end $$;

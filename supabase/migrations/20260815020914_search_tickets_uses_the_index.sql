-- The billing tracker stops sorting every ticket to show ten.
--
-- `search_tickets` built a CTE of every matching ticket, then used it twice —
-- once to count, once to sort for the page. Postgres materialises a CTE
-- referenced more than once, so at 50,000 tickets the plan was:
--
--     Seq Scan on tickets  → 50,005 rows
--     CTE materialised     → temp written=207   (spilled to disk)
--     top-N heapsort over all 50,005 rows       → to return 10
--
-- 33 ms and a temp-file spill for the first page of the tracker, growing
-- linearly with the ticket count. `search_jobs` was given this same treatment
-- in 20260814060000; tickets never got it.
--
-- Selecting the page straight from the table lets the planner walk an index in
-- order and stop after `page_size` rows. The count stays a separate scalar
-- subquery — it genuinely has to look at everything, but an index-only scan
-- over a narrow index is far cheaper than materialising the whole table.
--
-- The ordering is unchanged: created_at desc with id as the tiebreaker, which
-- is what makes paging deterministic (20260814120000). The index now carries
-- that tiebreaker too, so the order comes out of the index rather than a sort.

-- Matches the ORDER BY exactly, so it can drive it end to end.
create index if not exists idx_tickets_created_id
  on public.tickets (created_at desc, id desc);

-- Same, for the status-filtered pills.
create index if not exists idx_tickets_status_created_id
  on public.tickets (status, created_at desc, id desc);

-- Superseded by the two above, which have the same leading columns plus the
-- tiebreaker. Keeping both would be two indexes to maintain on every insert
-- for one lookup path.
drop index if exists public.idx_tickets_created_at;
drop index if exists public.idx_tickets_status_created;

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
language sql
stable
set search_path = public
as $$
  select t.id, t.work_date, t.status, t.total, t.created_at,
         j.job_number, j.project, c.name, p.name,
         (select count(*) from public.tickets tc
           where status_filter = 'All'
              or (status_filter = 'Over 7 days'
                  and tc.status = 'Awaiting approval'
                  and now() - tc.created_at > interval '7 days')
              or tc.status = status_filter)
  from (
    select t2.id
    from public.tickets t2
    where status_filter = 'All'
       or (status_filter = 'Over 7 days'
           and t2.status = 'Awaiting approval'
           and now() - t2.created_at > interval '7 days')
       or t2.status = status_filter
    order by t2.created_at desc, t2.id desc
    offset page_num * page_size
    limit page_size
  ) pg
  join public.tickets t on t.id = pg.id
  left join public.jobs j on j.id = t.job_id
  left join public.clients c on c.id = j.client_id
  left join public.profiles p on p.id = t.technician_id
  order by t.created_at desc, t.id desc;
$$;

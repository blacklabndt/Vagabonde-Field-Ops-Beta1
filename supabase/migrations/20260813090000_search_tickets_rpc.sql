-- Server-side paging for the Billing tracker — same problem, same fix as
-- Home's job list: Db.listAllTickets() fetched every ticket ever raised,
-- unbounded, every time an admin opened the tracker. At thousands of
-- tickets a year this becomes the slowest thing in the app.
--
-- Two functions: one cheap aggregate for the four summary tiles (computed
-- over the whole table, not just the visible page — those numbers are meant
-- to represent everything), and one paged/filtered list for the table itself.
create or replace function public.ticket_tracker_stats()
returns table (
  unsigned_count bigint, unsigned_total numeric,
  over7_count bigint, over7_total numeric,
  approved_count bigint, approved_total numeric,
  invoiced_count bigint, invoiced_total numeric
)
language sql stable as $$
  select
    count(*) filter (where status = 'Awaiting approval'),
    coalesce(sum(total) filter (where status = 'Awaiting approval'), 0),
    count(*) filter (where status = 'Awaiting approval' and now() - created_at > interval '7 days'),
    coalesce(sum(total) filter (where status = 'Awaiting approval' and now() - created_at > interval '7 days'), 0),
    count(*) filter (where status = 'Approved'),
    coalesce(sum(total) filter (where status = 'Approved'), 0),
    count(*) filter (where status = 'Invoiced'),
    coalesce(sum(total) filter (where status = 'Invoiced'), 0)
  from public.tickets;
$$;

grant execute on function public.ticket_tracker_stats() to authenticated;

create or replace function public.search_tickets(
  status_filter text default 'All',
  page_num int default 0,
  page_size int default 10
)
returns table (
  id text, work_date date, status text, total numeric, created_at timestamptz,
  job_number text, project text, client_name text, technician_name text, total_count bigint
)
language sql stable as $$
  with filtered as (
    select
      t.id, t.work_date, t.status, t.total, t.created_at,
      j.job_number, j.project, c.name as client_name, p.name as technician_name,
      count(*) over () as total_count
    from public.tickets t
    left join public.jobs j on j.id = t.job_id
    left join public.clients c on c.id = j.client_id
    left join public.profiles p on p.id = t.technician_id
    where status_filter = 'All'
       or (status_filter = 'Over 7 days' and t.status = 'Awaiting approval' and now() - t.created_at > interval '7 days')
       or t.status = status_filter
  )
  select id, work_date, status, total, created_at, job_number, project, client_name, technician_name, total_count
  from filtered
  order by created_at desc
  offset page_num * page_size
  limit page_size;
$$;

grant execute on function public.search_tickets(text, int, int) to authenticated;

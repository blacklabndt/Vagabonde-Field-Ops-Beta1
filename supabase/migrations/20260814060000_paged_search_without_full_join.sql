-- Paged search stops joining the whole result set to count it.
--
-- Both search RPCs computed `count(*) over ()` inside the filtered CTE — that
-- is, *after* joining jobs to clients, contractors and profiles, and *before*
-- the LIMIT. Fetching ten rows therefore dragged every matching row through
-- three joins to produce a number.
--
-- At sixty jobs that is free. At fifty thousand it is the cost of every
-- keystroke in the search box, because the board searches on a debounce and
-- each search starts at page one.
--
-- Restructured so the two questions are asked separately:
--
--   how many match?   -> counted over the driving table alone
--   which ten?        -> ordered, offset, limited, and only then joined
--
-- The joins now touch page_size rows instead of the whole match set. The
-- count still visits every matching row — an exact total has to — but it
-- reads one narrow table, and for the default "any" search it can ride the
-- GIN trigram index on jobs.search_text rather than scanning wide rows.
--
-- Behaviour is unchanged: same signature, same columns, same filters, same
-- ordering, same totals.

create or replace function public.search_jobs(
  q text default '',
  status_filter text default 'All',
  search_field text default 'any',
  page_num integer default 0,
  page_size integer default 10
)
returns table (
  id uuid, job_number text, project text, lsd text, afe text, method text,
  procedure text, status text, created_at timestamptz, client_id uuid,
  contractor_id uuid, client_name text, contractor_name text,
  created_by_name text, total_count bigint
)
language sql
stable
as $$
  with matched as (
    -- Driving table only. `search_text` is the trigger-maintained,
    -- normalised blob of project + LSD + job number + client + contractor,
    -- which is why the default search needs no join to filter.
    select j.id, j.created_at
    from public.jobs j
    where (status_filter = 'All' or j.status = status_filter)
      and (
        q = '' or
        case search_field
          when 'project'    then j.project    ilike '%' || q || '%'
          when 'lsd'        then j.lsd        ilike '%' || q || '%'
          when 'id'         then j.job_number ilike '%' || q || '%'
          -- Semi-joins rather than joins: they filter jobs without widening
          -- the row, so the count still runs over jobs alone.
          when 'client'     then exists (
                                 select 1 from public.clients c
                                 where c.id = j.client_id and c.name ilike '%' || q || '%')
          when 'contractor' then exists (
                                 select 1 from public.contractors k
                                 where k.id = j.contractor_id and k.name ilike '%' || q || '%')
          else j.search_text ilike '%' || regexp_replace(lower(q), '[^a-z0-9]', '', 'g') || '%'
        end
      )
  ),
  total as (select count(*) as n from matched),
  page as (
    select m.id from matched m
    order by m.created_at desc
    offset page_num * page_size
    limit page_size
  )
  select j.id, j.job_number, j.project, j.lsd, j.afe, j.method, j.procedure,
         j.status, j.created_at, j.client_id, j.contractor_id,
         c.name, k.name, p.name,
         (select n from total)
  from page pg
  join public.jobs j on j.id = pg.id
  left join public.clients c on c.id = j.client_id
  left join public.contractors k on k.id = j.contractor_id
  left join public.profiles p on p.id = j.created_by
  order by j.created_at desc;
$$;

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
as $$
  with matched as (
    select t.id, t.created_at
    from public.tickets t
    where status_filter = 'All'
       or (status_filter = 'Over 7 days'
           and t.status = 'Awaiting approval'
           and now() - t.created_at > interval '7 days')
       or t.status = status_filter
  ),
  total as (select count(*) as n from matched),
  page as (
    select m.id from matched m
    order by m.created_at desc
    offset page_num * page_size
    limit page_size
  )
  select t.id, t.work_date, t.status, t.total, t.created_at,
         j.job_number, j.project, c.name, p.name,
         (select n from total)
  from page pg
  join public.tickets t on t.id = pg.id
  left join public.jobs j on j.id = t.job_id
  left join public.clients c on c.id = j.client_id
  left join public.profiles p on p.id = t.technician_id
  order by t.created_at desc;
$$;

-- Paging needs a total order, not just a sort.
--
-- Both search RPCs ordered by `created_at desc` alone. That is not a total
-- order: rows sharing a timestamp can come back in any order, and OFFSET/LIMIT
-- across an unstable order repeats some rows on one page and skips others
-- entirely. A load test made it obvious — pulling every ticket in 1000-row
-- pages returned 5002 rows of which only 4980 were distinct.
--
-- It is not a synthetic problem. The offline queue replays queued tickets
-- back to back, so several land within the same instant routinely; anything
-- inserted by one statement shares a timestamp exactly.
--
-- Adding the primary key as a tiebreaker makes the order total, so a row lands
-- on exactly one page.

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
set search_path = public
as $$
  with matched as (
    select j.id, j.created_at
    from public.jobs j
    where (status_filter = 'All' or j.status = status_filter)
      and (
        q = '' or
        case search_field
          when 'project'    then j.project    ilike '%' || q || '%'
          when 'lsd'        then j.lsd        ilike '%' || q || '%'
          when 'id'         then j.job_number ilike '%' || q || '%'
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
    order by m.created_at desc, m.id desc
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
  order by j.created_at desc, j.id desc;
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
set search_path = public
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
    order by m.created_at desc, m.id desc
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
  order by t.created_at desc, t.id desc;
$$;

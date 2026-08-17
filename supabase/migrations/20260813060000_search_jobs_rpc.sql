-- Server-side search + paging for the Home jobs table.
--
-- Db.listJobs() fetched every job, joined to client/contractor/creator names,
-- on every sign-in — Home then filtered and paginated that array in the
-- browser. Harmless at a few dozen jobs; a straight line up as the job count
-- grows, on every login, before a single field is drawn.
--
-- One round trip now returns only the page shown, with the filter/search
-- done by Postgres. The normalization Home's search already relied on (LSDs
-- get written "13-22-047-05 W5M" and "1322047 05W5M" interchangeably, so both
-- sides are stripped to bare alphanumerics before comparing) is reproduced
-- here rather than dropped, so search behaves exactly as it did.
create or replace function public.search_jobs(
  q text default '',
  status_filter text default 'All',
  search_field text default 'any',
  page_num int default 0,
  page_size int default 10
)
returns table (
  id uuid, job_number text, project text, lsd text, afe text, method text, procedure text,
  status text, created_at timestamptz, client_id uuid, contractor_id uuid,
  client_name text, contractor_name text, created_by_name text, total_count bigint
)
language sql stable as $$
  with norm as (
    select
      j.id, j.job_number, j.project, j.lsd, j.afe, j.method, j.procedure,
      j.status, j.created_at, j.client_id, j.contractor_id,
      c.name as client_name, k.name as contractor_name, p.name as created_by_name,
      regexp_replace(lower(
        case search_field
          when 'project' then coalesce(j.project, '')
          when 'lsd' then coalesce(j.lsd, '')
          when 'id' then j.job_number
          when 'client' then coalesce(c.name, '')
          when 'contractor' then coalesce(k.name, '')
          else coalesce(j.project, '') || ' ' || coalesce(j.lsd, '') || ' ' || j.job_number
               || ' ' || coalesce(c.name, '') || ' ' || coalesce(k.name, '')
        end
      ), '[^a-z0-9]', '', 'g') as haystack
    from public.jobs j
    left join public.clients c on c.id = j.client_id
    left join public.contractors k on k.id = j.contractor_id
    left join public.profiles p on p.id = j.created_by
    where (status_filter = 'All' or j.status = status_filter)
  ), filtered as (
    select *, count(*) over () as total_count
    from norm
    where q = '' or haystack like '%' || regexp_replace(lower(q), '[^a-z0-9]', '', 'g') || '%'
  )
  select id, job_number, project, lsd, afe, method, procedure, status, created_at,
         client_id, contractor_id, client_name, contractor_name, created_by_name,
         coalesce(total_count, 0)
  from filtered
  order by created_at desc
  offset page_num * page_size
  limit page_size;
$$;

grant execute on function public.search_jobs(text, text, text, int, int) to authenticated;

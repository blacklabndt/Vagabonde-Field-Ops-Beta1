-- Two follow-ups to the earlier search RPCs, now that they're the pattern
-- everything else measures against: both did real work (regexp
-- normalization, a correlated subquery) per row on every call, which is
-- fine at dozens of rows and becomes the bottleneck again at thousands.

create extension if not exists pg_trgm;

-- ── Jobs: precomputed, indexed search text ──────────────────────────────
-- search_jobs()'s "any" search — the default and by far the most common
-- path — used to regexp-normalize every job (joined to client/contractor
-- names) on every call. That work now happens once, when a job or its
-- client/contractor name changes, into a stored column a trigram index can
-- actually use.
alter table public.jobs add column if not exists search_text text;

create or replace function public.jobs_refresh_search_text()
returns trigger language plpgsql as $$
begin
  new.search_text := regexp_replace(lower(
    coalesce(new.project, '') || ' ' || coalesce(new.lsd, '') || ' ' || new.job_number || ' ' ||
    coalesce((select name from public.clients where id = new.client_id), '') || ' ' ||
    coalesce((select name from public.contractors where id = new.contractor_id), '')
  ), '[^a-z0-9]', '', 'g');
  return new;
end;
$$;

drop trigger if exists jobs_search_text_biu on public.jobs;
create trigger jobs_search_text_biu
  before insert or update of project, lsd, job_number, client_id, contractor_id
  on public.jobs for each row execute function public.jobs_refresh_search_text();

-- A renamed client/contractor has to refresh every job that references it —
-- rare (renaming a company), so doing it eagerly here is the right trade,
-- not something a search query should ever have to redo.
create or replace function public.refresh_jobs_search_text_for_org()
returns trigger language plpgsql as $$
begin
  if TG_TABLE_NAME = 'clients' then
    update public.jobs set search_text = regexp_replace(lower(
      coalesce(project, '') || ' ' || coalesce(lsd, '') || ' ' || job_number || ' ' || coalesce(new.name, '') || ' ' ||
      coalesce((select name from public.contractors where id = jobs.contractor_id), '')
    ), '[^a-z0-9]', '', 'g') where client_id = new.id;
  else
    update public.jobs set search_text = regexp_replace(lower(
      coalesce(project, '') || ' ' || coalesce(lsd, '') || ' ' || job_number || ' ' ||
      coalesce((select name from public.clients where id = jobs.client_id), '') || ' ' || coalesce(new.name, '')
    ), '[^a-z0-9]', '', 'g') where contractor_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists clients_name_refresh_jobs on public.clients;
create trigger clients_name_refresh_jobs after update of name on public.clients
  for each row execute function public.refresh_jobs_search_text_for_org();

drop trigger if exists contractors_name_refresh_jobs on public.contractors;
create trigger contractors_name_refresh_jobs after update of name on public.contractors
  for each row execute function public.refresh_jobs_search_text_for_org();

-- Backfill every existing job once.
update public.jobs j set search_text = regexp_replace(lower(
  coalesce(j.project, '') || ' ' || coalesce(j.lsd, '') || ' ' || j.job_number || ' ' ||
  coalesce((select name from public.clients where id = j.client_id), '') || ' ' ||
  coalesce((select name from public.contractors where id = j.contractor_id), '')
), '[^a-z0-9]', '', 'g');

create index if not exists idx_jobs_search_text_trgm on public.jobs using gin (search_text gin_trgm_ops);

-- The "any" path now filters an indexed column instead of computing the
-- haystack per row; the narrower field pickers (project/lsd/id/client/
-- contractor) fall back to a direct ILIKE on that field, trigram-indexed
-- below, without the alnum-only normalization "any" gets — a reasonable
-- trade since picking a specific field means you're typing it as written.
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
  with base as (
    select
      j.id, j.job_number, j.project, j.lsd, j.afe, j.method, j.procedure,
      j.status, j.created_at, j.client_id, j.contractor_id,
      c.name as client_name, k.name as contractor_name, p.name as created_by_name,
      j.search_text
    from public.jobs j
    left join public.clients c on c.id = j.client_id
    left join public.contractors k on k.id = j.contractor_id
    left join public.profiles p on p.id = j.created_by
    where (status_filter = 'All' or j.status = status_filter)
  ), filtered as (
    select *, count(*) over () as total_count
    from base
    where q = '' or (
      case search_field
        when 'project' then project
        when 'lsd' then lsd
        when 'id' then job_number
        when 'client' then client_name
        when 'contractor' then contractor_name
        else search_text
      end
    ) ilike '%' || (case when search_field = 'any' then regexp_replace(lower(q), '[^a-z0-9]', '', 'g') else q end) || '%'
  )
  select id, job_number, project, lsd, afe, method, procedure, status, created_at,
         client_id, contractor_id, client_name, contractor_name, created_by_name,
         coalesce(total_count, 0)
  from filtered
  order by created_at desc
  offset page_num * page_size
  limit page_size;
$$;

create index if not exists idx_jobs_project_trgm on public.jobs using gin (project gin_trgm_ops);
create index if not exists idx_jobs_lsd_trgm on public.jobs using gin (lsd gin_trgm_ops);
create index if not exists idx_clients_name_trgm on public.clients using gin (name gin_trgm_ops);
create index if not exists idx_contractors_name_trgm on public.contractors using gin (name gin_trgm_ops);

-- ── Org directory: one join instead of a subquery per row ──────────────
-- search_org_directory() ran a correlated subquery to count each org's
-- contacts and another `exists(...)` to match on them — both re-executed
-- per org, once per page load. A left join + group by does the same work
-- once, as a single query plan.
create or replace function public.search_org_directory(
  q text default '',
  scope text default 'All',
  page_num int default 0,
  page_size int default 20
)
returns table (
  org_type text, org_id uuid, name text, agreement_ref text, contact_count bigint, total_count bigint
)
language sql stable as $$
  with orgs as (
    select 'client'::text as org_type, c.id as org_id, c.name, c.agreement_ref
    from public.clients c where scope in ('All', 'Clients')
    union all
    select 'contractor'::text, k.id, k.name, null::text
    from public.contractors k where scope in ('All', 'Contractors')
  ), joined as (
    select o.org_type, o.org_id, o.name, o.agreement_ref,
      count(ct.id) as contact_count,
      bool_or(
        q = '' or o.name ilike '%' || q || '%' or
        ct.name ilike '%' || q || '%' or ct.email ilike '%' || q || '%' or ct.phone ilike '%' || q || '%'
      ) as matched
    from orgs o
    left join public.contacts ct on ct.org_type = o.org_type and ct.org_id = o.org_id
    group by o.org_type, o.org_id, o.name, o.agreement_ref
  ), counted as (
    select *, count(*) over () as total_count from joined where matched
  )
  select org_type, org_id, name, agreement_ref, contact_count, total_count
  from counted
  order by name
  offset page_num * page_size
  limit page_size;
$$;

create index if not exists idx_contacts_org on public.contacts (org_type, org_id);
create index if not exists idx_contacts_name_trgm on public.contacts using gin (name gin_trgm_ops);
create index if not exists idx_contacts_email_trgm on public.contacts using gin (email gin_trgm_ops);

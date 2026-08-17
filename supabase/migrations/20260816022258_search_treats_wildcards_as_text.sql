-- Searching for an underscore returned every job.
--
-- The search box drops what someone types straight into an ILIKE pattern, so
-- the three characters LIKE treats as syntax — % _ \ — behaved as syntax
-- rather than as the characters they typed. Measured against the real data:
--
--   lsd field, query "_"     -> 61   (every job)
--   lsd field, query "%"     -> 61
--   lsd field, query "0_-0"  -> 19   (_ matching any character)
--   lsd field, query "06-06" ->  1   (a genuine substring, for contrast)
--
-- The third line is the one that matters. Someone typing a partial site code
-- gets nineteen unrelated jobs back and no indication why. LSDs and job
-- numbers are exactly the kind of text that carries punctuation — one job on
-- file has an LSD of P25/2-DF-\33 — so this is ordinary use, not an edge case
-- somebody has to go looking for.
--
-- Not a security hole: these are ILIKE patterns, not SQL, and row-level
-- security still decides which rows can be seen. It is a correctness bug, and
-- it makes the search quietly untrustworthy, which for a search is the same
-- thing as broken.
--
-- The 'any' branch of search_jobs is deliberately left alone. It strips the
-- query to letters and digits before matching, because search_text is stored
-- that way, so a wildcard cannot survive to be interpreted. Searching "%"
-- there is the same as searching for nothing, and returning everything is the
-- honest answer to that.
--
-- The escape is written out in both functions rather than factored into a
-- helper. Both are SECURITY INVOKER, so their bodies resolve as the signed-in
-- user, and `authenticated` has no USAGE on the private schema — that boundary
-- is deliberate (006 moved the helpers off the exposed API). A
-- private.like_escape() helper was tried first and broke every search with
-- "permission denied for schema private"; granting USAGE to save three
-- replace() calls is the wrong trade.

create or replace function public.search_jobs(
  q text default ''::text,
  status_filter text default 'All'::text,
  search_field text default 'any'::text,
  page_num integer default 0,
  page_size integer default 10
)
returns table(id uuid, job_number text, project text, lsd text, afe text, method text,
              procedure text, status text, created_at timestamp with time zone,
              client_id uuid, contractor_id uuid, client_name text, contractor_name text,
              created_by uuid, created_by_name text, total_count bigint)
language sql
stable
set search_path to 'public'
as $function$
  -- Backslash first, or it would double-escape what the other two add.
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ),
  matched as (
    select j.id, j.created_at
    from public.jobs j, esc
    where (status_filter = 'All' or j.status = status_filter)
      and (
        q = '' or
        case search_field
          when 'project'    then j.project    ilike esc.pat
          when 'lsd'        then j.lsd        ilike esc.pat
          when 'id'         then j.job_number ilike esc.pat
          when 'client'     then exists (
                                 select 1 from public.clients c
                                 where c.id = j.client_id and c.name ilike esc.pat)
          when 'contractor' then exists (
                                 select 1 from public.contractors k
                                 where k.id = j.contractor_id and k.name ilike esc.pat)
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
         c.name, k.name, j.created_by, p.name,
         (select n from total)
  from page pg
  join public.jobs j on j.id = pg.id
  left join public.clients c on c.id = j.client_id
  left join public.contractors k on k.id = j.contractor_id
  left join public.profiles p on p.id = j.created_by
  order by j.created_at desc, j.id desc;
$function$;

create or replace function public.search_org_directory(
  q text default ''::text,
  scope text default 'All'::text,
  page_num integer default 0,
  page_size integer default 20
)
returns table(org_type text, org_id uuid, name text, agreement_ref text,
              contact_count bigint, total_count bigint)
language sql
stable
set search_path to 'public'
as $function$
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ),
  orgs as (
    select 'client'::text as org_type, c.id as org_id, c.name, c.agreement_ref
    from public.clients c where scope in ('All', 'Clients')
    union all
    select 'contractor'::text, k.id, k.name, null::text
    from public.contractors k where scope in ('All', 'Contractors')
  ), joined as (
    select o.org_type, o.org_id, o.name, o.agreement_ref,
      count(ct.id) as contact_count,
      bool_or(
        q = '' or o.name ilike (select pat from esc) or
        ct.name ilike (select pat from esc) or
        ct.email ilike (select pat from esc) or
        ct.phone ilike (select pat from esc)
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
$function$;

revoke execute on function public.search_jobs(text, text, text, integer, integer) from anon, public;
grant  execute on function public.search_jobs(text, text, text, integer, integer) to authenticated;
revoke execute on function public.search_org_directory(text, text, integer, integer) from anon, public;
grant  execute on function public.search_org_directory(text, text, integer, integer) to authenticated;

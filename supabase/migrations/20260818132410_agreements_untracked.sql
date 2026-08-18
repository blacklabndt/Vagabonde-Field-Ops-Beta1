-- Agreements go untracked, per Kyle: the agreement_ref label was carried on
-- every client, shown in three places, and used by nothing. The directory
-- search returned it, so the function is rebuilt without it (a return-type
-- change needs the drop), and then the column goes.
drop function public.search_org_directory(text, text, integer, integer);

create function public.search_org_directory(
  q text default ''::text, scope text default 'All'::text,
  page_num integer default 0, page_size integer default 20)
returns table(org_type text, org_id uuid, name text, contact_count bigint, total_count bigint)
language sql stable
set search_path to 'public'
as $function$
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ),
  orgs as (
    select 'client'::text as org_type, c.id as org_id, c.name
    from public.clients c where scope in ('All', 'Clients')
    union all
    select 'contractor'::text, k.id, k.name
    from public.contractors k where scope in ('All', 'Contractors')
  ), joined as (
    select o.org_type, o.org_id, o.name,
      count(ct.id) as contact_count,
      bool_or(
        q = '' or o.name ilike (select pat from esc) or
        ct.name ilike (select pat from esc) or
        ct.email ilike (select pat from esc) or
        ct.phone ilike (select pat from esc)
      ) as matched
    from orgs o
    left join public.contacts ct on ct.org_type = o.org_type and ct.org_id = o.org_id
    group by o.org_type, o.org_id, o.name
  ), counted as (
    select *, count(*) over () as total_count from joined where matched
  )
  select org_type, org_id, name, contact_count, total_count
  from counted
  order by name
  offset page_num * page_size
  limit page_size;
$function$;

alter table public.clients drop column agreement_ref;

-- Server-side search/paging for the two remaining full-table screens
-- (Equipment, Contacts), plus indexes for the reference-data pickers
-- (Clients/Contractors) that intentionally still load in full.
--
-- Equipment and Contacts get the same treatment as jobs/tickets: a table
-- that was downloading everything on every visit now fetches one page at a
-- time, with any "computed over everything" numbers (overdue/due-soon
-- counts) done as a separate aggregate so they stay accurate regardless of
-- filter or page.
--
-- Clients/Contractors are different in kind, not just scale: every screen
-- that reads them (New job, Rate admin, the ticket contractor field) needs
-- the *whole* list because it is feeding a picker, not a browsable table —
-- paging a dropdown makes it worse, not faster. The org count here is bounded
-- by how many companies you work with, not by how much work you've done, so
-- it grows nowhere near as fast as jobs or tickets. The right fix at this
-- scale is making sure the full-list query stays index-backed as it grows,
-- not rationing which rows come back.

-- ── Equipment ────────────────────────────────────────────────────────────
create or replace function public.equipment_stats()
returns table (overdue_count bigint, due_soon_count bigint)
language sql stable as $$
  select
    count(*) filter (where calibration_due is not null and calibration_due < current_date),
    count(*) filter (where calibration_due is not null and calibration_due >= current_date and calibration_due <= current_date + 30)
  from public.equipment;
$$;

grant execute on function public.equipment_stats() to authenticated;

create or replace function public.search_equipment(
  filter_key text default 'All',
  page_num int default 0,
  page_size int default 10
)
returns table (
  id uuid, type text, serial_number text, calibration_due date, status text,
  assigned_to uuid, assigned_name text, total_count bigint
)
language sql stable as $$
  with filtered as (
    select e.id, e.type, e.serial_number, e.calibration_due, e.status, e.assigned_to, p.name as assigned_name,
      count(*) over () as total_count
    from public.equipment e
    left join public.profiles p on p.id = e.assigned_to
    where filter_key = 'All'
       or (filter_key = 'Due soon' and e.calibration_due is not null and e.calibration_due >= current_date and e.calibration_due <= current_date + 30)
       or (filter_key = 'Overdue' and e.calibration_due is not null and e.calibration_due < current_date)
       or e.type = filter_key
  )
  select * from filtered
  order by type, serial_number
  offset page_num * page_size
  limit page_size;
$$;

grant execute on function public.search_equipment(text, int, int) to authenticated;

-- ── Contacts directory ─────────────────────────────────────────────────
-- One page of organisations (clients + contractors), matched by company
-- name OR any of their people's name/email/phone — replacing the old
-- "download every contact, filter in the browser" approach. Contacts for
-- the org picked from this list are still fetched with the existing small,
-- already-scoped listContactsForOrg query.
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
  ), matched as (
    select o.*, (
      select count(*) from public.contacts ct where ct.org_type = o.org_type and ct.org_id = o.org_id
    ) as contact_count
    from orgs o
    where q = '' or o.name ilike '%' || q || '%' or exists (
      select 1 from public.contacts ct
      where ct.org_type = o.org_type and ct.org_id = o.org_id
        and (ct.name ilike '%' || q || '%' or ct.email ilike '%' || q || '%' or ct.phone ilike '%' || q || '%')
    )
  ), counted as (
    select *, count(*) over () as total_count from matched
  )
  select org_type, org_id, name, agreement_ref, contact_count, total_count
  from counted
  order by name
  offset page_num * page_size
  limit page_size;
$$;

grant execute on function public.search_org_directory(text, text, int, int) to authenticated;

-- ── Reference-data pickers: keep the full-list scan index-backed ────────
create index if not exists idx_clients_name on public.clients (name);
create index if not exists idx_contractors_name on public.contractors (name);

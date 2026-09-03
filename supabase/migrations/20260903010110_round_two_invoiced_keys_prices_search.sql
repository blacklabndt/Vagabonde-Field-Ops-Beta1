-- Round two: what the owner asked for after the deployment review.
--
-- 1. Tickets can be marked invoiced. The status, the column and the
--    tracker's filter all existed; nothing wrote them, so "approved, not
--    invoiced" grew for ever. An Admin-only RPC moves Approved → Invoiced
--    (stamping invoiced_at) and back, and the approved-ticket immutability
--    policies stay exactly as they are — this is the one door.
-- 2. Idempotent replays. A save whose response was lost on the radio used
--    to replay as a second ticket (or a second report). The client mints a
--    key per unsaved ticket/report and the unique index turns a repeat into
--    a lookup of the row that already landed.
-- 3. Prices are for Admins and Technicians. Rate cards, overrides, their
--    history and ticket lines were readable by anyone with the job tab —
--    Helpers and subcontractors included. The tab conditions stay; the role
--    is now required as well. (No Coordinator accounts exist today; a
--    Coordinator would need the role added here to price a ticket.)
-- 4. The tracker can search (ticket, job, project, client, technician) and
--    filter by work date, and "chased" is a column rather than a memory the
--    page loses on reload.
-- 5. Technicians get the Timesheets tab — the screen already showed a
--    technician their own hours; the preset simply never included it. Both
--    homes of the role→tabs table move together (data.js ROLE_PRESETS is
--    the other), and existing technician accounts are brought in line.
-- 6. Equipment can be searched by serial, type or the person it's assigned to.
--
-- Probed live with role simulation: a Helper reads 0 rate lines and 0
-- ticket lines, a Technician reads the card; marking invoiced → 42501 for a
-- Technician, 1 row each way for an Admin.

-- 1 · invoiced
create or replace function public.mark_tickets_invoiced(p_ids text[], p_invoiced boolean default true)
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare n integer;
begin
  if (select private.user_role()) is distinct from 'Admin' then
    raise exception 'Only an admin can mark a ticket invoiced.' using errcode = '42501';
  end if;
  if p_invoiced then
    update public.tickets set status = 'Invoiced', invoiced_at = now()
     where id = any(p_ids) and status = 'Approved' and approved_at is not null;
  else
    update public.tickets set status = 'Approved', invoiced_at = null
     where id = any(p_ids) and status = 'Invoiced';
  end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.mark_tickets_invoiced(text[], boolean) from public, anon;
grant execute on function public.mark_tickets_invoiced(text[], boolean) to authenticated;

-- 2 · idempotency keys
alter table public.tickets add column if not exists client_key uuid;
create unique index if not exists tickets_client_key_key on public.tickets (client_key) where client_key is not null;
alter table public.reports add column if not exists client_key uuid;
create unique index if not exists reports_client_key_key on public.reports (client_key) where client_key is not null;

-- 3 · prices
drop policy if exists rate_lines_select on public.rate_lines;
create policy rate_lines_select on public.rate_lines for select to authenticated
  using ((select private.user_role()) in ('Admin', 'Technician')
         and (select private.has_any_tab('rates', 'ticket', 'job')));
drop policy if exists rate_overrides_select on public.rate_overrides;
create policy rate_overrides_select on public.rate_overrides for select to authenticated
  using ((select private.user_role()) in ('Admin', 'Technician')
         and (select private.has_any_tab('rates', 'job')));
drop policy if exists "rate line history read" on public.rate_line_history;
create policy "rate line history read" on public.rate_line_history for select to authenticated
  using ((select private.user_role()) in ('Admin', 'Technician')
         and (select private.has_any_tab('rates', 'ticket', 'job')));
drop policy if exists ticket_lines_select on public.ticket_lines;
create policy ticket_lines_select on public.ticket_lines for select to authenticated
  using ((select private.user_role()) in ('Admin', 'Technician')
         and (select private.has_any_tab('ticket', 'job', 'tracker')));

-- 4 · the tracker's search, dates and chased flag
alter table public.tickets add column if not exists chased_at timestamp with time zone;
drop function if exists public.search_tickets(text, integer, integer);
create or replace function public.search_tickets(
  status_filter text default 'All', page_num integer default 0, page_size integer default 10,
  q text default '', date_from date default null, date_to date default null)
returns table(id text, work_date date, status text, total numeric, created_at timestamp with time zone,
              job_number text, project text, client_name text, technician_name text,
              chased_at timestamp with time zone, invoiced_at timestamp with time zone, total_count bigint)
language sql stable set search_path to 'public' as $$
  with hit as (
    select t.id, t.work_date, t.status, t.total, t.created_at, t.chased_at, t.invoiced_at,
           j.job_number, j.project, c.name as client_name, p.name as technician_name
      from public.tickets t
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
     where (status_filter = 'All'
            or (status_filter = 'Over 7 days' and t.status = 'Awaiting approval' and now() - t.created_at > interval '7 days')
            or t.status = status_filter)
       and (coalesce(q, '') = ''
            or t.id ilike '%' || q || '%' or j.job_number ilike '%' || q || '%'
            or j.project ilike '%' || q || '%' or c.name ilike '%' || q || '%' or p.name ilike '%' || q || '%')
       and (date_from is null or t.work_date >= date_from)
       and (date_to is null or t.work_date <= date_to)
  )
  select h.id, h.work_date, h.status, h.total, h.created_at, h.job_number, h.project, h.client_name,
         h.technician_name, h.chased_at, h.invoiced_at, count(*) over () as total_count
    from hit h
   order by h.created_at desc, h.id desc
  offset page_num * page_size limit page_size;
$$;

-- 5 · technicians see their own hours
create or replace function public.tabs_for_role(_role text) returns text[]
language sql immutable set search_path to 'public' as $$
  select case _role
    when 'Admin'       then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','rates','tracker','users','mail','chat']
    when 'Coordinator' then array['board','job','jha','upload','ticket','mytickets','files','contacts','equipment','timesheets','tracker','chat']
    when 'Helper'      then array['board','job','jha','files','contacts','chat']
    when 'Technician'  then array['board','job','jha','upload','ticket','mytickets','files','contacts','timesheets','chat']
    -- Any role this function has not been taught yet still gets a working
    -- account rather than a failed signup.
    else array['board','job','files','contacts']
  end;
$$;
update public.profiles set tab_access = array_append(tab_access, 'timesheets')
 where role = 'Technician' and not ('timesheets' = any(tab_access));

-- 6 · equipment search
drop function if exists public.search_equipment(text, integer, integer);
create or replace function public.search_equipment(filter_key text default 'All', page_num integer default 0, page_size integer default 10, search text default '')
returns table(id uuid, type text, serial_number text, calibration_due date, status text, assigned_to uuid, assigned_name text, total_count bigint)
language sql stable set search_path to 'public' as $$
  with filtered as (
    select e.id, e.type, e.serial_number, e.calibration_due, e.status, e.assigned_to, p.name as assigned_name,
      count(*) over () as total_count
    from public.equipment e
    left join public.profiles p on p.id = e.assigned_to
    where (filter_key = 'All'
       or (filter_key = 'Due soon' and e.calibration_due is not null and e.calibration_due >= current_date and e.calibration_due <= current_date + 30)
       or (filter_key = 'Overdue' and e.calibration_due is not null and e.calibration_due < current_date)
       or e.type = filter_key)
      and (coalesce(search, '') = ''
       or e.serial_number ilike '%' || search || '%'
       or e.type ilike '%' || search || '%'
       or p.name ilike '%' || search || '%')
  )
  select * from filtered
  order by type, serial_number
  offset page_num * page_size
  limit page_size;
$$;

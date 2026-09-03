-- Round three: the seams the second review found.
--
-- 1 · The approval plumbing on tickets is the service role's to write.
--     The UPDATE policy's WITH CHECK pins the approval columns, but a
--     policy cannot pin what it does not name, and approval_token,
--     approval_sent_at/expires_at/sent_to/sent_by were unnamed: a technician
--     could plant a token hash on their own draft and sign it from the link.
--     Column-level grants, as jhas already has — the editor writes five
--     columns and gets exactly those. Withdrawing an approval (which nulls
--     the token) moves into a definer RPC.
-- 2 · Billing lines are written only by the roles that can read them: a
--     Coordinator's save read zero lines under the price policy and then
--     replaced the ticket's real lines with nothing.
-- 3 · Rate writes carry the same role test as rate reads.
-- 4 · Totals follow the price rule too: the tracker's sums and search
--     results return null money to roles that cannot see prices.
-- 5 · Search patterns escape LIKE metacharacters (a trailing backslash was
--     a 500), and the search RPCs are not callable anonymously.
-- 6 · Reads that were open to any signed-in account now need a tab, so a
--     locked account's unexpired token reads nothing.
-- 7 · jhas.client_key — the same idempotency key tickets and reports have.
-- 8 · Housekeeping: jobs.status default satisfies its own check; the
--     ticket_lines order has an index; stored_role is called once per
--     statement.

-- ── 1 · tickets: the editor's columns, and nothing else ──────────────────
revoke update on public.tickets from anon, authenticated;
grant update (status, client_contact, contractor_contact, delays, chased_at)
  on public.tickets to authenticated;

drop policy if exists "tickets insert" on public.tickets;
create policy "tickets insert" on public.tickets
  for insert to authenticated
  with check (
    (select is_staff())
    and (technician_id = (select auth.uid())
         or (select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text]))
    and status = 'Draft'
    and total = 0
    and approved_at is null and approved_by_email is null and approved_ip is null
    and approved_signature is null
    and approval_token is null and approval_sent_at is null and approval_expires_at is null
    and approval_sent_to is null and approval_sent_by is null
    and invoiced_at is null and chased_at is null
  );

create or replace function public.withdraw_ticket_approval(p_id text)
returns integer
language plpgsql security definer set search_path to 'public' as $$
declare
  n integer;
begin
  if not (select is_staff()) or not private.can_write_ticket(p_id) then
    return 0;
  end if;
  update public.tickets
     set status = 'Draft', approval_token = null, approval_sent_at = null,
         approval_expires_at = null, approval_sent_to = null, approval_sent_by = null
   where id = p_id and status = 'Awaiting approval' and approved_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.withdraw_ticket_approval(text) from public, anon;
grant execute on function public.withdraw_ticket_approval(text) to authenticated;

-- ── 2 · ticket_lines: written by the roles that can read them ────────────
drop policy if exists ticket_lines_write on public.ticket_lines;
create policy ticket_lines_write on public.ticket_lines
  for insert to authenticated
  with check ((select private.can_write_ticket(ticket_id))
              and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));
drop policy if exists ticket_lines_delete on public.ticket_lines;
create policy ticket_lines_delete on public.ticket_lines
  for delete to authenticated
  using ((select private.can_write_ticket(ticket_id))
         and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));

-- ── 3 · rate writes carry the price role ─────────────────────────────────
drop policy if exists rate_lines_write on public.rate_lines;
create policy rate_lines_write on public.rate_lines
  for insert to authenticated
  with check ((select private.has_any_tab('rates'))
              and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));
drop policy if exists rate_lines_update on public.rate_lines;
create policy rate_lines_update on public.rate_lines
  for update to authenticated
  using ((select private.has_any_tab('rates'))
         and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]))
  with check ((select private.has_any_tab('rates'))
              and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));
drop policy if exists rate_lines_delete on public.rate_lines;
create policy rate_lines_delete on public.rate_lines
  for delete to authenticated
  using ((select private.has_any_tab('rates'))
         and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));

drop policy if exists rate_overrides_insert on public.rate_overrides;
create policy rate_overrides_insert on public.rate_overrides
  for insert to authenticated
  with check ((select private.has_any_tab('rates'))
              and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));
drop policy if exists rate_overrides_update on public.rate_overrides;
create policy rate_overrides_update on public.rate_overrides
  for update to authenticated
  using ((select private.has_any_tab('rates')) and not locked
         and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]))
  with check ((select private.has_any_tab('rates'))
              and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));
drop policy if exists rate_overrides_delete on public.rate_overrides;
create policy rate_overrides_delete on public.rate_overrides
  for delete to authenticated
  using ((select private.has_any_tab('rates')) and not locked
         and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));

drop policy if exists rate_schedules_write on public.rate_schedules;
create policy rate_schedules_write on public.rate_schedules
  for insert to authenticated
  with check ((select private.has_any_tab('rates'))
              and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));
drop policy if exists rate_schedules_update on public.rate_schedules;
create policy rate_schedules_update on public.rate_schedules
  for update to authenticated
  using ((select private.has_any_tab('rates'))
         and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]))
  with check ((select private.has_any_tab('rates'))
              and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));
drop policy if exists rate_schedules_delete on public.rate_schedules;
create policy rate_schedules_delete on public.rate_schedules
  for delete to authenticated
  using ((select private.has_any_tab('rates'))
         and (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]));

-- ── 4 · totals follow the price rule; 5 · escaped search, no anon ────────
create or replace function public.ticket_tracker_stats()
returns table(unsigned_count bigint, unsigned_total numeric, over7_count bigint, over7_total numeric,
              approved_count bigint, approved_total numeric, invoiced_count bigint, invoiced_total numeric)
language sql stable set search_path to 'public' as $$
  -- One row always, even with no tickets: the flag is a scalar subquery,
  -- not a join, so the aggregate keeps its no-GROUP-BY single row.
  with priced as (
    select (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]) as ok
  )
  select
    count(*) filter (where status = 'Awaiting approval'),
    case when (select ok from priced) then coalesce(sum(total) filter (where status = 'Awaiting approval'), 0) end,
    count(*) filter (where status = 'Awaiting approval' and now() - created_at > interval '7 days'),
    case when (select ok from priced) then coalesce(sum(total) filter (where status = 'Awaiting approval' and now() - created_at > interval '7 days'), 0) end,
    count(*) filter (where status = 'Approved'),
    case when (select ok from priced) then coalesce(sum(total) filter (where status = 'Approved'), 0) end,
    count(*) filter (where status = 'Invoiced'),
    case when (select ok from priced) then coalesce(sum(total) filter (where status = 'Invoiced'), 0) end
  from public.tickets;
$$;

create or replace function public.search_tickets(
  status_filter text default 'All', page_num integer default 0, page_size integer default 10,
  q text default '', date_from date default null, date_to date default null)
returns table(id text, work_date date, status text, total numeric, created_at timestamp with time zone,
              job_number text, project text, client_name text, technician_name text,
              chased_at timestamp with time zone, invoiced_at timestamp with time zone, total_count bigint)
language sql stable set search_path to 'public' as $$
  with esc as (
    select '%' || replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
           coalesce(q, '') = '' as blank,
           (select private.user_role()) = any (array['Admin'::text, 'Technician'::text]) as priced
  ),
  hit as (
    select t.id, t.work_date, t.status,
           case when esc.priced then t.total end as total,
           t.created_at, t.chased_at, t.invoiced_at,
           j.job_number, j.project, c.name as client_name, p.name as technician_name
      from public.tickets t
      cross join esc
      left join public.jobs j on j.id = t.job_id
      left join public.clients c on c.id = j.client_id
      left join public.profiles p on p.id = t.technician_id
     where (status_filter = 'All'
            or (status_filter = 'Over 7 days' and t.status = 'Awaiting approval' and now() - t.created_at > interval '7 days')
            or t.status = status_filter)
       and (esc.blank
            or t.id ilike esc.pat or j.job_number ilike esc.pat
            or j.project ilike esc.pat or c.name ilike esc.pat or p.name ilike esc.pat)
       and (date_from is null or t.work_date >= date_from)
       and (date_to is null or t.work_date <= date_to)
  )
  select h.id, h.work_date, h.status, h.total, h.created_at, h.job_number, h.project, h.client_name,
         h.technician_name, h.chased_at, h.invoiced_at, count(*) over () as total_count
    from hit h
   order by h.created_at desc, h.id desc
  offset page_num * page_size limit page_size;
$$;

create or replace function public.search_equipment(filter_key text default 'All', page_num integer default 0, page_size integer default 10, search text default '')
returns table(id uuid, type text, serial_number text, calibration_due date, status text, assigned_to uuid, assigned_name text, total_count bigint)
language sql stable set search_path to 'public' as $$
  with esc as (
    select '%' || replace(replace(replace(coalesce(search, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat,
           coalesce(search, '') = '' as blank
  ),
  filtered as (
    select e.id, e.type, e.serial_number, e.calibration_due, e.status, e.assigned_to, p.name as assigned_name,
      count(*) over () as total_count
    from public.equipment e
    cross join esc
    left join public.profiles p on p.id = e.assigned_to
    where (filter_key = 'All'
       or (filter_key = 'Due soon' and e.calibration_due is not null and e.calibration_due >= current_date and e.calibration_due <= current_date + 30)
       or (filter_key = 'Overdue' and e.calibration_due is not null and e.calibration_due < current_date)
       or e.type = filter_key)
      and (esc.blank
       or e.serial_number ilike esc.pat
       or e.type ilike esc.pat
       or p.name ilike esc.pat)
  )
  select * from filtered
  order by type, serial_number
  offset page_num * page_size
  limit page_size;
$$;

revoke execute on function public.search_tickets(text, integer, integer, text, date, date) from public, anon;
grant execute on function public.search_tickets(text, integer, integer, text, date, date) to authenticated;
revoke execute on function public.search_equipment(text, integer, integer, text) from public, anon;
grant execute on function public.search_equipment(text, integer, integer, text) to authenticated;
revoke execute on function public.search_org_directory(text, text, integer, integer) from public, anon;
grant execute on function public.search_org_directory(text, text, integer, integer) to authenticated;

-- ── 6 · a locked account's leftover token reads nothing ──────────────────
drop policy if exists "contacts read" on public.contacts;
create policy "contacts read" on public.contacts
  for select to authenticated using ((select is_staff()));
drop policy if exists "equipment select" on public.equipment;
create policy "equipment select" on public.equipment
  for select to authenticated using ((select is_staff()));
drop policy if exists "timesheet approvals read" on public.timesheet_approvals;
create policy "timesheet approvals read" on public.timesheet_approvals
  for select to authenticated using ((select is_staff()));
drop policy if exists "arcade read" on public.arcade_scores;
create policy "arcade read" on public.arcade_scores
  for select to authenticated using ((select is_staff()));

-- ── 7 · jhas.client_key ──────────────────────────────────────────────────
alter table public.jhas add column if not exists client_key uuid;
create unique index if not exists jhas_client_key_key on public.jhas (client_key) where client_key is not null;

-- ── 8 · housekeeping ─────────────────────────────────────────────────────
alter table public.jobs alter column status set default 'Active';
create index if not exists idx_ticket_lines_ticket_order on public.ticket_lines (ticket_id, line_order);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (
    (select private.has_any_tab('users'))
    and not (id = (select auth.uid()) and not ('users' = any (tab_access)))
  )
  with check (
    (select private.has_any_tab('users'))
    and not (id = (select auth.uid()) and not ('users' = any (tab_access)))
    and (role = (select private.stored_role(id)) or (select private.user_role()) = 'Admin')
  );

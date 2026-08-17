-- The RLS helpers were being called once per row. Now they are called once
-- per query.
--
-- 20260814040000 cut three has_tab() calls down to one has_any_tab(). That was
-- the smaller half of the problem. The plan showed the rest:
--
--     Seq Scan on public.rate_lines  (rows=152)
--       Filter: private.has_any_tab(VARIADIC '{rates,ticket,job}')
--
-- A Filter, not an InitPlan — so the function ran 152 times for a query that
-- returns one number. Postgres will not inline a SECURITY DEFINER function,
-- and a bare STABLE call with constant arguments is not hoisted out of a
-- filter; only a scalar subquery becomes an InitPlan evaluated once. It is
-- exactly the reason Supabase's own advice is to write `(select auth.uid())`
-- rather than `auth.uid()`, and it applies with far more force to a helper
-- that reads a table.
--
-- So every policy below wraps its helper call in `(select ...)`. Same access,
-- same helpers — evaluated once per statement instead of once per row.
--
-- This is what was really behind `profiles` being the busiest table in the
-- database: not one lookup per query, but three per row.

-- clients
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select using ((select private.has_any_tab('board', 'job', 'rates')));
drop policy if exists clients_write on public.clients;
create policy clients_write on public.clients
  for all using ((select private.has_any_tab('board', 'rates')))
  with check ((select private.has_any_tab('board', 'rates')));

-- contractors
drop policy if exists contractors_select on public.contractors;
create policy contractors_select on public.contractors
  for select using ((select private.has_any_tab('board', 'job')));
drop policy if exists contractors_write on public.contractors;
create policy contractors_write on public.contractors
  for all using ((select private.has_any_tab('board')))
  with check ((select private.has_any_tab('board')));

-- jobs
drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs
  for select using ((select private.has_any_tab('board', 'job')));
drop policy if exists jobs_insert on public.jobs;
create policy jobs_insert on public.jobs
  for insert with check ((select private.has_any_tab('board')));
drop policy if exists jobs_update on public.jobs;
create policy jobs_update on public.jobs
  for update using ((select private.has_any_tab('job', 'board')));

-- reports
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports
  for select using ((select private.has_any_tab('upload', 'job')));
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert with check ((select private.has_any_tab('upload', 'job')));

-- rate_lines
drop policy if exists rate_lines_select on public.rate_lines;
create policy rate_lines_select on public.rate_lines
  for select using ((select private.has_any_tab('rates', 'ticket', 'job')));
drop policy if exists rate_lines_write on public.rate_lines;
create policy rate_lines_write on public.rate_lines
  for insert with check ((select private.has_any_tab('rates')));
drop policy if exists rate_lines_update on public.rate_lines;
create policy rate_lines_update on public.rate_lines
  for update using ((select private.has_any_tab('rates')));
drop policy if exists rate_lines_delete on public.rate_lines;
create policy rate_lines_delete on public.rate_lines
  for delete using ((select private.has_any_tab('rates')));

-- rate_schedules
drop policy if exists rate_schedules_select on public.rate_schedules;
create policy rate_schedules_select on public.rate_schedules
  for select using ((select private.has_any_tab('rates', 'ticket', 'job')));
drop policy if exists rate_schedules_write on public.rate_schedules;
create policy rate_schedules_write on public.rate_schedules
  for insert with check ((select private.has_any_tab('rates')));
drop policy if exists rate_schedules_update on public.rate_schedules;
create policy rate_schedules_update on public.rate_schedules
  for update using ((select private.has_any_tab('rates')));
drop policy if exists rate_schedules_delete on public.rate_schedules;
create policy rate_schedules_delete on public.rate_schedules
  for delete using ((select private.has_any_tab('rates')));

-- rate_overrides — `not locked` is per row and stays per row; only the tab
-- check is hoisted.
drop policy if exists rate_overrides_select on public.rate_overrides;
create policy rate_overrides_select on public.rate_overrides
  for select using ((select private.has_any_tab('rates', 'job')));
drop policy if exists rate_overrides_write on public.rate_overrides;
create policy rate_overrides_write on public.rate_overrides
  for all using ((select private.has_any_tab('rates')) and not locked)
  with check ((select private.has_any_tab('rates')));

-- ticket_lines — the approved_at guard is per row by necessity.
drop policy if exists ticket_lines_select on public.ticket_lines;
create policy ticket_lines_select on public.ticket_lines
  for select using ((select private.has_any_tab('ticket', 'job', 'tracker')));
drop policy if exists ticket_lines_write on public.ticket_lines;
create policy ticket_lines_write on public.ticket_lines
  for insert with check (
    exists (select 1 from public.tickets t where t.id = ticket_lines.ticket_id and t.approved_at is null)
    and (select private.has_any_tab('ticket', 'job'))
  );
drop policy if exists ticket_lines_delete on public.ticket_lines;
create policy ticket_lines_delete on public.ticket_lines
  for delete to authenticated using (
    exists (select 1 from public.tickets t where t.id = ticket_lines.ticket_id and t.approved_at is null)
    and (select private.has_any_tab('ticket', 'job'))
  );

-- audit_log
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select using ((select private.has_any_tab('users', 'rates')));

-- profiles — `tab_access` and `id` are the target row's columns and stay
-- per row; only the caller's own permission is hoisted.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check ((select private.has_any_tab('users')));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (
    (select private.has_any_tab('users'))
    and not (id = (select auth.uid()) and not ('users' = any (tab_access)))
  );
drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete using ((select private.has_any_tab('users')) and id <> (select auth.uid()));

-- equipment
drop policy if exists "equipment write" on public.equipment;
create policy "equipment write" on public.equipment
  for all to authenticated
  using ((select private.has_any_tab('equipment')) and (select private.user_role()) in ('Admin', 'Coordinator'))
  with check ((select private.has_any_tab('equipment')) and (select private.user_role()) in ('Admin', 'Coordinator'));

-- ticket_crew
drop policy if exists "crew write" on public.ticket_crew;
create policy "crew write" on public.ticket_crew
  for all to authenticated
  using ((select private.has_any_tab('ticket', 'timesheets')))
  with check ((select private.has_any_tab('ticket', 'timesheets')));

-- timesheet_approvals
drop policy if exists "timesheet approvals write" on public.timesheet_approvals;
create policy "timesheet approvals write" on public.timesheet_approvals
  for all to authenticated
  using ((select private.has_any_tab('timesheets')))
  with check ((select private.has_any_tab('timesheets')));

-- tickets and jhas call is_staff(), which reads the same profile.
drop policy if exists "tickets select" on public.tickets;
create policy "tickets select" on public.tickets
  for select to authenticated using ((select public.is_staff()));
drop policy if exists "tickets insert" on public.tickets;
create policy "tickets insert" on public.tickets
  for insert to authenticated with check ((select public.is_staff()));
drop policy if exists "tickets update" on public.tickets;
create policy "tickets update" on public.tickets
  for update to authenticated
  using ((select public.is_staff()) and approved_at is null and status not in ('Approved', 'Invoiced'))
  with check ((select public.is_staff()));
drop policy if exists "tickets delete" on public.tickets;
create policy "tickets delete" on public.tickets
  for delete to authenticated
  using ((select public.is_staff()) and approved_at is null and status not in ('Approved', 'Invoiced'));

drop policy if exists "jhas insert" on public.jhas;
create policy "jhas insert" on public.jhas
  for insert to authenticated with check ((select public.is_staff()));
drop policy if exists "jhas update" on public.jhas;
create policy "jhas update" on public.jhas
  for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

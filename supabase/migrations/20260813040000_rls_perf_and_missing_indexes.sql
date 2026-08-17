-- Database performance: the two items Supabase's advisors flagged as
-- INFO/WARN (see README "Known gaps") — none of it matters yet at this app's
-- scale, but it's cheap to fix now while the schema is fresh.
--
-- 1. auth.uid() re-evaluated per row in RLS policies. Postgres treats a bare
--    auth.uid() call inside a policy as volatile-per-row even though the
--    signed-in user can't change mid-query — wrapping it in a subquery,
--    `(select auth.uid())`, lets the planner evaluate it once (an InitPlan)
--    instead of once per row scanned. has_tab() is the fix that matters most:
--    it's called from nearly every write policy in the app.
create or replace function public.has_tab(_tab text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and _tab = any (p.tab_access)
  );
$$;

drop policy if exists "equipment write" on public.equipment;
create policy "equipment write" on public.equipment for all to authenticated
  using (public.has_tab('equipment') and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('Admin', 'Coordinator')))
  with check (public.has_tab('equipment') and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('Admin', 'Coordinator')));

-- 2. A handful of foreign keys with no supporting index — everything else
-- was covered in 20260813000000_search_indexes.sql. These are the ones that
-- migration missed: joins to profiles that db.js actually performs
-- (technician on a ticket, who filed a JHA, who created a job, who approved
-- a timesheet) and the equipment assignment lookup the JHA screen queries.
create index if not exists idx_tickets_technician_id on public.tickets (technician_id);
create index if not exists idx_jobs_created_by on public.jobs (created_by);
create index if not exists idx_jhas_signed_by on public.jhas (signed_by);
create index if not exists idx_equipment_assigned_to on public.equipment (assigned_to);
create index if not exists idx_timesheet_approvals_approved_by on public.timesheet_approvals (approved_by);

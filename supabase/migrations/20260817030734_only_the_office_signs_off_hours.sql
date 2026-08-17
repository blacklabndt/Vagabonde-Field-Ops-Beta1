-- The Approve button is admin-only; the table it writes was not.
--
-- timesheet_approvals gated its writes on holding the timesheets tab, and
-- every technician and helper holds that tab -- it is how they see their
-- own hours. The screen's comment says approval is a control and signing
-- off your own hours is not one; the policy disagreed, and a helper could
-- have approved their own period straight through the API. The gate is now
-- the role the button already checks.
--
-- Reads stay open to anyone signed in: the "Approved" tag on your own
-- timesheet is information you are entitled to.

drop policy if exists "timesheet_approvals_insert" on public.timesheet_approvals;
drop policy if exists "timesheet_approvals_update" on public.timesheet_approvals;
drop policy if exists "timesheet_approvals_delete" on public.timesheet_approvals;

create policy "timesheet_approvals_insert" on public.timesheet_approvals
  for insert to authenticated
  with check ((select private.user_role()) = 'Admin');

create policy "timesheet_approvals_update" on public.timesheet_approvals
  for update to authenticated
  using ((select private.user_role()) = 'Admin')
  with check ((select private.user_role()) = 'Admin');

create policy "timesheet_approvals_delete" on public.timesheet_approvals
  for delete to authenticated
  using ((select private.user_role()) = 'Admin');

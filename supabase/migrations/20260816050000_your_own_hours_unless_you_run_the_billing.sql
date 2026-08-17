-- A helper can read the whole crew's hours. Now they read their own.
--
-- ticket_crew's select policy was "anyone holding ticket, job, tracker or
-- timesheets", which is right for the first three and too broad for the last.
-- The timesheets tab exists so somebody can look at their own hours; it was
-- also handing them everybody else's, and not only on screen — these rows are
-- readable straight from the API, so removing the crew list from the page
-- would have changed what is displayed and nothing about what is reachable.
--
-- Measured before: Bob Joe, a Helper whose tabs are board, files, timesheets
-- and contacts, could read every crew row in the table.
--
-- The split is by what the rows are being used for:
--
--   ticket, job, tracker  the crew block on a ticket, on the client's invoice
--                         and on the billing tracker. These need everybody's
--                         rows and belong to people running the work.
--
--   anyone else           their own rows only, which is what a timesheet is.
--
-- A technician keeps full visibility because the billing screen shows who else
-- was on the truck and their hours; that is the ticket, not a timesheet. What
-- changes is that holding `timesheets` alone no longer opens the whole crew.

drop policy if exists "crew read" on public.ticket_crew;
create policy "crew read" on public.ticket_crew
  for select to authenticated
  using (
    (select private.has_any_tab('ticket', 'job', 'tracker'))
    or profile_id = (select auth.uid())
  );

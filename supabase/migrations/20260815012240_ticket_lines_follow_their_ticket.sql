-- A ticket's lines have to be writable by whoever can write the ticket.
--
-- They were not, and the split was invisible. The three tables that make up a
-- billing ticket each gated writes differently:
--
--   tickets       is_staff() and (own ticket or Admin/Coordinator) — no tab gate
--   ticket_crew   has_any_tab('ticket','timesheets')
--   ticket_lines  ...and has_any_tab('ticket','job')
--
-- So an admin holding 'board', 'tracker', 'timesheets' and 'mytickets' — which
-- is what the Admin preset actually grants — could create the ticket, write
-- its total, and save its crew, but every line insert was refused by RLS.
--
-- The failure mode is the worst kind. updateTicket writes the total first and
-- the lines second, so the ticket lands showing a dollar figure with nothing
-- itemising it. Every ticket in the database was in that state: totals, no
-- lines. Nobody saw a red banner on the common path either, because the screen
-- reports a line failure as "saved, but the approval email didn't go out".
--
-- The fix is to stop giving the child rows a tab vocabulary of their own. What
-- a ticket's lines are is not a separate permission from the ticket: if you may
-- write the ticket, you may write what is on it. Reaching a ticket at all is
-- already gated by the tab that shows it.
--
-- The parts worth keeping are kept:
--   * approved_at is null  — an approved ticket is what the client agreed to
--                            pay and stays immutable. This is the guard that
--                            was restored once already; it does not move.
--   * own ticket or Admin/Coordinator — a technician can see another
--                            technician's bill but not edit it.
--
-- SELECT is untouched: reading a line is fine for anyone who can see the
-- ticket, including the tracker.

-- The same predicate for both write directions. updateTicket replaces lines
-- wholesale (delete then insert), so a mismatch between the two would leave a
-- ticket that can be emptied but not refilled.
create or replace function private.can_write_ticket(t_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tickets t
    where t.id = t_id
      and t.approved_at is null
      and (
        t.technician_id = (select auth.uid())
        or (select private.user_role()) = any (array['Admin', 'Coordinator'])
      )
  );
$$;

revoke all on function private.can_write_ticket(text) from public;
grant execute on function private.can_write_ticket(text) to authenticated;

drop policy if exists ticket_lines_write on public.ticket_lines;
drop policy if exists ticket_lines_delete on public.ticket_lines;

create policy ticket_lines_write on public.ticket_lines
  for insert to authenticated
  with check ((select private.can_write_ticket(ticket_id)));

create policy ticket_lines_delete on public.ticket_lines
  for delete to authenticated
  using ((select private.can_write_ticket(ticket_id)));

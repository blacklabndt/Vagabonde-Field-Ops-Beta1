-- The "hide a tab only hides its menu shortcut" fix from a couple of steps
-- back only touched the client's navigation gate. The tickets table's own
-- write policy still checks has_tab('ticket') on the technician's profile,
-- so the moment that tab is hidden the *database* still refuses the insert —
-- which is exactly the "create a ticket from the job screen" error just
-- reported. Ticket creation is core field work reached from the job, not
-- from the tab menu; it must not depend on that tab being visible.
drop policy if exists "tickets write" on public.tickets;
create policy "tickets write" on public.tickets for all to authenticated
  using (true)
  with check (true);

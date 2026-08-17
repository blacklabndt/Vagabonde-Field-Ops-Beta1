-- The last six FOR ALL policies, split into the commands they mean.
--
-- The README already says never to write FOR ALL, and it says so because this
-- project has been bitten by it: a FOR ALL policy added to relax tab gating
-- silently ORed away the `approved_at is null` condition that made approved
-- tickets immutable. 20260814010000 fixed that one table. Six were missed.
--
-- Permissive policies OR together, so a FOR ALL policy participates in every
-- command including SELECT — which is why the linter reports these as
-- duplicate SELECT policies. The cost is a second predicate evaluated on
-- every read; the hazard is that the widest policy on the table silently sets
-- the floor for all four commands.
--
-- Same access as before on five of them: the expressions are copied across
-- unchanged, just bound to the command each was meant for. ticket_crew is the
-- exception, below.

-- ── clients ──────────────────────────────────────────────────────────────
drop policy if exists clients_write on public.clients;
create policy clients_insert on public.clients for insert to authenticated
  with check ((select private.has_any_tab('board', 'rates')));
create policy clients_update on public.clients for update to authenticated
  using ((select private.has_any_tab('board', 'rates')))
  with check ((select private.has_any_tab('board', 'rates')));
create policy clients_delete on public.clients for delete to authenticated
  using ((select private.has_any_tab('board', 'rates')));

-- ── contractors ──────────────────────────────────────────────────────────
drop policy if exists contractors_write on public.contractors;
create policy contractors_insert on public.contractors for insert to authenticated
  with check ((select private.has_any_tab('board')));
create policy contractors_update on public.contractors for update to authenticated
  using ((select private.has_any_tab('board')))
  with check ((select private.has_any_tab('board')));
create policy contractors_delete on public.contractors for delete to authenticated
  using ((select private.has_any_tab('board')));

-- ── equipment ────────────────────────────────────────────────────────────
drop policy if exists "equipment write" on public.equipment;
create policy equipment_insert on public.equipment for insert to authenticated
  with check ((select private.has_any_tab('equipment'))
              and (select private.user_role()) = any (array['Admin', 'Coordinator']));
create policy equipment_update on public.equipment for update to authenticated
  using ((select private.has_any_tab('equipment'))
         and (select private.user_role()) = any (array['Admin', 'Coordinator']))
  with check ((select private.has_any_tab('equipment'))
              and (select private.user_role()) = any (array['Admin', 'Coordinator']));
create policy equipment_delete on public.equipment for delete to authenticated
  using ((select private.has_any_tab('equipment'))
         and (select private.user_role()) = any (array['Admin', 'Coordinator']));

-- ── rate_overrides ───────────────────────────────────────────────────────
-- `not locked` was only ever in USING, which is the right half — it decides
-- which existing rows may be changed or removed. Kept exactly there.
drop policy if exists rate_overrides_write on public.rate_overrides;
create policy rate_overrides_insert on public.rate_overrides for insert to authenticated
  with check ((select private.has_any_tab('rates')));
create policy rate_overrides_update on public.rate_overrides for update to authenticated
  using ((select private.has_any_tab('rates')) and not locked)
  with check ((select private.has_any_tab('rates')));
create policy rate_overrides_delete on public.rate_overrides for delete to authenticated
  using ((select private.has_any_tab('rates')) and not locked);

-- ── timesheet_approvals ──────────────────────────────────────────────────
drop policy if exists "timesheet approvals write" on public.timesheet_approvals;
create policy timesheet_approvals_insert on public.timesheet_approvals for insert to authenticated
  with check ((select private.has_any_tab('timesheets')));
create policy timesheet_approvals_update on public.timesheet_approvals for update to authenticated
  using ((select private.has_any_tab('timesheets')))
  with check ((select private.has_any_tab('timesheets')));
create policy timesheet_approvals_delete on public.timesheet_approvals for delete to authenticated
  using ((select private.has_any_tab('timesheets')));

-- ── ticket_crew ──────────────────────────────────────────────────────────
--
-- This one changes, and deliberately.
--
-- The old rule was a tab check and nothing else: anyone holding 'ticket' or
-- 'timesheets' could rewrite anyone's hours, on any ticket, including one the
-- client had already approved. Hours are what people are paid from and what
-- the client was billed for, so that is the same immutability hole that
-- ticket_lines had — the crew rows just weren't looked at when it was fixed.
--
-- Now they follow their ticket, exactly as the lines do: writable while the
-- ticket is writable, by the technician who raised it or an Admin or
-- Coordinator, and never once it is approved or invoiced.
--
-- Reading is untouched. Crews are meant to see each other's hours, and the
-- timesheet screen reads every crew row in a pay period.
drop policy if exists "crew write" on public.ticket_crew;
create policy ticket_crew_insert on public.ticket_crew for insert to authenticated
  with check ((select private.can_write_ticket(ticket_id)));
create policy ticket_crew_update on public.ticket_crew for update to authenticated
  using ((select private.can_write_ticket(ticket_id)))
  with check ((select private.can_write_ticket(ticket_id)));
create policy ticket_crew_delete on public.ticket_crew for delete to authenticated
  using ((select private.can_write_ticket(ticket_id)));

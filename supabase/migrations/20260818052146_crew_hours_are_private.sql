-- Hours are private. The crew read policy granted global read to anyone
-- holding the ticket, job or tracker tab — which is every technician and
-- helper — so any account could browse every person's hours through the
-- API. The seeded-load beta test made it plain: a technician could read
-- 44,870 crew rows that weren't theirs.
--
-- What the screens actually need: your own rows (timesheet), everything
-- (admin approval and exports), and the crew of a ticket you are part of
-- (the ticket editor shows who was on the truck). Nothing needs a global
-- read below Admin.
--
-- SECURITY DEFINER, because a policy on ticket_crew cannot query
-- ticket_crew as the caller without recursing into itself.
create or replace function private.shares_ticket(p_ticket text)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (select 1 from tickets t
                  where t.id = p_ticket and t.technician_id = auth.uid())
      or exists (select 1 from ticket_crew c
                  where c.ticket_id = p_ticket and c.profile_id = auth.uid());
$$;

drop policy "crew read" on public.ticket_crew;
create policy "crew read"
  on public.ticket_crew for select to authenticated
  using (
    (profile_id = ( select auth.uid() as uid))
    or (( select private.user_role() as user_role) = any (array['Admin'::text, 'Coordinator'::text]))
    or ( select private.shares_ticket(ticket_crew.ticket_id) as shares_ticket)
  );

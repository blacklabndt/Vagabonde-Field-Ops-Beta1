-- Tightening the tickets/jhas write policies back down from the blanket
-- `using (true)` they were widened to. That widening fixed a real bug —
-- filing a ticket or JHA from a job screen shouldn't depend on the "ticket"
-- or "jha" tab being visible on the technician's account — but "any
-- authenticated session can write" is wider than that fix needed. The actual
-- requirement is "a real member of staff", not "anyone signed in with a
-- valid JWT" — a stray or leaked token with no profile behind it shouldn't
-- be able to write rows at all.
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()));
$$;

drop policy if exists "tickets write" on public.tickets;
create policy "tickets write" on public.tickets for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists "jhas insert" on public.jhas;
create policy "jhas insert" on public.jhas for insert to authenticated
  with check (public.is_staff());

drop policy if exists "jhas update" on public.jhas;
create policy "jhas update" on public.jhas for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

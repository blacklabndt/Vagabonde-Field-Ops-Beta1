-- ─────────────────────────────────────────────────────────────────────────
-- Let a JHA be closed out
--
-- jhas could be inserted and read, but never updated — so writing the end
-- readings was silently refused. Postgres row-level security does not error on
-- an update no policy allows: it reports success having changed nothing, which
-- is why the close-out dialog closed cleanly and the assessment stayed Open.
--
-- Anyone who can file a hazard assessment can close one out: it is the crew who
-- read the dosimeters at the end of the day.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.jhas enable row level security;

drop policy if exists "jhas update" on public.jhas;

create policy "jhas update" on public.jhas
  for update to authenticated
  using (public.has_tab('jha')) with check (public.has_tab('jha'));

-- Reading and filing may already be covered by the base schema; these are
-- written idempotently so this file works on a database that never had them.
drop policy if exists "jhas read" on public.jhas;
create policy "jhas read" on public.jhas
  for select to authenticated using (true);

drop policy if exists "jhas insert" on public.jhas;
create policy "jhas insert" on public.jhas
  for insert to authenticated
  with check (public.has_tab('jha'));

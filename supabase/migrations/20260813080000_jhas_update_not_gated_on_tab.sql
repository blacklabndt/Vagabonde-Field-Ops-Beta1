-- Same fix as the insert policy: closing out a JHA happens from the job
-- screen the technician who filed it is working from, not from the "jha"
-- tab itself, so it must not depend on that tab being visible.
drop policy if exists "jhas update" on public.jhas;
create policy "jhas update" on public.jhas for update to authenticated using (true) with check (true);

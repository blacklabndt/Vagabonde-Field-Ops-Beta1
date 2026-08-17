-- Same fix as tickets_write_not_gated_on_tab.sql: filing a JHA is reached
-- from the job screen, not the tab menu, so it must not depend on the "jha"
-- tab being visible on the technician's account.
drop policy if exists "jhas insert" on public.jhas;
create policy "jhas insert" on public.jhas for insert to authenticated with check (true);

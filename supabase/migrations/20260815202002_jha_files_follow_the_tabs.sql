-- Storage buckets were still gated by a first-generation set of policies that
-- a second generation was layered on top of, never replacing it. Permissive
-- policies OR together, so the older, looser one wins every time.
--
-- The one that mattered:
--
--   create policy "jhas read" on storage.objects for select
--     to authenticated using (bucket_id = 'jhas');
--
-- No tab check at all. It sat alongside "jhas_bucket_read", which does check
-- for the jha or job tab — and ORed that check away entirely. Measured before
-- writing this, as the role rather than as the migration runner:
--
--   Bob Joe, tab_access {board, files, timesheets, contacts} — no jha, no job
--   → 9 of 9 JHA files visible.
--
-- A JHA carries crew names, signatures and cert numbers, so that is every
-- signed-in account able to list and download the lot regardless of their
-- tabs. Same shape of bug as the FOR ALL policies in 20260815191345: an old
-- broad policy quietly setting the floor under a newer narrow one.
--
-- While here, the survivors are rewritten to the two rules in the README:
-- private.has_tab rather than the public.has_tab wrapper, and each call
-- wrapped in (select …) so it is an InitPlan evaluated once per query instead
-- of a Filter evaluated per row. storage.objects is the one table here that
-- really does grow without bound, so per-row was the wrong shape for it.
--
-- On who keeps access. The second-generation gate was jha-or-job, but the PDF
-- links live on Job detail, which is reached from the board as a context
-- screen rather than as a tab of its own — so the UI offers those links to
-- anyone holding `board`. Applied literally, jha-or-job would lock both admin
-- accounts out of their own JHA and report files:
--
--   Dave Chapman  job, jha            → keeps it
--   Kyle Keith    users, files, …     → would LOSE it
--   Mark Cline    users, files, …     → would LOSE it
--   Bob Joe       board, files, …     → loses it, which is the point
--
-- So the gate is jha, job, or users. Whoever administers accounts can already
-- grant themselves any tab; withholding the file that the tab leads to buys
-- nothing. If JHAs should be narrower than that, tighten this policy and hide
-- the link on Job detail to match — the two need to move together.

-- ── jhas ──────────────────────────────────────────────────────────────────
drop policy if exists "jhas read"         on storage.objects;  -- the ungated one
drop policy if exists "jhas write"        on storage.objects;  -- duplicate of _bucket_write
drop policy if exists "jhas delete"       on storage.objects;
drop policy if exists "jhas_bucket_read"  on storage.objects;
drop policy if exists "jhas_bucket_write" on storage.objects;

create policy "jhas read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'jhas'
    and (
      (select private.has_tab('jha'))
      or (select private.has_tab('job'))
      or (select private.has_tab('users'))
    )
  );

create policy "jhas write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'jhas' and (select private.has_tab('jha')));

-- Deleting a JHA stays with the admin tab, as it was.
create policy "jhas delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'jhas' and (select private.has_tab('users')));

-- ── reports ───────────────────────────────────────────────────────────────
drop policy if exists "reports_bucket_read"  on storage.objects;
drop policy if exists "reports_bucket_write" on storage.objects;

create policy "reports read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'reports'
    and (
      (select private.has_tab('upload'))
      or (select private.has_tab('job'))
      or (select private.has_tab('users'))
    )
  );

create policy "reports write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'reports'
    and ((select private.has_tab('upload')) or (select private.has_tab('job')))
  );

-- ── shared ────────────────────────────────────────────────────────────────
drop policy if exists "shared read"   on storage.objects;
drop policy if exists "shared write"  on storage.objects;
drop policy if exists "shared delete" on storage.objects;

create policy "shared read" on storage.objects
  for select to authenticated
  using (bucket_id = 'shared' and (select private.has_tab('files')));

create policy "shared write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'shared' and (select private.has_tab('files')));

create policy "shared delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'shared' and (select private.has_tab('files')));

-- ── and the one table policy still calling its helper bare ────────────────
drop policy if exists "rate line history read" on public.rate_line_history;
create policy "rate line history read" on public.rate_line_history
  for select to authenticated
  using ((select public.is_staff()));

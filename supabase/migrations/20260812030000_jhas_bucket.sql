-- ─────────────────────────────────────────────────────────────────────────
-- Private storage bucket for rendered JHAs
--
-- The render-jha Edge Function writes the PDF here with the service role;
-- signed-in accounts that can see the Files or JHA screens read it back
-- through a short-lived signed URL, the same way reports work.
-- ─────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('jhas', 'jhas', false)
on conflict (id) do nothing;

drop policy if exists "jhas read"   on storage.objects;
drop policy if exists "jhas write"  on storage.objects;
drop policy if exists "jhas delete" on storage.objects;

-- Read is open to any signed-in account: a hazard assessment is a safety
-- record, and everyone on the crew is entitled to the one they were named on.
create policy "jhas read" on storage.objects
  for select to authenticated
  using (bucket_id = 'jhas');

-- Writes come from the function (service role, which bypasses this), but the
-- policy exists so a future client-side render does not need a schema change.
create policy "jhas write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'jhas' and public.has_tab('jha'));

create policy "jhas delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'jhas' and public.has_tab('users'));

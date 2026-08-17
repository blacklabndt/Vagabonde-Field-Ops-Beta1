-- Shared files bucket — the Files tab.
--
-- Private, like `reports` and `jhas`: nothing here has a public URL, and the
-- app hands out ten-minute signed links instead. Folders are path prefixes
-- inside this bucket, so there is no folders table to keep in sync.

insert into storage.buckets (id, name, public)
values ('shared', 'shared', false)
on conflict (id) do nothing;

-- Anyone whose profile grants them the Files tab can read and write. Access is
-- deliberately flat: this is a company drive, not per-client storage — the
-- per-client documents live as reports against their job.
drop policy if exists "shared read"   on storage.objects;
drop policy if exists "shared write"  on storage.objects;
drop policy if exists "shared delete" on storage.objects;

create policy "shared read" on storage.objects
  for select to authenticated
  using (bucket_id = 'shared' and public.has_tab('files'));

create policy "shared write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'shared' and public.has_tab('files'));

create policy "shared delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'shared' and public.has_tab('files'));

-- Existing accounts were provisioned before the Files tab existed, so grant it
-- to everyone once. New accounts pick it up from the role presets.
update public.profiles
set tab_access = array_append(tab_access, 'files')
where not ('files' = any (tab_access));

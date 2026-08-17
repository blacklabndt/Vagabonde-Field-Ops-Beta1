-- Private buckets — PDFs are never public. The app must request a
-- short-lived signed URL to view one, per "Serve via short-lived signed
-- URLs so a leaked link can't expose a client's reports."
insert into storage.buckets (id, name, public)
values ('reports', 'reports', false), ('jhas', 'jhas', false)
on conflict (id) do nothing;

create policy reports_bucket_read on storage.objects for select
  using (bucket_id = 'reports' and (public.has_tab('upload') or public.has_tab('job')));
create policy reports_bucket_write on storage.objects for insert
  with check (bucket_id = 'reports' and (public.has_tab('upload') or public.has_tab('job')));

create policy jhas_bucket_read on storage.objects for select
  using (bucket_id = 'jhas' and (public.has_tab('jha') or public.has_tab('job')));
create policy jhas_bucket_write on storage.objects for insert
  with check (bucket_id = 'jhas' and public.has_tab('jha'));

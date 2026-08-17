-- Approving a period now freezes it as a PDF.
--
-- The approval row says that hours were signed off; the document says
-- which hours. Tickets can be corrected after the fact, and when they
-- are, the approved figures and the live figures part ways -- the PDF is
-- the record of what the admin actually saw and signed. It is built in
-- the browser at approval time and stored here, one per person per
-- period, at <profile_id>/<period_start>.pdf.
--
-- The folder-per-person layout is what the read policy keys on: everyone
-- reads their own folder, admins read all of them, and only admins write
-- or remove anything. Update exists because re-approving a reopened
-- period overwrites the same path rather than minting a second file.

alter table public.timesheet_approvals add column pdf_key text;

insert into storage.buckets (id, name, public)
values ('timesheets', 'timesheets', false)
on conflict (id) do nothing;

create policy "timesheets write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'timesheets' and (select private.user_role()) = 'Admin');

create policy "timesheets update" on storage.objects
  for update to authenticated
  using (bucket_id = 'timesheets' and (select private.user_role()) = 'Admin')
  with check (bucket_id = 'timesheets' and (select private.user_role()) = 'Admin');

create policy "timesheets read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'timesheets'
    and (
      (select private.user_role()) = 'Admin'
      or (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );

create policy "timesheets delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'timesheets' and (select private.user_role()) = 'Admin');

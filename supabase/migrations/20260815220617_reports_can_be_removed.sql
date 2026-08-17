-- Nothing could ever delete a report file.
--
-- The jhas bucket has had a delete policy since the start, gated on the users
-- (admin) tab. The reports bucket had insert and select only, so once a PDF
-- was uploaded it stayed for good — and when its row went away with a deleted
-- job, the file was stranded with no route to remove it through the app at
-- all. That is how the orphan found in this review came to exist: a 563 KB
-- report belonging to job J-2845, which no longer exists.
--
-- Same gate as its neighbour: removing a client deliverable is an admin's.

create policy "reports delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'reports' and (select private.has_tab('users')));

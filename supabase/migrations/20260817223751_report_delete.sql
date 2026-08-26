-- Deleting an uploaded report, same rule as hazard assessments: admins and
-- technicians — the techs who upload them clean up their own. There was no
-- delete policy at all before this, so nothing could remove a report row.
create policy "reports delete"
  on public.reports for delete to authenticated
  using ((( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Technician'::text])));

-- The stored PDF goes with the row. This was has_tab('users') (admins only),
-- which would have stranded the file whenever a technician removed the row —
-- the same widening the jhas bucket got in 20260817182041.
drop policy "reports delete" on storage.objects;
create policy "reports delete"
  on storage.objects for delete to authenticated
  using (((bucket_id = 'reports'::text) AND (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Technician'::text]))));

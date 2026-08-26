-- Hazard assessments: emailing and deleting.
--
-- sent_at / sent_to mirror the reports table's bookkeeping — the send-jha
-- function stamps them after Postmark accepts the message, so the job page
-- can say truthfully where an assessment has gone. sent_to is the same
-- comma-joined address list recipients() builds for reports.
alter table public.jhas add column sent_at timestamp with time zone;
alter table public.jhas add column sent_to text;

-- Admins and technicians may delete an assessment — per Kyle, the techs who
-- file them clean up their own. Deliberately narrower than is_staff(), which
-- is true for anyone with a profile: a helper can file a JHA but not remove
-- one.
create policy "jhas delete"
  on public.jhas for delete to authenticated
  using ((( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Technician'::text])));

-- The stored PDF goes with the row, so whoever may delete the assessment must
-- be able to delete its object too — this was has_tab('users') (admins only),
-- which would have stranded the file whenever a technician removed the row.
drop policy "jhas delete" on storage.objects;
create policy "jhas delete"
  on storage.objects for delete to authenticated
  using (((bucket_id = 'jhas'::text) AND (( SELECT private.user_role() AS user_role) = ANY (ARRAY['Admin'::text, 'Technician'::text]))));

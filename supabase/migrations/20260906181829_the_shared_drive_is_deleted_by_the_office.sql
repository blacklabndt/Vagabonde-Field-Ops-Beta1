-- The shared drive's delete is the office's. Applied live 6 Sept 2026 as
-- 20260906181829 and probed with role simulation (probes beside it).
--
-- The Files screen hides the × from anyone below Coordinator — the drive
-- holds the RT procedure and the report template, and there is no undo — but
-- the storage policy behind it still let any account holding the files tab
-- delete, which every role holds. The button was the courtesy and there was
-- no gate (CLAUDE.md: "the button is the courtesy, the policy is the gate").
-- Reading and uploading stay as they were: a technician filing a photo of a
-- gauge or a procedure revision is the drive's purpose.
drop policy if exists "shared delete" on storage.objects;
create policy "shared delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'shared'
    and (select private.has_tab('files'))
    and (select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text])
  );

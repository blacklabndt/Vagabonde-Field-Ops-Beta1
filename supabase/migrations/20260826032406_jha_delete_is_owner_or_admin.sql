-- JHA deletion narrows to owner-or-Admin.
--
-- "Admins and technicians may delete an assessment" was written for techs
-- cleaning up their own filings, but it said something broader: any
-- Technician could delete any assessment — someone else's signed safety
-- record included. Kyle's call on review: a Technician deletes their own,
-- an Admin deletes anything. signed_by is the filing technician (set on
-- insert from the signed-in profile), so it is the ownership column.
drop policy "jhas delete" on public.jhas;
create policy "jhas delete"
  on public.jhas for delete to authenticated
  using (
    (( select private.user_role()) = 'Admin'::text)
    or ((( select private.user_role()) = 'Technician'::text)
        and (signed_by = ( select auth.uid())))
  );

-- The stored PDF. The app deletes the row first and the object second, so
-- when the storage delete arrives the row is already gone — an ownership
-- test against public.jhas would find nothing and strand every PDF. The
-- rule is therefore: an object may go when no surviving row claims it
-- (exactly the state the owner-gated row delete above leaves behind), or
-- when the row that does claim it is the caller's own. SECURITY DEFINER
-- like shares_ticket, so the answer doesn't depend on what the jhas read
-- policy happens to show the caller.
create or replace function private.jha_pdf_is_deletable(p_key text)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select not exists (
    select 1 from jhas j
    where j.pdf_key = p_key
      and j.signed_by is distinct from auth.uid()
  );
$$;

drop policy "jhas delete" on storage.objects;
create policy "jhas delete"
  on storage.objects for delete to authenticated
  using (
    (bucket_id = 'jhas'::text)
    and (
      (( select private.user_role()) = 'Admin'::text)
      or ((( select private.user_role()) = 'Technician'::text)
          and ( select private.jha_pdf_is_deletable(storage.objects.name)))
    )
  );

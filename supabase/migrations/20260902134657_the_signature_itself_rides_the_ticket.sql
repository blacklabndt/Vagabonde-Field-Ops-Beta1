-- The approval page can now carry the rep's actual signature — drawn on
-- the page or uploaded as an image — alongside the typed name that remains
-- the legal signature. Stored on the ticket as a size-capped PNG data URL:
-- small, immutable with the rest of the approval record, and readable by
-- the same policies that guard the ticket.
alter table public.tickets add column approved_signature text
  constraint tickets_signature_shape check (
    approved_signature is null
    or (length(approved_signature) <= 400000
        and approved_signature like 'data:image/png;base64,%')
  );

-- The insert guard already insists a new ticket arrives unapproved in
-- every column; the signature joins that list.
drop policy "tickets insert" on public.tickets;
create policy "tickets insert" on public.tickets
  for insert with check (
    (select is_staff())
    and ((technician_id = (select auth.uid()))
         or ((select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text])))
    and status = 'Draft'
    and approved_at is null
    and approved_by_email is null
    and approved_ip is null
    and approval_token is null
    and approval_sent_at is null
    and approved_signature is null
  );

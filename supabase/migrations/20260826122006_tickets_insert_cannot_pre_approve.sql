-- A ticket cannot be born approved.
--
-- The tickets INSERT policy checked is_staff() and ownership, but nothing
-- about status or the approval columns — so a hand-crafted PostgREST
-- insert (RLS is the boundary, not the app) could land a row already
-- stamped status='Approved', approved_at=now(), any total, no lines. The
-- balance trigger deliberately skips already-approved rows, so the fake
-- total is never reconciled; the UPDATE policy then locks the row, making
-- the forged approval permanent. This is exactly the invariant CLAUDE.md
-- names — "approval is Admin-role-gated in RLS, not just in the UI" — and
-- the UPDATE policy already carries the guard; INSERT just never got it.
--
-- Insert is now Draft-only with every approval column null. Approval flows
-- exclusively through send-ticket-approval + approve-ticket, which set
-- those columns with the service role after a real client signs.
drop policy "tickets insert" on public.tickets;
create policy "tickets insert"
  on public.tickets for insert to authenticated
  with check (
    (select is_staff())
    and ((technician_id = (select auth.uid()))
         or ((select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text])))
    and status = 'Draft'
    and approved_at is null
    and approved_by_email is null
    and approved_ip is null
    and approval_token is null
    and approval_sent_at is null
  );

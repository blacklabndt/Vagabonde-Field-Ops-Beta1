-- Approval is the client's act alone.
--
-- Four things, all from the deployment review:
--
-- 1. The tickets UPDATE policy pinned the OLD row (unapproved; mine or
--    Admin/Coordinator) but said nothing about the NEW one, so a technician
--    could PATCH their own draft straight to Approved with a fabricated
--    signature — 20260826122006 had closed the same door on INSERT only.
--    WITH CHECK now carries the same guard: the approval columns stay null
--    and the status stays short of Approved on anything a signed-in account
--    writes. Only the service role — approve-ticket, on the strength of the
--    emailed token — approves.
--
-- 2. tickets.approval_token held the raw token, and every staff account can
--    read tickets, so anyone signed in could list the live links and sign a
--    colleague's ticket as the client. The column now holds
--    'sha256:' || hex(sha256(token)); send-ticket-approval writes that and
--    approve-ticket hashes the URL's token before looking it up
--    (_shared/approvalToken.ts). Existing raw tokens are hashed in place so
--    the links already in inboxes keep working; the prefix makes the UPDATE
--    re-runnable without hashing a hash.
--
-- 3. Who the link went to and who sent it are recorded (approval_sent_to,
--    approval_sent_by) and printed on the approval stamp — the one fact that
--    separates a genuine approval from one a technician mailed to themselves.
--
-- 4. ticket_lines had no order: PostgREST returns the embed in heap order,
--    which drifts once vacuum reuses the space a re-saved ticket left behind,
--    and the printed bill's lines would shuffle. line_order is the insertion
--    sequence (the app saves lines in the rate card's order) and every
--    renderer orders by it.
--
-- Plus profiles.deactivated_at: an account with work on file cannot be
-- deleted (the foreign keys keep history's names on purpose), so delete-user
-- locks it instead and stamps this.
--
-- Probed live with request.jwt.claims role simulation as a Technician:
-- self-approve → 42501; editing own draft → 1 row; recalling own awaiting
-- ticket → 1 row.

-- 1 · the approval outcome is the service role's alone
drop policy if exists "tickets update" on public.tickets;
create policy "tickets update" on public.tickets
  for update to authenticated
  using (
    (select is_staff())
    and approved_at is null
    and status <> all (array['Approved'::text, 'Invoiced'::text])
    and (technician_id = (select auth.uid())
         or (select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text]))
  )
  with check (
    (select is_staff())
    and (technician_id = (select auth.uid())
         or (select private.user_role()) = any (array['Admin'::text, 'Coordinator'::text]))
    and status <> all (array['Approved'::text, 'Invoiced'::text])
    and approved_at is null
    and approved_by_email is null
    and approved_ip is null
    and approved_signature is null
  );

-- 2 · tokens at rest are hashes
update public.tickets
   set approval_token = 'sha256:' || encode(sha256(convert_to(approval_token, 'UTF8')), 'hex')
 where approval_token is not null
   and approval_token not like 'sha256:%';

-- 3 · the audit trail of a send
alter table public.tickets
  add column if not exists approval_sent_to text,
  add column if not exists approval_sent_by uuid references public.profiles(id) on delete set null;
create index if not exists tickets_approval_sent_by_idx on public.tickets (approval_sent_by);

-- 4 · lines keep their order
create sequence if not exists public.ticket_lines_line_order_seq;
alter table public.ticket_lines
  add column if not exists line_order bigint not null default nextval('public.ticket_lines_line_order_seq');
alter sequence public.ticket_lines_line_order_seq owned by public.ticket_lines.line_order;
grant usage, select on sequence public.ticket_lines_line_order_seq to authenticated, service_role;

-- 5 · locked accounts
alter table public.profiles add column if not exists deactivated_at timestamp with time zone;

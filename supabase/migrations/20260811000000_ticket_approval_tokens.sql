-- Approval links for billing tickets.
--
-- A client rep signs a ticket without ever having an account: they get an
-- emailed link carrying a random token. The token lives on the ticket row,
-- expires, and is cleared the moment it is used, so a forwarded email
-- cannot approve the same ticket twice.

alter table public.tickets
  add column if not exists approval_token       text unique,
  add column if not exists approval_sent_at     timestamptz,
  add column if not exists approval_expires_at  timestamptz;

create index if not exists tickets_approval_token_idx
  on public.tickets (approval_token) where approval_token is not null;

-- The approval endpoint runs as the service role (it has no signed-in user),
-- so no RLS policy is needed for it. Nothing else should ever read the
-- token: keep it out of the client-facing views by never selecting it in
-- the app. (approval_token is a single-use secret from the approval email,
-- server-side only.)

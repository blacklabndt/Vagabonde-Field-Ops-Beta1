-- A ticket is edited by its technician or an Admin.
--
-- Why: the owner's rule is that one technician never edits another's
-- ticket — only an Admin can. The gate behind every ticket_lines and
-- ticket_crew write is private.can_write_ticket, and since the baseline it
-- has let a Coordinator through as well as the technician and an Admin. A
-- Coordinator cannot read or write ticket_lines anyway (those policies want
-- the price role), but the crew rows — somebody's hours — were still theirs
-- to write on any ticket. Now they are the technician's and an Admin's alone.
--
-- Re-created whole from the baseline §2 with the one word removed; grants
-- and revokes are untouched by CREATE OR REPLACE, so `authenticated` still
-- cannot call it directly and the policies still can.
--
-- The tickets UPDATE policy itself (status, contacts, delays, chased_at —
-- the column grant) keeps its Coordinator arm on purpose: that is the
-- office's chase and query plumbing on the tracker, not the bill.
create or replace function private.can_write_ticket(t_id text)
returns boolean
language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from public.tickets t
    where t.id = t_id
      and t.approved_at is null
      and (
        t.technician_id = (select auth.uid())
        or (select private.user_role()) = 'Admin'
      )
  );
$$;

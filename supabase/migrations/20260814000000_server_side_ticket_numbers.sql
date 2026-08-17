-- Ticket numbers minted in the database, not the browser.
--
-- A ticket number is its primary key: {initials}-{MMDD}-{YY}-{NN}. The app
-- built it by counting today's tickets for those initials and adding one, then
-- inserting with that as the id. Two failure modes came out of that:
--
--   - Two people sharing initials raising a ticket the same day both count the
--     same number and mint the same id. The second insert dies on the primary
--     key, surfacing as "couldn't save the ticket" on a screen holding a full
--     day of billing.
--   - Worse offline: a number minted at 07:00 with no signal is replayed
--     hours later, by which time the slot is often taken. The replay fails,
--     and because that is not a network error the queue keeps the item.
--
-- Counting here rather than in the browser also fixes a correctness problem
-- the client version could not see: `tickets` is behind row-level security, so
-- an account without the ticket/job/tracker tabs counts only the rows it can
-- read and mints a number that is already in use. This function is SECURITY
-- DEFINER precisely so the count is taken over every ticket, not the caller's
-- visible subset. It returns a number and nothing else.

create or replace function public.next_ticket_number(_initials text, _work_date date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  _prefix text;
  _next   int;
begin
  if coalesce(trim(_initials), '') = '' then
    raise exception 'Ticket numbers need the technician''s initials.';
  end if;
  if _work_date is null then
    raise exception 'Ticket numbers need the work date.';
  end if;

  _prefix := upper(trim(_initials)) || '-' ||
             to_char(_work_date, 'MMDD') || '-' ||
             to_char(_work_date, 'YY') || '-';

  -- Serialise minting per prefix, so two technicians calling this at the same
  -- instant cannot read the same maximum. The lock is transaction-scoped and
  -- this function is its own transaction, so it does NOT cover the gap between
  -- minting and the caller's insert — the primary key is what closes that, and
  -- db.js retries on a duplicate. A reservation table would remove the retry
  -- but would burn a number every time a draft was abandoned, and an
  -- accountant reading a gap in the ticket sequence is a worse problem than a
  -- retry nobody sees.
  perform pg_advisory_xact_lock(hashtext(_prefix));

  select coalesce(max(nullif(substring(id from '([0-9]+)$'), '')::int), 0) + 1
    into _next
    from public.tickets
   where id like _prefix || '%';

  return _prefix || lpad(_next::text, 2, '0');
end;
$$;

revoke all on function public.next_ticket_number(text, date) from public;
grant execute on function public.next_ticket_number(text, date) to authenticated;

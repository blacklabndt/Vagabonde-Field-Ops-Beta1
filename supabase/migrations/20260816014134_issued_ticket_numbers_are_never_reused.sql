-- A ticket number that has been sent to a client is never handed out twice.
--
-- next_ticket_number takes max(existing) + 1, which recycles the number of any
-- deleted ticket. Measured, and rolled back:
--
--   minted and saved : ZZ-1201-26-01
--   minted and saved : ZZ-1201-26-02
--   deleted          : ZZ-1201-26-02
--   next mint        : ZZ-1201-26-02   <-- reuses the deleted number
--
-- For an abandoned draft that is the right behaviour, and deliberately so:
-- the alternative burns a number every time somebody opens the billing screen
-- and thinks better of it, and a gap in the ticket sequence is the kind of
-- thing an accountant asks about. That reasoning is in the function and it
-- still holds.
--
-- What it did not weigh is a ticket that has already left the building. A
-- ticket sitting at "Awaiting approval" has been emailed to a client with a
-- live signing link, and its own technician may still delete it — the delete
-- policy only bars Approved and Invoiced. Recycling that number gives two
-- different pieces of work the same identifier, one of which the client has
-- in writing at a different amount. That is a dispute waiting to happen, and
-- it is not the same trade as a gap.
--
-- So: numbers are recycled freely until the moment one is sent, and never
-- afterwards. Drafts still leave no gaps; issued numbers are burned on delete.

create table if not exists public.burned_ticket_numbers (
  id          text primary key,
  burned_at   timestamptz not null default now(),
  reason      text
);

comment on table public.burned_ticket_numbers is
  'Ticket numbers that reached a client and must never be issued again, kept when the ticket itself is deleted. See next_ticket_number.';

alter table public.burned_ticket_numbers enable row level security;

-- Readable by anyone who can see tickets; written only by the trigger below,
-- which runs as owner. No insert/update/delete policy exists on purpose.
drop policy if exists "burned numbers read" on public.burned_ticket_numbers;
create policy "burned numbers read" on public.burned_ticket_numbers
  for select to authenticated
  using ((select is_staff()));

create or replace function private.burn_issued_ticket_number()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- Only numbers a client has actually been given. A draft that was never
  -- sent is free to be reused, which is what keeps the sequence gapless.
  if old.approval_sent_at is not null then
    insert into public.burned_ticket_numbers (id, reason)
    values (old.id, 'sent for approval on ' || to_char(old.approval_sent_at, 'YYYY-MM-DD') || ', ticket later deleted')
    on conflict (id) do nothing;
  end if;
  return old;
end;
$$;

revoke execute on function private.burn_issued_ticket_number() from anon, authenticated, public;

drop trigger if exists tickets_burn_issued_number on public.tickets;
create trigger tickets_burn_issued_number
  before delete on public.tickets
  for each row execute function private.burn_issued_ticket_number();

-- The mint now looks at both the live tickets and the burned list.
create or replace function public.next_ticket_number(_initials text, _work_date date)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  -- Letters only. The prefix is interpolated into a LIKE pattern below, and
  -- this function is callable over the API by any signed-in account, so
  -- initials of '%' would otherwise widen the match to every technician's
  -- tickets for that date and mint against somebody else's sequence.
  if upper(trim(_initials)) !~ '^[A-Z]{1,4}$' then
    raise exception 'Initials must be one to four letters.';
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

  -- Both lists: the tickets that exist, and the numbers that have been issued
  -- to a client and since deleted. Recycling the first is fine; recycling the
  -- second hands two different bills the same identifier.
  select coalesce(max(n), 0) + 1 into _next
  from (
    select nullif(substring(id from '([0-9]+)$'), '')::int as n
      from public.tickets
     where id like _prefix || '%'
    union all
    select nullif(substring(id from '([0-9]+)$'), '')::int
      from public.burned_ticket_numbers
     where id like _prefix || '%'
  ) s;

  return _prefix || lpad(_next::text, 2, '0');
end;
$function$;

revoke execute on function public.next_ticket_number(text, date) from anon, public;
grant execute on function public.next_ticket_number(text, date) to authenticated;

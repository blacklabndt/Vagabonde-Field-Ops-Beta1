-- The cross-table CHECK that Postgres does not have, done the way Postgres
-- does have: a deferrable constraint trigger.
--
-- The previous migration keeps tickets.total in step whenever a *line*
-- changes, and said plainly what it could not cover — a ticket inserted with
-- a total whose lines then never arrive. No line changes, so nothing fires.
-- That is exactly how KK-0814-26-01 came to store $17.00 against nothing: the
-- row saved, an RLS policy refused the lines, and the screen showed money
-- nobody could account for.
--
-- A CHECK constraint cannot see another table. A constraint trigger can, and
-- being DEFERRABLE INITIALLY DEFERRED it runs at COMMIT rather than after each
-- statement — so a transaction is free to be inconsistent in the middle and
-- only has to balance by the end. That matters for the line insert, which
-- writes several rows and would otherwise be judged after the first one.
--
-- The app was writing the total itself, and the two halves of a save are two
-- PostgREST requests and therefore two transactions. So the row is now
-- inserted at zero and the lines move it (see createTicket / updateTicket in
-- db.js). Every commit boundary balances:
--
--   insert ticket, total 0, no lines        0 = 0        ok
--   insert lines, trigger sets the total    sum = sum    ok
--   delete lines, trigger zeroes it         0 = 0        ok
--
-- and the case this exists for:
--
--   insert ticket, total 17, no lines       17 <> 0      refused at commit
--
-- Approved and invoiced tickets are exempt. What a client signed for is the
-- record, and if a historical row ever failed to balance, refusing every
-- future write to it would be a worse outcome than the discrepancy.

create or replace function private.ticket_total_balances()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  _row    public.tickets%rowtype;
  _lines  numeric;
begin
  -- Both sides are re-read as they stand *now*, not taken from NEW.
  --
  -- A deferred trigger captures its NEW row when the statement runs but only
  -- fires at commit, so the two are separated by the rest of the transaction.
  -- Comparing a stale NEW.total against a current line sum rejects the normal
  -- save: the ticket is inserted at zero, queueing a check that says "total
  -- 0", and by the time it runs the lines are in and sum to the real figure.
  -- Measured before this was fixed — a legitimate two-line ticket was refused
  -- with "says 0.00 but its lines add up to 2316". Reading the row here makes
  -- the check say what it means: at the end of this transaction, do these two
  -- agree? It also makes it idempotent, which matters because several
  -- statements can queue the same check.
  select * into _row from public.tickets where id = new.id;

  -- Deleted later in the same transaction: nothing left to balance.
  if not found then
    return null;
  end if;

  if _row.approved_at is not null or _row.status in ('Approved', 'Invoiced') then
    return null;
  end if;

  select coalesce(sum(quantity * unit_rate), 0) into _lines
    from public.ticket_lines where ticket_id = _row.id;

  if _row.total is distinct from _lines then
    raise exception
      'Ticket % says % but its lines add up to %. A ticket cannot carry a total it has no lines for — save the lines, or save the ticket at zero.',
      _row.id, _row.total, _lines
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

revoke execute on function private.ticket_total_balances() from anon, authenticated, public;

drop trigger if exists tickets_total_balances on public.tickets;
create constraint trigger tickets_total_balances
  after insert or update of total on public.tickets
  deferrable initially deferred
  for each row execute function private.ticket_total_balances();

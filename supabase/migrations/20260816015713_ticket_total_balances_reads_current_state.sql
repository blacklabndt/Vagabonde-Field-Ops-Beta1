-- Correction to the migration immediately before this one, applied minutes
-- later. Kept as its own file because the database records it as its own
-- step, and a file list that disagrees with the history is how `db push`
-- ends up replaying work that is already done.
--
-- The constraint trigger compared NEW.total — captured when the statement
-- ran — against a line sum read at COMMIT. A deferred trigger separates those
-- two moments by the whole transaction, so the check queued by inserting the
-- ticket at zero was later judged against lines that had since arrived, and a
-- perfectly good two-line ticket was refused with "says 0.00 but its lines add
-- up to 2316".
--
-- Re-reading the row makes the check ask what it means: at the end of this
-- transaction, do these two agree? It also makes it idempotent, which matters
-- because several statements in one transaction queue the same check.
--
-- 20260816015524 already carries this corrected body, so replaying the two in
-- order simply defines the same function twice.

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
  select * into _row from public.tickets where id = new.id;
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

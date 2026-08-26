-- A line's billable amount is its product rounded to the cent — one
-- formula, shared by the total sync, the balance check, the app and the
-- printed invoice.
--
-- Found by the arithmetic audit: sync_ticket_total wrote the exact sum
-- into a two-decimal column (which rounds), and the deferred balance check
-- then compared that rounded total against the unrounded sum — so any
-- line whose product carries a third decimal made the whole save fail at
-- commit: half an hour at a $9.25 rate meant "4.63 but its lines add up
-- to 4.625", raised by the database against its own arithmetic. It never
-- fired in the field only because every rate so far has been whole
-- dollars.
create or replace function private.sync_ticket_total()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  _ticket text := coalesce(new.ticket_id, old.ticket_id);
begin
  update public.tickets t
     set total = coalesce((
           select sum(round(l.quantity * l.unit_rate, 2))
             from public.ticket_lines l
            where l.ticket_id = _ticket
         ), 0)
   where t.id = _ticket;

  if tg_op = 'UPDATE' and new.ticket_id is distinct from old.ticket_id then
    update public.tickets t
       set total = coalesce((
             select sum(round(l.quantity * l.unit_rate, 2))
               from public.ticket_lines l
              where l.ticket_id = old.ticket_id
           ), 0)
     where t.id = old.ticket_id;
  end if;

  return null;
end;
$function$;

create or replace function private.ticket_total_balances()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $function$
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

  -- The same per-line rounding the sync writes, so the two can never
  -- disagree about sub-cent precision.
  select coalesce(sum(round(quantity * unit_rate, 2)), 0) into _lines
    from public.ticket_lines where ticket_id = _row.id;

  if _row.total is distinct from _lines then
    raise exception
      'Ticket % says % but its lines add up to %. A ticket cannot carry a total it has no lines for — save the lines, or save the ticket at zero.',
      _row.id, _row.total, _lines
      using errcode = 'check_violation';
  end if;

  return null;
end;
$function$;

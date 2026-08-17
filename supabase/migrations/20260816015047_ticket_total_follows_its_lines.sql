-- A ticket's total is derived from its lines, at the database rather than by
-- convention in three codebases.
--
-- tickets.total is written by whoever saves the ticket, and the sum of
-- ticket_lines is what the client's invoice prints. Nothing made them agree.
-- One row had already drifted: KK-0814-26-01 stored $17.00 against no lines
-- at all, left over from the period when an RLS policy silently refused every
-- line insert while the ticket row itself saved fine. The screen showed a
-- total nobody could account for.
--
-- The app computes total from the lines in createTicket and updateTicket, the
-- invoice recomputes it from the printed lines, and now the database keeps
-- them in step whenever lines change — so a line edited or removed by any
-- route, including straight SQL or some later feature, cannot leave a stale
-- figure behind.
--
-- What this does not cover, said plainly: a ticket inserted with a total whose
-- lines then never arrive. No line changed, so nothing fires. That is exactly
-- how the $17.00 came about, and what prevents it now is the RLS fix in
-- 20260815012240 plus the app summing the lines it is about to write. A
-- cross-table CHECK would be the real guarantee and Postgres has no such
-- thing.

create or replace function private.sync_ticket_total()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  _ticket text := coalesce(new.ticket_id, old.ticket_id);
begin
  update public.tickets t
     set total = coalesce((
           select sum(l.quantity * l.unit_rate)
             from public.ticket_lines l
            where l.ticket_id = _ticket
         ), 0)
   where t.id = _ticket;

  -- A line can in principle be moved between tickets; both ends need
  -- recomputing, and this is cheap enough not to bother detecting it.
  if tg_op = 'UPDATE' and new.ticket_id is distinct from old.ticket_id then
    update public.tickets t
       set total = coalesce((
             select sum(l.quantity * l.unit_rate)
               from public.ticket_lines l
              where l.ticket_id = old.ticket_id
           ), 0)
     where t.id = old.ticket_id;
  end if;

  return null;  -- AFTER trigger; the return value is ignored
end;
$$;

revoke execute on function private.sync_ticket_total() from anon, authenticated, public;

drop trigger if exists ticket_lines_sync_total on public.ticket_lines;
create trigger ticket_lines_sync_total
  after insert or update or delete on public.ticket_lines
  for each row execute function private.sync_ticket_total();

-- The one row that had already drifted. Its lines are gone and cannot be
-- reconstructed, so the honest value is what the lines say: nothing.
update public.tickets t
   set total = coalesce((
         select sum(l.quantity * l.unit_rate)
           from public.ticket_lines l
          where l.ticket_id = t.id
       ), 0)
 where t.approved_at is null
   and t.status not in ('Approved', 'Invoiced')
   and t.total <> coalesce((
         select sum(l.quantity * l.unit_rate)
           from public.ticket_lines l
          where l.ticket_id = t.id
       ), 0);

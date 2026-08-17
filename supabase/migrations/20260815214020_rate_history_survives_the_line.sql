-- The rate audit trail could be erased by the thing it audits.
--
-- Measured, on a real schedule, rolled back afterwards:
--
--   history rows before      : 44
--   after ADDING a line      : 44  (not logged)
--   after EDITING its rate   : 45  (logged)
--   after DELETING the line  : 44  (not logged — AND the edit's row went too)
--
-- Two separate faults with the same consequence.
--
-- rate_line_history.rate_line_id was NOT NULL with ON DELETE CASCADE, so
-- deleting a rate line deleted its entire change history along with it. On a
-- billing system that is the wrong way round: someone can raise a rate, bill
-- against it, delete the line, and leave no evidence the rate ever existed.
-- An audit trail that a single DELETE can rewrite is not an audit trail.
--
-- And the trigger fired on UPDATE only, so adding a line at any rate, or
-- removing one, was never recorded in the first place. Only edits to an
-- existing line were — which is the one case where the old value survives
-- anyway.
--
-- After this: the line's history outlives the line (label, kind and unit are
-- already denormalised onto each history row, so a row still reads sensibly
-- once rate_line_id is null), and every create, change and removal is logged.
--
-- Deliberately unchanged: schedule_id keeps ON DELETE CASCADE. Deleting a
-- whole rate card with its history is a different act from quietly dropping
-- one line out of a live one, and a client asking to be removed should take
-- their pricing with them.

-- ── 1. history outlives the line ──────────────────────────────────────────
alter table public.rate_line_history
  alter column rate_line_id drop not null;

alter table public.rate_line_history
  drop constraint rate_line_history_rate_line_id_fkey;

alter table public.rate_line_history
  add constraint rate_line_history_rate_line_id_fkey
  foreign key (rate_line_id) references public.rate_lines(id) on delete set null;

-- ── 2. log the whole life of a line, not just the middle of it ────────────
create or replace function public.log_rate_line_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    -- A new line arrives at a price. old_rate null reads as "did not exist".
    insert into public.rate_line_history
      (rate_line_id, schedule_id, kind, label, unit, old_rate, new_rate, changed_by)
    values (new.id, new.schedule_id, new.kind, new.label, new.unit, null, new.rate, auth.uid());
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- rate_line_id is left null on purpose: the row it would point at is
    -- being removed in this same statement, and the FK would refuse it.
    -- new_rate null reads as "no longer exists".
    insert into public.rate_line_history
      (rate_line_id, schedule_id, kind, label, unit, old_rate, new_rate, changed_by)
    values (null, old.schedule_id, old.kind, old.label, old.unit, old.rate, null, auth.uid());
    return old;
  end if;

  -- UPDATE. A rename or a unit change alters what a client sees on an
  -- invoice just as surely as a price does, so all three are worth a row.
  if new.rate  is distinct from old.rate
  or new.label is distinct from old.label
  or new.unit  is distinct from old.unit then
    insert into public.rate_line_history
      (rate_line_id, schedule_id, kind, label, unit, old_rate, new_rate, changed_by)
    values (new.id, new.schedule_id, new.kind, new.label, new.unit, old.rate, new.rate, auth.uid());
  end if;
  return new;
end;
$function$;

revoke execute on function public.log_rate_line_change() from anon, authenticated, public;

drop trigger if exists rate_lines_history_trigger on public.rate_lines;
create trigger rate_lines_history_trigger
  after insert or update or delete on public.rate_lines
  for each row execute function public.log_rate_line_change();

-- ── 3. dead code that would silently do nothing if edited ─────────────────
-- private.handle_new_auth_user is attached to nothing; auth.users fires
-- public.handle_new_user. Two functions with one job is how the wrong one
-- gets maintained.
drop function if exists private.handle_new_auth_user();

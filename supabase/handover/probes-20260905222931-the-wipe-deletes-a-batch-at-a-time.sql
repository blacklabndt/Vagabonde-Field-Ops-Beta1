-- Probes for restore_wipe_batch (20260905222931).
--
-- READ ONLY in effect, though not in kind: every block that deletes ends in
-- a RAISE, and the raise is the rollback. Nothing any of them takes stays
-- taken, and running the file twice leaves the database exactly where it
-- started. Do not "tidy" a raise away.
--
-- HOW TO RUN
--   Run each numbered block WHOLE. Blocks 1-3 fail before the migration is
--   applied (the function does not exist yet) and that IS their "before".
--   Apply, run them again, and read them against the assertions.
--
-- WHY THE FUNCTION EXISTS
--   The wipe phase of a restore-everything emptied each table with one
--   unbounded DELETE, and the role the Edge Functions reach the database
--   through carries an eight-second statement cap it cannot raise. On the
--   live project ticket_lines is 111,777 rows, every one of them firing the
--   ticket-total sync trigger: the statement was cancelled every time, rolled
--   back whole, and a retry started from 111,777 again. The restore was
--   observed failing there twice in a row on 2026-09-05, AFTER it had emptied
--   ticket_crew — 46,080 rows of paid hours gone, nothing put back.

-- ═══ 1 · The door: it empties the wipe's tables and nothing else ═══════
-- AFTER:
--   unknown table refused [22023]
--   keep-elsewhere refused [22023]
--   a table with nothing in it answers 0
do $$
declare n integer; notes text := '';
begin
  begin
    n := public.restore_wipe_batch('auth.users', 10);
    notes := 'UNKNOWN TABLE NOT REFUSED';
  exception when others then notes := 'unknown table refused [' || sqlstate || ']';
  end;

  -- The Admin's own profile row is the wipe's one exception, and it is
  -- profiles' alone: no other table in WIPE_ORDER is even keyed on `id`
  -- the same way, and a keep silently ignored would be a row deleted that
  -- the caller believed it had held back.
  begin
    n := public.restore_wipe_batch('tickets', 10, gen_random_uuid());
    notes := notes || ' | KEEP ON A NON-PROFILES TABLE NOT REFUSED';
  exception when others then notes := notes || ' | keep-elsewhere refused [' || sqlstate || ']';
  end;

  notes := notes || ' | empty table answers ' || public.restore_wipe_batch('burned_ticket_numbers', 100);
  raise exception '%', notes;
end $$;

-- ═══ 2 · A composite-keyed table, which is why it is ctid and not a key ══
-- Three of the wipe's tables have no single-column primary key
-- (chat_reactions, chat_reads, arcade_scores). AFTER, on a database with
-- chat_reads rows in it:
--   chat_reads 3 -> 1, said 2
-- and the raise puts all three back.
do $$
declare n integer; before_n integer; after_n integer;
begin
  select count(*) into before_n from public.chat_reads;
  n := public.restore_wipe_batch('chat_reads', 2);
  select count(*) into after_n from public.chat_reads;
  raise exception 'chat_reads % -> %, said %', before_n, after_n, n;
end $$;

-- ═══ 3 · The batch that could not be deleted, timed ════════════════════
-- The whole point. Run this on a database with a production-sized
-- ticket_lines; on a copy of the live project (111,777 lines) it read:
--   cold  batch=2000  3302 ms
--   warm  batch=1000   220 ms
--   warm  batch=2000   438 ms
-- against a cap of 8,000 ms. `set constraints all immediate` is not
-- decoration: tickets_total_balances is DEFERRABLE INITIALLY DEFERRED, so a
-- real batch pays for it at COMMIT and the delete's own clock would hide it.
-- The cold figure is the one that matters — it is what the first batches of
-- a real restore meet — and 2000 is chosen for that 2.4× margin. A batch the
-- database cancels anyway is halved by the caller and tried again, down to
-- MIN_WIPE_BATCH, so the size is a starting point and not a promise.
do $$
declare
  t0 timestamptz := clock_timestamp();
  n integer;
  ms numeric;
begin
  n := public.restore_wipe_batch('ticket_lines', 2000);
  execute 'set constraints all immediate';
  ms := extract(epoch from (clock_timestamp() - t0)) * 1000;
  raise exception 'ticket_lines batch=2000 deleted=% ms=%', n, round(ms, 1);
end $$;

-- ═══ 4 · Who may call it ═══════════════════════════════════════════════
-- AFTER: exactly {postgres, service_role}. Nobody signed in, ever: a
-- function that empties tables by name is one to keep behind the service
-- key, and the restore is the only thing that holds it.
select array_agg(g.grantee::text order by g.grantee::text) as grantees
  from information_schema.routine_privileges g
 where g.routine_name = 'restore_wipe_batch';

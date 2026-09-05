-- The wipe a restore-everything runs, one bounded delete at a time.
--
-- Every table the restore empties was emptied by a single unbounded DELETE,
-- and the role these functions reach the database through carries an
-- eight-second statement timeout that nothing in them can raise: it is the
-- platform default on the authenticator and the service key inherits it. So
-- the delete of ticket_lines — 111,777 rows on the live project, every one
-- of them firing the ticket-total sync trigger — was cancelled, rolled back
-- whole, and started again from 111,777 rows on the next attempt. The
-- restore-everything button could not finish on real data at all, and it
-- failed AFTER emptying ticket_crew: the app left half wiped, 46,080 rows of
-- somebody's paid hours gone, and nothing put back.
--
-- The delete is bounded here and the loop is in the caller: one call takes
-- at most p_limit rows of one table and says how many it got, and the
-- restore keeps asking until a short answer says the table is empty. It is
-- an RPC and not a PostgREST delete because PostgREST cannot say "some of
-- them" — a limit pushed through a filter is a different row set every call.
--
-- ctid rather than a key, because three of these tables have a composite one
-- (chat_reactions, chat_reads, arcade_scores) and a wipe does not care which
-- rows it takes first.
--
-- Batching is safe with the triggers WIPE_ORDER exists to manage, and that
-- is not luck: ticket_lines' sync trigger rewrites each ticket's total as
-- its lines go, so the deferred balance check passes at every batch's
-- commit rather than only at the end; tickets are still every one of them
-- deleted before burned_ticket_numbers is cleared; and rate_lines is still
-- emptied entirely before rate_line_history.
--
-- The table name is a whitelist, not a parameter in the honest sense: it is
-- WIPE_ORDER's own list checked against a literal array, because a function
-- that deletes from any table you name is a function worth stealing. It is
-- the service role's alone, like restore_patch_rows and
-- restore_chat_messages beside it. p_keep_id is the wipe's one exception —
-- the Admin driving the restore keeps their own profile row, or the session
-- loses its permissions halfway through the job — and it is refused for
-- any table but profiles rather than quietly ignored.
create or replace function public.restore_wipe_batch(
  p_table text,
  p_limit integer default 2000,
  p_keep_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  allowed text[] := array[
    'ticket_crew', 'ticket_lines', 'tickets', 'burned_ticket_numbers',
    'timesheet_approvals', 'jhas', 'reports', 'rate_overrides', 'jobs',
    'rate_lines', 'rate_line_history', 'rate_schedules', 'contacts',
    'clients', 'contractors', 'chat_reactions', 'chat_reads',
    'chat_messages', 'push_subscriptions', 'arcade_scores',
    'function_errors', 'audit_log', 'equipment', 'profiles'
  ];
  cap integer := least(greatest(coalesce(p_limit, 2000), 1), 20000);
  n integer := 0;
begin
  if not (p_table = any (allowed)) then
    raise exception
      'restore_wipe_batch does not empty "%". It empties the tables a restore wipes, and nothing else.',
      p_table
      using errcode = '22023';
  end if;

  if p_keep_id is not null and p_table <> 'profiles' then
    raise exception
      'restore_wipe_batch keeps a row back from profiles alone, not from "%".',
      p_table
      using errcode = '22023';
  end if;

  if p_table = 'profiles' and p_keep_id is not null then
    execute format(
      'delete from public.%I where ctid = any (array(select ctid from public.%I where id <> $1 limit $2))',
      p_table, p_table
    ) using p_keep_id, cap;
  else
    execute format(
      'delete from public.%I where ctid = any (array(select ctid from public.%I limit $1))',
      p_table, p_table
    ) using cap;
  end if;

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.restore_wipe_batch(text, integer, uuid) is
  'Empty at most p_limit rows of one of the tables a restore wipes, and say how many went. The restore calls it until a short answer says the table is empty: one unbounded DELETE over a production-sized table is cancelled by the eight-second statement cap the functions inherit, rolls back whole, and can never finish. Raises on any other table, and keeps a row back from profiles alone. The service role''s alone.';

revoke execute on function public.restore_wipe_batch(text, integer, uuid) from public, anon, authenticated;
grant execute on function public.restore_wipe_batch(text, integer, uuid) to service_role;

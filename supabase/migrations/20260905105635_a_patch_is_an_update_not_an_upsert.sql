-- The three columns a restore has to put back on their own, and the one
-- door that can do it.
--
-- A restore loads whole rows, but three values have to be written a second
-- time, after the rows are in and after the triggers that overwrite them
-- have stopped firing: chat_messages.reply_to (a reply can sit in an
-- earlier part than the message it quotes), tickets.total (the deferred
-- balance trigger refuses a ticket whose lines are not in yet, so a ticket
-- loads at zero and a signed one gets its own figure back), and
-- jobs.last_activity_at (the definer triggers on tickets, JHAs and reports
-- stamp every restored job with today).
--
-- Those three were written as PostgREST upserts of two columns each, and
-- every one of them would have been refused: Postgres builds the proposed
-- tuple and checks NOT NULL on it BEFORE it looks for the conflict, so
-- {id, reply_to} fails on chat_messages.profile_id, {id, total} on
-- tickets.job_id and {id, last_activity_at} on jobs.job_number — however
-- certainly the id is already on the table. A partial write has to be an
-- UPDATE, and PostgREST has no bulk update keyed per row, so this is it.
--
-- Deliberately not general. It takes exactly three (table, column) pairs
-- and raises on anything else, because a function that could set any column
-- of any table from a jsonb blob is a function worth stealing. It is the
-- service role's alone — the same reader as restore_chat_messages beside
-- it — and it is safe with the triggers that remain on:
--   · the tickets it writes a total for are Approved or Invoiced, and
--     private.ticket_total_balances returns early for exactly those;
--   · private.guard_job_update exempts the service role by claim, and the
--     claim is unchanged inside a definer function;
--   · tickets_touch_job is AFTER UPDATE OF status, which this never writes,
--     so patching a total does not re-stamp the job's activity time.
create or replace function public.restore_patch_rows(p_table text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;

  if p_table = 'chat_messages' then
    update public.chat_messages m
       set reply_to = s.reply_to
      from jsonb_populate_recordset(null::public.chat_messages, p_rows) s
     where m.id = s.id;

  elsif p_table = 'tickets' then
    update public.tickets t
       set total = s.total
      from jsonb_populate_recordset(null::public.tickets, p_rows) s
     where t.id = s.id;

  elsif p_table = 'jobs' then
    update public.jobs j
       set last_activity_at = s.last_activity_at
      from jsonb_populate_recordset(null::public.jobs, p_rows) s
     where j.id = s.id;

  else
    raise exception
      'restore_patch_rows does not patch "%". It writes chat_messages.reply_to, tickets.total and jobs.last_activity_at, and nothing else.',
      p_table
      using errcode = '22023';
  end if;

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.restore_patch_rows(text, jsonb) is
  'Write back one of the three columns a restore puts right after the load: chat_messages.reply_to, tickets.total, jobs.last_activity_at. An UPDATE keyed on id, because a partial upsert is checked against the table''s NOT NULL columns before ON CONFLICT is ever reached. Raises on any other table. The service role''s alone.';

revoke execute on function public.restore_patch_rows(text, jsonb) from public, anon, authenticated;
grant execute on function public.restore_patch_rows(text, jsonb) to service_role;

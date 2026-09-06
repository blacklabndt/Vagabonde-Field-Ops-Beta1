-- A worker keeps their own three dosimeter serials.
--
-- Filing a JHA needs at least one of a worker's TLD, DRD or alarming
-- dosimeter serial, and a technician whose profile carries none — which is
-- how both seed technicians and, per the beta report, real accounts arrive —
-- types them again on every assessment. Nothing the field can press has ever
-- written them back: profiles UPDATE wants the users tab (20260903054919,
-- profiles_update), and a technician's tabs are Home, tickets, chat, files,
-- contacts and timesheets. Widening that policy is not the fix — it would
-- hand every account an update path to somebody's rank, tabs and name — so
-- this takes the shape every other narrow door in the app takes
-- (mark_tickets_invoiced, archive_clear_jobs, clear_function_errors): a
-- definer RPC that writes three columns and nothing else, on one row and no
-- other.
--
-- There is no id parameter to pass. auth.uid() is the whole target, so
-- "set someone else's serials" is not a call this function can be made to
-- perform. A deactivated account is refused with the rest of them — the
-- update carries the same `deactivated_at is null` test private.user_role()
-- has answered null for since 20260904135107, so a locked account's
-- unexpired token writes nothing here either.
--
-- All three columns are written every time, a blank meaning none: the panel
-- that calls this only appears for a worker who has none of the three, and a
-- half-written profile would leave the builder asking the same question on
-- the next job.
create or replace function public.set_own_dosimetry(p_tld text, p_drd text, p_alarm text)
returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  update public.profiles
     set tld_serial   = nullif(btrim(coalesce(p_tld, '')), ''),
         drd_serial   = nullif(btrim(coalesce(p_drd, '')), ''),
         alarm_serial = nullif(btrim(coalesce(p_alarm, '')), '')
   where id = (select auth.uid())
     and deactivated_at is null
  returning id into v_id;
  -- No row updated is either no signed-in user or a locked account. Both are
  -- a refusal rather than a quiet no-op: the screen tells the person their
  -- serials were not kept, and a silent success would be a lie it repeats.
  if v_id is null then
    raise exception 'Only a signed-in account can keep its own dosimeter serials.' using errcode = '42501';
  end if;
  return v_id;
end $$;
revoke execute on function public.set_own_dosimetry(text, text, text) from public, anon;
grant execute on function public.set_own_dosimetry(text, text, text) to authenticated;

comment on function public.set_own_dosimetry(text, text, text) is
  'The caller''s own three dosimeter serials, written to their own profile '
  'row. The profiles update policy wants the users tab, which the field does '
  'not hold; this writes those three columns, on auth.uid()''s row alone.';

-- ⚠ Superseded in part by 20260814050000. Read that one before copying
-- anything from here.
--
-- The reasoning below is sound and still stands, but the implementation
-- dropped SECURITY DEFINER from the helpers. `authenticated` has no USAGE on
-- the `private` schema, so every policy that called one failed with
-- "permission denied for schema private" — denying whole queries rather than
-- rows. The app was down for every signed-in user until the next migration
-- put it back. Comment-only note; nothing below has changed.
--
-- Row-level security stops hammering `profiles`.
--
-- `profiles` is the busiest object in this database by an order of magnitude —
-- 56,979 index scans against 5,405 for the next busiest — and almost none of
-- that is the app reading profiles. It is RLS: every policy calls has_tab(),
-- which is a SECURITY DEFINER function that selects from profiles.
--
-- Worse, each *distinct* call is its own lookup. A policy written
--
--     has_tab('ticket') or has_tab('job') or has_tab('tracker')
--
-- reads profiles three times before returning a single ticket row.
--
-- Two changes here:
--
--   1. One lookup instead of many. `private.tab_access()` returns the whole
--      array once and `private.has_any_tab(...)` tests it with array overlap,
--      so a three-tab policy costs one lookup rather than three.
--
--   2. Ideally none at all. If the access-token hook below is enabled, the
--      tab list travels in the JWT and `tab_access()` reads it from the token
--      — no table access anywhere in the policy. The function falls back to
--      the table whenever the claim is absent, so this migration is safe to
--      apply before the hook is turned on, and safe for sessions holding
--      tokens minted before it was.
--
-- The trade the JWT buys performance with: a permissions change now takes
-- effect on the user's next token refresh (Supabase default: one hour) rather
-- than on their next request. Removing someone's access is not immediate.
-- Deleting their profile still is, because sign-in checks for one.

-- === 1. One source of truth for "what can this session see" ==========

create or replace function private.tab_access()
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claim jsonb;
begin
  -- The token, when the hook has put it there.
  claim := auth.jwt() -> 'app_metadata' -> 'tab_access';
  if claim is not null and jsonb_typeof(claim) = 'array' then
    return array(select jsonb_array_elements_text(claim));
  end if;
  -- Otherwise the table, exactly as before.
  return (select p.tab_access from public.profiles p where p.id = (select auth.uid()));
end;
$$;

create or replace function private.user_role()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claim jsonb;
begin
  claim := auth.jwt() -> 'app_metadata' -> 'app_role';
  if claim is not null and jsonb_typeof(claim) = 'string' then
    return claim #>> '{}';
  end if;
  return (select p.role from public.profiles p where p.id = (select auth.uid()));
end;
$$;

-- Array overlap: true when the session holds any of these tabs. One
-- evaluation of tab_access() however many tabs are listed.
create or replace function private.has_any_tab(variadic tabs text[])
returns boolean
language sql
stable
as $$
  select coalesce(private.tab_access() && tabs, false);
$$;

-- The old single-tab helpers stay, delegating, so anything not rewritten
-- below (or written later, or in an Edge Function) keeps working.
create or replace function private.has_tab(tab text)
returns boolean
language sql
stable
as $$
  select coalesce(private.tab_access() && array[tab], false);
$$;

create or replace function public.has_tab(_tab text)
returns boolean
language sql
stable
as $$
  select coalesce(private.tab_access() && array[_tab], false);
$$;

-- "Is this a real member of staff" — a profile exists, or a token was minted
-- from one. No lookup once the claim is present.
create or replace function public.is_staff()
returns boolean
language sql
stable
as $$
  select private.tab_access() is not null;
$$;

-- === 2. Policies, rewritten to ask once ==============================
-- Same access as before in every case; only the number of lookups changes.

-- clients
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select using (private.has_any_tab('board', 'job', 'rates'));
drop policy if exists clients_write on public.clients;
create policy clients_write on public.clients
  for all using (private.has_any_tab('board', 'rates'))
  with check (private.has_any_tab('board', 'rates'));

-- contractors
drop policy if exists contractors_select on public.contractors;
create policy contractors_select on public.contractors
  for select using (private.has_any_tab('board', 'job'));
drop policy if exists contractors_write on public.contractors;
create policy contractors_write on public.contractors
  for all using (private.has_any_tab('board'))
  with check (private.has_any_tab('board'));

-- jobs
drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs
  for select using (private.has_any_tab('board', 'job'));
drop policy if exists jobs_insert on public.jobs;
create policy jobs_insert on public.jobs
  for insert with check (private.has_any_tab('board'));
drop policy if exists jobs_update on public.jobs;
create policy jobs_update on public.jobs
  for update using (private.has_any_tab('job', 'board'));

-- reports
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports
  for select using (private.has_any_tab('upload', 'job'));
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert with check (private.has_any_tab('upload', 'job'));

-- rate_lines
drop policy if exists rate_lines_select on public.rate_lines;
create policy rate_lines_select on public.rate_lines
  for select using (private.has_any_tab('rates', 'ticket', 'job'));
drop policy if exists rate_lines_write on public.rate_lines;
create policy rate_lines_write on public.rate_lines
  for insert with check (private.has_any_tab('rates'));
drop policy if exists rate_lines_update on public.rate_lines;
create policy rate_lines_update on public.rate_lines
  for update using (private.has_any_tab('rates'));
drop policy if exists rate_lines_delete on public.rate_lines;
create policy rate_lines_delete on public.rate_lines
  for delete using (private.has_any_tab('rates'));

-- rate_schedules
drop policy if exists rate_schedules_select on public.rate_schedules;
create policy rate_schedules_select on public.rate_schedules
  for select using (private.has_any_tab('rates', 'ticket', 'job'));
drop policy if exists rate_schedules_write on public.rate_schedules;
create policy rate_schedules_write on public.rate_schedules
  for insert with check (private.has_any_tab('rates'));
drop policy if exists rate_schedules_update on public.rate_schedules;
create policy rate_schedules_update on public.rate_schedules
  for update using (private.has_any_tab('rates'));
drop policy if exists rate_schedules_delete on public.rate_schedules;
create policy rate_schedules_delete on public.rate_schedules
  for delete using (private.has_any_tab('rates'));

-- rate_overrides — the `not locked` guard is the billing lock and stays.
drop policy if exists rate_overrides_select on public.rate_overrides;
create policy rate_overrides_select on public.rate_overrides
  for select using (private.has_any_tab('rates', 'job'));
drop policy if exists rate_overrides_write on public.rate_overrides;
create policy rate_overrides_write on public.rate_overrides
  for all using (private.has_any_tab('rates') and not locked)
  with check (private.has_any_tab('rates'));

-- ticket_lines — the approved_at guard is the billing immutability rule.
drop policy if exists ticket_lines_select on public.ticket_lines;
create policy ticket_lines_select on public.ticket_lines
  for select using (private.has_any_tab('ticket', 'job', 'tracker'));
drop policy if exists ticket_lines_write on public.ticket_lines;
create policy ticket_lines_write on public.ticket_lines
  for insert with check (
    exists (select 1 from public.tickets t where t.id = ticket_lines.ticket_id and t.approved_at is null)
    and private.has_any_tab('ticket', 'job')
  );
drop policy if exists ticket_lines_delete on public.ticket_lines;
create policy ticket_lines_delete on public.ticket_lines
  for delete to authenticated using (
    exists (select 1 from public.tickets t where t.id = ticket_lines.ticket_id and t.approved_at is null)
    and private.has_any_tab('ticket', 'job')
  );

-- audit_log
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select using (private.has_any_tab('users', 'rates'));

-- profiles — `tab_access` inside the check is the *target* row's column, not
-- the caller's, and stays a column reference.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert with check (private.has_any_tab('users'));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (
    private.has_any_tab('users')
    and not (id = (select auth.uid()) and not ('users' = any (tab_access)))
  );
drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles
  for delete using (private.has_any_tab('users') and id <> (select auth.uid()));

-- equipment — the role check was a second profiles read on every write.
drop policy if exists "equipment write" on public.equipment;
create policy "equipment write" on public.equipment
  for all to authenticated
  using (private.has_any_tab('equipment') and private.user_role() in ('Admin', 'Coordinator'))
  with check (private.has_any_tab('equipment') and private.user_role() in ('Admin', 'Coordinator'));

-- ticket_crew
drop policy if exists "crew write" on public.ticket_crew;
create policy "crew write" on public.ticket_crew
  for all to authenticated
  using (private.has_any_tab('ticket', 'timesheets'))
  with check (private.has_any_tab('ticket', 'timesheets'));

-- timesheet_approvals
drop policy if exists "timesheet approvals write" on public.timesheet_approvals;
create policy "timesheet approvals write" on public.timesheet_approvals
  for all to authenticated
  using (private.has_any_tab('timesheets'))
  with check (private.has_any_tab('timesheets'));

-- === 3. The access-token hook ========================================
-- Supabase calls this while minting a token. Whatever it returns becomes the
-- claims. It is deliberately defensive: if anything goes wrong it hands back
-- the event untouched, so a bug here can never stop someone signing in — the
-- policies simply fall back to reading the table.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb;
  tabs   text[];
  urole  text;
begin
  select p.tab_access, p.role into tabs, urole
  from public.profiles p
  where p.id = (event ->> 'user_id')::uuid;

  if tabs is null then
    return event;   -- no profile: nothing to say about them
  end if;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  if claims ? 'app_metadata' then
    claims := jsonb_set(claims, '{app_metadata,tab_access}', to_jsonb(tabs));
    claims := jsonb_set(claims, '{app_metadata,app_role}', to_jsonb(coalesce(urole, '')));
  else
    claims := jsonb_set(claims, '{app_metadata}',
      jsonb_build_object('tab_access', to_jsonb(tabs), 'app_role', to_jsonb(coalesce(urole, ''))));
  end if;

  return jsonb_set(event, '{claims}', claims);
exception when others then
  return event;
end;
$$;

-- The hook runs as supabase_auth_admin, which is subject to RLS like anyone
-- else, so it needs its own way in to profiles.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant select on table public.profiles to supabase_auth_admin;

drop policy if exists "auth admin reads profiles for the token hook" on public.profiles;
create policy "auth admin reads profiles for the token hook" on public.profiles
  for select to supabase_auth_admin using (true);

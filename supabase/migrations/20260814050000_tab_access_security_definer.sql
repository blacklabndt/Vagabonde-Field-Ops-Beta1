-- Fixes a break introduced by 20260814040000.
--
-- The helper functions were rewritten as plain `language sql stable`, dropping
-- the SECURITY DEFINER that the originals carried. Every one of them calls
-- private.tab_access(), and `authenticated` has no USAGE on the `private`
-- schema — that is the entire point of putting the helpers there, so
-- PostgREST never exposes them. Without SECURITY DEFINER the inner call runs
-- as the caller, and every policy that used one failed with
--
--     permission denied for schema private
--
-- which denies the query outright rather than denying a row. The app was down
-- for every signed-in user between that migration and this one.
--
-- SECURITY DEFINER makes the body run as the owner, which is how the original
-- has_tab() reached the table. search_path is pinned on each, as it must be on
-- any definer function.

create or replace function private.has_any_tab(variadic tabs text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(private.tab_access() && tabs, false);
$$;

create or replace function private.has_tab(tab text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(private.tab_access() && array[tab], false);
$$;

create or replace function public.has_tab(_tab text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(private.tab_access() && array[_tab], false);
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.tab_access() is not null;
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

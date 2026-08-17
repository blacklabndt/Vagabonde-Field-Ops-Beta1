-- Hardening for the functions added or rewritten today.
--
-- 1. `custom_access_token_hook` had no pinned search_path. It is executed by
--    supabase_auth_admin every time a token is minted, so an unqualified name
--    inside it resolves against whatever search_path that session carries —
--    the classic shape of a privilege-escalation bug. Pinned now. (It stays
--    SECURITY INVOKER, as Supabase requires for auth hooks; it runs with the
--    auth admin's rights already, which is why it needed its own read policy
--    on profiles rather than definer rights.)
--
-- 2. `next_ticket_number` was revoked from PUBLIC, but Supabase grants
--    EXECUTE on public-schema functions to `anon` explicitly, so revoking
--    PUBLIC did not remove it. It is SECURITY DEFINER and reads the tickets
--    table, so an unauthenticated caller could have used it to probe how many
--    tickets a given technician raised on a given day. Revoked properly.
--
-- 3. search_jobs/search_tickets get a pinned search_path too. They are
--    SECURITY INVOKER so the exposure is smaller, but they were rewritten
--    today and it costs nothing to leave them tidy.
--
-- has_tab() and is_staff() keep their EXECUTE grant to anon deliberately:
-- with no session they return false, which is what makes an anonymous read
-- return an empty list. Revoking it would turn that into a permission error.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = public
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
    return event;
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

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

-- Minting a ticket number is a signed-in action.
revoke execute on function public.next_ticket_number(text, date) from anon, public;
grant  execute on function public.next_ticket_number(text, date) to authenticated;

alter function public.search_jobs(text, text, text, integer, integer) set search_path = public;
alter function public.search_tickets(text, integer, integer) set search_path = public;

-- Claiming a push endpoint goes through a definer function.
--
-- The probe for the previous migration caught it: ON CONFLICT DO UPDATE
-- must be able to see the row it collides with, and the select policy
-- rightly hides other people's subscriptions — so the shared-tablet
-- takeover (the next tech claiming the endpoint the last one left
-- behind) could never work through the table. The function upserts as
-- its owner, pins the new owner to whoever is signed in, and the update
-- policy that existed for that path goes away with nothing left to use it.

drop policy push_subscriptions_update on public.push_subscriptions;

create or replace function public.claim_push_subscription(_endpoint text, _p256dh text, _auth text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if (select auth.uid()) is null or not (select private.has_tab('chat')) then
    raise exception 'Only someone in the chat can subscribe to it.';
  end if;
  insert into public.push_subscriptions (profile_id, endpoint, p256dh, auth)
  values ((select auth.uid()), _endpoint, _p256dh, _auth)
  on conflict (endpoint) do update
    set profile_id = excluded.profile_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth;
end;
$$;

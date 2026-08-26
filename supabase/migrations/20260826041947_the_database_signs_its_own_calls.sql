-- The database signs its own calls.
--
-- chat-push and chat-retention run with JWT verification off — their
-- callers are an insert trigger and a pg_cron job, neither of which holds
-- a user token — which left them answering to anyone with the publishable
-- key. The real damage was bounded (chat-push replays a recent buzz to
-- the crew it would have buzzed anyway; chat-retention deletes exactly
-- what the nightly job would), but an open door to a service-role
-- function is not a thing to leave lying around.
--
-- So: a shared secret, minted here, kept in a table in the private
-- schema no API role can see, sent by the database as the
-- x-internal-secret header on both calls, and demanded by both
-- functions. The definer accessor is how the functions learn the
-- expected value — private is not an exposed schema, so even the service
-- role cannot reach the table over REST without it; anon and
-- authenticated cannot execute it at all.

create table private.internal_config (
  key text primary key,
  value text not null
);

insert into private.internal_config (key, value)
values ('edge_shared_secret', encode(gen_random_bytes(32), 'hex'));

create or replace function public.internal_secret()
returns text
language sql
stable security definer
set search_path to ''
as $$
  select value from private.internal_config where key = 'edge_shared_secret';
$$;
revoke execute on function public.internal_secret() from public, anon, authenticated;
grant execute on function public.internal_secret() to service_role;

-- The trigger call carries the signature now.
create or replace function private.notify_chat_push()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform net.http_post(
    url := 'https://eielmvxzdwwprmmfamlq.supabase.co/functions/v1/chat-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg',
      'x-internal-secret', (select value from private.internal_config where key = 'edge_shared_secret')
    ),
    body := jsonb_build_object('messageId', new.id)
  );
  return new;
end;
$$;

-- And so does the nightly clock. The secret is read when the job fires,
-- not baked into the job's text, so rotating the table value rotates
-- everything at once.
select cron.unschedule('chat-retention-nightly');
select cron.schedule(
  'chat-retention-nightly',
  '17 9 * * *',
  $$
  select net.http_post(
    url := 'https://eielmvxzdwwprmmfamlq.supabase.co/functions/v1/chat-retention',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg',
      'x-internal-secret', (select value from private.internal_config where key = 'edge_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Push notifications for the team chat.
--
-- A row here is one browser that asked to be told about new messages:
-- the push endpoint and keys the browser minted, owned by whoever was
-- signed in when they flipped the switch. Everyone manages their own
-- rows; the chat-push function (service role) is what reads the room's
-- worth of them to send.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- The endpoint identifies the browser, not the person. Unique, so a
  -- shared tablet holds one subscription no matter how many techs have
  -- passed through it.
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index push_subscriptions_by_profile on public.push_subscriptions (profile_id);

alter table public.push_subscriptions enable row level security;

create policy push_subscriptions_select on public.push_subscriptions
  for select using (profile_id = (select auth.uid()));

create policy push_subscriptions_insert on public.push_subscriptions
  for insert with check (
    (select private.has_tab('chat'))
    and profile_id = (select auth.uid())
  );

-- Update exists for one reason: a shared tablet's endpoint already
-- belongs to the last person who subscribed on it, and the next person
-- flipping the switch must be able to claim it. The check still pins
-- the new owner to whoever is signed in.
create policy push_subscriptions_update on public.push_subscriptions
  for update
  using ((select private.has_tab('chat')))
  with check (profile_id = (select auth.uid()));

create policy push_subscriptions_delete on public.push_subscriptions
  for delete using (profile_id = (select auth.uid()));

-- Every new message tells the chat-push function, which does the actual
-- sending. pg_net queues the call and fires it after commit, so posting
-- a message never waits on anyone's phone.
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
      'apikey', 'sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg'
    ),
    body := jsonb_build_object('messageId', new.id)
  );
  return new;
end;
$$;

create trigger chat_messages_push
  after insert on public.chat_messages
  for each row execute function private.notify_chat_push();

-- Reactions, and messages that point at the shared files.
--
-- A reaction is one person, one message, one emoji from a fixed six —
-- the primary key makes double-tapping idempotent and the check keeps
-- the set curated. Everyone in the chat sees them; you place and take
-- back only your own. Realtime carries them so a thumbs-up lands on
-- every phone as it happens.

create table public.chat_reactions (
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null constraint chat_reactions_curated
    check (emoji in ('👍', '❤️', '😂', '😮', '🔥', '👌')),
  created_at timestamptz not null default now(),
  primary key (message_id, profile_id, emoji)
);

-- The pk covers message_id lookups; profiles' cascade needs its own.
create index chat_reactions_by_profile on public.chat_reactions (profile_id);

alter table public.chat_reactions enable row level security;

create policy chat_reactions_select on public.chat_reactions
  for select using ((select private.has_tab('chat')));
create policy chat_reactions_insert on public.chat_reactions
  for insert with check (
    (select private.has_tab('chat'))
    and profile_id = (select auth.uid())
  );
create policy chat_reactions_delete on public.chat_reactions
  for delete using (profile_id = (select auth.uid()));

alter publication supabase_realtime add table public.chat_reactions;

-- A message can link a file from the Files page: the shared bucket's
-- path plus the name to show. The file is referenced, never owned —
-- deleting or expiring the message must not touch the Files page, which
-- is why these keys stay out of every cleanup path.
alter table public.chat_messages
  add column file_key text,
  add column file_name text,
  add constraint chat_messages_file_named check (file_key is null or file_name is not null);

alter table public.chat_messages drop constraint chat_messages_says_or_shows;
alter table public.chat_messages add constraint chat_messages_says_or_shows
  check (
    length(body) <= 4000
    and (btrim(body) <> '' or image_key is not null or gif_url is not null
         or audio_key is not null or file_key is not null)
  );

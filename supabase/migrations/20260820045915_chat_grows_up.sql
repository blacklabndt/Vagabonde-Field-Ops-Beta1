-- The chat's second wind: unread counts, replies, and voice notes.
--
-- Unread: one row per person saying when they last looked at the room.
-- The drawer badge is a count of what arrived since, minus your own
-- words — you cannot be behind on what you said yourself. The count
-- function is SECURITY INVOKER on purpose: the caller's own RLS decides
-- what is countable, so it needs no guard of its own.

create table public.chat_reads (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now()
);

alter table public.chat_reads enable row level security;

create policy chat_reads_select on public.chat_reads
  for select using (profile_id = (select auth.uid()));
create policy chat_reads_insert on public.chat_reads
  for insert with check (profile_id = (select auth.uid()));
create policy chat_reads_update on public.chat_reads
  for update using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

create or replace function public.chat_unread_count()
returns integer
language sql
stable
security invoker
set search_path to 'public'
as $$
  select count(*)::int
  from public.chat_messages m
  where m.created_at > coalesce(
          (select r.last_read_at from public.chat_reads r where r.profile_id = (select auth.uid())),
          '-infinity')
    and m.profile_id is distinct from (select auth.uid());
$$;

revoke execute on function public.chat_unread_count() from public, anon;
grant execute on function public.chat_unread_count() to authenticated;

-- Replies: a message can point at the one it answers. The pointer goes
-- null if the quoted message expires or is moderated away — the reply
-- stands on its own words. Partial index for the FK's delete-time lookup.
alter table public.chat_messages
  add column reply_to uuid references public.chat_messages (id) on delete set null;
create index chat_messages_by_reply on public.chat_messages (reply_to)
  where reply_to is not null;

-- Voice notes: a message can carry a recording, stored in chat-media
-- like the pictures. Saying, showing, or speaking — one of them, at least.
alter table public.chat_messages add column audio_key text;
alter table public.chat_messages drop constraint chat_messages_says_or_shows;
alter table public.chat_messages add constraint chat_messages_says_or_shows
  check (
    length(body) <= 4000
    and (btrim(body) <> '' or image_key is not null or gif_url is not null or audio_key is not null)
  );

-- What browsers actually record: Opus in WebM (Chrome/Android), AAC in
-- MP4 (iPhone), and the two common fallbacks.
update storage.buckets
   set allowed_mime_types = array[
     'image/jpeg', 'image/png', 'image/webp', 'image/gif',
     'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg'
   ]
 where id = 'chat-media';

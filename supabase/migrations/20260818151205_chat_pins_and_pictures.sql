-- Pins and pictures in the team chat.
--
-- Pinning: an Admin can hold a message at the top of the room until an
-- Admin takes it down. Nobody — Admin included — can edit what a message
-- says: UPDATE is granted on the pin columns alone, so a row's words
-- stay immutable while its pin moves.
--
-- Pictures: a message can carry an image (photos and GIFs), stored in a
-- private bucket and read through short-lived signed URLs, gated on the
-- same chat tab as the room itself.

alter table public.chat_messages
  add column pinned_at timestamptz,
  add column pinned_by uuid references public.profiles (id) on delete set null,
  add column image_key text;

-- A message now says something or shows something (or both).
alter table public.chat_messages drop constraint chat_messages_body_says_something;
alter table public.chat_messages add constraint chat_messages_says_or_shows
  check (length(body) <= 4000 and (btrim(body) <> '' or image_key is not null));

-- The pinned strip reads newest pin first, and almost nothing is pinned.
create index chat_messages_pinned on public.chat_messages (pinned_at desc)
  where pinned_at is not null;

-- Only the pin columns are updatable at all — the grant, not just the
-- policy, is what keeps message bodies immutable.
revoke update on public.chat_messages from anon, authenticated;
grant update (pinned_at, pinned_by) on public.chat_messages to authenticated;

create policy chat_messages_update on public.chat_messages
  for update
  using ((select private.user_role()) = 'Admin')
  with check (
    (select private.user_role()) = 'Admin'
    -- A pin is signed by whoever set it; clearing both is an unpin.
    and (pinned_by is null or pinned_by = (select auth.uid()))
  );

-- The pictures live in their own private bucket. 8MB and image types
-- only — this is a chat, not the report archive.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 8388608,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

create policy "chat-media read" on storage.objects for select
  using (bucket_id = 'chat-media' and (select private.has_tab('chat')));

-- Uploads go under your own folder, so an object's path says who sent it
-- and the delete policy below can hold people to their own pictures.
create policy "chat-media write" on storage.objects for insert
  with check (
    bucket_id = 'chat-media'
    and (select private.has_tab('chat'))
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "chat-media delete" on storage.objects for delete
  using (
    bucket_id = 'chat-media'
    and ((storage.foldername(name))[1] = (select auth.uid())::text
         or (select private.user_role()) = 'Admin')
  );

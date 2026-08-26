-- A chat message can be a GIF from the built-in search.
--
-- The GIF itself never touches our storage: the message carries the
-- Tenor CDN URL and every phone loads it from there, which is how the
-- picker can offer millions of them without a single upload. The check
-- pins the column to Tenor's media host so a message cannot be used to
-- make every phone in the crew fetch an arbitrary link.

alter table public.chat_messages add column gif_url text
  constraint chat_messages_gif_from_tenor
  check (gif_url is null or gif_url ~ '^https://media\.tenor\.com/');

-- Saying something, showing a picture, or showing a GIF.
alter table public.chat_messages drop constraint chat_messages_says_or_shows;
alter table public.chat_messages add constraint chat_messages_says_or_shows
  check (
    length(body) <= 4000
    and (btrim(body) <> '' or image_key is not null or gif_url is not null)
  );

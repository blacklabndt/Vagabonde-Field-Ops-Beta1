-- The GIF search moves from Tenor to KLIPY.
--
-- Google shut the Tenor API down for good on 2026-06-30 — no new keys
-- since January — so the search the chat shipped with could never have
-- worked. KLIPY is where the ecosystem moved (built by ex-Tenor people;
-- lifetime-free API). Its media is served from the static*.klipy.com
-- hosts, so the host pin on gif_url moves there; the reasoning is
-- unchanged — a chat message must not be able to make every phone in
-- the crew fetch an arbitrary link. No rows carry a Tenor URL (the old
-- search never had a key to answer with), so nothing needs rewriting.

alter table public.chat_messages drop constraint chat_messages_gif_from_tenor;
alter table public.chat_messages add constraint chat_messages_gif_from_klipy
  check (gif_url is null or gif_url ~ '^https://static[0-9]*\.klipy\.com/');

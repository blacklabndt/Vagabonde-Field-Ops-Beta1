-- The team chat forgets: unpinned messages live 30 days.
--
-- The deletion itself is the chat-retention Edge Function, because
-- expired picture messages need their files taken out of the chat-media
-- bucket through the Storage API, which SQL is not allowed to touch.
-- This migration is the clock that calls it: pg_cron fires nightly at
-- 09:17 UTC — around three in the morning in Grande Prairie — and
-- pg_net carries the HTTP call. The publishable key in the header is
-- the project's public client key, not a secret; the function enforces
-- a fixed policy, so nothing worse than an early tidy-up can come from
-- calling it.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'chat-retention-nightly',
  '17 9 * * *',
  $$
  select net.http_post(
    url := 'https://eielmvxzdwwprmmfamlq.supabase.co/functions/v1/chat-retention',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- The office hears about failures.
--
-- Applied live 6 Sept 2026 as 20260906143757, after admin-digest was
-- deployed (the job would 404 every morning otherwise).
--
-- Everything the app knows about its own health is already written down:
-- a failed run in backup_runs, a lapsed drive consent in
-- app_settings.backup_connection_error, a schedule nothing is picking up in
-- backup_next_run_at, and every function's own failures in
-- function_errors. All four are pull, not push — they say nothing until
-- somebody opens the Admin screen and looks, and for a one-person office
-- that can be weeks.
--
-- Home's attention strip is one half of the answer: it says these things to
-- an Admin who is already in the app. This is the other half — a morning
-- clock for the admin-digest function, which says them to an Admin who is
-- not. The function sends nothing at all on a morning with nothing to
-- report, so a message in the inbox always means something needs doing.
--
-- The call is chat-retention's shape exactly: pg_net carries it, the
-- database signs it with x-internal-secret read from private.internal_config
-- AT THE MOMENT THE JOB FIRES rather than baked into the job's text, so
-- rotating the value in that table rotates this too. The URL and the
-- publishable key are baked in, which is what makes this one of the
-- migrations that has to be re-pointed when the repo is replayed into a
-- fresh project — see CLAUDE.md's fresh-environment warning and HANDOVER.md
-- Path B.
--
-- DEPLOY THE FUNCTION FIRST. A job scheduled against a function that is not
-- there yet gets a 404 every morning until it is deployed:
--   npx supabase functions deploy admin-digest --project-ref eielmvxzdwwprmmfamlq

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Unscheduled by id and only if it is there, so this is safe to re-run:
-- cron.unschedule(name) raises when the name does not exist, which would
-- take the whole migration down on a first apply.
select cron.unschedule(jobid)
  from cron.job
 where jobname = 'admin-digest-daily';

-- 13:00 UTC. pg_cron's clock is UTC and has no notion of a time zone, so
-- this is 07:00 in Grande Prairie for the summer half of the year and 06:00
-- for the winter half — the hour drifts with Alberta's daylight saving and
-- is left to drift on purpose. An hour either side of first coffee is the
-- right accuracy for a digest; pinning the wall clock would mean two cron
-- entries and a re-schedule twice a year for no gain anybody would notice.
select cron.schedule(
  'admin-digest-daily',
  '0 13 * * *',
  $$
  select net.http_post(
    url := 'https://eielmvxzdwwprmmfamlq.supabase.co/functions/v1/admin-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_iRMrq2AOLFWQvx4UxiCjmw_B_kSw1zg',
      'x-internal-secret', (select value from private.internal_config where key = 'edge_shared_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

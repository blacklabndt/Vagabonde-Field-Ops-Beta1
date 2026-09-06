-- Probes for 20260906143757 admin-digest-daily. Run live on 6 Sept 2026:
-- the job exists, active, at 0 13 * * *, calls admin-digest and reads the
-- secret from private.internal_config when it fires. READ ONLY: every statement here is a SELECT.
--
-- HOW TO RUN
--   Run each numbered block WHOLE — the begin/rollback pair is what makes
--   `set local role` local. Run them all BEFORE applying and keep the
--   output (blocks 1-3 answer "no such job", and that IS their "before"),
--   apply, then run them again and read them against the assertions.
--
-- WHAT THERE IS TO SIMULATE
--   Almost nothing, and that is the point: this migration adds no table, no
--   policy and no function, only a pg_cron entry. The two things worth
--   proving are that the entry exists with the schedule and the body that
--   were intended, and that the secret it carries is still unreachable by
--   anyone but the service role — the job's text names
--   private.internal_config, and a job that could be read by a signed-in
--   account would hand out the key to every internal function at once.
--   Block 4 is that check, and it is the one that must not change.

-- ═══ 1 · The job exists, on the intended schedule ══════════════════════
-- BEFORE: 0 rows.
-- AFTER: one row — schedule '0 13 * * *', active true, and the owner is
-- postgres. 13:00 UTC is 07:00 in Grande Prairie in summer and 06:00 in
-- winter; the hour drifting with daylight saving is intended.
select 'digest job' as probe,
       jobname, schedule, active, username
  from cron.job
 where jobname = 'admin-digest-daily';

-- ═══ 2 · It calls the right function, and signs the call ═══════════════
-- BEFORE: 0 rows.
-- AFTER: one row, all three true. The secret must be read from
-- private.internal_config in the job's own body — a value pasted into the
-- text would go stale the moment the table's is rotated, and every morning
-- after that the function would refuse the call it is there to answer.
select 'digest job body' as probe,
       command like '%functions/v1/admin-digest%'                      as calls_admin_digest,
       command like '%x-internal-secret%'                              as signs_the_call,
       command like '%private.internal_config%'                        as reads_the_secret_when_it_fires
  from cron.job
 where jobname = 'admin-digest-daily';

-- ═══ 3 · Exactly one of it ═════════════════════════════════════════════
-- BEFORE: 0.
-- AFTER: 1. Re-running the migration must not leave two jobs mailing the
-- same digest twice every morning — the unschedule-by-id at the top is what
-- makes it re-runnable, and this is the assertion that it worked.
select 'one digest job' as probe, count(*) as jobs
  from cron.job
 where jobname = 'admin-digest-daily';

-- ═══ 4 · The secret the job carries is still nobody else's ═════════════
-- BEFORE and AFTER, unchanged: both selects raise 42501 (permission
-- denied). cron.job is readable only by its owner, and internal_secret()
-- has no grant to authenticated. This block is here because the migration
-- writes the secret's NAME into a job body; if either of these ever answers
-- instead of raising, the digest's clock has become the way to read the key
-- every internal function trusts.
begin;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profiles
                             where role = 'Admin' and deactivated_at is null
                             order by created_at limit 1))::text,
  true);
set local role authenticated;
-- Expect: 42501 permission denied for schema cron (or for table job).
select 'admin cannot read the job' as probe, count(*) from cron.job;
rollback;

begin;
set local role authenticated;
-- Expect: 42501 permission denied for function internal_secret.
select 'authenticated cannot read the secret' as probe, public.internal_secret();
rollback;

-- ═══ 5 · What the digest will find this morning ════════════════════════
-- No before/after: this is the same reading the function does, run by hand,
-- so the first live run can be predicted instead of waited for. All four
-- columns null/false/0 means an ordinary morning and NO email — which is
-- the intended behaviour, not a broken job.
select 'what the digest would say' as probe,
       (select backup_connection_error from public.app_settings limit 1)   as drive_needs_reconnecting,
       (select r.status = 'failed' from public.backup_runs r
         where r.status in ('complete', 'failed')
         order by coalesce(r.finished_at, r.created_at) desc limit 1)      as last_run_failed,
       (select backup_next_run_at < now() - interval '6 hours'
          from public.app_settings limit 1)                                as backup_overdue,
       (select count(*) from public.function_errors
         where created_at >= now() - interval '24 hours')                  as errors_since_yesterday;

-- ═══ 6 · Who it would be mailed to ═════════════════════════════════════
-- The function joins these ids to Auth for the addresses (profiles does not
-- hold them). Zero rows here means the digest has nobody to tell, which the
-- function records as a failure rather than passing over in silence.
select 'digest recipients' as probe, id, name
  from public.profiles
 where role = 'Admin' and deactivated_at is null
 order by created_at;

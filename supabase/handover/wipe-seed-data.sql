-- Handover wipe: EVERYTHING, not only the seed rows — in one transaction.
--
-- Despite the file name, nothing below is scoped to the load-test markers
-- (S-1% jobs, @seed.vagabonde.ca accounts). Every job, ticket, JHA, report,
-- client, contact, chat message and account except the owner's goes. That
-- is what a handover wants — the client starts from an empty book — and it
-- is also why the interlock just below refuses to run until you have read
-- this far. To remove only the seed rows and keep real records, use
-- wipe-seed-only.sql beside this file instead.
--
-- THIS IS DESTRUCTIVE AND NOT A MIGRATION. It lives here, not in
-- supabase/migrations/, precisely so nothing ever runs it by accident.
-- Run it once, by hand (dashboard SQL editor, or psql), at the moment the
-- database is handed to the client — and not before, because the e2e test
-- suite signs in as two of the seed technicians and retires with them.
--
-- What it keeps:
--   - The owner account (blacklabndt@gmail.com) and its profile.
--   - The house rate card (rate_schedules.client_id is null) with its
--     lines and history — placeholder prices for the client to edit in
--     Rate admin, which beats an empty screen.
--   - The app_settings row's existence (its values are cleared in the
--     optional block at the bottom — the client enters their own keys).
--   - The schema, policies, functions, cron jobs: everything structural.
--
-- What it removes: all jobs, tickets (lines, crew), JHAs, reports,
-- clients, contractors, contacts, per-client rate cards, chat, uploaded
-- files' records, timesheet approvals, push subscriptions, scores, error
-- logs — and every account that isn't the owner.
--
-- After it commits, empty the storage buckets from the dashboard too
-- (Storage → each bucket → select all → delete): this script removes the
-- database's record of every file, which makes them unreachable, but the
-- stored bytes themselves are only reclaimed by deleting through the
-- dashboard or API.

begin;

-- The interlock. This script deletes ALL data, not only the seed rows; it
-- refuses to continue unless the session has said, in so many words, that
-- that is understood. Run this first, in the same session:
--
--   set app.confirm_total_wipe = 'yes';
--
do $$
begin
  if current_setting('app.confirm_total_wipe', true) is distinct from 'yes' then
    raise exception 'Refusing: wipe-seed-data.sql deletes EVERY job, ticket, JHA, report, client and account except the owner — not only the seed rows. Read the header; to proceed run:  set app.confirm_total_wipe = ''yes'';  first. For seed rows only, use wipe-seed-only.sql.';
  end if;
end $$;

-- Billing first (children before parents, so no cascade surprises).
delete from public.ticket_crew;
delete from public.ticket_lines;
delete from public.tickets;
delete from public.burned_ticket_numbers;
delete from public.timesheet_approvals;

-- Field paperwork, then the jobs it hangs off.
delete from public.jhas;
delete from public.reports;
delete from public.rate_overrides;
delete from public.jobs;

-- The directory, and every per-client rate card with it. The house card
-- (client_id is null) survives with its lines — but its edit HISTORY does
-- not: history rows carry changed_by references to the seed profiles being
-- deleted below (a plain foreign key, no cascade), so keeping any of them
-- would abort this whole transaction at the account delete. A history of
-- placeholder prices is worth nothing to the client anyway.
--
-- The lines go BEFORE the history, not after: rate_lines_history_trigger
-- fires AFTER DELETE and writes a history row per line removed, so clearing
-- the history first would leave exactly as many rows behind as were deleted
-- — and every one of them still pointing at a seed profile.
delete from public.rate_lines
  where schedule_id in (select id from public.rate_schedules where client_id is not null);
delete from public.rate_line_history;
delete from public.rate_schedules where client_id is not null;
delete from public.contacts;
delete from public.clients;
delete from public.contractors;

-- Chat, notifications, and the odds and ends of testing.
delete from public.chat_reactions;
delete from public.chat_reads;
delete from public.chat_messages;
delete from public.push_subscriptions;
delete from public.arcade_scores;
delete from public.function_errors;
delete from public.audit_log;

-- Equipment: the four rows here look seeded, so they go. If any are real
-- gear, comment this line out before running.
delete from public.equipment;

-- The database's record of every uploaded file (see the note up top about
-- emptying the buckets afterwards).
delete from storage.objects
  where bucket_id in ('reports', 'jhas', 'shared', 'timesheets', 'chat-media');

-- Every account but the owner. Deleting the auth user cascades the
-- profile, and everything that referenced profiles is already gone above.
delete from auth.users where email <> 'blacklabndt@gmail.com';

-- Optional: clear the Admin screen's keys so the client starts from their
-- own accounts (Resend, KLIPY) rather than inheriting the developer's.
update public.app_settings set
  resend_api_key = null, from_reports = null, from_billing = null,
  reply_to = null, klipy_api_key = null, approval_base_url = null,
  updated_at = now();

-- The receipt: expect the owner's profile, the house card, and zeroes
-- everywhere else. Run as one script this prints AFTER the commit is
-- already in; to rehearse instead, run everything above this line, eyeball
-- these counts, then type COMMIT or ROLLBACK yourself.
select
  (select count(*) from public.profiles)       as profiles_expect_1,
  (select count(*) from public.jobs)           as jobs_expect_0,
  (select count(*) from public.tickets)        as tickets_expect_0,
  (select count(*) from public.clients)        as clients_expect_0,
  (select count(*) from public.contacts)       as contacts_expect_0,
  (select count(*) from public.rate_schedules) as schedules_expect_1,
  (select count(*) from public.rate_lines)     as house_rate_lines,
  (select count(*) from auth.users)            as accounts_expect_1;

commit;
